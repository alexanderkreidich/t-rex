/** Real owned PTY -> herdr attach -> SSP -> restty -> screenshot pixels, never a renderer injection. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { createServer } from "../server/index.ts";
import { paneSendText, workspaceCreate, workspaceClose } from "../server/herdr/client.ts";
import { applyDiff, type Frame, type FrameDiff, type Style } from "../shared/ssp.ts";
import { chromePath } from "./chrome-path.ts";

const root = mkdtempSync(join(tmpdir(), "kitty-e2e-"));
const evidence = process.env["UI_EVIDENCE_DIR"] ?? mkdtempSync(join(tmpdir(), "kitty-evidence-"));
mkdirSync(evidence, { recursive: true });
const renderer = process.env["RENDERER"] === "webgl2" ? "webgl2" : process.env["RENDERER"] === "webgpu" ? "webgpu" : "auto";
const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state") });
let browser: Browser | undefined;
let workspace: string | undefined;
const image = (data: string, format: number, width: number, height: number): string => {
  let out = "\x1b[?25l\x1b[2J\x1b[H";
  for (let offset = 0; offset < data.length; offset += 4096) {
    const more = offset + 4096 < data.length ? 1 : 0;
    const control = offset === 0 ? `a=T,f=${format},t=d,i=7,p=3,s=${width},v=${height},c=8,r=4,q=2,m=${more}` : `q=2,m=${more}`;
    out += `\x1b_G${control};${data.slice(offset, offset + 4096)}\x1b\\`;
  }
  return out;
};
async function pixels(page: Page, filename?: string): Promise<{ red: number; green: number }> {
  const png = await page.locator(".pane-frame.is-current .restty-terminal").screenshot(filename ? { path: filename } : {});
  return page.evaluate(async (base64) => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))], { type: "image/png" }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let red = 0, green = 0;
    for (let at = 0; at < data.length; at += 4) {
      if (data[at]! > 220 && data[at + 1]! < 40 && data[at + 2]! < 40) red++;
      if (data[at]! < 40 && data[at + 1]! > 220 && data[at + 2]! < 40) green++;
    }
    return { red, green };
  }, png.toString("base64"));
}
async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!(await check())) {
    assert(Date.now() < deadline, `Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
try {
  const made = await workspaceCreate({ cwd: root, label: "kitty-graphics-e2e" });
  workspace = made.workspace.workspace_id;
  const pane = made.root_pane.pane_id;
  const send = async (name: string, data: string): Promise<void> => {
    const path = join(root, `${name}.vt`);
    writeFileSync(path, data);
    await paneSendText(pane, `cat '${path.replaceAll("'", "'\\''")}'\r`);
  };
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--enable-unsafe-webgpu"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript((renderer) => {
    localStorage.setItem("t-rex:settings", JSON.stringify({ language: "en", terminalRenderer: renderer }));
    const Native = window.WebSocket;
    const sockets: WebSocket[] = [];
    (window as unknown as { kittyTestSockets: WebSocket[] }).kittyTestSockets = sockets;
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); sockets.push(this); }
    };
  }, renderer);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let holdAssets = true;
  const heldAcks: (() => void)[] = [];
  const assetPackets: { offset: number; bytes: number }[] = [];
  await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
    const upstream = socket.connectToServer();
    upstream.onMessage((raw) => socket.send(raw));
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (holdAssets && message.type === "ssp-asset-ack") heldAcks.push(() => upstream.send(raw));
      else upstream.send(raw);
    });
  });
  let newest: Frame | null = null;
  let received = 0, connections = 0;
  const deltas: FrameDiff[] = [];
  const frames = new Map<string, Frame>();
  const styles = new Map<number, Style>();
  page.on("websocket", (socket) => {
    connections++;
    socket.on("framereceived", ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (message.type === "error") errors.push(`${message.code}: ${message.message}`);
      if (message.type === "ssp-asset") assetPackets.push({ offset: message.offset, bytes: Buffer.byteLength(String(payload)) });
      if (message.type !== "ssp" || message.pane_id !== pane) return;
      const diff = message as FrameDiff;
      const base = diff.base === 0 ? null : frames.get(`${diff.stream}/${diff.base}`);
      if (diff.base !== 0 && !base) return;
      newest = applyDiff(base ?? null, diff, styles);
      frames.set(`${diff.stream}/${diff.num}`, newest);
      deltas.push(diff);
      received++;
    });
  });
  const origin = `http://127.0.0.1:${server.port}`;
  await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
  await page.locator('.restty-terminal[data-ready="true"]').waitFor();
  const backend = await page.evaluate(() => (performance.getEntriesByName("restty:ready").at(-1) as PerformanceMark | undefined)?.detail?.backend);
  assert(["webgpu", "webgl2"].includes(String(backend)), "the native renderer reports its active backend");
  if (renderer !== "auto") assert.equal(backend, renderer, "the requested backend must actually render");
  await until(() => newest !== null, "initial SSP screen");
  const red = Buffer.alloc(512 * 512 * 4);
  for (let at = 0; at < red.length; at += 4) { red[at] = 255; red[at + 3] = 255; }
  await send("red", image(red.toString("base64"), 32, 512, 512));
  await until(() => (newest?.graphics?.placements.length ?? 0) === 1, "Kitty scene in SSP");
  await until(() => heldAcks.length >= 2, "bounded image window while its acknowledgements are held");
  await paneSendText(pane, "printf '\\nCELLS_WHILE_IMAGE_PENDING\\n'\r");
  await page.waitForFunction(() => {
    const node = document.querySelector<HTMLElement & { screen?: () => { text: string } }>(".pane-frame.is-current .restty-terminal");
    return node?.screen?.().text.includes("CELLS_WHILE_IMAGE_PENDING");
  });
  assert(new Set(assetPackets.map((packet) => packet.offset)).size <= 2, "unacknowledged pixels stay inside the two-chunk window");
  holdAssets = false;
  for (const release of heldAcks.splice(0)) release();
  await until(async () => (await pixels(page)).red > 1000, "red Kitty pixels rendered from the real attach stream");
  await pixels(page, join(evidence, `${renderer}-red.png`));
  assert(deltas.some((delta) => (delta.graphics?.assets.length ?? 0) > 0), "joining frame declares its image assets");
  assert(assetPackets.length > 2 && assetPackets.every((packet) => packet.bytes < 140_000), "an image larger than the 1 MiB socket limit arrives as bounded chunks");
  assert(deltas.every((delta) => delta.graphics?.assets.every((asset) => asset.data === "") ?? true), "screen frames contain metadata, not unbounded pixel payloads");

  const beforeReconnect = connections;
  const beforeFrames = received;
  await page.evaluate(() => (window as unknown as { kittyTestSockets: WebSocket[] }).kittyTestSockets.forEach((socket) => socket.close(4000, "Kitty reconnect test")));
  await until(() => connections > beforeReconnect && received > beforeFrames, "new socket and SSP after reconnect");
  await until(async () => (await pixels(page)).red > 1000, "image after reconnect");
  await page.reload();
  await page.locator('.restty-terminal[data-ready="true"]').waitFor();
  await until(async () => (await pixels(page)).red > 1000, "late join reconstructs pixels in a fresh renderer");
  await page.setViewportSize({ width: 1000, height: 700 });
  await until(async () => (await pixels(page)).red > 1000, "image survives resize");

  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 2; canvas.height = 2;
    const context = canvas.getContext("2d")!; context.fillStyle = "rgb(0,255,0)"; context.fillRect(0, 0, 2, 2);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  await send("green-png", image(png, 100, 2, 2));
  await until(async () => { const counts = await pixels(page); return counts.green > 1000 && counts.red < 100; }, "PNG replacement of the same image ID");
  await pixels(page, join(evidence, `${renderer}-png-replaced.png`));
  const imagePath = join(root, "pixels.rgba");
  writeFileSync(imagePath, red);
  await send("file-medium", `\x1b[2J\x1b[H\x1b_Ga=T,f=32,t=f,s=512,v=512,i=7,p=3,c=8,r=4,q=2;${Buffer.from(imagePath).toString("base64")}\x1b\\`);
  await until(async () => { const counts = await pixels(page); return counts.red > 1000 && counts.green < 100; }, "owned file-medium pixels read off the herdr render thread");
  await pixels(page, join(evidence, `${renderer}-file.png`));
  await send("scroll", "\x1b[2S");
  await until(() => newest?.graphics?.placements[0]?.rows === 2, "scrolled image is clipped, not moved to the viewport edge");
  await until(async () => (await pixels(page)).red > 500, "clipped image remains visible");
  holdAssets = true;
  red[0] = 0; red[1] = 255;
  await send("pending-replacement", image(red.toString("base64"), 32, 512, 512));
  await until(() => heldAcks.length >= 2, "a superseded image still has chunks in flight");
  await send("delete", "\x1b_Ga=d,d=A,q=2\x1b\\");
  await until(() => (newest?.graphics?.placements.length ?? 1) === 0, "empty authoritative image scene");
  holdAssets = false;
  for (const release of heldAcks.splice(0)) release();
  await until(async () => { const counts = await pixels(page); return counts.green < 100 && counts.red < 100; }, "deleted images disappear from the canvas");
  await pixels(page, join(evidence, `${renderer}-deleted.png`));
  await page.reload();
  await page.locator('.restty-terminal[data-ready="true"]').waitFor();
  const deleted = await pixels(page);
  assert(deleted.red < 100 && deleted.green < 100, "reload must not resurrect deleted pixels");

  // pi's alt screen: a PNG with C=1 and a random 32-bit ID, then a redraw that drops every
  // placement (d=a) and places the uploaded image again by ID alone, cropped, row by row
  const piId = 3_000_000_001;
  const piPng = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 64; canvas.height = 64;
    const context = canvas.getContext("2d")!; context.fillStyle = "rgb(0,255,0)"; context.fillRect(0, 0, 64, 64);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  await send("pi-upload", `\x1b[?1049h\x1b[?7l\x1b[2J\x1b[H\x1b[?2026h\x1b[2;1H\x1b_Ga=T,f=100,q=2,C=1,c=8,r=4,i=${piId};${piPng}\x1b\\\x1b[7;1HPI_TEXT\x1b[?2026l`);
  await until(async () => (await pixels(page)).green > 1000, "pi's PNG with a 32-bit image ID");
  const uploads = assetPackets.length;
  let redraw = "\x1b[?2026h\x1b_Ga=d,d=a,q=2\x1b\\";
  for (let row = 1; row <= 7; row++) redraw += `\x1b[${row};1H\x1b[2K${row === 1 ? `\x1b_Ga=p,q=2,C=1,c=8,i=${piId},y=16,h=48,r=3\x1b\\` : row === 6 ? "PI_TEXT" : ""}`;
  await send("pi-redraw", `${redraw}\x1b[?2026l`);
  const placed = () => newest?.graphics?.placements[0];
  await until(() => placed()?.row === 0 && placed()?.rows === 3 && placed()?.sourceY === 16, "pi's placement-only crop in SSP");
  await until(async () => (await pixels(page)).green > 1000, "pi's image after its placements were redrawn");
  assert.equal(assetPackets.length, uploads, "a placement-only redraw must not send the pixels again");
  await pixels(page, join(evidence, `${renderer}-pi-redrawn.png`));
  assert.deepEqual(errors, []);
  console.log(`PASS Kitty ${renderer} (${backend}): real PTY/attach/SSP pixels, >1 MiB RGBA, bounded upload with live text while ACKs stall, reconnect, late join, resize, PNG replacement, file medium, scroll clipping, deletion with stale pixel ACKs in flight and pi's cropped placement-only redraw; evidence ${evidence}`);
} finally {
  await browser?.close();
  server.stop();
  if (workspace) await workspaceClose(workspace);
  rmSync(root, { recursive: true, force: true });
}

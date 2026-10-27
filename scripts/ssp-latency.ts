/**
 * Local echo on a slow link, measured in a real browser (docs/ROADMAP.md, Phase 5): the page reaches
 * the bridge through a proxy that holds every WebSocket frame DELAY_MS each way, and types a command
 * a key at a time. For each key it times the press to the glyph on screen: the screen the view
 * hands the terminal (its `screen()`, docs/development.md), which restty paints on the next frame.
 *
 * The first key of a line shows only once its echo is back (a guess is confirmed before guesses
 * show); every key after it must show at once, well under the round trip. Then the screen must
 * settle on the program's own echo, with no guess left underlined. Without the delay, nothing is
 * guessed and every key shows at the speed of the link.
 *
 *   bun run build && bun run check run bun scripts/ssp-latency.ts [delay ms each way, default 100]
 *
 * SSP_LATENCY_VERBOSE=1 prints every key's time. On a Mac without Playwright's Chromium, point
 * CHROME_PATH at Google Chrome.
 */
import "./test-herdr.ts"; // a herdr session of its own: nothing shows in the user's
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { chromium, type Page } from "playwright-core";
import { createServer } from "../server/index.ts";
import { workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { chromePath } from "./chrome-path.ts";

const DELAY_MS = Number(process.argv[2] ?? 100);
const TYPED = "echo local-echo-works";

const root = realpathSync(mkdtempSync(join(tmpdir(), "restty-ssp-latency-")));
const cwd = join(root, "work");
mkdirSync(cwd);
const created = await workspaceCreate({ cwd, label: "ssp-latency" });
const workspaceId = created.workspace.workspace_id;
const bridge = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state") });

/** The bridge behind a slow link: HTTP as it is, every WebSocket frame held `delay` ms each way. */
function slowLink(delay: number) {
  type Data = { upstream: WebSocket; queue: string[] };
  return Bun.serve<Data, undefined>({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/ws") {
        const upstream = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws${url.search}`);
        if (server.upgrade(request, { data: { upstream, queue: [] } })) return undefined;
        upstream.close();
        return new Response("upgrade failed", { status: 400 });
      }
      const headers = new Headers(request.headers);
      headers.delete("host");
      headers.delete("accept-encoding");
      const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
      const answer = await fetch(`http://127.0.0.1:${bridge.port}${url.pathname}${url.search}`, { method: request.method, headers, body, redirect: "manual" });
      const back = new Headers(answer.headers);
      back.delete("content-encoding");
      back.delete("content-length");
      return new Response(await answer.arrayBuffer(), { status: answer.status, headers: back });
    },
    websocket: {
      open(socket: ServerWebSocket<Data>) {
        const { upstream, queue } = socket.data;
        upstream.addEventListener("open", () => { for (const frame of queue.splice(0)) upstream.send(frame); });
        upstream.addEventListener("message", (event) => { setTimeout(() => socket.send(String(event.data)), delay); });
        upstream.addEventListener("close", () => socket.close());
      },
      message(socket: ServerWebSocket<Data>, frame) {
        const { upstream, queue } = socket.data;
        setTimeout(() => {
          if (upstream.readyState === WebSocket.OPEN) upstream.send(String(frame));
          else queue.push(String(frame));
        }, delay);
      },
      close(socket: ServerWebSocket<Data>) { socket.data.upstream.close(); },
    },
  });
}

/** Presses `key` and times it to the moment the terminal's rows show `expected`. */
async function timeKey(page: Page, key: string, expected: string): Promise<number> {
  // armed before the press: Playwright may deliver the key ahead of an evaluate sent with it
  await page.evaluate((expected) => {
    const timing = { pressed: 0, shown: 0 };
    (window as unknown as { keyTiming: typeof timing }).keyTiming = timing;
    // the cursor's row up to the cursor: a typed space shows there before anything after it does
    const rows = (): string => {
      const shown = (document.querySelector(".pane-frame.is-current .restty-terminal") as (HTMLElement & { screen?: () => { text: string; cursor: { row: number; col: number } } }) | null)?.screen?.();
      return shown ? (shown.text.split("\n")[shown.cursor.row] ?? "").padEnd(shown.cursor.col).slice(0, shown.cursor.col) : "";
    };
    window.addEventListener("keydown", () => { timing.pressed = performance.now(); }, { capture: true, once: true });
    const poll = (): void => {
      if (timing.pressed && rows().endsWith(expected)) timing.shown = performance.now();
      else requestAnimationFrame(poll);
    };
    poll();
  }, expected);
  await page.keyboard.press(key);
  const handle = await page.waitForFunction(() => {
    const timing = (window as unknown as { keyTiming: { pressed: number; shown: number } }).keyTiming;
    return timing.shown ? timing.shown - timing.pressed : 0;
  }, undefined, { timeout: 5000, polling: "raf" }).catch(async (error: unknown) => {
    const shown = await page.evaluate(() => (document.querySelector(".pane-frame.is-current .restty-terminal") as (HTMLElement & { screen?: () => { text: string } }) | null)?.screen?.().text ?? null);
    throw new Error(`${expected} never showed; the screen: ${JSON.stringify(shown?.trimEnd())}`, { cause: error });
  });
  return (await handle.jsonValue()) as number;
}

async function typeAndTime(page: Page): Promise<number[]> {
  const times: number[] = [];
  for (let i = 0; i < TYPED.length; i++) {
    const key = TYPED[i] === " " ? "Space" : TYPED[i]!;
    times.push(await timeKey(page, key, `$ ${TYPED.slice(0, i + 1)}`));
  }
  return times;
}

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

async function measure(delay: number): Promise<{ first: number; rest: number; max: number }> {
  const link = slowLink(delay);
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox", "--accept-lang=en-US"] });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(() => localStorage.setItem("t-rex:settings", JSON.stringify({ language: "en" })));
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${link.port}/`);
    await page.locator(`.workspace-group[data-workspace="${workspaceId}"] .workspace-select`).click();
    const input = page.locator(".pane-frame.is-current .terminal-ime").first();
    await input.waitFor({ state: "attached", timeout: 20_000 });
    // input is ready once the shell's prompt is there and nothing waits on the terminal
    await page.waitForFunction(() => /\$ *$/m.test(((document.querySelector(".pane-frame.is-current .restty-terminal") as (HTMLElement & { screen?: () => { text: string; underlined: number } }) | null)?.screen?.().text ?? "").trimEnd())
      && !document.querySelector(".terminal-banner")?.textContent?.includes("Waiting"), undefined, { timeout: 20_000 });
    // a plain prompt, so what is typed is easy to find
    await input.focus();
    await page.keyboard.type("PS1='$ '; clear");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => /^\$\s*$/.test(((document.querySelector(".pane-frame.is-current .restty-terminal") as (HTMLElement & { screen?: () => { text: string; underlined: number } }) | null)?.screen?.().text ?? "").trim()), undefined, { timeout: 20_000 });
    // warm up: the bridge measures the round trip from the screens' acknowledgements
    await page.keyboard.type("true");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(Math.max(500, delay * 6));
    const times = await typeAndTime(page);
    // the program's own echo replaces every guess, and nothing stays underlined
    await page.keyboard.press("Enter");
    await page.waitForFunction((typed) => ((document.querySelector(".pane-frame.is-current .restty-terminal") as (HTMLElement & { screen?: () => { text: string; underlined: number } }) | null)?.screen?.().text ?? "").includes(typed.replace("echo ", "")), TYPED, { timeout: 10_000 });
    await page.waitForTimeout(delay * 4);
    const underlined = await page.evaluate(() => (document.querySelector(".pane-frame.is-current .restty-terminal") as (HTMLElement & { screen?: () => { underlined: number } }) | null)?.screen?.().underlined ?? 0);
    assert.equal(underlined, 0, "no guess is left underlined once the echo is back");
    await page.keyboard.type("clear");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(delay * 4);
    if (process.env["SSP_LATENCY_VERBOSE"]) console.log(`ssp-latency: ${delay} ms each way, per key: ${times.map((time) => time.toFixed(0)).join(" ")}`);
    return { first: times[0]!, rest: median(times.slice(1)), max: Math.max(...times.slice(1)) };
  } finally {
    await browser.close();
    link.stop(true);
  }
}

try {
  const slow = await measure(DELAY_MS);
  const fast = await measure(0);
  const rtt = DELAY_MS * 2;
  console.log(`ssp-latency: round trip ${rtt} ms: first key ${slow.first.toFixed(0)} ms, then median ${slow.rest.toFixed(0)} ms, worst ${slow.max.toFixed(0)} ms per key`);
  console.log(`ssp-latency: no delay: first key ${fast.first.toFixed(0)} ms, then median ${fast.rest.toFixed(0)} ms, worst ${fast.max.toFixed(0)} ms per key`);
  // the first key waits for its echo; every later one is local
  assert.ok(slow.first >= rtt * 0.8, `the first key of a line shows only with its echo (${slow.first.toFixed(0)} ms)`);
  assert.ok(slow.rest < rtt / 4, `later keys show at once, not after the round trip (${slow.rest.toFixed(0)} ms median)`);
  console.log("ssp-latency: ok");
} finally {
  bridge.stop();
  await workspaceClose(workspaceId).catch(() => {});
  rmSync(root, { recursive: true, force: true });
}

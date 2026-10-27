/**
 * Browser zoom stays native even with Kitty key reporting; Mod+N makes one tab in the current
 * workspace. Synthetic zoom events check cancellation and terminal I/O: headless Chrome does not
 * run its browser-level zoom commands.
 *
 *   bun run build && bun run check run bun scripts/app-shortcuts-regression.ts
 */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { paneSendKeys, paneSendText, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { chromePath } from "./chrome-path.ts";
import { waitForScreenText } from "./terminal-screen.ts";

const root = mkdtempSync(join(tmpdir(), "t-rex-app-shortcuts-"));
const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state") });
const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
let workspace: string | undefined;

try {
  for (const platform of ["MacIntel", "Linux x86_64", "Win32"]) {
    const made = await workspaceCreate({ cwd: root, label: "t-rex-test-app-shortcuts" });
    workspace = made.workspace.workspace_id;
    const paneId = made.root_pane.pane_id;
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript((platform) => {
      Object.defineProperty(navigator, "platform", { get: () => platform });
      localStorage.setItem("t-rex:settings", JSON.stringify({ language: "en" }));
    }, platform);
    try {
      const page = await context.newPage();
      const inputs: string[] = [];
      let kitty = 0;
      page.on("websocket", (socket) => {
        socket.on("framesent", ({ payload }) => {
          const message = JSON.parse(String(payload));
          if (message.type === "input") inputs.push(message.text);
        });
        socket.on("framereceived", ({ payload }) => {
          const message = JSON.parse(String(payload));
          if (message.type === "ssp" && message.pane_id === paneId) kitty = message.modes.kittyKeyboard;
        });
      });
      await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(paneId)}`);
      const terminal = page.locator('.pane-frame.is-current .restty-terminal[data-ready="true"]');
      await terminal.waitFor({ timeout: 20_000 });
      const input = terminal.locator(".terminal-ime");
      await input.focus();
      const mac = platform === "MacIntel";
      for (const mode of [0, 3]) {
        if (mode !== 0) {
          // An owned raw-mode process requests press/release reporting and stays alive to keep it on.
          const program = "process.stdin.setRawMode(true);process.stdin.on('data',d=>{if(d.includes(3))process.exit()});process.stdout.write('\\x1b[>3u\\r\\nzoom-kitty-ready\\r\\n')";
          await paneSendText(paneId, `node -e ${JSON.stringify(program)}\r`);
          await waitForScreenText(page, /^zoom-kitty-ready\s*$/m);
          assert.equal(kitty, mode, "the pane requested Kitty press/release reporting");
        }
        const before = inputs.length;
        for (const [key, code, shiftKey] of [["-", "Minus", false], ["=", "Equal", false], ["+", "Equal", true], ["+", "NumpadAdd", false], ["-", "NumpadSubtract", false]] as const) {
          for (const type of ["keydown", "keyup"]) {
            const allowed = await input.evaluate((element, init) => element.dispatchEvent(new KeyboardEvent(init.type, { ...init, bubbles: true, cancelable: true })), {
              type, key, code, shiftKey, metaKey: mac, ctrlKey: !mac,
            });
            assert.equal(allowed, true, `${platform} ${key} ${type} stays native in keyboard mode ${mode}`);
          }
        }
        // Bound negative I/O assertions with a later frame on the same WebSocket, not a sleep.
        await page.keyboard.type("zoom-marker");
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        for (const deadline = Date.now() + 5_000; !inputs.slice(before).join("").includes("zoom-marker");) {
          assert.ok(Date.now() < deadline, "the terminal input marker arrives");
          await Bun.sleep(25);
        }
        assert.equal(inputs.slice(before).join(""), "zoom-marker", "zoom keys never reach the pane");
        if (mode === 0) await paneSendKeys(paneId, ["ctrl+u"]);
      }

      const created = page.waitForResponse((response) => response.url().endsWith("/api/tab/create") && response.request().method() === "POST");
      const allowed = await input.evaluate((element, mac) => {
        const init = { key: "n", code: "KeyN", metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true };
        const allowed = element.dispatchEvent(new KeyboardEvent("keydown", init));
        element.dispatchEvent(new KeyboardEvent("keydown", { ...init, repeat: true }));
        element.dispatchEvent(new KeyboardEvent("keyup", init));
        return allowed;
      }, mac);
      assert.equal(allowed, false, "Mod+N runs the app action instead of the browser default");
      const result = await (await created).json();
      assert.equal(result.tab.workspace_id, workspace, "the new tab belongs to the current workspace");
      await page.locator(`.workspace-tab-select[data-tab-id="${result.tab.tab_id}"][aria-current="true"]`).waitFor();
      assert.equal(await page.locator(`.workspace-group[data-workspace="${workspace}"] .workspace-tab-select`).count(), 2, "a held chord makes only one new tab");
      console.log(`PASS ${platform}: native zoom in legacy/Kitty modes; Mod+N makes one tab in the current workspace`);
    } finally {
      await context.close();
      await workspaceClose(workspace);
      workspace = undefined;
    }
  }
} finally {
  await browser.close();
  server.stop();
  if (workspace) await workspaceClose(workspace);
  rmSync(root, { recursive: true, force: true });
}

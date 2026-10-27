/** Kept terminal scenarios, independent of the removed chat/More-menu browser suite. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type WebSocket } from "playwright-core";
import { createServer } from "../server/index.ts";
import { workspaceCreate, workspaceClose, tabCreate, paneSplit } from "../server/herdr/client.ts";
import type { TabCreated } from "../shared/protocol.ts";
import { chromePath } from "./chrome-path.ts";
import { checkTerminalCopy } from "./terminal-copy-regression.ts";
import { checkCtrlEnter } from "./terminal-ctrl-enter-regression.ts";
import { checkCommandBackspace } from "./terminal-command-backspace-regression.ts";
import { checkHeldDraftPaneSwitch } from "./terminal-draft-regression.ts";
import { checkTerminalFileInput } from "./terminal-file-input-regression.ts";
import { openSettingsPage } from "./settings-page.ts";

const root = mkdtempSync(join(tmpdir(), "restty-regression-"));
const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state") });
let browser: Browser | undefined;
let workspace: string | undefined;
try {
  const made = await workspaceCreate({ cwd: root, label: "restty-regression" });
  workspace = made.workspace.workspace_id;
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--enable-unsafe-webgpu"] });
  const origin = `http://127.0.0.1:${server.port}`;
  const only = process.argv[2];
  if (!only || only === "copy") await checkTerminalCopy(browser, origin);
  if (!only || only === "keys") {
    await checkCtrlEnter(browser, origin, made.root_pane.pane_id);
    await checkCommandBackspace(browser, origin, made.root_pane.pane_id);
  }
  if (!only || only === "drafts") {
    const other = await tabCreate({ workspaceId: workspace, cwd: root });
    await checkHeldDraftPaneSwitch(browser, origin, made.root_pane.pane_id, other.root_pane.pane_id);
  }
  if (!only || only === "files" || only === "split") {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      const page = await context.newPage();
      const ready = Promise.withResolvers<WebSocket>();
      page.on("websocket", (socket) => socket.on("framereceived", ({ payload }) => {
        const message = JSON.parse(String(payload));
        if (message.type === "input-ready" && message.ready !== false) ready.resolve(socket);
      }));
      if (only !== "files") await paneSplit(made.root_pane.pane_id, "right", false);
      await page.goto(`${origin}/?pane=${encodeURIComponent(made.root_pane.pane_id)}`);
      const socket = await Promise.race([ready.promise, page.waitForTimeout(15_000).then(() => { throw new Error("Terminal input never became ready"); })]);
      if (only !== "files") {
        await page.waitForFunction(() => document.querySelectorAll('.pane-terminal .restty-terminal[data-ready="true"]').length === 2);
        console.log("PASS both herdr split panes mount restty");
      }
      if (only !== "split") await checkTerminalFileInput(page, socket);
    } finally { await context.close(); }
  }
  if (!only || only === "appearance" || only === "new-tab") {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const release = Promise.withResolvers<void>();
    let holdRoster = false;
    try {
      await context.addInitScript(() => {
        if (!localStorage.getItem("t-rex:settings")) localStorage.setItem("t-rex:settings", JSON.stringify({ language: "en", terminalRenderer: "webgl2" }));
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/api/machines", async (route) => {
        if (holdRoster) await release.promise;
        await route.continue();
      });
      await page.goto(`${origin}/?pane=${encodeURIComponent(made.root_pane.pane_id)}`);
      await page.locator('.pane-frame.is-current .restty-terminal[data-ready="true"]').waitFor();
      assert.equal(await page.evaluate(() => (performance.getEntriesByName("restty:ready").at(-1) as PerformanceMark).detail.backend), "webgl2");
      if (only !== "new-tab") {
        await page.keyboard.press("ControlOrMeta+Shift+Comma");
        await openSettingsPage(page, "Appearance");
        await page.getByRole("button", { name: "Increase terminal font size", exact: true }).click();
        await page.locator("#settings-terminal-theme").selectOption({ index: 1 });
        const theme = await page.locator("#settings-terminal-theme").inputValue();
        assert(theme.length > 0, "a Ghostty theme is selectable");
        await page.getByRole("button", { name: "Close settings", exact: true }).click();
        assert.notEqual(await page.locator(".pane-frame.is-current .terminal-stack").evaluate((node) => getComputedStyle(node).getPropertyValue("--term-bg").trim()), "");
        await page.reload();
        await page.locator('.pane-frame.is-current .restty-terminal[data-ready="true"]').waitFor();
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("t-rex:settings")!).terminalThemeName), theme);
        console.log("PASS restty Appearance: WebGL2, font size, Ghostty theme and persistence");
      }
      if (only !== "appearance") {
        holdRoster = true;
        await page.evaluate(() => { (window as unknown as { previousTerminal: Element | null }).previousTerminal = document.querySelector(".pane-frame.is-current .restty-terminal"); });
        const createdResponse = page.waitForResponse((response) => response.url().endsWith("/tab/create") && response.request().method() === "POST");
        await page.locator(".app-header .tab-strip-add").click();
        const created = await (await createdResponse).json() as TabCreated;
        assert(created.tab && created.pane, "creation returns herdr's new tab and pane");
        await page.waitForFunction(() => {
          const current = document.querySelector<HTMLElement>(".pane-frame.is-current .restty-terminal");
          return current && current !== (window as unknown as { previousTerminal: Element | null }).previousTerminal && current.dataset.ready === "true";
        }, null, { timeout: 10_000 });
        console.log("PASS new tab mounts restty while the full roster request is held");
      }
      assert.deepEqual(errors, []);
    } finally {
      release.resolve();
      await context.close();
    }
  }
} finally {
  await browser?.close();
  server.stop();
  if (workspace) await workspaceClose(workspace);
  rmSync(root, { recursive: true, force: true });
}

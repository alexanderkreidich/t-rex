/**
 * The terminal keeps the keyboard through navigation, on a herdr of its own: a sidebar row or a tab
 * picked with the pointer (the open one again too) and a click on the sidebar's empty space leave
 * typing in the terminal; what is typed while a pane just picked opens its input reaches that pane
 * once it is ready; typing into a pane put away before its input opened is held for review, never
 * sent behind the user's back.
 *
 *   bun run build && bun run check run bun scripts/terminal-keyboard-regression.ts
 */
import "./test-herdr.ts"; // a herdr session of its own: nothing shows in the user's
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { createServer } from "../server/index.ts";
import { paneRead, tabCreate, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { chromePath } from "./chrome-path.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "restty-terminal-keyboard-")));
const cwd = join(root, "work");
mkdirSync(cwd);
const a = await workspaceCreate({ cwd, label: "keyboard-a" });
const b = await workspaceCreate({ cwd, label: "keyboard-b" });
const b2 = await tabCreate({ workspaceId: b.workspace.workspace_id, cwd });
const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state") });
const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox", "--accept-lang=en-US"] });

async function until(check: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, message);
    await Bun.sleep(25);
  }
}
const paneText = async (paneId: string): Promise<string> => (await paneRead({ paneId, source: "recent", lines: 60 })).text;
// the command's own output line, not the echo of what was typed
const ran = (paneId: string, word: string) => until(async () => (await paneText(paneId)).split("\n").some((line) => line.trim() === word), `${word} ran in ${paneId}`);

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => localStorage.setItem("t-rex:settings", JSON.stringify({ language: "en" })));
  // a pane's input-ready frames wait while `gate` is closed: the moment between a pick and its
  // input opening lasts as long as the check needs, on any machine
  const gate = { closed: false, held: [] as (string | Buffer)[], release: () => {} };
  await context.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
    const upstream = socket.connectToServer();
    gate.release = () => { gate.closed = false; for (const frame of gate.held.splice(0)) socket.send(frame); };
    upstream.onMessage((frame) => {
      if (gate.closed && String(frame).includes('"type":"input-ready"')) gate.held.push(frame);
      else socket.send(frame);
    });
  });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.port}/`);

  const row = (workspaceId: string) => page.locator(`.workspace-group[data-workspace="${workspaceId}"] .workspace-select`);
  const tab = (tabId: string) => page.locator(`.app-header [role="tab"][data-tab-id="${tabId}"]`);
  const current = (paneId: string) => page.locator(`.pane-frame.is-current[data-layout-pane="${paneId}"]`);
  const ready = (paneId: string) => current(paneId).locator("[data-pane-content]").waitFor({ timeout: 20_000 });
  const typing = (paneId: string) => current(paneId).locator(".terminal-ime").evaluate((field) => field === document.activeElement);
  const held = page.locator(".pane-frame.is-current .terminal-banner-draft .draft-text");
  const run = async (page: Page, word: string) => { await page.keyboard.type(`echo ${word}`); await page.keyboard.press("Enter"); };

  const paneA = a.root_pane.pane_id;
  await row(a.workspace.workspace_id).click();
  await ready(paneA);
  assert.equal(await typing(paneA), true, "a picked workspace's terminal takes the keyboard");

  // the open pane picked again: its row, its tab, and the sidebar's empty space keep typing in the terminal
  await row(a.workspace.workspace_id).click();
  assert.equal(await typing(paneA), true, "the open workspace's row picked again leaves typing in the terminal");
  await run(page, "kb-row");
  await ran(paneA, "kb-row");
  await tab(a.root_pane.tab_id).click();
  assert.equal(await typing(paneA), true, "the open tab picked again leaves typing in the terminal");
  await run(page, "kb-tab");
  await ran(paneA, "kb-tab");
  const list = await page.locator(".machine-list").boundingBox();
  assert.ok(list, "the sidebar's list is shown");
  await page.mouse.click(list.x + list.width / 2, list.y + list.height - 8);
  assert.equal(await typing(paneA), true, "a click on the sidebar's empty space leaves typing in the terminal");
  await run(page, "kb-blank");
  await ran(paneA, "kb-blank");

  // typed before the picked pane's input opened: it reaches that pane once it is ready
  const paneB = b.root_pane.pane_id;
  gate.closed = true;
  await row(b.workspace.workspace_id).click();
  await current(paneB).waitFor();
  await until(() => typing(paneB), "the picked workspace's terminal takes the keyboard before its input opens");
  await run(page, "kb-early");
  assert.equal(await held.count(), 0, "typing into an opening pane is not held for review");
  assert.equal((await paneText(paneB)).includes("kb-early"), false, "nothing reaches the pane before its input is ready");
  gate.release();
  await ran(paneB, "kb-early");
  assert.equal(await held.count(), 0, "nothing is left held once the pane took the typing");

  // the same through a tab
  const paneB2 = b2.root_pane.pane_id;
  gate.closed = true;
  await tab(b2.root_pane.tab_id).click();
  await until(() => typing(paneB2), "the picked tab's terminal takes the keyboard before its input opens");
  await run(page, "kb-tab-early");
  gate.release();
  await ran(paneB2, "kb-tab-early");

  // put away before its input opened: held for review on return, never sent on its own
  gate.closed = true;
  await tab(b.root_pane.tab_id).click();
  await until(() => typing(paneB), "the other tab's terminal takes the keyboard");
  await page.keyboard.type("echo kb-away");
  await tab(b2.root_pane.tab_id).click();
  gate.release();
  await ready(paneB2);
  await tab(b.root_pane.tab_id).click();
  await ready(paneB);
  await held.filter({ hasText: "echo kb-away" }).waitFor({ timeout: 10_000 });
  assert.equal((await paneText(paneB)).includes("kb-away"), false, "typing into a pane put away is held, not sent");

  console.log("terminal-keyboard-regression: ok");
} finally {
  await browser.close();
  server.stop();
  await workspaceClose(a.workspace.workspace_id).catch(() => {});
  await workspaceClose(b.workspace.workspace_id).catch(() => {});
  rmSync(root, { recursive: true, force: true });
}

/**
 * The minimal chrome (docs/ROADMAP.md, Phase 1) in a real browser, on a herdr of its own: the bar
 * holds the sidebar toggle and the tabs as pills and nothing else; the sidebar lists workspaces
 * only, under its top row's PC switcher and +; Ctrl+F opens the palette from the terminal; no pane opens a chat, even one that asked to;
 * the pane is drawn by restty (WebGPU, or WebGL2 where the browser has no WebGPU). Focus mode is
 * on by default (Mod+Shift+. toggles it): tabs live under their workspace, where a row moves by drag and by Alt+↑/↓, and a
 * sidebar hidden with Mod+B hands them back to the bar. A row dropped on another workspace's name
 * goes there, its shell still running; a workspace's last tab leaves a new shell behind it.
 * The top row's + makes a workspace at once, a shell in the PC's home, with no dialog.
 * Each pane is a rounded card whose title bar carries Split right, Split down, Zoom and Close (a
 * split from there is drawn at the click, before herdr's layout); a card dragged by its title onto
 * another of its tab trades places with it in herdr. Mod+D from the
 * terminal splits its pane right.
 *
 *   bun run build && bun run check run bun scripts/minimal-ui-regression.ts
 */
import "./test-herdr.ts"; // a herdr session of its own: nothing shows in the user's
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { paneRead, tabCreate, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { chromePath } from "./chrome-path.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "restty-minimal-ui-")));
const cwd = join(root, "work");
mkdirSync(cwd);
const created = await workspaceCreate({ cwd, label: "minimal-ui" });
const workspaceId = created.workspace.workspace_id;
await tabCreate({ workspaceId, cwd });
const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state") });
const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox", "--accept-lang=en-US"] });
let madeId: string | null = null;

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript((paneId) => {
    if (localStorage.getItem("t-rex:settings") === null) {
      localStorage.setItem("t-rex:settings", JSON.stringify({ language: "en" }));
    }
    // a lens an older version remembered: the pane still opens in its terminal
    localStorage.setItem(`t-rex:view:${paneId}`, "chat");
  }, created.root_pane.pane_id);
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.port}/`);
  const tabs = page.locator(".app-header .header-tabs [role=tab]");
  const rows = page.locator(`.workspace-group[data-workspace="${workspaceId}"] .workspace-tab-select`);
  // in focus mode a workspace's row folds its tabs: its tab rows open the panes
  await rows.first().click();
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await rows.nth(1).waitFor({ timeout: 20_000 });
  assert.equal(await tabs.count(), 0, "focus mode is on by default: no pills in the bar");
  assert.equal(await rows.count(), 2, "both tabs start under their workspace");

  // Turning focus mode off is remembered when T-Rex opens again.
  await page.keyboard.press(`${mod}+Shift+Period`);
  await tabs.nth(1).waitFor({ timeout: 5_000 });
  await page.reload();
  await tabs.nth(1).waitFor({ timeout: 20_000 });
  assert.equal(await page.locator(".workspace-tab").count(), 0, "the saved opt-out survives a reload");

  // the bar: the toggle and the tabs, nothing else
  for (const gone of [".header-more-button", ".view-switch", ".palette-button", ".header-files-button", ".context-title"]) {
    assert.equal(await page.locator(gone).count(), 0, `${gone} is gone from the bar`);
  }
  assert.equal(await tabs.count(), 2, "both tabs are pills in the bar");
  assert.equal(await page.locator(".app-header .header-tabs .tab-strip-icon").count(), 2, "each tab says what runs in it");
  assert.equal(await page.locator(".pane-column > .pane-split .tab-strip").count(), 0, "no second strip over the pane");
  const open = page.locator(".app-header [role=tab][aria-selected=true]");
  assert.notEqual(await open.evaluate((tab) => getComputedStyle(tab).backgroundColor), "rgba(0, 0, 0, 0)", "the open tab is a filled pill");

  // the sidebar: workspaces, no Agents list, no folder or favicon face
  assert.equal(await page.getByText("No agents running").count(), 0, "no Agents section");
  assert.equal(await page.locator(".agents-sidebar, .workspace-folder, .workspace-favicon").count(), 0, "no agents list or workspace face");

  // its top row: the PC switcher, and the + for a new workspace at the row's far edge; no PC header over the list
  const side = page.locator(".app-header .header-side");
  const switcher = side.locator(".pc-switch");
  const plus = side.locator(".pc-new");
  await switcher.waitFor();
  assert.equal(await page.locator(".sidebar .pc-switch, .machine-header").count(), 0, "no PC header or second switcher in the list");
  const [sideBox, plusBox] = [await side.boundingBox(), await plus.boundingBox()];
  assert.ok(sideBox && plusBox && sideBox.x + sideBox.width - (plusBox.x + plusBox.width) <= 16, `the + ends the top row: ${JSON.stringify({ sideBox, plusBox })}`);
  await switcher.click();
  const pcs = page.getByRole("menu", { name: "PCs", exact: true });
  await pcs.waitFor();
  assert.equal(await pcs.locator('[aria-current="true"]').count(), 1, "the PC on screen is the menu's current item");
  await pcs.getByRole("menuitem", { name: "Add PC", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await pcs.waitFor({ state: "detached" });

  // never a chat, even for a pane that remembered one
  assert.equal(await page.locator(".chat-view, .composer").count(), 0, "the pane shows its terminal");
  await page.locator(".restty-terminal canvas").first().waitFor({ state: "attached" });
  await page.locator(".terminal-ime").first().waitFor({ state: "attached" });
  // restty is up and has drawn the pane's first screen
  await page.waitForFunction(() => performance.getEntriesByName("restty:ready").length > 0 && performance.getEntriesByName("terminal:first-screen").length > 0, null, { timeout: 20_000 });
  const backend = await page.evaluate(() => (performance.getEntriesByName("restty:ready")[0] as PerformanceMark).detail?.backend);
  assert.ok(backend === "webgpu" || backend === "webgl2", `restty draws with WebGPU or WebGL2 (${String(backend)})`);

  // Ctrl+F from inside the terminal opens the palette, and the terminal does not get the key
  await page.locator(".terminal-ime").first().focus();
  await page.keyboard.press("Control+f");
  await page.locator(".palette-scrim").waitFor({ timeout: 5_000 });
  await page.keyboard.press("Escape");
  await page.locator(".palette-scrim").waitFor({ state: "detached", timeout: 5_000 });
  // the lens switch's old chord does nothing
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+J" : "Control+Shift+J");
  assert.equal(await page.locator(".chat-view, .composer").count(), 0, "Mod+Shift+J opens no chat");

  // focus mode (Mod+Shift+.): the tabs are rows under their workspace and the bar over the pane goes
  await page.keyboard.press(`${mod}+Shift+Period`);
  await rows.nth(1).waitFor({ timeout: 5_000 });
  assert.equal(await tabs.count(), 0, "no pills in the bar in focus mode");
  assert.equal(await rows.count(), 2, "both tabs are rows under their workspace");
  assert.equal(await page.locator(".pane-column").evaluate((column) => Math.round(column.getBoundingClientRect().top)), 0, "the pane runs to the window's top");
  assert.equal(await page.locator(".app-header .sidebar-toggle").count(), 1, "the sidebar toggle stays, in the sidebar's top row");
  assert.equal(await page.locator(".app-header .header-side .pc-switch").count(), 1, "the PC switcher stays in that row too");
  await rows.nth(1).click();
  await page.locator(`.workspace-group[data-workspace="${workspaceId}"] .workspace-tab.is-selected .workspace-tab-select`).nth(0).waitFor();
  assert.equal(await rows.nth(1).getAttribute("aria-current"), "true", "a row opens its tab's pane");
  // a row dragged below the other rises and follows the pointer while the other steps up into its
  // place, and takes that place in herdr; the drag opens nothing, and Alt+↑ moves it back with the
  // focus kept on it
  const order = () => rows.evaluateAll((buttons) => buttons.map((button) => button.getAttribute("data-tab-id")));
  const ordered = (want: (string | null)[]) => page.waitForFunction(({ selector, want }) => JSON.stringify([...document.querySelectorAll(selector)].map((button) => button.getAttribute("data-tab-id"))) === want,
    { selector: `.workspace-group[data-workspace="${workspaceId}"] .workspace-tab-select`, want: JSON.stringify(want) }, { timeout: 5_000 });
  const before = await order();
  const [upper, lower] = [await rows.nth(0).boundingBox(), await rows.nth(1).boundingBox()];
  assert.ok(upper && lower);
  await page.mouse.move(upper.x + upper.width / 2, upper.y + upper.height / 2);
  await page.mouse.down();
  await page.mouse.move(upper.x + upper.width / 2, lower.y + lower.height * 0.8, { steps: 6 });
  await page.locator(`.workspace-group[data-workspace="${workspaceId}"] .workspace-tab.is-lifted`).waitFor({ timeout: 5_000 });
  const stepped = `.workspace-group[data-workspace="${workspaceId}"] .workspace-tab:not(.is-lifted)`;
  await page.waitForFunction(({ selector, half }) => {
    const row = document.querySelector(selector);
    return row !== null && new DOMMatrix(getComputedStyle(row).transform).m42 < -half;
  }, { selector: stepped, half: lower.height / 2 }, { timeout: 5_000 }).catch(() => assert.fail("the other row steps up into the held one's place"));
  await page.mouse.up();
  await ordered([before[1]!, before[0]!]);
  await page.locator(".workspace-tab.is-lifted, .workspace-tab.is-carried").first().waitFor({ state: "detached", timeout: 5_000 });
  assert.equal(await page.locator(`.workspace-tab-select[aria-current="true"]`).getAttribute("data-tab-id"), before[1], "the drag opened nothing");
  await rows.nth(1).focus();
  await page.keyboard.press("Alt+ArrowUp");
  await ordered(before);
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-tab-id")), before[0], "the moved row keeps the focus");
  // a click on the workspace's row folds its tab rows under it: they slide away, the row says how
  // many it holds, and the terminal keeps the keyboard; by key the fold is at once
  const workspaceRow = page.locator(`.workspace-group[data-workspace="${workspaceId}"] > .workspace-header > .workspace-select`);
  const tabList = page.locator(`.workspace-group[data-workspace="${workspaceId}"] > .workspace-tabs`);
  const typing = () => page.evaluate(() => document.activeElement?.classList.contains("terminal-ime") === true);
  await page.locator(".pane-frame[data-layout-pane]:not(.is-hidden) .terminal-ime").first().focus();
  await workspaceRow.click();
  assert.equal(await page.evaluate(() => document.getAnimations().some((animation) => (animation.effect as KeyframeEffect | null)?.target instanceof Element && ((animation.effect as KeyframeEffect).target as Element).matches(".workspace-tab"))), true, "a click's fold slides");
  await tabList.waitFor({ state: "hidden", timeout: 5_000 });
  assert.equal(await workspaceRow.getAttribute("aria-expanded"), "false", "the row says it is folded");
  assert.equal(await workspaceRow.locator(".workspace-fold-count").textContent(), "+2", "the folded row says how many tabs it holds");
  assert.equal(await typing(), true, "a click on the row leaves typing in the terminal");
  await workspaceRow.focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await tabList.isVisible(), true, "→ unfolds at once");
  assert.equal(await page.evaluate(() => document.getAnimations().filter((animation) => (animation.effect as KeyframeEffect | null)?.target instanceof Element && ((animation.effect as KeyframeEffect).target as Element).matches(".workspace-tab")).length), 0, "a fold by key does not move");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await tabList.isHidden(), true, "← folds at once");
  await page.keyboard.press("Enter");
  await rows.nth(1).waitFor({ timeout: 5_000 });
  // a hidden sidebar hands the tabs back to the bar, and showing it takes them again
  await page.keyboard.press(`${mod}+b`);
  await tabs.nth(1).waitFor({ timeout: 5_000 });
  assert.equal(await page.locator(".app-header [role=tab][aria-selected=true] .tab-strip-label").textContent(), await rows.nth(1).locator(".workspace-tab-name").textContent(), "the bar opens on the same tab");
  await page.keyboard.press(`${mod}+b`);
  await tabs.first().waitFor({ state: "detached", timeout: 5_000 });
  // and the same chord leaves focus mode
  await page.keyboard.press(`${mod}+Shift+Period`);
  await tabs.nth(1).waitFor({ timeout: 5_000 });
  assert.equal(await page.locator(".workspace-tab").count(), 0, "no tab rows outside focus mode");

  // the pane is a card, its title bar says what runs in it and carries the pane's actions
  const card = page.locator(".pane-frame[data-layout-pane]:not(.is-hidden)").first();
  assert.notEqual(await card.evaluate((frame) => getComputedStyle(frame).borderTopLeftRadius), "0px", "the pane is a rounded card");
  const actions = card.locator(".pane-frame-actions button");
  assert.deepEqual(await actions.evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label"))),
    ["Split right", "Split down", "Zoom pane", "Close pane"], "the title bar carries the pane's actions");
  assert.equal(await actions.nth(2).isDisabled(), true, "a lone pane has nothing to zoom");
  // Split right from the title bar, its halves drawn at the click; then the left card, dragged by its
  // title onto the right one, trades places with it in herdr
  const drawn = await card.getByRole("button", { name: "Split right" }).evaluate(async (button) => {
    const frame = button.closest<HTMLElement>(".pane-frame")!;
    const whole = frame.getBoundingClientRect().width;
    (button as HTMLElement).click();
    // React draws a click's update in a microtask: no answer from the bridge can come before it
    for (let i = 0; i < 3; i++) await Promise.resolve();
    return { whole, kept: frame.getBoundingClientRect().width, asked: document.querySelector(".pane-frame.is-asked") !== null };
  });
  assert.ok(drawn.asked && drawn.kept < drawn.whole * 0.6, `the halves are drawn at the click: ${JSON.stringify(drawn)}`);
  const cards = page.locator(".pane-frame[data-layout-pane]:not(.is-hidden)");
  await cards.nth(1).waitFor({ timeout: 10_000 });
  const [left, right] = await cards.evaluateAll((frames) => frames.map((frame) => (frame as HTMLElement).dataset["layoutPane"]!));
  const columns = async (): Promise<Map<string, number>> => {
    const session = await page.evaluate(async () => (await (await fetch("/api/session")).json()).snapshot) as { layouts: { panes: { pane_id: string; rect: { x: number } }[] }[] };
    return new Map(session.layouts.flatMap((layout) => layout.panes.map((pane) => [pane.pane_id, pane.rect.x] as const)));
  };
  const split = await columns();
  assert.ok(split.get(left!)! < split.get(right!)!, "the new pane is on the right");
  // the new pane's card is drawn when herdr answers the split, before its layout lists the pane:
  // cards trade places by their titles once that layout has come
  await page.locator(".pane-canvas.is-sortable").waitFor({ timeout: 10_000 });
  const title = (await cards.nth(0).locator(".pane-frame-head").boundingBox())!;
  const drop = (await cards.nth(1).boundingBox())!;
  await page.mouse.move(title.x + 40, title.y + title.height / 2);
  await page.mouse.down();
  await page.mouse.move(drop.x + drop.width / 2, drop.y + drop.height / 2, { steps: 8 });
  await page.mouse.up();
  let swapped = await columns();
  for (const deadline = Date.now() + 5_000; Date.now() < deadline && swapped.get(left!) === split.get(left!);) {
    await page.waitForTimeout(100);
    swapped = await columns();
  }
  assert.equal(swapped.get(left!), split.get(right!), "the dragged pane took the other's place");
  assert.equal(swapped.get(right!), split.get(left!), "and the other took its place");
  // Mod+D from inside the terminal splits the pane right: off a Mac Ctrl+D is the app's, not the shell's EOF
  await cards.nth(0).locator(".terminal-ime").focus();
  await page.keyboard.press(`${mod}+d`);
  await cards.nth(2).waitFor({ timeout: 10_000 });

  // the top row's + makes a workspace at once and opens it: a shell in home, no dialog asking for an agent or a folder
  const known = await page.locator(".workspace-group[data-workspace]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-workspace")));
  await plus.click();
  const made = page.locator(".workspace-group.is-selected[data-workspace]");
  await page.waitForFunction((ids) => {
    const id = document.querySelector(".workspace-group.is-selected[data-workspace]")?.getAttribute("data-workspace");
    return id != null && !ids.includes(id);
  }, known, { timeout: 20_000 });
  madeId = await made.getAttribute("data-workspace");
  assert.equal(await page.locator("[role=dialog]").count(), 0, "no dialog opens");
  const snapshot = await page.evaluate(async () => (await (await fetch("/api/session")).json()).snapshot) as { panes: { workspace_id: string; terminal_id?: string; cwd?: string | null; agent?: string | null }[] };
  const madePanes = snapshot.panes.filter((pane) => pane.workspace_id === madeId);
  assert.equal(madePanes.length, 1, "one pane in the new workspace");
  assert.equal(madePanes[0]!.cwd, homedir(), "its shell starts in home");
  assert.equal(madePanes[0]!.agent ?? null, null, "no agent starts in it");
  const madeTerminal = madePanes[0]!.terminal_id;

  // in focus mode, the new workspace's one tab dragged over the first workspace's first row goes
  // there, first among its tabs, its place saying the new shell that keeps the new workspace; the
  // tab stays open, the shell in it is the same one, still taking input, and the new workspace has
  // a shell of its own
  await page.keyboard.press(`${mod}+Shift+Period`);
  const lone = page.locator(`.workspace-group[data-workspace="${madeId}"] .workspace-tab-select`);
  await lone.waitFor({ timeout: 5_000 });
  const lonelyTab = await lone.getAttribute("data-tab-id");
  const into = page.locator(`.workspace-group[data-workspace="${workspaceId}"]`);
  const [held, firstRow] = [await lone.boundingBox(), await into.locator(".workspace-tab-select").first().boundingBox()];
  assert.ok(held && firstRow);
  await page.mouse.move(held.x + held.width / 2, held.y + held.height / 2);
  await page.mouse.down();
  await page.mouse.move(firstRow.x + firstRow.width / 2, firstRow.y + firstRow.height / 4, { steps: 8 });
  await page.locator(`.workspace-group[data-workspace="${madeId}"] .workspace-tabs[data-vacated]`).waitFor({ timeout: 5_000 });
  await page.mouse.up();
  await page.waitForFunction(({ selector, gone }) => {
    const ids = [...document.querySelectorAll(selector)].map((button) => button.getAttribute("data-tab-id"));
    return ids.length === 1 && !ids.includes(gone);
  }, { selector: `.workspace-group[data-workspace="${madeId}"] .workspace-tab-select[data-tab-id]`, gone: lonelyTab }, { timeout: 10_000 });
  const first = into.locator(".workspace-tab-select").first();
  await page.waitForFunction((selector) => document.querySelector(selector)?.getAttribute("aria-current") === "true",
    `.workspace-group[data-workspace="${workspaceId}"] .workspace-tab:first-child .workspace-tab-select`, { timeout: 10_000 });
  const openTab = await first.getAttribute("data-tab-id");
  const session = await page.evaluate(async () => (await (await fetch("/api/session")).json()).snapshot) as { panes: { pane_id: string; tab_id: string; terminal_id?: string }[] };
  const moved = session.panes.find((pane) => pane.tab_id === openTab);
  assert.ok(moved, "the moved tab has its pane");
  assert.equal(moved.terminal_id, madeTerminal, "the same shell, under the pane's new id");
  const keptTab = await lone.getAttribute("data-tab-id");
  const kept = session.panes.find((pane) => pane.tab_id === keptTab);
  assert.ok(kept && kept.terminal_id !== madeTerminal, "the new workspace keeps a shell of its own");
  await page.locator(".pane-frame[data-layout-pane]:not(.is-hidden) .terminal-ime").first().focus();
  await page.keyboard.type("echo t-rex-moved-$((6*7))\n");
  for (let deadline = Date.now() + 10_000; ; await page.waitForTimeout(200)) {
    const text = (await paneRead({ paneId: moved.pane_id })).text;
    if (text.includes("t-rex-moved-42")) break;
    assert.ok(Date.now() < deadline, `the moved shell answers: ${text.slice(-200)}`);
  }

  console.log("minimal-ui-regression: ok");
} finally {
  await browser.close();
  server.stop();
  await workspaceClose(workspaceId).catch(() => {});
  if (madeId !== null) await workspaceClose(madeId).catch(() => {});
  rmSync(root, { recursive: true, force: true });
}

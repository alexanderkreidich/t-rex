// Sandbox-only measurement: time to the first pane screen on a cold and a warm load, and from the
// New terminal button to the new tab's first screen. Works on this branch (restty marks) and on
// main (xterm rows), so the PR can compare them. URL selects the bridge; RUNS the repetitions.
import { chromium, type Page } from "playwright-core";
import { chromePath } from "./chrome-path.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = process.env["URL"] ?? "http://127.0.0.1:7417/";
const runs = Number(process.env["RUNS"] ?? 5);

/** ms from navigation start to a visible screen in the selected pane, or from `since` to one in a new pane */
async function screenAt(page: Page, since: number): Promise<number> {
  return page.evaluate(async ({ since }) => {
    const deadline = performance.now() + 20_000;
    for (;;) {
      const marks = performance.getEntriesByName("terminal:first-screen");
      const ready = performance.getEntriesByName("restty:ready");
      if (marks.length + ready.length > 0 || document.querySelector(".restty-terminal")) {
        // restty: the newest pane's screen is drawn once its terminal is up too
        const screens = marks.filter((mark) => mark.startTime >= since);
        const ups = ready.filter((mark) => mark.startTime >= since);
        if (screens.length > 0) {
          const screen = screens[screens.length - 1]!.startTime;
          const ready = (screens[screens.length - 1] as PerformanceMark).detail?.ready ? screen : ups.at(-1)?.startTime;
          if (ready !== undefined) return Math.max(screen, ready) - since;
        }
      } else {
        const frame = document.querySelector(".pane-frame.is-current");
        const rows = frame?.querySelector(".xterm-rows");
        const fresh = since === 0 || frame !== (window as { perfOldFrame?: Element | null }).perfOldFrame;
        if (fresh && rows && (rows.textContent ?? "").trim().length > 0) return performance.now() - since;
      }
      if (performance.now() > deadline) throw new Error("Timed out waiting for a terminal screen");
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }, { since });
}

const cold: number[] = [];
const warm: number[] = [];
const newTab: number[] = [];
for (let run = 0; run < runs; run++) {
  const profile = mkdtempSync(join(tmpdir(), "perf-profile-"));
  const context = await chromium.launchPersistentContext(profile, { executablePath: chromePath(), headless: true, args: ["--enable-unsafe-webgpu", "--lang=en-US"], viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(url);
    cold.push(await screenAt(page, 0));
    await page.reload();
    warm.push(await screenAt(page, 0));
    await page.waitForTimeout(500);
    const createdResponse = page.waitForResponse((response) => response.url().endsWith("/tab/create") && response.request().method() === "POST");
    const since = await page.evaluate(() => {
      (window as { perfOldFrame?: Element | null }).perfOldFrame = document.querySelector(".pane-frame.is-current");
      (document.querySelector(".tab-strip-add") as HTMLElement).click();
      return performance.now();
    });
    newTab.push(await screenAt(page, since));
    const created = await (await createdResponse).json() as { pane_id: string };
    const { snapshot } = await (await page.request.get(new URL("/api/session", url).href)).json();
    const tabId = snapshot.panes.find((pane: { pane_id: string }) => pane.pane_id === created.pane_id)?.tab_id;
    if (!tabId) throw new Error("New tab is absent from the authoritative roster");
    const closed = await page.request.post(new URL("/api/tab/close", url).href, { data: { tab_id: tabId } });
    if (!closed.ok()) throw new Error("Could not close the benchmark tab");
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
}
const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const show = (name: string, values: number[]) => console.log(`${name}: median ${median(values).toFixed(0)} ms  [${values.map((v) => v.toFixed(0)).join(", ")}]`);
show("cold load → first screen", cold);
show("warm load → first screen", warm);
show("New terminal → first screen", newTab);

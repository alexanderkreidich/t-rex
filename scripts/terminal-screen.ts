/**
 * What a pane's terminal shows, for browser regressions. restty draws on a canvas, so there are
 * no rows in the DOM to read: PaneTerminal gives the terminal's box a `screen()` that returns the
 * screen the SSP view hands restty (the bridge's newest one, with local echo on top), which restty
 * paints on the next frame. `scope` picks the pane: the selected one by default.
 */
import type { Frame, Page } from "playwright-core";

export interface ShownScreen {
  text: string;
  cursor: { row: number; col: number };
  /** cells drawn underlined: a program's, and local echo's unconfirmed guesses */
  underlined: number;
  /** the grid, its cell in CSS pixels (the grid starts at the box's top-left corner) and the font size drawn */
  cols: number;
  rows: number;
  cell: { width: number; height: number };
  fontSize: number;
  /** the selection's text as it would be copied, null without one (the highlight is on the canvas) */
  selection: string | null;
}

const CURRENT = ".pane-frame.is-current .restty-terminal";

/** The screen of the terminal under `scope`, or null while none is mounted. */
export function screen(page: Page | Frame, scope = CURRENT): Promise<ShownScreen | null> {
  return page.evaluate((selector) => (document.querySelector(selector) as (HTMLElement & { screen?: () => ShownScreen }) | null)?.screen?.() ?? null, scope);
}

/** The screen's text, one line per row ("" while no terminal is mounted). */
export async function screenText(page: Page | Frame, scope = CURRENT): Promise<string> {
  return (await screen(page, scope))?.text ?? "";
}

/** Waits until the screen shows `text` (a string to contain, or a pattern to match). */
export async function waitForScreenText(page: Page | Frame, text: string | RegExp, options: { scope?: string; timeout?: number } = {}): Promise<void> {
  const pattern = typeof text === "string" ? { source: text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags: "" } : { source: text.source, flags: text.flags };
  await page.waitForFunction(({ selector, source, flags }) => {
    const shown = (document.querySelector(selector) as (HTMLElement & { screen?: () => { text: string } }) | null)?.screen?.();
    return shown !== undefined && new RegExp(source, flags).test(shown.text);
  }, { selector: options.scope ?? CURRENT, ...pattern }, { timeout: options.timeout ?? 10_000 });
}

/**
 * Where the first row that shows `text` (contains it, or matches it) is drawn on the page, as a
 * row element's box was: the grid starts at the terminal box's top-left corner. Null while no
 * row shows it.
 */
export function rowBox(page: Page | Frame, text: string | RegExp, scope = CURRENT): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const pattern = typeof text === "string" ? { source: text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags: "" } : { source: text.source, flags: text.flags };
  return page.evaluate(({ selector, source, flags }) => {
    const box = document.querySelector(selector) as (HTMLElement & { screen?: () => ShownScreen }) | null;
    const shown = box?.screen?.();
    if (!box || !shown) return null;
    const row = shown.text.split("\n").findIndex((line) => new RegExp(source, flags).test(line));
    if (row < 0) return null;
    const rect = box.getBoundingClientRect();
    return { x: rect.left, y: rect.top + row * shown.cell.height, width: shown.cols * shown.cell.width, height: shown.cell.height };
  }, { selector: scope, ...pattern });
}

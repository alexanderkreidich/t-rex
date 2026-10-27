import type { PaneLayoutSnapshot } from "../../shared/protocol.ts";
type PaneLayoutSplit = PaneLayoutSnapshot["splits"][number];

/** Where a split has no room: a tab's panes are shown one at a time (PaneCanvas) and picked from the tab's menu (TabStrip). */
export const SOLO_PANE_QUERY = "(max-width: 768px)";

/**
 * The pane a tab shows alone, or null when every pane is drawn: herdr's zoomed pane, else on a
 * narrow screen the selected pane (herdr's focused one, then the first, while the selection is
 * not in this tab). A narrow screen changes only what this browser draws, never herdr's zoom.
 */
export function soloPane(layout: PaneLayoutSnapshot | null, paneIds: readonly string[], selectedPaneId: string | null, narrow: boolean): string | null {
  if (layout?.zoomed) return layout.focused_pane_id;
  if (!narrow || paneIds.length < 2) return null;
  if (selectedPaneId !== null && paneIds.includes(selectedPaneId)) return selectedPaneId;
  return layout !== null && paneIds.includes(layout.focused_pane_id) ? layout.focused_pane_id : paneIds[0]!;
}

/** macOS Control-click opens a context menu even though its pointer button is the left one. */
export function paneContextPress(event: { button: number; ctrlKey: boolean }, apple: boolean): boolean {
  return event.button === 2 || (apple && event.button === 0 && event.ctrlKey);
}

/**
 * A right-click in a pane's own text field (the composer, the terminal's input line, the find or
 * secret field) is the browser's: its Copy, Paste and spelling menu on that field (#1180). The
 * terminal's hidden field (restty's) is the terminal's, so a right-click on the terminal stays the pane menu.
 */
export function paneFieldTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const field = target.closest("input, textarea, [contenteditable=true]");
  return field !== null && !field.classList.contains("terminal-ime");
}

/** herdr's stable split path, not its preorder number (which changes after another split). */
export function splitPath(id: string): boolean[] | null {
  const match = /^split_\d+_(root|[01]+)$/.exec(id);
  if (!match) return null;
  return match[1] === "root" ? [] : [...match[1]!].map((side) => side === "1");
}

/** Changes in ratios/terminal size are harmless; changes in topology cancel a drag. */
export function layoutTopology(layout: PaneLayoutSnapshot): string {
  return JSON.stringify([layout.tab_id, layout.zoomed, layout.panes.map((pane) => pane.pane_id),
    layout.splits.map((split) => [split.id, split.direction])]);
}

export function splitRatioAt(split: PaneLayoutSplit, layout: PaneLayoutSnapshot,
  canvas: { left: number; top: number; width: number; height: number }, x: number, y: number): number {
  const horizontal = split.direction === "right";
  const point = horizontal ? layout.area.x + (x - canvas.left) / canvas.width * layout.area.width
    : layout.area.y + (y - canvas.top) / canvas.height * layout.area.height;
  const start = horizontal ? split.rect.x : split.rect.y;
  const extent = horizontal ? split.rect.width : split.rect.height;
  return Math.max(0.1, Math.min(0.9, (point - start) / Math.max(1, extent)));
}

/** A pane's place in percent of its tab's area (lib/layoutMap.ts `layoutCells`). */
export interface PaneBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where a pane's card is drawn: its cell, less half of `--pane-gap` on each side it shares with
 * another card, so the cards stand apart by the gap and the canvas's edges stay flush.
 */
export function cardPlace(cell: PaneBox): { left: string; top: string; width: string; height: string } {
  const start = (at: number): number => at > 0.01 ? 0.5 : 0;
  const end = (at: number, size: number): number => at + size < 99.99 ? 0.5 : 0;
  const left = start(cell.left);
  const right = end(cell.left, cell.width);
  const top = start(cell.top);
  const bottom = end(cell.top, cell.height);
  const place = (percent: number, gaps: number, sign: "+" | "-"): string =>
    gaps === 0 ? `${percent}%` : `calc(${percent}% ${sign} ${gaps} * var(--pane-gap, 0px))`;
  return {
    left: place(cell.left, left, "+"),
    top: place(cell.top, top, "+"),
    width: place(cell.width, left + right, "-"),
    height: place(cell.height, top + bottom, "-"),
  };
}

/** Two panes of a tab dragged into each other's place, and the cells herdr's layout had them in. */
export interface PaneSwap {
  tabId: string;
  a: string;
  b: string;
  cellA: PaneBox;
  cellB: PaneBox;
}

const sameBox = (one: PaneBox, other: PaneBox): boolean =>
  Math.abs(one.left - other.left) < 0.01 && Math.abs(one.top - other.top) < 0.01
  && Math.abs(one.width - other.width) < 0.01 && Math.abs(one.height - other.height) < 0.01;

/**
 * Whether herdr's layout still has the swapped pair where the swap found them: until it says
 * otherwise (it swapped them, or the layout moved on) the canvas draws the pair traded.
 */
export function swapPending(cells: readonly (PaneBox & { paneId: string })[], swap: PaneSwap | null, tabId: string | undefined): swap is PaneSwap {
  if (!swap || swap.tabId !== tabId) return false;
  const a = cells.find((cell) => cell.paneId === swap.a);
  const b = cells.find((cell) => cell.paneId === swap.b);
  return !!a && !!b && sameBox(a, swap.cellA) && sameBox(b, swap.cellB);
}

/** The cells with a pending swap's pair traded: what the canvas draws before herdr's answer arrives. */
export function swappedCells<T extends PaneBox & { paneId: string }>(cells: readonly T[], swap: PaneSwap | null, tabId: string | undefined): T[] {
  if (!swapPending(cells, swap, tabId)) return [...cells];
  const box = ({ left, top, width, height }: PaneBox): PaneBox => ({ left, top, width, height });
  return cells.map((cell) => cell.paneId === swap.a ? { ...cell, ...box(swap.cellB) }
    : cell.paneId === swap.b ? { ...cell, ...box(swap.cellA) } : cell);
}

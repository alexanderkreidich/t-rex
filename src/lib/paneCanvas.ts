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

/** A split asked for from a card, drawn before herdr's layout has it: the pane in the half it keeps, the new pane's place beside it. */
export interface PaneSplitAsk {
  tabId: string;
  paneId: string;
  direction: "right" | "down";
  /** the pane's cell when the split was asked for: herdr's layout keeps it there until the split lands */
  cell: PaneBox;
  kept: PaneBox;
  made: PaneBox;
}

/**
 * The halves herdr's pane.split makes of a pane, in its own cells and rounding (15 columns keep 8
 * and make 7): the pane keeps the first, the new pane takes the second. Null for a pane not in the
 * layout, or one too small to halve.
 */
export function splitAsk(layout: PaneLayoutSnapshot, paneId: string, direction: "right" | "down"): PaneSplitAsk | null {
  const pane = layout.panes.find((item) => item.pane_id === paneId);
  if (!pane) return null;
  const { area } = layout;
  const box = (x: number, y: number, width: number, height: number): PaneBox => ({
    left: ((x - area.x) / Math.max(1, area.width)) * 100,
    top: ((y - area.y) / Math.max(1, area.height)) * 100,
    width: (width / Math.max(1, area.width)) * 100,
    height: (height / Math.max(1, area.height)) * 100,
  });
  const { x, y, width, height } = pane.rect;
  const across = direction === "right";
  const kept = Math.round((across ? width : height) / 2);
  if (kept < 1 || (across ? width : height) - kept < 1) return null;
  return {
    tabId: layout.tab_id, paneId, direction,
    cell: box(x, y, width, height),
    kept: across ? box(x, y, kept, height) : box(x, y, width, kept),
    made: across ? box(x + kept, y, width - kept, height) : box(x, y + kept, width, height - kept),
  };
}

/** Whether herdr's layout still has the split pane where the split found it: until then the canvas draws the halves. */
export function splitPending(cells: readonly (PaneBox & { paneId: string })[], ask: PaneSplitAsk | null, tabId: string | undefined): ask is PaneSplitAsk {
  if (!ask || ask.tabId !== tabId) return false;
  const cell = cells.find((item) => item.paneId === ask.paneId);
  return !!cell && sameBox(cell, ask.cell);
}

/** The cells with a pending split's pane in the half it keeps; the new pane's place is the ask's `made`. */
export function splitCells<T extends PaneBox & { paneId: string }>(cells: readonly T[], ask: PaneSplitAsk | null, tabId: string | undefined): T[] {
  if (!splitPending(cells, ask, tabId)) return [...cells];
  return cells.map((cell) => cell.paneId === ask.paneId ? { ...cell, ...ask.kept } : cell);
}

/** A pane closed from its card, drawn gone before herdr's layout says so: the places its neighbours take. */
export interface PaneCloseAsk {
  tabId: string;
  paneId: string;
  /** the pane's cell when it was closed: herdr's layout keeps it there until the close lands */
  cell: PaneBox;
  /** the other panes' places once it is gone: the half it leaves goes to the other half of its split */
  cells: ReadonlyMap<string, PaneBox>;
  /** the pane that takes its place, the first of that other half */
  heir: string;
}

type Rect = PaneLayoutSnapshot["panes"][number]["rect"];
const within = (outer: Rect, inner: Rect): boolean => inner.x >= outer.x && inner.y >= outer.y
  && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

/**
 * The layout herdr makes of a tab when a pane closes: the split it was a half of gives its whole
 * rect to the other half, whose panes stretch across it along the split. Null for a pane that is
 * alone in its tab (the tab closes with it) or not one whole half of a split.
 */
export function closeAsk(layout: PaneLayoutSnapshot, paneId: string): PaneCloseAsk | null {
  const pane = layout.panes.find((item) => item.pane_id === paneId);
  if (!pane) return null;
  const { rect } = pane;
  // its split is the smallest one around it
  const split = layout.splits.filter((item) => within(item.rect, rect))
    .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height)[0];
  if (!split) return null;
  const across = split.direction === "right";
  const whole = split.rect;
  const first = across ? rect.x === whole.x : rect.y === whole.y;
  const fills = across ? rect.y === whole.y && rect.height === whole.height && (first || rect.x + rect.width === whole.x + whole.width)
    : rect.x === whole.x && rect.width === whole.width && (first || rect.y + rect.height === whole.y + whole.height);
  if (!fills) return null;
  const other: Rect = across
    ? { x: first ? whole.x + rect.width : whole.x, y: whole.y, width: whole.width - rect.width, height: whole.height }
    : { x: whole.x, y: first ? whole.y + rect.height : whole.y, width: whole.width, height: whole.height - rect.height };
  const stretch = (r: Rect): Rect => across
    ? { ...r, x: whole.x + (r.x - other.x) * whole.width / other.width, width: r.width * whole.width / other.width }
    : { ...r, y: whole.y + (r.y - other.y) * whole.height / other.height, height: r.height * whole.height / other.height };
  const { area } = layout;
  const box = (r: Rect): PaneBox => ({
    left: ((r.x - area.x) / Math.max(1, area.width)) * 100,
    top: ((r.y - area.y) / Math.max(1, area.height)) * 100,
    width: (r.width / Math.max(1, area.width)) * 100,
    height: (r.height / Math.max(1, area.height)) * 100,
  });
  const rest = layout.panes.filter((item) => item.pane_id !== paneId);
  const heirs = rest.filter((item) => within(other, item.rect)).sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  if (heirs.length === 0) return null;
  return {
    tabId: layout.tab_id, paneId, cell: box(rect), heir: heirs[0]!.pane_id,
    cells: new Map(rest.map((item) => [item.pane_id, box(within(other, item.rect) ? stretch(item.rect) : item.rect)])),
  };
}

/** Whether herdr's layout still has the closed pane where the close found it: until then the canvas draws it gone. */
export function closePending(cells: readonly (PaneBox & { paneId: string })[], ask: PaneCloseAsk | null, tabId: string | undefined): ask is PaneCloseAsk {
  if (!ask || ask.tabId !== tabId) return false;
  const cell = cells.find((item) => item.paneId === ask.paneId);
  return !!cell && sameBox(cell, ask.cell);
}

/** The cells with a pending close's pane gone and its neighbours in the places they take. */
export function closedCells<T extends PaneBox & { paneId: string }>(cells: readonly T[], ask: PaneCloseAsk | null, tabId: string | undefined): T[] {
  if (!closePending(cells, ask, tabId)) return [...cells];
  return cells.filter((cell) => cell.paneId !== ask.paneId).map((cell) => {
    const place = ask.cells.get(cell.paneId);
    return place ? { ...cell, ...place } : cell;
  });
}

/** herdr's tab.move counts insertion boundaries before removing the source tab. */
export function movedTabOrder(ids: readonly string[], tabId: string, insertIndex: number): string[] | null {
  const source = ids.indexOf(tabId);
  if (source < 0 || !Number.isInteger(insertIndex) || insertIndex < 0 || insertIndex > ids.length) return null;
  const target = insertIndex > source ? insertIndex - 1 : insertIndex;
  if (target === source) return null;
  const order = [...ids];
  order.splice(source, 1);
  order.splice(target, 0, tabId);
  return order;
}

/** One adjacent move, expressed in native insertion-boundary coordinates. */
export function adjacentTabBoundary(ids: readonly string[], tabId: string, direction: -1 | 1): number | null {
  const source = ids.indexOf(tabId);
  if (source < 0 || source + direction < 0 || source + direction >= ids.length) return null;
  return direction < 0 ? source - 1 : source + 2;
}

/** DOM hit rectangles stay in snapshot order, including the source tab. */
export function tabDropBoundary(rects: readonly { left: number; right: number }[], x: number): number {
  const before = rects.findIndex((rect) => x < (rect.left + rect.right) / 2);
  return before < 0 ? rects.length : before;
}

/** A place a lifted tab row can be dropped on (lib/useTabRowDrag.ts). */
export interface RowSlot {
  workspaceId: string;
  /** herdr's insertion boundary there, counted before the tab leaves its place (tab.move) */
  boundary: number;
  /** the tab's index among that workspace's tabs once it is there */
  final: number;
  /** where the row's top would be, in the column's coordinates */
  y: number;
  /** the row's own place: dropping it there moves nothing */
  home: boolean;
}

/** a workspace's tab rows as drawn: where they start, and each row with its place in herdr's order */
export interface RowColumn { workspaceId: string; top: number; rows: readonly { tabId: string; index: number; top: number; bottom: number }[] }

export interface RowLift { top: number; bottom: number; removed: boolean; slots: RowSlot[] }

/**
 * A row lifted out of the column of every workspace's tab rows, as a phone's list lifts one: the
 * rows below it close up, except under a workspace's last tab (`alone`), whose place stays for the
 * shell that keeps the workspace. Its slots are the top of each workspace's rows and the bottom of
 * each row, where they would stand with it gone. A row not drawn keeps its place in herdr's order.
 */
export function liftRow(columns: readonly RowColumn[], tabId: string, alone: boolean): RowLift | null {
  const column = columns.find((candidate) => candidate.rows.some((row) => row.tabId === tabId));
  const row = column?.rows.find((candidate) => candidate.tabId === tabId);
  if (!column || !row) return null;
  const height = row.bottom - row.top;
  const removed = !alone;
  const closed = (y: number): number => (removed && y >= row.bottom - 0.5 ? y - height : y);
  const slots: RowSlot[] = [];
  for (const { workspaceId, top, rows } of columns) {
    const own = workspaceId === column.workspaceId;
    const add = (boundary: number, y: number): void => {
      slots.push({ workspaceId, boundary, final: own && boundary > row.index ? boundary - 1 : boundary, y: closed(y), home: own && (boundary === row.index || boundary === row.index + 1) });
    };
    add(0, top);
    for (const candidate of rows) if (!(removed && candidate === row)) add(candidate.index + 1, candidate.bottom);
  }
  return { top: row.top, bottom: row.bottom, removed, slots };
}

/** The slot nearest to where the lifted row's top is now. */
export function nearestSlot(slots: readonly RowSlot[], y: number): RowSlot | null {
  let best: RowSlot | null = null;
  for (const slot of slots) if (!best || Math.abs(slot.y - y) < Math.abs(best.y - y)) best = slot;
  return best;
}

/** How far whatever stands in the column at `top` moves while the lifted row is over `target`: the slot opens. */
export function liftShift(top: number, lift: RowLift, target: RowSlot | null): number {
  const height = lift.bottom - lift.top;
  const below = lift.removed && top >= lift.bottom - 0.5;
  // a kept place is open already: going back to it opens nothing
  const opens = target !== null && !(target.home && !lift.removed) && (below ? top - height : top) >= target.y - 0.5;
  return (below ? -height : 0) + (opens ? height : 0);
}

/**
 * A tab moved into another workspace of the same herdr. herdr's tab.move stays within a workspace,
 * so the tab is carried over pane by pane with pane.move: its first pane opens a new tab there and
 * every other pane goes beside one already moved, splitting it as the tab was split. Each pane
 * keeps its terminal, so the shells and agents in it carry on. herdr closes the old tab once its
 * last pane has left. herdr would close the old workspace with its last tab: a new shell tab opens
 * there first (in the folder the workspace's + would use), and the workspace stays.
 *
 * herdr refuses to move a pane out of a zoomed tab: the zoom is taken off first and put back on
 * the same pane in the new tab. A move that fails halfway leaves the panes moved so far in the new
 * tab: herdr has no transaction to undo them with.
 */
import type { HerdrTab, PaneLayoutSnapshot, TabTransferred } from "../shared/protocol.ts";
import { HerdrError, paneMove, paneZoom, sessionSnapshot, tabCreate, tabMove } from "./herdr/client.ts";

type Direction = "right" | "down";
/** A tab's split tree: a pane, or a split whose first side gets `ratio` of it. */
export type PaneTree = { pane: string } | { direction: Direction; ratio: number; first: PaneTree; second: PaneTree };

const start = (rect: { x: number; y: number }, direction: Direction): number => (direction === "right" ? rect.x : rect.y);
const end = (rect: { x: number; y: number; width: number; height: number }, direction: Direction): number =>
  direction === "right" ? rect.x + rect.width : rect.y + rect.height;

/**
 * The tree behind herdr's layout snapshot, or null where it cannot be read. Each split's id names
 * its place in the tree (`split_<n>_root`, `split_<n>_0110`: 0 descends the first side, 1 the
 * second); which panes lie on which side comes from their rects, cut on the line nearest the
 * split's ratio that crosses no pane.
 */
export function paneTree(layout: Pick<PaneLayoutSnapshot, "panes" | "splits">): PaneTree | null {
  const splits = new Map<string, PaneLayoutSnapshot["splits"][number]>();
  for (const split of layout.splits) {
    const path = /^split_\d+_(root|[01]+)$/.exec(split.id)?.[1];
    if (path !== undefined) splits.set(path === "root" ? "" : path, split);
  }
  const build = (path: string, panes: PaneLayoutSnapshot["panes"]): PaneTree | null => {
    if (panes.length === 1) return { pane: panes[0]!.pane_id };
    const split = splits.get(path);
    const direction: Direction | null = split?.direction === "right" ? "right" : split?.direction === "down" ? "down" : null;
    if (!split || !direction || panes.length === 0) return null;
    const from = start(split.rect, direction);
    const aim = from + (end(split.rect, direction) - from) * split.ratio;
    const cuts = [...new Set(panes.map((pane) => start(pane.rect, direction)))]
      .filter((line) => line > from && panes.every((pane) => end(pane.rect, direction) <= line || start(pane.rect, direction) >= line));
    if (cuts.length === 0) return null;
    const line = cuts.reduce((best, cut) => (Math.abs(cut - aim) < Math.abs(best - aim) ? cut : best));
    const first = build(`${path}0`, panes.filter((pane) => end(pane.rect, direction) <= line));
    const second = build(`${path}1`, panes.filter((pane) => start(pane.rect, direction) >= line));
    return first && second ? { direction, ratio: split.ratio, first, second } : null;
  };
  return build("", layout.panes);
}

/**
 * The moves that build the tree again in a new tab: `first` opens it, then each split, parent
 * before child, puts its second side's first pane beside its first side's, which until then stands
 * for the whole split.
 */
export function rebuildPlan(tree: PaneTree): { first: string; splits: { pane: string; beside: string; split: Direction; ratio: number }[] } {
  const lead = (node: PaneTree): string => ("pane" in node ? node.pane : lead(node.first));
  const splits: { pane: string; beside: string; split: Direction; ratio: number }[] = [];
  const walk = (node: PaneTree): void => {
    if ("pane" in node) return;
    splits.push({ pane: lead(node.second), beside: lead(node.first), split: node.direction, ratio: node.ratio });
    walk(node.first);
    walk(node.second);
  };
  walk(tree);
  return { first: lead(tree), splits };
}

/** herdr names a tab by its place until it is renamed: only a name it was given goes with it. */
function givenLabel(tab: HerdrTab, place: number): string | undefined {
  const label = tab.label.trim();
  return label === "" || label === String(place) ? undefined : label;
}

/**
 * Moves the tab to `insertIndex` (0..that workspace's tab count) among the tabs of `workspaceId`.
 * Its own workspace is a plain reorder (herdr's tab.move, the boundary counted before removal).
 */
export async function tabTransfer(tabId: string, workspaceId: string, insertIndex: number, socketPath?: string): Promise<TabTransferred> {
  const snapshot = await sessionSnapshot(socketPath);
  const tab = snapshot.tabs.find((candidate) => candidate.tab_id === tabId);
  if (!tab) throw new HerdrError("tab_not_found", `tab ${tabId} not found`);
  if (!snapshot.workspaces.some((workspace) => workspace.workspace_id === workspaceId)) throw new HerdrError("workspace_not_found", `workspace ${workspaceId} not found`);
  if (tab.workspace_id === workspaceId) {
    const moved = await tabMove(tabId, insertIndex, socketPath);
    const panes = snapshot.panes.filter((pane) => pane.tab_id === tabId).map((pane) => [pane.pane_id, pane.pane_id]);
    return { ok: true, tab_id: tabId, tabs: moved.tabs, pane_ids: Object.fromEntries(panes) };
  }
  const count = snapshot.tabs.filter((candidate) => candidate.workspace_id === workspaceId).length;
  if (insertIndex > count) throw new HerdrError("tab_move_failed", `insert_index ${insertIndex} is out of bounds`);

  let layout = snapshot.layouts.find((candidate) => candidate.tab_id === tabId);
  const zoomed = layout?.zoomed ? layout.focused_pane_id : null;
  if (zoomed) {
    await paneZoom(zoomed, "off", socketPath);
    layout = (await sessionSnapshot(socketPath)).layouts.find((candidate) => candidate.tab_id === tabId);
  }
  const tree = layout ? paneTree(layout) : null;
  if (!tree) throw new HerdrError("pane_layout_unavailable", `the layout of tab ${tabId} could not be read`);
  const plan = rebuildPlan(tree);

  const own = snapshot.tabs.filter((candidate) => candidate.workspace_id === tab.workspace_id);
  const label = givenLabel(tab, own.indexOf(tab) + 1);
  if (own.length === 1) {
    const workspace = snapshot.workspaces.find((candidate) => candidate.workspace_id === tab.workspace_id);
    const front = snapshot.panes.find((pane) => pane.pane_id === layout?.focused_pane_id);
    const cwd = workspace?.worktree?.checkout_path ?? front?.cwd;
    await tabCreate({ workspaceId: tab.workspace_id, ...(cwd ? { cwd } : {}) }, socketPath);
  }
  const ids = new Map<string, string>();
  const opened = await paneMove(plan.first, { type: "new_tab", workspace_id: workspaceId, ...(label === undefined ? {} : { label }) }, socketPath);
  ids.set(plan.first, opened.pane.pane_id);
  const newTabId = opened.created_tab?.tab_id ?? opened.pane.tab_id;
  for (const step of plan.splits) {
    const moved = await paneMove(step.pane, { type: "tab", tab_id: newTabId, target_pane_id: ids.get(step.beside)!, split: step.split, ratio: step.ratio }, socketPath);
    ids.set(step.pane, moved.pane.pane_id);
  }
  // the new tab opened last in its workspace: it goes where it was dropped
  const tabs = insertIndex < count
    ? (await tabMove(newTabId, insertIndex, socketPath)).tabs
    : (await sessionSnapshot(socketPath)).tabs.filter((candidate) => candidate.workspace_id === workspaceId);
  if (zoomed) await paneZoom(ids.get(zoomed)!, "on", socketPath);
  return { ok: true, tab_id: newTabId, tabs, pane_ids: Object.fromEntries(ids) };
}

import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type AnimationEvent, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Ellipsis, FolderOpen, GitBranch, LoaderCircle, Pencil, Pin, PinOff, Plus, SquareTerminal, Trash2, TriangleAlert, X } from "lucide-react";

import "./Sidebar.css";

import type { AgentStatus, HerdrPane, HerdrTab, PaneInfo, SessionSnapshot, WorkspaceInfo } from "../../shared/protocol.ts";
import { paneTitle } from "../../shared/notify-policy.ts";
import { MAX_LABEL_CHARS } from "../../shared/labels.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import type { AppActions } from "../lib/actions.ts";
import { indicatorGlyph, knownStatus, rollupStatus, STATUS_WORD } from "../lib/status.ts";
import { AgentMark } from "./AgentMark.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { RowMenu, type RowMenuItem } from "./RowMenu.tsx";
import { WorktreeDialog, type WorktreeDialogMode } from "./WorktreeDialog.tsx";
import { focusWorkspaceListToggle } from "../lib/focus.ts";
import { folderName, shortPathTitle, stripPaneChrome, taskRowLines } from "../lib/paneName.ts";
import { ApiError } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { userErrorMessage } from "../lib/userError.ts";
import { rosterPanes } from "../lib/dagPane.ts";
import { useSidebarActivity } from "../lib/sidebarActivity.tsx";
import { useSettings } from "../lib/settings.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { useAnnouncedText } from "../lib/useAnnouncedText.ts";
import { useWorktreeBranches } from "../lib/useWorktreeBranches.ts";
import { watchTouchReorder } from "../lib/touchReorder.ts";
import { useTabRowDrag } from "../lib/useTabRowDrag.ts";
import { captureFold, playFold, type FoldCapture, type FoldMotion } from "../lib/foldMotion.ts";
import { placeBlock, workspaceMoves, worktreeGroups as groupWorktrees } from "../lib/workspaceOrder.ts";
import { worktreeLabel } from "../lib/worktreeName.ts";
import { lastViewedPane, rememberViewedPane } from "../lib/lastViewedPane.ts";
import { customTabLabel, tabLabel } from "../lib/tabName.ts";
import { tabCloseAsks, tabPane } from "../lib/tabs.ts";
import { sidebarAgents, workspaceAgentLabels } from "../lib/sidebarAgents.ts";
import { PANE_DRAG_TYPE, paneDragData } from "../lib/split.ts";
import { currentSidebarPins, pinnedGroupIds, pinnedWorkspaceIds, pruneWorkspacePins, reorderWorkspacePins, setSidebarPins, splitPinnedGroups, subscribeSidebarPins, toggleSidebarPin, workspacePinKey, type WorkspaceGroup } from "../lib/sidebarPins.ts";

const ERROR_NOTE_MS = 5000;

const worktreeCollapsedKey = (machineId: string, repoKey: string) => `t-rex:worktree-group-collapsed:${machineId}:${repoKey}`;
// focus mode: a workspace whose tab rows are folded under its row
const tabsCollapsedKey = (machineId: string, workspaceId: string) => `t-rex:workspace-tabs-collapsed:${machineId}:${workspaceId}`;
function storedCollapsed(keyOf: (id: string) => string, ids: string[]): Set<string> {
  const collapsed = new Set<string>();
  try {
    for (const id of ids) if (localStorage.getItem(keyOf(id)) === "1") collapsed.add(id);
  } catch { /* storage denied: nothing is folded */ }
  return collapsed;
}

export { paneTitle };

/**
 * The title a row or the header shows: the user's label, else the live title minus its chrome,
 * a working directory written out shortened to its last folder (lib/paneName.ts).
 */
export function displayPaneTitle(pane: PaneInfo): string {
  return pane.label?.trim() || shortPathTitle(stripPaneChrome(paneTitle(pane), pane.agent)) || pane.pane_id;
}

/**
 * The title an alert names a pane by: as a row's, with the folder Codex adds after its thread
 * kept. A notification is read away from the row that says where the pane is.
 */
export function alertPaneTitle(pane: PaneInfo): string {
  return pane.label?.trim() || shortPathTitle(stripPaneChrome(paneTitle(pane), pane.agent, true)) || pane.pane_id;
}

/** herdr could not bring this pane back after a restart (0.9.3+ `restore_error`): a warning in the status cell, its reason on hover. */
export function RestoreErrorBadge({ reason }: { reason: string }) {
  const t = useT();
  const label = t("NOT RESTORED");
  return (
    <span className="badge badge-restore-error sidebar-status" data-status="restore-error" role="status" aria-label={label} title={`${label} — ${reason}`}>
      <TriangleAlert aria-hidden="true" />
      <span className="visually-hidden">{label}</span>
    </span>
  );
}

/** Every breathing dot or glyph keeps the document clock's phase, so a row that starts working breathes in step with the rest. */
function alignBreath(event: AnimationEvent<HTMLSpanElement>) {
  if (event.animationName !== "sidebar-breathe") return;
  for (const animation of event.currentTarget.getAnimations()) animation.startTime = 0;
}

/** a tab row's status cell while herdr makes the move it shows: a stepped spinner (Sidebar.css) */
function MovingBadge() {
  const t = useT();
  return <span className="badge sidebar-status sidebar-status-moving" role="status" aria-label={t("Moving…")} title={t("Moving…")}><LoaderCircle aria-hidden="true" /></span>;
}

export function StatusBadge({ status, compact = false }: { status?: AgentStatus; compact?: boolean }) {
  const t = useT();
  const { settings } = useSettings();
  const value = knownStatus(status);
  const label = t(STATUS_WORD[value]);
  const description = value === "waiting" ? t("Agent waiting on background work") : t("Agent {status}", { status: label });
  // classic (the default): a compact cell draws only the states that ask for a look: a red question
  // mark while the agent waits for an answer, a green dot once it has finished and was not looked
  // at, a working-coloured dot that breathes while it runs, a working-coloured ring held still while
  // its turn waits on background work. Ready and unknown keep the cell, its label and its tooltip.
  // Dots or Symbols: herdr's TUI glyph for every state, in herdr's color (lib/status.ts, Sidebar.css)
  const indicators = settings.statusIndicators;
  const dot = value === "working" || value === "done" || value === "waiting";
  return (
    <span
      className={`badge badge-${value}${compact ? " sidebar-status" : ""}`}
      data-status={value}
      role={compact ? "status" : undefined}
      aria-label={compact ? description : undefined}
      title={description}
    >
      {compact && indicators !== "classic" && <span className="sidebar-status-glyph" aria-hidden="true" onAnimationStart={value === "working" ? alignBreath : undefined}>{indicatorGlyph(value, indicators)}</span>}
      {compact && indicators === "classic" && value === "blocked" && <span className="sidebar-status-mark" aria-hidden="true">?</span>}
      {compact && indicators === "classic" && dot && <span className="sidebar-status-dot" aria-hidden="true" onAnimationStart={value === "working" ? alignBreath : undefined} />}
      <span className={compact ? "visually-hidden" : undefined}>{label}</span>
    </span>
  );
}

function cwdBasename(cwd: string | null | undefined): string {
  return cwd ? folderName(cwd) : "unknown directory";
}

interface InlineError {
  workspaceId?: string;
  message: string;
  detail: string | null;
}

/**
 * A workspace right-click opens herdr's workspace menu at the pointer without moving focus.
 * Dismissal restores the prior input. A name editor keeps the browser's paste menu.
 * A finger's long press is left alone: it picks a workspace row up to be moved (lib/touchReorder.ts),
 * and the ⋯ is always there on touch. A desktop draws no ⋯ (Sidebar.css): the row itself anchors the menu.
 */
export function onRowContextMenu(event: MouseEvent<HTMLElement>, toggle: (anchor: HTMLElement, point?: { x: number; y: number }, previousFocus?: HTMLElement | null) => void): void {
  if ((event.target as HTMLElement).closest("input")) return;
  // Chrome and Safari say what pressed; Firefox does not, so there the device's main pointer decides
  const pointer = (event.nativeEvent as PointerEvent).pointerType;
  if (pointer ? pointer === "touch" : window.matchMedia("(pointer: coarse)").matches) return;
  const toggleButton = event.currentTarget.querySelector<HTMLElement>(".row-menu-toggle");
  if (!toggleButton) return;
  const anchor = toggleButton.getClientRects().length > 0 ? toggleButton : event.currentTarget;
  event.preventDefault();
  const box = anchor.getBoundingClientRect();
  toggle(anchor, event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : { x: box.left, y: box.bottom }, document.activeElement instanceof HTMLElement ? document.activeElement : null);
}

/** The row whose ⋯ menu is open: a workspace, seen through the pane its row shows. */
interface MenuState { anchor: HTMLElement; point?: { x: number; y: number }; previousFocus?: HTMLElement | null; workspace: WorkspaceInfo; title: string; place: string }
interface ConfirmState { title: string; body: string; action?: string; run: () => Promise<void>; escalation?: { label: string; code: string; run: () => Promise<void> } }

export interface SidebarProps {
  snapshot: SessionSnapshot | null;
  online: boolean;
  selectedPaneId: string | null;
  actions: AppActions;
}

/**
 * Spaces follow herdr's workspace roster. A workspace opens its current pane; tabs and split
 * panes are navigated through the tab strip, while Agents is an independent API-backed list.
 */
export function Sidebar({ snapshot, online, selectedPaneId, actions }: SidebarProps) {
  const t = useT();
  const { settings } = useSettings();
  const twoLine = settings.sidebarRows === "two";
  // focus mode (App): from 769px each workspace's tabs are rows under it; App hides the sidebar,
  // tabs and all, when it hands them back to the bar
  const wide = useMediaQuery("(min-width: 769px)");
  const tabsUnder = settings.focusMode && wide;
  const machineId = useMachineId();
  const activity = useSidebarActivity();
  const { closeWorkspace, listWorktrees, moveTab, moveWorkspace, removeWorktree, renameWorkspace, transferTab } = useMachineApi();
  // the roster's wait is a live region in the list from its first render, clipped while empty (never
  // display: none); its words land a frame after it (lib/useAnnouncedText.ts)
  const loadingWords = useAnnouncedText(snapshot ? null : t("Loading workspaces…"));
  // herdr marks only a workspace it opened as a worktree. One made on a repository's folder has no
  // `worktree`, and it is where the first worktree starts: each is asked once whether git answers
  // for it. A refusal (4xx) is an answer and is kept; a failure to ask is not, so that workspace
  // keeps what was known of it and is asked again when the set changes or the PC comes back.
  const unmarked = (snapshot?.workspaces ?? []).filter((workspace) => !workspace.worktree).map((workspace) => workspace.workspace_id).join("\n");
  const [repositoryWorkspaces, setRepositoryWorkspaces] = useState<ReadonlySet<string>>(() => new Set());
  const repositoryAnswers = useRef(new Map<string, boolean>());
  useEffect(() => {
    const known = repositoryAnswers.current;
    if (!online || unmarked === "") { known.clear(); setRepositoryWorkspaces(new Set()); return; }
    const ids = unmarked.split("\n");
    for (const id of [...known.keys()]) if (!ids.includes(id)) known.delete(id);
    let live = true;
    const publish = () => { if (live) setRepositoryWorkspaces(new Set(ids.filter((id) => known.get(id) === true))); };
    publish();
    void Promise.all(ids.filter((id) => !known.has(id)).map((id) => listWorktrees(id).then(
      () => { if (live) known.set(id, true); },
      (error: unknown) => { if (live && error instanceof ApiError && error.status < 500) known.set(id, false); },
    ))).then(publish);
    return () => { live = false; };
  }, [listWorktrees, unmarked, online]);
  const { branches, rememberOpened } = useWorktreeBranches(snapshot, online, true, repositoryWorkspaces);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [worktreeDialog, setWorktreeDialog] = useState<{ mode: WorktreeDialogMode; workspace: WorkspaceInfo } | null>(null);
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(null);
  const [workspaceLabel, setWorkspaceLabel] = useState("");
  const [workspaceOrder, setWorkspaceOrder] = useState<string[]>([]);
  const [dragWorkspaceId, setDragWorkspaceId] = useState<string | null>(null);
  // a finger's drag (lib/touchReorder.ts): the row it holds and the row it is over
  const [touchDrag, setTouchDrag] = useState<{ source: string; over: string | null } | null>(null);
  // the browser's drag and drop is a mouse's: on a touch screen a long press lifts the row instead
  const coarsePointer = useMediaQuery("(pointer: coarse)");
  const [inlineError, setInlineError] = useState<InlineError | null>(null);
  const rosterId = useId();
  const workspaceRoot = useRef<HTMLDivElement>(null);
  const revealOpenedWorkspace = useRef<string | null>(null);
  const [collapsedWorktrees, setCollapsedWorktrees] = useState<Set<string>>(() => storedCollapsed((key) => worktreeCollapsedKey(machineId, key), snapshot?.workspaces.flatMap((workspace) => workspace.worktree ? [workspace.worktree.repo_key] : []) ?? []));
  const [collapsedTabs, setCollapsedTabs] = useState<Set<string>>(() => storedCollapsed((id) => tabsCollapsedKey(machineId, id), snapshot?.workspaces.map((workspace) => workspace.workspace_id) ?? []));
  // the workspaces whose stored fold was read, once each
  const tabFoldsRead = useRef(new Set<string>(snapshot?.workspaces.map((workspace) => workspace.workspace_id) ?? []));
  // a fold slides (lib/foldMotion.ts): where everything is drawn is read before React renders the
  // fold, and the rows move on from there once it has. The keyboard's folds do not move.
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const foldCapture = useRef<{ capture: FoldCapture; motion: FoldMotion } | null>(null);
  const [instantFold, setInstantFold] = useState(false);
  // the pane each workspace was last seen on in this browser: its row keeps showing and opening
  // that one, also after the page reloads (lib/lastViewedPane.ts). Kept once per pane opened, not
  // per snapshot, and a workspace opened again on the same pane becomes the newest seen again.
  const viewedWorkspaceId = selectedPaneId ? snapshot?.panes.find((pane) => pane.pane_id === selectedPaneId)?.workspace_id : undefined;
  useEffect(() => {
    if (selectedPaneId && viewedWorkspaceId) rememberViewedPane("workspace", machineId, viewedWorkspaceId, selectedPaneId);
  }, [machineId, selectedPaneId, viewedWorkspaceId]);

  const setWorktreeCollapsed = (repoKey: string, collapsed: boolean): void => {
    setCollapsedWorktrees((current) => {
      if (current.has(repoKey) === collapsed) return current;
      const next = new Set(current);
      if (collapsed) next.add(repoKey); else next.delete(repoKey);
      return next;
    });
    try {
      if (collapsed) localStorage.setItem(worktreeCollapsedKey(machineId, repoKey), "1");
      else localStorage.removeItem(worktreeCollapsedKey(machineId, repoKey));
    } catch {}
  };

  const setTabsCollapsed = (workspaceIds: string[], collapsed: boolean): void => {
    setCollapsedTabs((current) => {
      const next = new Set(current);
      for (const id of workspaceIds) if (collapsed) next.add(id); else next.delete(id);
      return next;
    });
    try {
      for (const id of workspaceIds) {
        if (collapsed) localStorage.setItem(tabsCollapsedKey(machineId, id), "1");
        else localStorage.removeItem(tabsCollapsedKey(machineId, id));
      }
    } catch {}
  };

  /**
   * A row's fold, or with Alt every row's: in focus mode what hangs under it, its tab rows and its
   * worktrees; otherwise a repository's worktrees. A pointer's fold slides, the keyboard's does not.
   */
  const foldRows = (group: WorkspaceGroup<WorkspaceInfo>, collapsed: boolean, every: boolean, pointer: boolean): void => {
    const root = workspaceRoot.current;
    const motion: FoldMotion = !pointer ? "none" : reducedMotion ? "fade" : "slide";
    if (root) foldCapture.current = { capture: captureFold(root), motion };
    setInstantFold(motion !== "slide");
    const groups = every ? worktreeGroups : [group];
    if (tabsUnder) setTabsCollapsed(groups.flatMap(({ workspace, children }) => [workspace, ...(every ? children : [])].map((candidate) => candidate.workspace_id)), collapsed);
    for (const { workspace, children } of groups) {
      if (workspace.worktree && children.length > 0) setWorktreeCollapsed(workspace.worktree.repo_key, collapsed);
    }
  };
  // A pointer's fold keeps the keyboard where it was, in the terminal most often. The row's press
  // takes the focus (cancelling it would stop the row's drag), and its click gives it back.
  const focusBeforePress = useRef<Element | null>(null);
  const giveFocusBack = (): void => {
    const before = focusBeforePress.current;
    focusBeforePress.current = null;
    if (before instanceof HTMLElement && before.isConnected && !workspaceRoot.current?.contains(before)) before.focus({ preventScroll: true });
  };
  useLayoutEffect(() => {
    const pending = foldCapture.current;
    const root = workspaceRoot.current;
    if (!pending || !root) return;
    foldCapture.current = null;
    // the keyboard in a row that folded away goes to the row it hangs from
    const gone = document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>("[data-fold][hidden]") : null;
    if (gone) {
      const above = [...root.querySelectorAll<HTMLElement>(".workspace-select")].filter((row) => !row.closest("[hidden]") && (row.compareDocumentPosition(gone) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
      above.at(-1)?.focus({ preventScroll: true });
    }
    playFold(root, pending.capture, pending.motion);
  });

  useEffect(() => {
    if (inlineError === null) return;
    const timer = window.setTimeout(() => setInlineError(null), ERROR_NOTE_MS);
    return () => window.clearTimeout(timer);
  }, [inlineError]);

  useEffect(() => {
    if (!snapshot) {
      setWorkspaceOrder([]);
      return;
    }
    const serverOrder = snapshot.workspaces.map((workspace) => workspace.workspace_id);
    setWorkspaceOrder((current) => current.join("\u0000") === serverOrder.join("\u0000") ? current : serverOrder);
    // New worktree groups bring their stored fold state after reconnecting or creating a workspace.
    setCollapsedWorktrees((current) => {
      const keys = snapshot.workspaces.flatMap((workspace) => workspace.worktree && !current.has(workspace.worktree.repo_key) ? [workspace.worktree.repo_key] : []);
      const stored = storedCollapsed((key) => worktreeCollapsedKey(machineId, key), keys);
      return stored.size === 0 ? current : new Set([...current, ...stored]);
    });
    // and new workspaces their tabs' fold
    const unread = snapshot.workspaces.map((workspace) => workspace.workspace_id).filter((id) => !tabFoldsRead.current.has(id));
    for (const id of unread) tabFoldsRead.current.add(id);
    const storedTabs = storedCollapsed((id) => tabsCollapsedKey(machineId, id), unread);
    if (storedTabs.size > 0) setCollapsedTabs((current) => new Set([...current, ...storedTabs]));
  }, [snapshot, machineId]);

  const orderedWorkspaces = useMemo(() => {
    if (!snapshot) return [];
    const byId = new Map(snapshot.workspaces.map((workspace) => [workspace.workspace_id, workspace]));
    return workspaceOrder.map((id) => byId.get(id)).filter((workspace): workspace is WorkspaceInfo => workspace !== undefined);
  }, [snapshot, workspaceOrder]);
  const roster = useMemo(() => rosterPanes(snapshot?.panes ?? [], selectedPaneId), [snapshot?.panes, selectedPaneId]);
  const agentRows = useMemo(() => sidebarAgents(snapshot), [snapshot]);
  const agentNames = useMemo(() => workspaceAgentLabels(agentRows), [agentRows]);
  // a repository's worktree workspaces hang under one on its main checkout (lib/workspaceOrder.ts)
  const worktreeGroups = useMemo(() => groupWorktrees(orderedWorkspaces), [orderedWorkspaces]);
  // pinned workspaces stand first, in a card, in pin order (shared with the other browsers,
  // lib/preferencesSync.ts); their moves change pins, while the rest change herdr's order
  const pins = useSyncExternalStore(subscribeSidebarPins, currentSidebarPins, currentSidebarPins);
  const pinnedIds = useMemo(() => pinnedWorkspaceIds(pins, machineId), [pins, machineId]);
  const shownGroups = useMemo(() => splitPinnedGroups(worktreeGroups, pinnedIds, (workspace) => workspace.workspace_id), [worktreeGroups, pinnedIds]);
  // a pinned head's worktrees remain outside the card, but cannot move away from their repository
  const fixedIds = useMemo(() => new Set([...pinnedGroupIds(worktreeGroups, pinnedIds, (workspace) => workspace.workspace_id)].filter((id) => !pinnedIds.includes(id))), [worktreeGroups, pinnedIds]);
  const movableGroups = shownGroups.rest.filter((group) => !fixedIds.has(group.workspace.workspace_id));
  // a pin moves the row to the other list, so React draws it anew: the row that had the focus gets it back
  const refocusRow = useRef<string | null>(null);
  useLayoutEffect(() => {
    const id = refocusRow.current;
    if (id === null) return;
    refocusRow.current = null;
    workspaceRoot.current?.querySelector<HTMLElement>(`.workspace-group[data-workspace="${CSS.escape(id)}"] > .workspace-header .workspace-select`)?.focus({ preventScroll: true });
  }, [pins]);
  const togglePin = (state: MenuState): void => {
    const id = state.workspace.workspace_id;
    const back = state.previousFocus === undefined ? state.anchor : state.previousFocus;
    if (back?.closest(`.workspace-group[data-workspace="${CSS.escape(id)}"]`)) refocusRow.current = id;
    // pins of workspaces gone from this PC leave with a change of the user's, never by themselves
    const live = new Set(snapshot?.workspaces.map((workspace) => workspace.workspace_id) ?? []);
    setSidebarPins(toggleSidebarPin(pruneWorkspacePins(pins, machineId, live), workspacePinKey(machineId, id)));
  };

  useLayoutEffect(() => {
    const id = revealOpenedWorkspace.current;
    if (!id) return;
    const row = [...(workspaceRoot.current?.querySelectorAll<HTMLElement>(".workspace-group") ?? [])].find((candidate) => candidate.dataset.workspace === id);
    const scroller = workspaceRoot.current?.closest<HTMLElement>(".machine-list");
    if (!row || !scroller || scroller.clientHeight === 0) return;
    const item = row.getBoundingClientRect();
    const panel = scroller.getBoundingClientRect();
    if (item.top < panel.top || item.bottom > panel.bottom) {
      scroller.scrollTop += (item.top + item.bottom - panel.top - panel.bottom) / 2;
    }
    revealOpenedWorkspace.current = null;
  }, [snapshot, selectedPaneId, branches]);

  const noteError = (message: string, workspaceId?: string, detail: string | null = null): void => setInlineError({ message, workspaceId, detail });

  // focus mode's tab rows move by drag, by Alt+↑/↓ and from their menu, and by drag into another
  // workspace (lib/useTabRowDrag.ts)
  // the pane open when a tab went to another workspace stays open there, under the id herdr gave it
  const openPane = useRef(selectedPaneId);
  openPane.current = selectedPaneId;
  const openAtTransfer = useRef<string | null>(null);
  const tabRows = useTabRowDrag({ owner: machineId, root: workspaceRoot, tabs: snapshot?.tabs ?? [], moveTab,
    openTabId: roster.find((pane) => pane.pane_id === selectedPaneId)?.tab_id ?? null,
    panesOf: (tabId) => roster.filter((pane) => pane.tab_id === tabId),
    transferTab: (tabId, workspaceId, boundary) => {
      openAtTransfer.current = openPane.current;
      return transferTab(tabId, workspaceId, boundary);
    },
    transferred: (result) => {
      const next = openAtTransfer.current === null ? undefined : result.pane_ids[openAtTransfer.current];
      if (next) actions.selectPane(next);
    },
    failed: (reason, workspaceId) => {
      const failure = userErrorMessage(reason);
      noteError(t("Move failed: {reason}", { reason: failure.message }), workspaceId, failure.detail);
    },
    stale: (workspaceId) => noteError(t("Tab order did not refresh. Try again."), workspaceId),
  });

  /** the pane a workspace's row shows and opens, among the panes the row stands for */
  const currentPane = (workspace: WorkspaceInfo, panes: PaneInfo[]): PaneInfo => {
    const pick = (id: string | null | undefined) => (id ? panes.find((pane) => pane.pane_id === id) : undefined);
    return pick(selectedPaneId)
      ?? pick(lastViewedPane("workspace", machineId, workspace.workspace_id))
      ?? pick(snapshot?.layouts?.find((layout) => layout.tab_id === workspace.active_tab_id)?.focused_pane_id)
      ?? panes.find((pane) => pane.focused)
      ?? panes[0]!;
  };

  const agentsTitle = (workspace: WorkspaceInfo): string | null => {
    const names = agentNames.get(workspace.workspace_id);
    return names ? t("Agents: {names}", { names: names.join(", ") }) : null;
  };

  const closeMenu = useCallback(() => setMenu(null), []);

  // A close takes the workspace with it, so it asks first, as herdr's ui.confirm_close does.
  // The row is gone afterwards, so focus moves to the header's workspace-list toggle.
  const leave = async (close: () => Promise<void>): Promise<void> => {
    await close();
    setConfirm(null);
    focusWorkspaceListToggle();
  };

  const menuItems = (state: MenuState): RowMenuItem[] => {
    // the roster may have moved on since the menu opened (a pane closed from another client):
    // what an item does follows the latest snapshot, not what the row showed at the click
    const workspace = snapshot?.workspaces.find((candidate) => candidate.workspace_id === state.workspace.workspace_id) ?? state.workspace;
    const panes = snapshot?.panes.filter((pane) => pane.workspace_id === workspace.workspace_id) ?? [];
    const paneCount = Math.max(1, panes.length);
    // a worktree workspace: its checkout can be deleted; the repository's workspace: herdr closes
    // every workspace of the repository with it (any other one on the main checkout too, whatever
    // group it shows under here), and refuses without close_group
    const linked = workspace.worktree?.is_linked_worktree === true;
    const repoKey = workspace.worktree?.repo_key;
    const sameRepo = linked || repoKey === undefined ? [] : (snapshot?.workspaces.filter((candidate) => candidate.workspace_id !== workspace.workspace_id && candidate.worktree?.repo_key === repoKey) ?? []);
    const worktrees = sameRepo.filter((candidate) => candidate.worktree?.is_linked_worktree);
    const otherHeads = sameRepo.length > worktrees.length;
    const worktreeItems: RowMenuItem[] = (workspace.worktree || repositoryWorkspaces.has(workspace.workspace_id)) && !linked ? [
      { id: "new-worktree", label: t("New worktree"), icon: GitBranch, run: () => setWorktreeDialog({ mode: "create", workspace }) },
      { id: "open-worktree", label: t("Open worktree…"), icon: FolderOpen, run: () => setWorktreeDialog({ mode: "open", workspace }) },
    ] : [];
    const deleteItems: RowMenuItem[] = linked ? [{
      id: "delete-worktree", label: t("Delete worktree checkout…"), icon: Trash2, danger: true,
      run: () => setConfirm({
        title: t("Delete the checkout of {name}?", { name: workspace.label }),
        body: t("The folder at {path} is deleted and the workspace closes. The branch stays.", { path: workspace.worktree?.checkout_path ?? "" }),
        action: t("Delete"),
        run: () => leave(async () => { await removeWorktree({ workspace_id: workspace.workspace_id }); }),
        // git refuses a checkout with unsaved changes: the refusal shows, and the action becomes a forced one
        escalation: { label: t("Delete anyway"), code: "dirty_worktree_requires_force", run: () => leave(async () => { await removeWorktree({ workspace_id: workspace.workspace_id, force: true }); }) },
      }),
    }] : [];
    // a repository's other open workspaces go with it
    const closeItem: RowMenuItem = { id: "close", label: t("Close workspace"), icon: X, danger: true, divider: true, run: () => setConfirm({
      title: t("Close workspace {name}?", { name: workspace.label }),
      body: (worktrees.length > 0
        ? t(paneCount === 1
          ? (worktrees.length === 1 ? "{n} pane and {m} worktree workspace close with it; the agents in them stop, and the checkout stays." : "{n} pane and {m} worktree workspaces close with it; the agents in them stop, and the checkouts stay.")
          : (worktrees.length === 1 ? "{n} panes and {m} worktree workspace close with it; the agents in them stop, and the checkout stays." : "{n} panes and {m} worktree workspaces close with it; the agents in them stop, and the checkouts stay."), { n: paneCount, m: worktrees.length })
        : t(paneCount === 1 ? "{n} pane closes with it, and the agent in it stops." : "{n} panes close with it, and the agents in them stop.", { n: paneCount }))
        + (otherHeads ? ` ${t("The other workspaces open on this repository's main checkout close too.")}` : ""),
      run: () => leave(() => closeWorkspace(workspace.workspace_id, sameRepo.length > 0)),
    }) };
    // One native workspace menu for both the pointer and the explicit ⋯ button.
    const folded = repoKey !== undefined && collapsedWorktrees.has(repoKey);
    const pinned = pinnedIds.includes(workspace.workspace_id);
    return [
      pinned
        ? { id: "unpin-workspace", label: t("Unpin workspace"), icon: PinOff, run: () => togglePin(state) }
        : { id: "pin-workspace", label: t("Pin workspace"), icon: Pin, run: () => togglePin(state) },
      { id: "rename-workspace", label: t("Rename workspace"), icon: Pencil, run: () => beginWorkspaceRename(workspace) },
      { ...closeItem, label: t(sameRepo.length > 0 ? "Close group" : "Close workspace"), divider: false },
      ...worktreeItems, ...deleteItems,
      ...(worktrees.length > 0 && repoKey ? [{ id: "fold", label: t(folded ? "Expand" : "Collapse"), icon: folded ? ChevronRight : ChevronDown, run: () => setWorktreeCollapsed(repoKey, !folded) }] : []),
    ];
  };

  // the roster moves under an open menu: a row that left takes its menu with it, and focus
  // goes where a closed row's focus goes
  useEffect(() => {
    if (!menu) return;
    const alive = snapshot?.workspaces.some((workspace) => workspace.workspace_id === menu.workspace.workspace_id);
    if (alive && menu.anchor.isConnected) return;
    setMenu(null);
    focusWorkspaceListToggle();
  });
  // a rename's failure is answered after later renders: it asks the roster as it is then, and
  // reopens nothing over an editor the user opened since
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const editingRef = useRef({ workspace: editingWorkspaceId });
  editingRef.current = { workspace: editingWorkspaceId };
  const editorOpen = (): boolean => editingRef.current.workspace !== null;

  const beginWorkspaceRename = (workspace: WorkspaceInfo): void => {
    setEditingWorkspaceId(workspace.workspace_id);
    setWorkspaceLabel(workspace.label);
  };

  const saveWorkspaceRename = (workspaceId: string): void => {
    const typed = workspaceLabel;
    const label = typed.trim();
    // herdr would keep an empty name, and the row would show none: the editor stays open
    if (label === "") { noteError(t("A workspace needs a name."), workspaceId); return; }
    setEditingWorkspaceId(null);
    // a name herdr set longer than the field allows is not sent back to be refused
    if (label === snapshotRef.current?.workspaces.find((candidate) => candidate.workspace_id === workspaceId)?.label) return;
    void renameWorkspace(workspaceId, label).catch((reason: unknown) => {
      // as for a pane: the typed name survives a failed request, for as long as the workspace does
      if (!editorOpen() && snapshotRef.current?.workspaces.some((candidate) => candidate.workspace_id === workspaceId)) {
        setEditingWorkspaceId(workspaceId);
        setWorkspaceLabel(typed);
      }
      const failure = userErrorMessage(reason);
      noteError(t("Rename failed: {reason}", { reason: failure.message }), workspaceId, failure.detail);
    });
  };

  const reorderWorkspaces = (next: string[]): void => {
    const previous = workspaceOrder;
    const moves = workspaceMoves(previous, next);
    if (moves.length === 0) return;
    setWorkspaceOrder(next);
    void (async () => {
      for (const move of moves) await moveWorkspace(move.workspaceId, move.insertIndex);
    })().catch((reason: unknown) => {
      // only this move's own optimistic order is rolled back: if a later reorder has landed in
      // the meantime, its order is the newer one and reverting to `previous` would undo it
      setWorkspaceOrder((current) => (current.length === next.length && current.every((id, index) => id === next[index]) ? previous : current));
      const failure = userErrorMessage(reason);
      noteError(t("Reorder failed: {reason}", { reason: failure.message }), undefined, failure.detail);
    });
  };

  const onDragStart = (event: DragEvent<HTMLElement>, workspaceId: string, paneId: string): void => {
    setDragWorkspaceId(workspaceId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-herdr-workspace", JSON.stringify({ machine_id: machineId, workspace_id: workspaceId }));
    // dropped on the pane area instead, the row opens its pane in half of it (lib/split.ts)
    event.dataTransfer.setData(PANE_DRAG_TYPE, paneDragData({ machineId, paneId }));
  };

  const onDrop = (event: DragEvent<HTMLElement>, targetWorkspaceId: string): void => {
    event.preventDefault();
    let payload: { machine_id?: string; workspace_id?: string };
    try { payload = JSON.parse(event.dataTransfer.getData("application/x-herdr-workspace")); } catch { return; }
    if (payload.machine_id !== machineId || typeof payload.workspace_id !== "string") return;
    const sourceId = dragWorkspaceId ?? payload.workspace_id;
    setDragWorkspaceId(null);
    dropVisible(sourceId, targetWorkspaceId);
  };

  // The roster shows groups: a repository's workspace moves past the next or previous group as
  // one, and a worktree moves among its siblings, by the neighbours the list shows (pinned rows
  // are not among them). herdr moves only the workspace it is told to, so a group's worktrees
  // (a pinned one too) are moved with it (lib/workspaceOrder.ts).
  const groupIds = (group: (typeof worktreeGroups)[number]): string[] => {
    const whole = worktreeGroups.find((candidate) => candidate.workspace.workspace_id === group.workspace.workspace_id) ?? group;
    return [whole.workspace, ...whole.children].map((workspace) => workspace.workspace_id);
  };
  const moveOrder = (workspaceId: string, direction: -1 | 1): string[] | null => {
    const side = direction === 1 ? "after" : "before";
    const groupIndex = movableGroups.findIndex((group) => group.workspace.workspace_id === workspaceId);
    if (groupIndex >= 0) {
      const target = movableGroups[groupIndex + direction];
      return target ? placeBlock(workspaceOrder, groupIds(movableGroups[groupIndex]!), groupIds(target), side) : null;
    }
    const parent = movableGroups.find((group) => group.children.some((child) => child.workspace_id === workspaceId));
    if (!parent) return null;
    const sibling = parent.children[parent.children.findIndex((child) => child.workspace_id === workspaceId) + direction];
    return sibling ? placeBlock(workspaceOrder, [workspaceId], [sibling.workspace_id], side) : null;
  };
  const moveVisible = (workspaceId: string, direction: -1 | 1): void => {
    const pinnedIndex = shownGroups.pinned.findIndex((group) => group.workspace.workspace_id === workspaceId);
    if (pinnedIndex >= 0) {
      const target = shownGroups.pinned[pinnedIndex + direction];
      if (target) setSidebarPins(reorderWorkspacePins(currentSidebarPins(), machineId, workspaceId, target.workspace.workspace_id));
      return;
    }
    const next = moveOrder(workspaceId, direction);
    if (next !== null) reorderWorkspaces(next);
  };

  /** A card drop belongs to the pin list; crossing the card's edge changes neither order. */
  const pinnedDropTarget = (sourceId: string, targetId: string): WorkspaceGroup<WorkspaceInfo> | undefined =>
    pinnedIds.includes(sourceId) && sourceId !== targetId
      ? shownGroups.pinned.find((group) => group.workspace.workspace_id !== sourceId && (group.workspace.workspace_id === targetId || group.children.some((child) => child.workspace_id === targetId)))
      : undefined;
  const dropVisible = (sourceId: string, targetId: string): void => {
    const target = pinnedDropTarget(sourceId, targetId);
    if (target) {
      setSidebarPins(reorderWorkspacePins(currentSidebarPins(), machineId, sourceId, target.workspace.workspace_id));
      return;
    }
    const next = dropOrder(sourceId, targetId);
    if (next !== null) reorderWorkspaces(next);
  };

  /** the order a dropped workspace makes, or none when the drop crosses a group's edge */
  const dropOrder = (sourceId: string, targetId: string): string[] | null => {
    const sourceGroup = movableGroups.find((group) => group.workspace.workspace_id === sourceId);
    if (sourceGroup) {
      const targetGroup = movableGroups.find((group) => group.workspace.workspace_id === targetId || group.children.some((child) => child.workspace_id === targetId));
      if (!targetGroup || targetGroup === sourceGroup) return null;
      const movingDown = workspaceOrder.indexOf(sourceId) < workspaceOrder.indexOf(targetGroup.workspace.workspace_id);
      return placeBlock(workspaceOrder, groupIds(sourceGroup), groupIds(targetGroup), movingDown ? "after" : "before");
    }
    const parent = movableGroups.find((group) => group.children.some((child) => child.workspace_id === sourceId));
    if (!parent || sourceId === targetId || !parent.children.some((child) => child.workspace_id === targetId)) return null;
    const movingDown = workspaceOrder.indexOf(sourceId) < workspaceOrder.indexOf(targetId);
    return placeBlock(workspaceOrder, [sourceId], [targetId], movingDown ? "after" : "before");
  };

  // a finger's drag lands where the mouse's does: the same groups, the same index for herdr
  const touchHandlers = useRef<Parameters<typeof watchTouchReorder>[1] | null>(null);
  touchHandlers.current = {
    canLift: (id) => editingWorkspaceId !== id && !fixedIds.has(id),
    onLift: (id) => { setMenu(null); setTouchDrag({ source: id, over: id }); },
    onOver: (id) => setTouchDrag((current) => current && { ...current, over: id }),
    onDrop: (id, target) => {
      setTouchDrag(null);
      if (target !== null && target !== id) dropVisible(id, target);
    },
    onCancel: () => setTouchDrag(null),
  };
  useEffect(() => {
    const root = workspaceRoot.current;
    if (!root) return;
    return watchTouchReorder(root, {
      canLift: (id) => touchHandlers.current?.canLift(id) ?? false,
      onLift: (id) => touchHandlers.current?.onLift(id),
      onOver: (id) => touchHandlers.current?.onOver(id),
      onDrop: (id, target) => touchHandlers.current?.onDrop(id, target),
      onCancel: () => touchHandlers.current?.onCancel(),
    });
  }, []);

  /** where a held row would land, drawn as a line: before or after a row, or after a group's worktrees */
  const dropMark = ((): { id: string; side: "before" | "after"; children: boolean } | null => {
    if (!touchDrag?.over || touchDrag.over === touchDrag.source) return null;
    const pinnedTarget = pinnedDropTarget(touchDrag.source, touchDrag.over);
    if (pinnedTarget) {
      const down = pinnedIds.indexOf(touchDrag.source) < pinnedIds.indexOf(pinnedTarget.workspace.workspace_id);
      return { id: pinnedTarget.workspace.workspace_id, side: down ? "after" : "before", children: down && pinnedTarget.children.length > 0 };
    }
    if (dropOrder(touchDrag.source, touchDrag.over) === null) return null;
    const down = workspaceOrder.indexOf(touchDrag.source) < workspaceOrder.indexOf(touchDrag.over);
    const sourceGroup = movableGroups.some((group) => group.workspace.workspace_id === touchDrag.source);
    const targetGroup = sourceGroup ? movableGroups.find((group) => group.workspace.workspace_id === touchDrag.over || group.children.some((child) => child.workspace_id === touchDrag.over)) : undefined;
    if (targetGroup) {
      const groupDown = workspaceOrder.indexOf(touchDrag.source) < workspaceOrder.indexOf(targetGroup.workspace.workspace_id);
      return { id: targetGroup.workspace.workspace_id, side: groupDown ? "after" : "before", children: groupDown && targetGroup.children.length > 0 };
    }
    return { id: touchDrag.over, side: down ? "after" : "before", children: false };
  })();

  const onRowKeyDown = (event: KeyboardEvent<HTMLDivElement>, workspaceId: string): void => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    moveVisible(workspaceId, event.key === "ArrowUp" ? -1 : 1);
  };

  const renderWorkspaceRow = (workspace: WorkspaceInfo, children: WorkspaceInfo[] = [], nested = false, drop?: "before" | "after", hidden = false) => {
    const panes = roster.filter((pane) => pane.workspace_id === workspace.workspace_id);
    if (panes.length === 0) return null;
    const pane = currentPane(workspace, panes);
    // the open tab on its way to another workspace is open there already (lib/useTabRowDrag.ts)
    const selected = tabRows.carry?.open ? tabRows.carry.to === workspace.workspace_id : panes.some((candidate) => candidate.pane_id === selectedPaneId);
    const repoKey = workspace.worktree?.repo_key;
    const linked = workspace.worktree?.is_linked_worktree === true;
    const branch = branches.get(workspace.workspace_id);
    const branchTitle = branch?.branch ?? (branch?.isDetached ? t("Detached HEAD") : null);
    // the row says the workspace's name, the one its owner gave it or herdr made from the branch; the
    // branch itself is the tooltip's and the menu's, where the name does not already say it
    const rowTitle = workspace.label;
    const secondaryBranch = linked && branchTitle && workspace.label !== branchTitle && workspace.label !== worktreeLabel(branchTitle) ? branchTitle : null;
    // as herdr's own sidebar: a top-level git workspace says its branch on a second line, while an
    // indented worktree (its name already the branch's), a pinned row (the card stays compact; the
    // branch is in its tooltip and menu) and a folder outside git keep one line
    const branchLine = !twoLine && !nested && !pinnedIds.includes(workspace.workspace_id) && branchTitle ? branchTitle : null;
    // the tooltip and the menu keep the exact branch (its slashes) even where the row does not repeat it
    const branchNote = branchTitle && branchTitle !== workspace.label ? branchTitle : null;
    const paths = [...new Set([workspace.worktree?.checkout_path, pane.cwd].filter((path): path is string => Boolean(path)))];
    const worktreesFolded = children.length > 0 && repoKey !== undefined && collapsedWorktrees.has(repoKey);
    const tabsFolded = tabsUnder && collapsedTabs.has(workspace.workspace_id);
    // focus mode folds everything under the row at once, its tab rows and its worktrees
    const collapsed = tabsUnder ? tabsFolded && (children.length === 0 || worktreesFolded) : worktreesFolded;
    // a folded group's parent stands for its worktrees too, as herdr's collapsed parent does:
    // a checkout that waits or has finished must not hide behind the fold
    const foldedPanes = worktreesFolded ? children.flatMap((child) => roster.filter((candidate) => candidate.workspace_id === child.workspace_id)) : [];
    // in focus mode a workspace's own tabs say their states under it: the row says only what its fold hides
    const statusPanes = tabsUnder ? [...(tabsFolded ? panes : []), ...foldedPanes] : [...panes, ...foldedPanes];
    // on two lines the row says what its pane is doing, and the workspace it has named until now sits under that
    const lines = twoLine ? taskRowLines({ paneTitle: displayPaneTitle(pane), labelled: Boolean(pane.label?.trim()), folder: cwdBasename(pane.cwd), workspace: rowTitle, alias: secondaryBranch }) : null;
    // a folded group still shows the checkout that is open; the count is of the ones put away, its
    // folded tab rows with them
    const foldedCount = (worktreesFolded ? children.filter((child) => !roster.some((candidate) => candidate.workspace_id === child.workspace_id && candidate.pane_id === selectedPaneId)).length : 0)
      + (tabsFolded ? snapshot?.tabs.filter((tab) => tab.workspace_id === workspace.workspace_id).length ?? 0 : 0);
    const editingWorkspace = editingWorkspaceId === workspace.workspace_id;
    const fixed = fixedIds.has(workspace.workspace_id);
    const menuOpen = menu?.workspace.workspace_id === workspace.workspace_id;
    const contentsId = `${rosterId}-worktrees-${encodeURIComponent(workspace.workspace_id)}`;
    const tabsId = `${rosterId}-tabs-${encodeURIComponent(workspace.workspace_id)}`;
    const controls = [tabsUnder ? tabsId : null, children.length > 0 ? contentsId : null].filter(Boolean).join(" ") || undefined;
    // a row with linked worktrees under it folds them from the chevron that leads it; in focus mode
    // every row leads with one, and the row itself folds too
    const folds = tabsUnder || (!nested && children.length > 0 && repoKey !== undefined);
    const fold = (next: boolean, every: boolean, pointer: boolean): void => foldRows({ workspace, children }, next, every, pointer);
    const foldLabel = tabsUnder
      ? t(collapsed ? "Expand {name}" : "Collapse {name}", { name: workspace.label })
      : t(collapsed ? "Expand worktrees of {name}" : "Collapse worktrees of {name}", { name: workspace.label });
    const toggleMenu = (anchor: HTMLElement, point?: { x: number; y: number }, previousFocus?: HTMLElement | null): void => setMenu(menuOpen ? null : { anchor, point, previousFocus, workspace, title: rowTitle, place: [branchNote, ...paths].filter(Boolean).join(" · ") || workspace.label });
    return <li
      className={`workspace workspace-group pane-item${selected ? " is-selected" : ""}${collapsed ? " is-collapsed" : ""}${tabsFolded ? " is-tabs-folded" : ""}${dragWorkspaceId === workspace.workspace_id ? " is-dragging" : ""}${touchDrag?.source === workspace.workspace_id ? " is-lifted" : ""}`}
      key={workspace.workspace_id}
      hidden={hidden || undefined}
      data-fold={nested ? "" : undefined}
      data-workspace={workspace.workspace_id}
      data-branch={branchTitle ?? undefined}
      data-drop={drop}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }}
      onDrop={(event) => onDrop(event, workspace.workspace_id)}
    >
      <div className="workspace-header"
        onMouseDownCapture={(event) => { if ((event.button === 2 || (event.button === 0 && event.ctrlKey)) && !(event.target as HTMLElement).closest("input")) event.preventDefault(); }}
        onContextMenu={(event) => onRowContextMenu(event, toggleMenu)}>
        {/* a workspace row leads with its name, over the guide its tabs and worktrees hang from;
            when linked worktrees sit under it, their fold comes first and the name follows it */}
        {folds && <button
          type="button"
          className="sidebar-row-action workspace-toggle"
          aria-label={foldLabel}
          title={`${foldLabel} · ${t("Alt-click: all")}`}
          aria-expanded={!collapsed}
          aria-controls={controls}
          // in focus mode the row is the keyboard's way to the fold; a click keeps the focus where it is
          tabIndex={tabsUnder ? -1 : undefined}
          onMouseDown={(event) => { if (tabsUnder && event.button === 0) event.preventDefault(); }}
          onClick={(event) => fold(!collapsed, event.altKey, event.detail > 0)}
        ><span className="sidebar-mark" aria-hidden="true"><ChevronDown /></span></button>}
        <div
          className="pane-select workspace-select"
          role="button"
          tabIndex={0}
          draggable={!coarsePointer && !editingWorkspace && !fixed}
          onDragStart={(event) => { if (!editingWorkspace) onDragStart(event, workspace.workspace_id, pane.pane_id); }}
          onDragEnd={() => setDragWorkspaceId(null)}
          aria-keyshortcuts={fixed ? undefined : "Alt+ArrowUp Alt+ArrowDown"}
          aria-description={fixed ? undefined : `${t("Reorder workspace {name}", { name: workspace.label })} · ${t("Drag to reorder · Alt+↑/↓")}`}
          data-pane={pane.pane_id}
          aria-current={selected ? "true" : undefined}
          aria-expanded={tabsUnder ? !collapsed : undefined}
          aria-controls={tabsUnder ? controls : undefined}
          title={[`${pane.pane_id} — ${rowTitle}`, branchNote, ...paths, paneTitle(pane), agentsTitle(workspace)].filter(Boolean).join(" — ")}
          // focus mode: the row folds what hangs under it, and its tab rows open the panes
          onMouseDown={(event) => { if (tabsUnder && event.button === 0) focusBeforePress.current = document.activeElement; }}
          onClick={(event) => {
            if (!tabsUnder) { actions.selectPane(pane.pane_id); return; }
            fold(!collapsed, event.altKey, event.detail > 0);
            if (event.detail > 0) giveFocusBack();
          }}
          onKeyDown={(event) => {
            onRowKeyDown(event, workspace.workspace_id);
            if (event.defaultPrevented) return;
            if (tabsUnder && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
              event.preventDefault();
              if ((event.key === "ArrowLeft") !== collapsed) fold(event.key === "ArrowLeft", false, false);
              return;
            }
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            if (tabsUnder) fold(!collapsed, false, false); else actions.selectPane(pane.pane_id);
          }}
        >
          {editingWorkspace ? <input
            className="input workspace-rename-input"
            aria-label={t("Workspace name")}
            autoFocus
            maxLength={MAX_LABEL_CHARS}
            value={workspaceLabel}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => setWorkspaceLabel(event.target.value)}
            onBlur={() => setEditingWorkspaceId(null)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              if (event.key === "Enter") saveWorkspaceRename(workspace.workspace_id);
              if (event.key === "Escape") setEditingWorkspaceId(null);
            }}
          /> : lines ? <span className="workspace-copy is-two-line">
            <span className="workspace-line">
              <span className="workspace-name">{lines.title}</span>
              {foldedCount > 0 && <span className="workspace-fold-count" aria-hidden="true">+{foldedCount}</span>}
            </span>
            {lines.place && <span className="workspace-place">{lines.place}</span>}
          </span> : branchLine ? <span className="workspace-copy is-branch-line">
            <span className="workspace-line">
              <span className="workspace-name">{rowTitle}</span>
              {foldedCount > 0 && <span className="workspace-fold-count" aria-hidden="true">+{foldedCount}</span>}
            </span>
            <span className="workspace-place workspace-branch">{branchLine}</span>
          </span> : <span className="workspace-copy">
            <span className="workspace-name">{rowTitle}</span>
            {secondaryBranch && <span className="worktree-workspace-label">{secondaryBranch}</span>}
            {foldedCount > 0 && <span className="workspace-fold-count" aria-hidden="true">+{foldedCount}</span>}
          </span>}
          <span className="sidebar-pane-meta">
            {online && pane.restore_error ? <RestoreErrorBadge reason={pane.restore_error} /> : <StatusBadge compact status={online ? rollupStatus(statusPanes.map((candidate) => activity.status(machineId, candidate))) : undefined} />}
          </span>
        </div>
        <div className="workspace-actions">
          <button type="button" className="sidebar-row-action row-menu-toggle" aria-label={t("More for {title}", { title: rowTitle })} aria-haspopup="menu" aria-expanded={menuOpen} onClick={(event) => toggleMenu(event.currentTarget)}>
            <Ellipsis aria-hidden="true" />
          </button>
        </div>
        {/* focus mode: the + the bar over the pane had, on the row of the workspace it adds to */}
        {tabsUnder && <button
          type="button"
          className="sidebar-row-action workspace-new-tab"
          aria-label={t("New terminal in {name}", { name: rowTitle })}
          title={t("New terminal in {name}", { name: rowTitle })}
          onClick={() => void actions.openTerminalTab({ machineId, workspaceId: workspace.workspace_id }).catch((reason: unknown) => {
            const failure = userErrorMessage(reason);
            noteError(t("New terminal failed: {reason}", { reason: failure.message }), workspace.workspace_id, failure.detail);
          })}
        ><Plus aria-hidden="true" /></button>}
      </div>
      {tabsUnder && snapshot && <WorkspaceTabs id={tabsId} folded={tabsFolded} snapshot={snapshot} workspace={workspace} panes={panes} selectedPaneId={selectedPaneId} online={online} actions={actions} noteError={noteError} rows={tabRows} />}
      {inlineError?.workspaceId === workspace.workspace_id && <p className="sidebar-inline-error" role="alert">{inlineError.message}{inlineError.detail !== null && <><br /><code>{inlineError.detail}</code></>}</p>}
    </li>;
  };

  /** a top-level row, and a repository's worktrees indented under it */
  const renderGroup = ({ workspace, children }: WorkspaceGroup<WorkspaceInfo>) => {
    const folded = collapsedWorktrees.has(workspace.worktree?.repo_key ?? "");
    const open = (child: WorkspaceInfo): boolean => roster.some((pane) => pane.workspace_id === child.workspace_id && pane.pane_id === selectedPaneId);
    const childrenHidden = folded && !children.some(open);
    // a group moved below this one lands after its worktrees, and the line says so
    const afterChildren = dropMark?.id === workspace.workspace_id && dropMark.children;
    return <Fragment key={workspace.workspace_id}>
      {renderWorkspaceRow(workspace, children, false, dropMark?.id === workspace.workspace_id && (!dropMark.children || childrenHidden) ? dropMark.side : undefined)}
      {children.length > 0 && <li
        className="worktree-children"
        id={`${rosterId}-worktrees-${encodeURIComponent(workspace.workspace_id)}`}
        hidden={childrenHidden}
        data-fold=""
        data-drop={afterChildren && !childrenHidden ? "after" : undefined}
      ><ul className="workspace-list">
        {/* the folded ones stay in the list, hidden, so that they can slide away and back */}
        {children.map((child) => renderWorkspaceRow(child, [], true, dropMark?.id === child.workspace_id ? dropMark.side : undefined, folded && !open(child)))}
      </ul></li>}
    </Fragment>;
  };

  return (
    <div className={`machine-workspaces${twoLine ? " is-two-line" : ""}${tabsUnder ? " is-focus" : ""}${tabRows.drag ? " is-tab-dragging" : ""}${instantFold ? " is-fold-instant" : ""}`} ref={workspaceRoot}>
      <nav className="sidebar-list" aria-label={t("Herdr workspaces")}>
        <>
          <p className={loadingWords === null ? "visually-hidden" : "tree-state"} role="status">{loadingWords}</p>
          {snapshot && snapshot.workspaces.length === 0 && (
            <div className="tree-state-empty">
              <p className="tree-state" role="status">{t("No workspaces yet")}</p>
              <button type="button" className="btn" onClick={() => actions.openNewSession()}><Plus aria-hidden="true" />{t("New workspace")}</button>
            </div>
          )}
          {shownGroups.pinned.some(({ workspace }) => roster.some((pane) => pane.workspace_id === workspace.workspace_id)) && <>
            <p className="sidebar-pinned-label" aria-hidden="true"><span><Pin />{t("Pinned")}</span></p>
            <ul className="workspace-list workspace-list-pinned sidebar-pinned" aria-label={t("Pinned")}>{shownGroups.pinned.map(renderGroup)}</ul>
          </>}
          <ul className="workspace-list">{shownGroups.rest.map(renderGroup)}</ul>
          {inlineError && inlineError.workspaceId === undefined && (
            <p className="sidebar-inline-error" role="alert">{inlineError.message}{inlineError.detail !== null && <><br /><code>{inlineError.detail}</code></>}</p>
          )}
        </>
      </nav>
      {menu && <RowMenu anchor={menu.anchor} point={menu.point} restoreFocusTo={menu.previousFocus} title={menu.title} subtitle={menu.place} items={menuItems(menu)} onClose={closeMenu} />}
      {confirm && <ConfirmDialog title={confirm.title} body={confirm.body} confirmLabel={confirm.action ?? t("Close")} onConfirm={confirm.run} escalation={confirm.escalation} onClose={() => setConfirm(null)} />}
      {worktreeDialog && <WorktreeDialog mode={worktreeDialog.mode} workspace={worktreeDialog.workspace} onClose={() => setWorktreeDialog(null)} onOpened={(opened) => {
        rememberOpened(opened);
        revealOpenedWorkspace.current = opened.workspace_id;
        const repoKey = worktreeDialog.workspace.worktree?.repo_key;
        if (repoKey) setWorktreeCollapsed(repoKey, false);
        setWorktreeDialog(null);
        actions.selectPane(opened.pane_id);
      }} />}
    </div>
  );
}

interface WorkspaceTabsProps {
  /** the list's id, which its workspace row's fold controls */
  id: string;
  /** folded under the workspace's row: the rows stay, hidden (lib/foldMotion.ts) */
  folded: boolean;
  snapshot: SessionSnapshot;
  workspace: WorkspaceInfo;
  /** the workspace's panes on the roster (lib/dagPane.ts) */
  panes: PaneInfo[];
  selectedPaneId: string | null;
  online: boolean;
  actions: AppActions;
  noteError: (message: string, workspaceId?: string, detail?: string | null) => void;
  /** the list's one tab row drag, the moves its menu and keys make, and the move herdr has not shown yet */
  rows: ReturnType<typeof useTabRowDrag<PaneInfo>>;
}

/**
 * Focus mode: a workspace's tabs as rows under it, in herdr's order. A row is what the tab strip's
 * pill is (TabStrip): its pane's mark and the tab's name, and its state in the status cell every
 * sidebar row has. A tab with no agent in it is dimmer: nothing is at work there. A click opens the
 * pane the strip would; the strip's menu is a right-click, Shift+F10 or the context-menu key away,
 * F2 names a tab and Delete closes it. A drag moves a row, and so do Alt+↑/↓ and the menu; a moved
 * row stands in its new place while herdr makes the move.
 */
function WorkspaceTabs({ id, folded, snapshot, workspace, panes, selectedPaneId, online, actions, noteError, rows }: WorkspaceTabsProps) {
  const t = useT();
  const machineId = useMachineId();
  const activity = useSidebarActivity();
  const { closeTab, renameTab } = useMachineApi();
  const list = useRef<HTMLUListElement>(null);
  const [menu, setMenu] = useState<{ anchor: HTMLElement; point?: { x: number; y: number }; previousFocus: HTMLElement | null; tab: HerdrTab } | null>(null);
  const [editing, setEditing] = useState<{ tabId: string; value: string } | null>(null);
  // the name just sent, shown until herdr's snapshot carries it
  const [sent, setSent] = useState<{ tabId: string; label: string } | null>(null);
  const [confirm, setConfirm] = useState<{ tab: HerdrTab; title: string; body: string } | null>(null);
  // what is open now, for a close that answers after another pane was opened
  const selected = useRef(selectedPaneId);
  selected.current = selectedPaneId;
  const tabs = rows.shown(workspace.workspace_id);
  const herdrTabs = snapshot.tabs.filter((tab) => tab.workspace_id === workspace.workspace_id);
  // a tab moved in from another workspace brings its panes along until herdr's order shows it here
  const carry = rows.carry;
  const carriedHere = carry !== null && carry.to === workspace.workspace_id && carry.from !== carry.to;
  const rowPanes = carriedHere ? [...panes, ...carry.panes] : panes;
  const panesOf = (tab: HerdrTab): PaneInfo[] => rowPanes.filter((pane) => pane.tab_id === tab.tab_id);
  const paneFor = (tab: HerdrTab): PaneInfo | undefined => tabPane(panesOf(tab), lastViewedPane("tab", machineId, tab.tab_id),
    snapshot.layouts?.find((layout) => layout.tab_id === tab.tab_id)?.focused_pane_id);
  // herdr's place, which its names of unnamed tabs count: the rows may show a move it has not made yet
  const placeOf = (tab: HerdrTab): number => carry?.tabId === tab.tab_id ? carry.place : herdrTabs.findIndex((candidate) => candidate.tab_id === tab.tab_id) + 1;
  // as the strip names a tab: the name it was given, else what runs in it, else its place
  const nameOf = (tab: HerdrTab): string => {
    if (sent?.tabId === tab.tab_id) return sent.label;
    const pane = paneFor(tab);
    return customTabLabel(tab, placeOf(tab)) ?? (pane ? displayPaneTitle(pane) : tabLabel(tab, t, placeOf(tab)));
  };
  const focusRow = (tabId: string): void => {
    window.requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(tabId)}"]`)?.focus());
  };
  // a row moved by its keys keeps the focus in its new place, once herdr's order shows it there
  const refocus = useRef<string | null>(null);
  const order = tabs.map((tab) => tab.tab_id).join("\n");
  useLayoutEffect(() => {
    const tabId = refocus.current;
    refocus.current = null;
    const row = tabId ? list.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(tabId)}"]`) : null;
    if (row && document.activeElement !== row) row.focus();
  }, [order]);
  useEffect(() => {
    if (!rows.moving) refocus.current = null;
  }, [rows.moving]);

  // the strip, which keeps the pane each tab was last seen on, is not drawn in focus mode
  const openPane = panes.find((pane) => pane.pane_id === selectedPaneId);
  const openTabId = openPane?.tab_id;
  useEffect(() => {
    if (openTabId && selectedPaneId) rememberViewedPane("tab", machineId, openTabId, selectedPaneId);
  }, [machineId, openTabId, selectedPaneId]);

  // tabs that arrive while the rows are on screen enter (Sidebar.css); the ones there when focus mode
  // came on are just there
  const seen = useRef<ReadonlySet<string> | null>(null);
  const arrived = (tabId: string): boolean => seen.current !== null && !seen.current.has(tabId) && !rows.arrivedByMove(tabId);
  useLayoutEffect(() => {
    seen.current = new Set(tabs.map((tab) => tab.tab_id));
  });

  // a menu, a name field or a question whose tab left (closed in the TUI) goes with it
  useEffect(() => {
    const here = (tabId: string): boolean => tabs.some((tab) => tab.tab_id === tabId);
    if (menu && !here(menu.tab.tab_id)) setMenu(null);
    if (editing && !here(editing.tabId)) setEditing(null);
    if (confirm && !here(confirm.tab.tab_id)) setConfirm(null);
    if (sent && tabs.find((tab) => tab.tab_id === sent.tabId)?.label.trim() === sent.label) setSent(null);
  });
  // a name herdr never showed back (renamed again elsewhere) does not stay on the row
  useEffect(() => {
    if (!sent) return;
    const timer = window.setTimeout(() => setSent(null), 8000);
    return () => window.clearTimeout(timer);
  }, [sent]);

  const beginRename = (tab: HerdrTab): void => {
    setEditing({ tabId: tab.tab_id, value: sent?.tabId === tab.tab_id ? sent.label : customTabLabel(tab, placeOf(tab)) ?? "" });
  };
  // an empty name is not sent: herdr would keep it, and its own tab row would show nothing
  const saveRename = (tab: HerdrTab): void => {
    const label = editing?.value.trim() ?? "";
    if (label === "") { noteError(t("A tab needs a name."), workspace.workspace_id); return; }
    setEditing(null);
    focusRow(tab.tab_id);
    if (label === nameOf(tab)) return;
    setSent({ tabId: tab.tab_id, label });
    void renameTab(tab.tab_id, label).catch((reason: unknown) => {
      setSent((current) => current?.tabId === tab.tab_id ? null : current);
      const failure = userErrorMessage(reason);
      noteError(t("Rename failed: {reason}", { reason: failure.message }), workspace.workspace_id, failure.detail);
    });
  };

  // the tab beside a closed open one takes its place, and the focus with it
  const close = async (tab: HerdrTab): Promise<void> => {
    const index = tabs.findIndex((candidate) => candidate.tab_id === tab.tab_id);
    const beside = tabs[index + 1] ?? tabs[index - 1];
    const besidePane = beside ? paneFor(beside) : undefined;
    const ownIds = panesOf(tab).map((pane) => pane.pane_id);
    const hadFocus = list.current?.contains(document.activeElement) === true;
    // the open tab goes at once, its terminal with it: the tab beside it opens before herdr answers
    if (besidePane && selected.current !== null && ownIds.includes(selected.current)) actions.selectPane(besidePane.pane_id);
    await closeTab(tab.tab_id);
    // the last tab took its workspace, and these rows, with it: focus goes where a closed row's goes
    if (!beside) { if (hadFocus) focusWorkspaceListToggle(); return; }
    if (hadFocus) focusRow(beside.tab_id);
  };
  const requestClose = (tab: HerdrTab): void => {
    // a turn that waits on its background work would lose that work too
    if (!tabCloseAsks(panesOf(tab) as HerdrPane[], tabs.length)) {
      void close(tab).catch((reason: unknown) => {
        const failure = userErrorMessage(reason);
        noteError(t("Close failed: {reason}", { reason: failure.message }), workspace.workspace_id, failure.detail);
      });
      return;
    }
    setConfirm({
      tab,
      title: t("Close tab {name}?", { name: nameOf(tab) }),
      body: tabs.length > 1
        ? t("An agent in it is still at work, and stops with the tab.")
        : t("It is the last tab of {workspace}: the workspace closes with it, and the agents and shells in it stop.", { workspace: workspace.label }),
    });
  };

  const menuItems = (tab: HerdrTab): RowMenuItem[] => [
    { id: "rename-tab", label: t("Rename tab"), icon: Pencil, run: () => beginRename(tab) },
    ...(!rows.moving && placeOf(tab) > 1
      ? [{ id: "move-up", label: t("Move tab up"), icon: ArrowUp, run: () => rows.moveAdjacent(tab.tab_id, workspace.workspace_id, -1) }] : []),
    ...(!rows.moving && placeOf(tab) < tabs.length
      ? [{ id: "move-down", label: t("Move tab down"), icon: ArrowDown, run: () => rows.moveAdjacent(tab.tab_id, workspace.workspace_id, 1) }] : []),
    { id: "close-tab", label: t("Close tab"), icon: X, danger: true, run: () => requestClose(tab) },
  ];
  const openMenu = (event: MouseEvent<HTMLButtonElement>, tab: HerdrTab): void => {
    event.preventDefault();
    rows.cancelDrag();
    setMenu({ anchor: event.currentTarget, tab, point: event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : undefined,
      previousFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    const row = event.target as HTMLElement;
    const tab = tabs.find((candidate) => candidate.tab_id === row.dataset["tabId"]);
    if (!tab) return;
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      event.preventDefault();
      if (!event.repeat) setMenu({ anchor: row, tab, previousFocus: row });
      return;
    }
    // as a workspace row moves among the workspaces
    if (event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      if (event.repeat) return;
      refocus.current = tab.tab_id;
      rows.moveAdjacent(tab.tab_id, workspace.workspace_id, event.key === "ArrowUp" ? -1 : 1);
      return;
    }
    if (event.key !== "F2" && event.key !== "Delete") return;
    event.preventDefault();
    // a held key is one press: the focus moves to the row beside a closed one
    if (event.repeat) return;
    if (event.key === "F2") beginRename(tab); else requestClose(tab);
  };

  return (
    <>
      <ul ref={list} id={id} hidden={folded} data-fold="" className="workspace-tabs" data-workspace={workspace.workspace_id} aria-label={t("Tabs of {workspace}", { workspace: workspace.label })} aria-busy={rows.moving} onKeyDown={onKeyDown}
        data-vacated={rows.drag?.away && rows.drag.workspaceId === workspace.workspace_id ? t("New shell") : undefined}>
        {tabs.map((tab, index) => {
          const own = panesOf(tab);
          const pane = paneFor(tab);
          if (!pane) return null;
          const name = nameOf(tab);
          const carried = carry?.tabId === tab.tab_id;
          // herdr moves the open pane before it answers: the moved row stays the open one meanwhile
          const open = carry?.open ? carried : own.some((candidate) => candidate.pane_id === selectedPaneId);
          const quiet = !own.some((candidate) => candidate.agent);
          const status = online ? rollupStatus(own.map((candidate) => activity.status(machineId, candidate))) : undefined;
          return (
            <li key={tab.tab_id} className={`workspace-tab${open ? " is-selected" : ""}${quiet ? " is-quiet" : ""}${arrived(tab.tab_id) ? " is-new" : ""}${rows.drag?.tabId === tab.tab_id ? " is-lifted" : ""}${carried ? " is-carried" : ""}`}
              data-key={tab.tab_id} data-index={index}>
              {editing?.tabId === tab.tab_id ? (
                <input
                  className="input workspace-tab-rename"
                  aria-label={t("Tab name")}
                  autoFocus
                  maxLength={MAX_LABEL_CHARS}
                  placeholder={name}
                  value={editing.value}
                  onFocus={(event) => event.currentTarget.select()}
                  onChange={(event) => setEditing({ tabId: tab.tab_id, value: event.target.value })}
                  onBlur={() => setEditing(null)}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    // an IME's Enter and Escape are the composition's, not the field's
                    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                    if (event.key === "Enter") saveRename(tab);
                    if (event.key === "Escape") { setEditing(null); focusRow(tab.tab_id); }
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="workspace-tab-select"
                  data-tab-id={tab.tab_id}
                  aria-current={open ? "true" : undefined}
                  aria-haspopup="menu"
                  aria-keyshortcuts="Shift+F10 F2 Delete Alt+ArrowUp Alt+ArrowDown"
                  aria-description={tabs.length > 1 ? t("Drag to reorder · Alt+↑/↓") : undefined}
                  title={own.length === 1 ? displayPaneTitle(pane) : t("{n} panes", { n: own.length })}
                  onMouseDown={(event) => { if (event.button === 2 || (event.button === 0 && event.ctrlKey)) event.preventDefault(); }}
                  onPointerDown={(event) => rows.onPointerDown(event, tab.tab_id, workspace.workspace_id)}
                  onPointerMove={rows.onPointerMove}
                  onPointerUp={rows.onPointerUp}
                  onPointerCancel={rows.cancelDrag}
                  onLostPointerCapture={rows.cancelDrag}
                  // a row on its way has panes on their way too: it opens once herdr has moved them
                  onClick={(event) => { if (!rows.consumeClick(event.detail) && !event.ctrlKey && !carried) actions.selectPane(pane.pane_id); }}
                  onDoubleClick={() => beginRename(tab)}
                  onContextMenu={(event) => openMenu(event, tab)}
                  // the middle button closes a tab, as it does a browser's
                  onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); requestClose(tab); } }}
                >
                  <span className="workspace-tab-mark" aria-hidden="true">{pane.agent ? <AgentMark agent={pane.agent} size={14} /> : <SquareTerminal />}</span>
                  <span className="workspace-tab-name">{name}</span>
                  {carried ? <MovingBadge /> : online && pane.restore_error ? <RestoreErrorBadge reason={pane.restore_error} /> : <StatusBadge compact status={status} />}
                </button>
              )}
            </li>
          );
        })}
        {/* its last tab gone, a workspace keeps a new shell the bridge opens first (server/tab-transfer.ts) */}
        {carry && carry.from === workspace.workspace_id && carry.to !== carry.from && tabs.length === 0 && <li className="workspace-tab is-quiet is-placeholder">
          <span className="workspace-tab-select">
            <span className="workspace-tab-mark" aria-hidden="true"><SquareTerminal /></span>
            <span className="workspace-tab-name">{t("New shell")}</span>
            <MovingBadge />
          </span>
        </li>}
      </ul>
      {menu && <RowMenu anchor={menu.anchor} point={menu.point} restoreFocusTo={menu.previousFocus} title={nameOf(menu.tab)} items={menuItems(menu.tab)} align="start" onClose={() => setMenu(null)} />}
      {confirm && <ConfirmDialog title={confirm.title} body={confirm.body} confirmLabel={t("Close tab")} onConfirm={async () => { await close(confirm.tab); setConfirm(null); }} onClose={() => setConfirm(null)} />}
    </>
  );
}

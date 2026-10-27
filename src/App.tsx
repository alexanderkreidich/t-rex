import { type CSSProperties, type DragEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Menu, PanelLeft, X } from "lucide-react";

import type { AgentStatus, ServerMessage, AccessRefusal, HealthAuth, HerdrPane } from "../shared/protocol.ts";
import { ApiError, authenticate, createTab, createWorkspace, fetchHealth, fetchBridgeHealth, fetchMachines, fetchSession, pairDevice, routeMissing, sendTestPush, signOut, splitPane, zoomPane, type HealthInfo } from "./lib/api.ts";
import { deviceLabel, takePairCode } from "./lib/phone.ts";
import { alertPaneTitle, displayPaneTitle } from "./components/Sidebar.tsx";
import { PaneCanvas } from "./components/PaneCanvas.tsx";
import { MachineSessionsProvider } from "./lib/machineSessionContext.tsx";
import { PaneTerminal } from "./components/PaneTerminal.tsx";
import { paneCovered, paneContentKey, paneContentPresented } from "./lib/panePresentation.ts";
import { PANE_TABPANEL_ID, paneTabPanelLabel } from "./lib/paneRegion.ts";
import { AccessGate } from "./components/AccessGate.tsx";
import { passingFolder, recentDirectories } from "./lib/recent-directories.ts";
import { usePreferencesSync } from "./lib/preferencesSync.ts";
import { TabStrip } from "./components/TabStrip.tsx";
import { SettingsDialog } from "./components/SettingsDialog.tsx";
import { loadedOnSettingsEntry, onSettingsHistory, recordSettings, settingsEntry } from "./lib/settingsHistory.ts";
import { sheetSteppedOff } from "./lib/sheetHistory.ts";
import { isNavigation, linkSearch, linksSomewhere, NAV_KEY, readLink, resolveLink, slugOf, type AppLink, type LinkNote } from "./lib/deepLink.ts";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { paletteOpenQuery } from "./lib/paletteSeed.ts";
import { MachineContext } from "./lib/machineContext.tsx";
import { MachineActionBanner, MachineSidebar } from "./components/MachineSidebar.tsx";
import { SidebarResizer } from "./components/SidebarResizer.tsx";
import { storedSidebarWidth } from "./lib/sidebarWidth.ts";
import { MachineDialog } from "./components/MachineDialog.tsx";
import type { RowMenuItem } from "./components/RowMenu.tsx";
import { focusWorkspaceListToggle } from "./lib/focus.ts";
import { paneStorageId, type Machine, type MachineEvent } from "../shared/machines.ts";
import { takeAuthTokenFromUrl } from "./lib/authLink.ts";
import { applyPaneStatus } from "./lib/snapshot.ts";
import { rosterPanes } from "./lib/dagPane.ts";
import { CreatedTabs } from "./lib/createdTabs.ts";
import { SnapshotRequests } from "./lib/snapshotRequests.ts";
import { alertPrefs, useSettings } from "./lib/settings.ts";
import { formatKeys, shortcutDisplayKeys, useShortcuts } from "./lib/shortcuts.ts";
import { useMediaQuery } from "./lib/useMediaQuery.ts";
import { useAnnouncedText } from "./lib/useAnnouncedText.ts";
import { paneContextPress } from "./lib/paneCanvas.ts";
import type { AppActions, PaneControls } from "./lib/actions.ts";
import {
  notificationState,
  paneNotificationHeading,
  requestNotificationPermission,
  shouldNotifyStatus,
  alertStatus,
  alertsAllow,
  showPaneEndedNotification,
  showPaneStatusNotification,
  type NotificationState,
} from "./lib/notifications.ts";
import { ensurePushSubscription, pushSupported, removePushSubscription } from "./lib/push.ts";
import { machineGone, notificationLanding, sameLink, onNotificationTarget, type NotificationTarget } from "./lib/notificationTarget.ts";
import { nativeNotifications } from "./lib/nativeNotifications.ts";
import { useUpdates } from "./lib/updates.ts";
import { UpdateNotice } from "./components/UpdateControls.tsx";
import { LanExposureNotice } from "./components/LanExposureNotice.tsx";
import { useT } from "./lib/i18n.ts";
import { markSelection, selectionStill, type SelectionMark } from "./lib/selectionMark.ts";
import { userErrorMessage } from "./lib/userError.ts";
import { useScreenWakeLock } from "./lib/wakeLock.ts";
import { watchDrawerSwipe } from "./lib/edgeSwipe.ts";
import { seedStatuses } from "./lib/statusBaseline.ts";
import { dockPane, draggedPane, paneDragData, dropSide, otherSlot, PANE_DRAG_TYPE, sameTarget, slotSide, storedSplit, storeSplit, type SplitSide, type SplitSlot, type SplitState, type SplitTarget } from "./lib/split.ts";
import { paneDrag } from "./lib/paneDrag.ts";
import { PaneFollowContext } from "./lib/paneSubmitContext.ts";
import { SplitDropPreview } from "./components/SplitDropPreview.tsx";
import { CrashProbe, RegionCrash } from "./components/AppCrash.tsx";
import { RenderBoundary } from "./components/RenderBoundary.tsx";

const APP_TITLE = "T-Rex";
/** how soon after a key press a focus counts as the user's own (lastKeyAtRef) */
const KEY_FOCUS_MS = 1000;
const POLL_MS = 5000;

/**
 * Polls and the event stream hand over fresh objects every few seconds even when nothing
 * changed; storing them re-rendered the whole app each time.
 */
function sameData(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}
/** trailing debounce for push-triggered refetches: bursts of events become one fetch */
const REFETCH_DEBOUNCE_MS = 500;

const SELECTION_KEY = "t-rex:selection";
type StoredSelection = { machine_id?: string; pane_id?: string | null };

/**
 * The pane to open: this window's own (sessionStorage is per window and survives
 * its reloads), else the last one any window showed, for a newly opened window.
 */
function storedSelection(): StoredSelection | null {
  for (const storage of ["sessionStorage", "localStorage"] as const) {
    try {
      const value: unknown = JSON.parse(window[storage].getItem(SELECTION_KEY) ?? "null");
      if (value !== null && typeof value === "object") return value as StoredSelection;
    } catch {
      /* private mode */
    }
  }
  return null;
}

function storeSelection(machineId: string, paneId: string | null): void {
  for (const storage of ["sessionStorage", "localStorage"] as const) {
    try { window[storage].setItem(SELECTION_KEY, JSON.stringify({ machine_id: machineId, pane_id: paneId })); } catch {}
  }
}

/** Drawn into `host` when there is one (the header's tab bar), else in place. */
function portalTo(host: HTMLElement | null, node: ReactNode): ReactNode {
  return host ? createPortal(node, host) : node;
}

/** Slot b of the split draws on connections of its own: both halves may attach one tab, and each
 *  attaches and detaches it as the other is not there (lib/split.ts). */
function SlotSessions({ slot, machineIds, children }: { slot: SplitSlot; machineIds: readonly string[]; children: ReactNode }) {
  return slot === "b" ? <MachineSessionsProvider machineIds={machineIds}>{children}</MachineSessionsProvider> : <>{children}</>;
}

/** The header's note, at the bar's end: a link that could not open what it named. Its status is in the
    header from the header's first render, clipped while empty (never display: none, as the connection
    chip), and its words land a frame after the box, even the ones a page opens with (lib/useAnnouncedText.ts). */
function HeaderNote({ note }: { note: string | null }) {
  const shown = useAnnouncedText(note);
  return (
    <span className={shown === null ? "visually-hidden" : "pill header-note"} role="status" style={{ minWidth: 0 }}>
      <span className="header-note-text">{shown}</span>
    </span>
  );
}

/** The connecting shell's one sidebar line: the same announced status as every other (lib/useAnnouncedText.ts). */
function ConnectingNote() {
  const t = useT();
  const shown = useAnnouncedText(t("Connecting…"));
  return <p className={shown === null ? "visually-hidden" : "tree-state"} role="status">{shown}</p>;
}

/** The header's connection chip. It speaks only while the bridge is not live; live, it stays in the document
    for a screen reader (and the browser scripts that wait on it), drawn by nothing (styles.css). Its word lands
    a frame after the chip (lib/useAnnouncedText.ts), as every status line's does. */
function ConnectionChip({ connected, word, title }: { connected: boolean; word: string; title: string | undefined }) {
  const shown = useAnnouncedText(word);
  return (
    <span className={`conn ${connected ? "conn-live" : "conn-reconnecting"}`} role="status" title={title}>
      <span className="conn-dot" aria-hidden="true" />
      <span className="conn-text">{shown}</span>
    </span>
  );
}

export function App() {
  const t = useT();
  const apple = /Mac|iPhone|iPad/.test(navigator.platform);
  const { settings, resolvedTheme, resolvedEntry, update: updateSettings } = useSettings();
  // this device's alert choices: sent with its push subscription, and applied to tab alerts here
  const alerts = useMemo(() => alertPrefs(settings), [settings.alertInput, settings.alertDone]);
  const alertsRef = useRef(alerts);
  alertsRef.current = alerts;
  // the Alerts item's switch for this device (the header's More menu): off drops its push subscription and silences tab and in-app alerts
  const alertsOn = settings.alertsOn;
  const alertsOnRef = useRef(alertsOn);
  alertsOnRef.current = alertsOn;
  const [machines, setMachines] = useState<Machine[]>([]);
  const [machineRosterLoaded, setMachineRosterLoaded] = useState(false);
  // the place the address names, read once at load: a link wins over this window's last selection
  const [initialLink] = useState(() => {
    if (!linksSomewhere(window.location.search)) return null;
    const link = readLink(window.location.search);
    // a load onto an entry Settings left (a reload) steps out of it (lib/settingsHistory.ts): the
    // dialog its address names, on that entry or on the one stepped back to, is the one it closed
    return loadedOnSettingsEntry() ? { ...link, settings: null, section: null } : link;
  });
  // New workspace's recent folders also know where a PC's panes are: kept behind the folders started in
  useEffect(() => {
    for (const machine of machines) {
      if (machine.state !== "connected" || !machine.snapshot) continue;
      // a worktree's checkout or a temporary folder is no project to start a workspace in
      const linked = machine.snapshot.workspaces.filter((workspace) => workspace.worktree?.is_linked_worktree);
      const inLinked = new Set(linked.map((workspace) => workspace.workspace_id));
      const worktrees = linked.map((workspace) => workspace.worktree!.checkout_path);
      recentDirectories.remember(machine.id, machine.snapshot.panes
        .filter((pane) => !pane.restore_error && !inLinked.has(pane.workspace_id) && !(pane.cwd && passingFolder(pane.cwd, worktrees)))
        .map((pane) => pane.cwd).reverse());
    }
  }, [machines]);
  const [selectedMachineId, setSelectedMachineId] = useState(() => {
    if (initialLink && (initialLink.pane || initialLink.workspace)) return initialLink.machine;
    return storedSelection()?.machine_id ?? "local";
  });
  const selectedMachine = machines.find((m) => m.id === selectedMachineId);
  // the PCs the switcher and the notices show: the Host alone until remote PCs are turned on (Settings → Remote PCs),
  // and the PC on screen whatever the setting (a link can open one)
  const shownMachines = settings.showRemotePcs ? machines : machines.filter((machine) => machine.kind === "local" || machine.id === selectedMachineId);
  const snapshot = selectedMachine?.snapshot ?? null;
  const machinesRef = useRef(machines); machinesRef.current = machines;
  const [updateRemote, setUpdateRemote] = useState(false);
  const [machineDialog, setMachineDialog] = useState<Machine | "new" | null>(null);
  // Add PC from Settings or the palette leaves no trigger to return focus to once its dialog
  // closes (Settings closed when it opened): the header's workspace-list toggle stands in
  const addPcFocusReturn = useRef(false);
  const closeMachineDialog = useCallback(() => {
    setMachineDialog(null);
    if (!addPcFocusReturn.current) return;
    addPcFocusReturn.current = false;
    focusWorkspaceListToggle();
  }, []);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  // a palette layout call a PC's bridge could not take: a line over the pane, gone after a moment as the tab strip's is
  const [layoutNotice, setLayoutNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!layoutNotice) return;
    const timer = window.setTimeout(() => setLayoutNotice(null), 6000);
    return () => window.clearTimeout(timer);
  }, [layoutNotice]);
  // null until the server has said whether it wants a token: the shell, and with it
  // the WebSocket, never mounts before that is known
  const [locked, setLocked] = useState<boolean | null>(null);
  const [lockReason, setLockReason] = useState<AccessRefusal | null>(null);
  /** the code a scanned QR brought along (`?pair=CODE`), taken off the address at once */
  const [pairCode] = useState(() => takePairCode());
  const [auth, setAuth] = useState<HealthAuth | null>(null);
  // a token a proxy sends with every request comes back right after signing out: signing out is the proxy's
  const canSignOut = auth?.authenticated === true && (auth.via === "device" || (auth.via === "token" && auth.bearer !== true));
  // a device that is in only because nothing is paired yet still pairs from the QR code's address
  const pairedFromAddress = useRef(false);
  useEffect(() => {
    if (locked !== false || pairCode === "" || pairedFromAddress.current || auth?.via === "device") return;
    pairedFromAddress.current = true;
    pairDevice(pairCode, deviceLabel(navigator.userAgent, navigator.maxTouchPoints ?? 0)).then(() => loadHealth()).catch(() => { /* the gate, if any, reports it */ });
  }, [locked, pairCode, auth]); // eslint-disable-line react-hooks/exhaustive-deps
  const updates = useUpdates(locked === false);
  const [selectedPaneId, setSelectedPaneId] = useState<string | null>(() => {
    if (initialLink?.pane) return initialLink.pane;
    // a link to a workspace opens the pane its row opens, once the roster is in (below)
    if (initialLink?.workspace) return null;
    return storedSelection()?.pane_id ?? null;
  });
  // the place a link named, settled against the PC's roster once it is in (lib/deepLink.ts resolveLink)
  const pendingLink = useRef<AppLink | null>(initialLink && (initialLink.pane || initialLink.workspace) ? initialLink : null);
  // state, not only the ref: what waits on the link landing (the address) runs again when it does
  const [linkLanded, setLinkLanded] = useState(() => pendingLink.current === null);
  // A PC is gone only by a roster the server sent after it was named (lib/notificationTarget.ts
  // machineGone): the count of rosters in, and the count when the pending link and the selection
  // were made (a remembered selection: 0, so the first roster checks it)
  const rosterSeq = useRef(0);
  const linkSince = useRef(0);
  const selectionSince = useRef(0);
  // the checks run again on a roster that came in while a link waits (the same list, kept as it
  // was, changes nothing they watch), and on a link a tap set (its pane may be the one selected)
  const [rosterTick, setRosterTick] = useState(0);
  const [linkTick, setLinkTick] = useState(0);
  // a split half whose pane the PC could not be asked about is checked again on the next roster
  const otherRecheck = useRef(false);
  const [otherRosterTick, setOtherRosterTick] = useState(0);
  const rosterIn = useCallback((): void => {
    rosterSeq.current += 1;
    if (pendingLink.current !== null) setRosterTick(rosterSeq.current);
    if (otherRecheck.current) { otherRecheck.current = false; setOtherRosterTick(rosterSeq.current); }
  }, []);
  // the workspace a tapped alert named for the pane it selected at once: a roster in hand may
  // still list a pane that has ended (a phone resumed from the background), and when the next
  // one drops it, that workspace opens with a word, as a link's does. Any other pick clears it.
  const selectionHint = useRef<{ machine: string; pane: string; workspace: string } | null>(null);
  // a short word in the header: a link that could not open what it named, or a link copied
  const [headerNote, setHeaderNote] = useState<LinkNote | "copied" | null>(null);
  useEffect(() => {
    if (headerNote === null) return;
    const timer = window.setTimeout(() => setHeaderNote(null), headerNote === "copied" ? 1600 : 8000);
    return () => window.clearTimeout(timer);
  }, [headerNote]);
  // the note that stands where the title does: a link that could not open what it named or was
  // copied, or a link waiting for its PC's roster before it can open what it named (HeaderNote)
  const note = headerNote
    ? t(headerNote === "copied" ? "Link copied" : headerNote === "pane-closed" ? "That agent has closed: its workspace is open" : headerNote === "machine-missing" ? "That link's PC is not set up here" : "That link's workspace is closed")
    : !linkLanded ? t("Opening link…") : null;
  // App picked the selected pane itself because the one selected closed: it must not raise a
  // phone's keyboard (over the drawer the close was tapped in) until the user picks a pane
  const [autoSelected, setAutoSelected] = useState(false);
  // counts the user's picks of a pane, the open one again too (its row, its tab): each hands its terminal the keyboard
  const [focusRequest, setFocusRequest] = useState(0);
  // a phone opened by a link that says so starts with its drawer out (lib/deepLink.ts)
  const [drawerOpen, setDrawerOpen] = useState(() => initialLink?.sidebar === "shown" && window.matchMedia?.("(min-width: 769px)").matches !== true);
  const drawerOpenRef = useRef(drawerOpen); drawerOpenRef.current = drawerOpen;
  // from 769px the drawer is a plain sidebar column and its toggle is hidden, so a drawer a
  // narrow window opened must not come back (with its scrim) the next time the window narrows
  const wideScreen = useMediaQuery("(min-width: 769px)");
  useEffect(() => { if (wideScreen) setDrawerOpen(false); }, [wideScreen]);
  // with a generation (lib/selectionMark.ts): a call that answers after the user opened another pane or PC leaves
  // the selection alone. Marked at commit, not in render: a render React throws away (Strict Mode, a replay)
  // must not move the generation on, and every reader runs from an event or a reply, after the commit
  const selectionRef = useRef<SelectionMark>({ machineId: selectedMachineId, paneId: selectedPaneId, generation: 0 });
  useLayoutEffect(() => {
    selectionRef.current = markSelection(selectionRef.current, selectedMachineId, selectedPaneId);
  }, [selectedMachineId, selectedPaneId]);
  // on a phone the drawer follows a swipe in from the left edge, and a swipe back (lib/edgeSwipe.ts)
  useEffect(() => watchDrawerSwipe(() => drawerOpenRef.current, setDrawerOpen), []);
  // Escape puts the open drawer away and goes no further: in the capture phase, so a terminal that kept the
  // focus never receives it. A dialog or an IME composition on top keeps its own Escape
  useEffect(() => {
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || !drawerOpenRef.current || event.isComposing || event.keyCode === 229) return;
      if (document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      event.stopPropagation();
      setDrawerOpen(false);
    };
    window.addEventListener("keydown", onEscape, true);
    return () => window.removeEventListener("keydown", onEscape, true);
  }, []);
  // a desktop opened by a link that says so starts with the sidebar collapsed, and the address says so while it is
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => initialLink?.sidebar === "hidden");
  // the width the sidebar's edge was dragged to on this device; null is the density's own
  const [sidebarWidth, setSidebarWidth] = useState(storedSidebarWidth);
  // two tabs side by side (lib/split.ts): the other half's pane, its side, and the active slot.
  // Only drawn where the sidebar stands beside the pane; a narrower window shows the active half
  const [split, setSplitState] = useState<SplitState | null>(storedSplit);
  const setSplit = useCallback((next: SplitState | null) => {
    setSplitState(next);
    storeSplit(next);
  }, []);
  // the slot a single pane is drawn in: the half left when a split ends keeps its slot, and with it
  // its terminals' connections
  const [soloSlot, setSoloSlot] = useState<SplitSlot>(() => storedSplit()?.active ?? "a");
  const endSplit = useCallback((remaining: SplitSlot) => {
    setSplit(null);
    setSoloSlot(remaining);
  }, [setSplit]);
  const splitRef = useRef(split); splitRef.current = split;
  // whether the other half is drawn: a narrow window keeps the split but shows the active half alone
  const splitShownRef = useRef(false);
  // when a key was last pressed: a focus moving into the other half makes it active only right after
  // one (a Tab), never when the app's own code moves the focus (an upload that finished)
  const lastKeyAtRef = useRef(0);
  useEffect(() => {
    const onKey = (): void => { lastKeyAtRef.current = Date.now(); };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  // the guide appears as soon as a pane is picked up; a target is chosen only over the area
  const [paneDragging, setPaneDragging] = useState(false);
  const [dropAt, setDropAt] = useState<SplitSide | null>(null);
  const dropAtRef = useRef<SplitSide | null>(null);
  const showDropTarget = useCallback((side: SplitSide | null): void => {
    dropAtRef.current = side;
    setDropAt(side);
  }, []);
  const clearDropPreview = useCallback((): void => {
    setPaneDragging(false);
    showDropTarget(null);
  }, [showDropTarget]);
  const paneAreaRef = useRef<HTMLDivElement>(null);
  // a tab dragged out of its strip (lib/paneDrag.ts)
  const tabDrag = useSyncExternalStore(paneDrag.subscribe, paneDrag.snapshot);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const openPalette = useCallback((query?: unknown) => { setPaletteQuery(paletteOpenQuery(query)); setPaletteOpen(true); }, []);
  const paneControls = useRef<PaneControls | null>(null);
  const [findRequest, setFindRequest] = useState<{ paneId: string | null; serial: number }>({ paneId: null, serial: 0 });
  // the pane canvas's actions, for the phone's tab menu (TabStrip)
  const paneActionsRef = useRef<((target: HerdrPane) => RowMenuItem[]) | null>(null);
  // a link to Settings opens it on its page, for that first opening alone
  const [settingsOpen, setSettingsOpen] = useState(() => initialLink?.settings != null);
  const [settingsLinkPage, setSettingsLinkPage] = useState<string | null>(() => initialLink?.settings ?? null);
  // the group on that page a link named: in the address while that page is shown
  const [settingsLinkSection, setSettingsLinkSection] = useState<string | null>(() => initialLink?.section ?? null);
  // the page Settings shows, for the address
  const [settingsPage, setSettingsPage] = useState<string | null>(null);
  // set by a button that points at one section of Settings, for that opening alone
  const [settingsSection, setSettingsSection] = useState<"updates" | null>(null);
  const closeSettings = useCallback(() => { setSettingsOpen(false); setSettingsSection(null); setSettingsLinkPage(null); setSettingsLinkSection(null); setSettingsPage(null); }, []);
  const settingsLinkPageRef = useRef(settingsLinkPage); settingsLinkPageRef.current = settingsLinkPage;
  const onSettingsPage = useCallback((page: string | null) => {
    setSettingsPage(page);
    if (page !== settingsLinkPageRef.current) setSettingsLinkSection(null);
  }, []);
  // Settings is in the history (lib/settingsHistory.ts): Back out of its last entry closes it,
  // Forward onto one opens it again, and closing it any other way takes its entries off
  useEffect(() => onSettingsHistory((entry, own) => {
    if (own) return;
    if (entry === null) closeSettings();
    else setSettingsOpen(true);
  }), [closeSettings]);
  useEffect(() => { if (!settingsOpen) recordSettings([]); }, [settingsOpen]);
  // a new workspace herdr has not answered for yet: another press makes no second one
  const creatingWorkspace = useRef(false);
  const [connected, setConnected] = useState(false);
  /** the active terminal's socket has been connected on this page before (PaneTerminal reports it): not
   *  connected, the chip says reconnecting; before this page's first connection to the PC, connecting */
  const [connectedBefore, setConnectedBefore] = useState(false);
  // the active slot's pane could not be drawn: no terminal is attached there to say so itself
  const paneLost = useCallback(() => setConnected(false), []);
  const [outputStopped, setOutputStopped] = useState(false);
  const [notifications, setNotifications] = useState<NotificationState>(() => notificationState());
  // this device has a server-side push subscription: alerts come from the server, not the tab
  const [pushOn, setPushOn] = useState(false);
  const pushOnRef = useRef(pushOn);
  pushOnRef.current = pushOn;
  // the shared settings and pins, the same in every browser of this server, once the app is in
  const { receive: receivePreferences, saveError: settingsSaveError } = usePreferencesSync(locked === false);
  const receivePreferencesRef = useRef(receivePreferences); receivePreferencesRef.current = receivePreferences;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  // last-seen agent status per pane: the baseline that decides whether a push is news
  const statusRef = useRef<Map<string, AgentStatus>>(new Map());
  const refetchTimer = useRef<number | null>(null);
  const snapshotRef = useRef<typeof snapshot>(null);
  snapshotRef.current = snapshot;

  const loadHealth = useCallback(async () => {
    try { const next = await fetchBridgeHealth(); setLocked(next.auth.required && !next.auth.authenticated); setLockReason(next.auth.reason ?? null); setAuth((previous) => sameData(previous, next.auth) ? previous : next.auth); }
    catch { /* retain the gate while the connection server restarts */ }
    try { const next = await fetchHealth(); setHealth((previous) => sameData(previous, next) ? previous : next); } catch { setHealth(null); }
  }, []);
  const snapshotRequests = useRef(new SnapshotRequests());
  const createdTabs = useRef(new CreatedTabs());
  /** the roster's event stream: while it is open it brings every change, and the poll leaves the roster to it */
  const machineEvents = useRef<EventSource | null>(null);
  const load = useCallback(async () => {
    try {
      await snapshotRequests.current.read(fetchMachines, (received) => {
        const next = createdTabs.current.apply(received);
        setMachines((previous) => sameData(previous, next) ? previous : next);
        rosterIn();
        setMachineRosterLoaded(true);
        setError(null); setLocked(false);
      });
    }
    catch (err) {
      if (err instanceof ApiError && err.status === 401) { setLocked(true); return; }
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [rosterIn]);

  useEffect(() => {
    const tick = (returned = false): void => {
      // a hidden tab (or a phone app in the background) polls nothing; it catches up on return
      if (document.visibilityState === "hidden") return;
      void loadHealth();
      // a locked tab only watches health, so a token entered in another tab still unlocks it.
      // The open event stream brings the roster; a page coming back reads it anyway, as its
      // stream may have died unnoticed while it was away
      const streamed = machineEvents.current?.readyState === EventSource.OPEN;
      if (lockedRef.current !== true && (returned || !streamed)) void load();
    };
    let timer = 0;
    let disposed = false;
    void (async (): Promise<void> => {
      // a bookmarked `#auth=<token>` link unlocks without typing; the fragment is
      // stripped before anything renders, and a stale token falls through to the
      // gate the first health check mounts
      const linkToken = takeAuthTokenFromUrl();
      if (linkToken !== null) await authenticate(linkToken).catch(() => undefined);
      if (disposed) return;
      tick();
      timer = window.setInterval(tick, POLL_MS);
    })();
    const onVisible = (): void => {
      if (document.visibilityState === "visible" && !disposed) tick(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load, loadHealth]);

  // push-triggered refetches are debounced so an event burst becomes one fetch
  const scheduleRefetch = useCallback(() => {
    if (refetchTimer.current !== null) return;
    refetchTimer.current = window.setTimeout(() => {
      refetchTimer.current = null;
      if (lockedRef.current !== true) void load();
    }, REFETCH_DEBOUNCE_MS);
  }, [load]);

  useEffect(() => () => {
    if (refetchTimer.current !== null) window.clearTimeout(refetchTimer.current);
  }, []);

  // One SSE subscription watches every PC, even when no terminal is selected.
  useEffect(() => {
    if (locked !== false) return;
    // the alerts take a pane waiting on its turn's background work for working (shared/notify-policy.ts)
    const alerting = (list: Machine[]) => list.map((machine) => ({
      id: machine.id,
      snapshot: machine.snapshot && { panes: machine.snapshot.panes.map((pane) => ({ pane_id: pane.pane_id, agent_status: alertStatus(pane.agent_status, (pane as HerdrPane).background_wait) })) },
    }));
    const events = new EventSource("/api/machines/events");
    machineEvents.current = events;
    events.onmessage = (event) => {
      let payload: MachineEvent;
      try { payload = JSON.parse(event.data); } catch { return; }
      if (payload.type === "preferences") { receivePreferencesRef.current(payload.preferences); return; }
      // A poll started before this event can carry an older roster or pane status.
      snapshotRequests.current.invalidate();
      if (payload.type === "machines") {
        seedStatuses(statusRef.current, alerting(payload.machines));
        const next = createdTabs.current.apply(payload.machines);
        setMachines((previous) => sameData(previous, next) ? previous : next);
        rosterIn();
        setMachineRosterLoaded(true);
        return;
      }
      const machine = machinesRef.current.find((m) => m.id === payload.machine_id);
      if (!machine) return;
      const message = payload.message;
      if (message.type === "pane-exited") createdTabs.current.forget(payload.machine_id, message.pane_id);
      if (message.type === "pane-status") {
        const key = paneStorageId(machine.id, message.pane_id);
        const previous = statusRef.current.get(key);
        const status = alertStatus(message.agent_status, message.background_wait);
        statusRef.current.set(key, status);
        const pane = machine.snapshot?.panes.find((p) => p.pane_id === message.pane_id);
        if (pane && shouldNotifyStatus(previous, status) && alertsOnRef.current && !pushOnRef.current && alertsAllow(alertsRef.current, status)) showPaneStatusNotification(message.pane_id, paneNotificationHeading(machine, pane, alertPaneTitle(pane)), status, () => takeNotificationTargetRef.current({ machine_id: machine.id, pane_id: message.pane_id, workspace_id: pane.workspace_id }), machine.id, pane.workspace_id);
        setMachines((list) => {
          let changed = false;
          const next = list.map((m) => {
            if (m.id !== machine.id || !m.snapshot) return m;
            const snapshot = applyPaneStatus(m.snapshot, message.pane_id, message.agent_status, message.background_tasks, message.background_wait === true, message.finish_id, message.finish_epoch);
            if (snapshot === m.snapshot) return m;
            changed = true;
            return { ...m, snapshot };
          });
          return changed ? next : list;
        });
      }
      if (message.type === "pane-exited") {
      }
      if (message.type === "pane-exited" && alertsOnRef.current && !pushOnRef.current && alertsRef.current.done !== "off") {
        const pane = machine.snapshot?.panes.find((p) => p.pane_id === message.pane_id);
        if (pane) showPaneEndedNotification(message.pane_id, paneNotificationHeading(machine, pane, alertPaneTitle(pane)), () => takeNotificationTargetRef.current({ machine_id: machine.id, pane_id: message.pane_id, workspace_id: pane.workspace_id }), machine.id, pane.workspace_id);
      }
      if (message.type === "session-changed" || message.type === "pane-exited") scheduleRefetch();
    };
    return () => { events.close(); if (machineEvents.current === events) machineEvents.current = null; };
  }, [locked, scheduleRefetch]);

  const handleServerMessage = useCallback((message: ServerMessage) => {
    if (message.type === "error" && message.code === "output_stalled") setOutputStopped(true);
  }, []);

  useEffect(() => {
    const refresh = () => setNotifications(notificationState());
    window.addEventListener("trex-notification-permission", refresh);
    refresh();
    return () => window.removeEventListener("trex-notification-permission", refresh);
  }, []);

  const enableNotifications = useCallback(async () => {
    const current = notificationState();
    const next = current === "default" ? await requestNotificationPermission() : current;
    setNotifications(next);
    // alerts are notifications: without the browser's permission the switch stays off
    if (next !== "granted") return false;
    updateSettings({ alertsOn: true });
    if (nativeNotifications()) return true;
    try {
      const endpoint = await ensurePushSubscription(alertsRef.current);
      setPushOn(endpoint !== null);
      // the confirmation push proves the whole path (server -> push service -> this device)
      if (endpoint) await sendTestPush(endpoint);
      return endpoint !== null;
    } catch (err) {
      console.warn("web push unavailable, alerts stay tab-only", err);
      return false;
    }
  }, [updateSettings]);

  // The browser's permission cannot be taken back from the page: turning alerts off drops
  // this device's push subscription (the server forgets it) and silences the tab's own.
  const disableNotifications = useCallback(async () => {
    updateSettings({ alertsOn: false });
    setPushOn(false);
    await removePushSubscription().catch((err) => console.warn("could not drop the push subscription", err));
  }, [updateSettings]);

  // a device that already allowed alerts re-registers on every load: idempotent, and it
  // brings the device back if the server lost its subscriptions; a changed choice of
  // alerts goes the same way
  useEffect(() => {
    if (locked !== false || notifications !== "granted" || !alertsOn || !pushSupported()) return;
    let cancelled = false;
    ensurePushSubscription(alerts)
      .then((endpoint) => {
        if (!cancelled) setPushOn(endpoint !== null);
      })
      .catch(() => {
        if (!cancelled) setPushOn(false);
      });
    return () => {
      cancelled = true;
    };
  }, [locked, notifications, alerts, alertsOn]);

  const unlock = useCallback(() => {
    setLocked(false);
    void loadHealth();
    void load();
  }, [load, loadHealth]);

  // pasting the auth link into an already-open tab is a fragment-only navigation:
  // no reload happens, so the boot consumer never re-runs. Watch for the arrival
  // of the fragment instead; a wrong token just leaves the gate as it is.
  useEffect(() => {
    const onHashChange = (): void => {
      const linkToken = takeAuthTokenFromUrl();
      if (linkToken === null) return;
      void authenticate(linkToken)
        .then(unlock)
        .catch(() => undefined);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [unlock]);

  const lock = useCallback(async () => {
    setDrawerOpen(false);
    // before signOut: the unsubscribe call needs the cookie, and a locked device must stop
    // receiving pane titles
    await removePushSubscription().catch(() => undefined);
    setPushOn(false);
    try {
      await signOut();
    } catch {
      throw new Error(t("Could not sign out. Try again."));
    } finally {
      // The response may have been lost after the cookie was cleared.
      await loadHealth();
    }
  }, [loadHealth, t]);

  const selectedMachineRef = useRef(selectedMachineId);
  selectedMachineRef.current = selectedMachineId;
  const selectTarget = useCallback((machineId: string, paneId: string | null) => {
    // Only another PC mounts a new terminal (and socket), which reports its own state. A pane
    // on the same PC keeps the connected socket, which never reports again: resetting here
    // left the header on "reconnecting" after every pane switch.
    if (machineId !== selectedMachineRef.current) { setConnected(false); setConnectedBefore(false); }
    // the active half alone takes the pick, whatever the other half shows (lib/split.ts)
    setSelectedMachineId(machineId); setSelectedPaneId(paneId); setAutoSelected(false); setDrawerOpen(false);
    setFocusRequest((serial) => serial + 1);
    setOutputStopped(false);
    // this browser's choice only: herdr's focus, its TUI and every other device stay where they are
    storeSelection(machineId, paneId);
    // a pane picked (a tapped notification, the sidebar, Back) before a link landed supersedes the link
    pendingLink.current = null; setLinkLanded(true);
    selectionHint.current = null;
    // a PC picked now (Open PC, before load() brings it) is checked against a roster sent after this
    selectionSince.current = rosterSeq.current;
  }, []);
  const selectTargetRef = useRef(selectTarget); selectTargetRef.current = selectTarget;
  useEffect(() => {
    // An offline PC's cached roster cannot invalidate a selection. Once connected,
    // a closed pane (including one remembered across reloads) must release its selection.
    if (!snapshot || selectedMachine?.state !== "connected") return;
    // a link lands once its PC's roster is in: its pane, the pane its workspace's row opens, or,
    // when nothing it named is open, the usual fallback below with a word in the header
    const fallback = (current: typeof snapshot) => current.panes.find((pane) => pane.pane_id === current.focused_pane_id)?.pane_id ?? current.panes[0]?.pane_id ?? null;
    const linked = pendingLink.current;
    if (linked && linked.machine === selectedMachineId) {
      const land = (landed: ReturnType<typeof resolveLink>): boolean => {
        pendingLink.current = null;
        setLinkLanded(true);
        if (landed.note) setHeaderNote(landed.note);
        if (landed.pane) {
          if (landed.pane !== selectedPaneId) setSelectedPaneId(landed.pane);
          return true;
        }
        return false;
      };
      const landed = resolveLink(snapshot, linked);
      if (!landed.note) {
        if (land(landed)) return;
      } else {
        // The combined roster is cached: a pane made just before the link opened can be missing
        // from it. Ask this PC before saying the link's place has closed.
        let cancelled = false;
        void fetchSession(selectedMachineId).then((current) => ({ current, confirmed: resolveLink(current, linked) }), () => null).then((read) => {
          if (cancelled || pendingLink.current !== linked) return;
          // a failed read is not evidence that anything closed: the link settles without a word
          if (read === null) { land({ pane: null, workspace: null, note: null }); return; }
          const { current, confirmed } = read;
          if (land(confirmed)) return;
          // as below: nothing selected takes the fallback, a selection that has gone takes it as auto-selected
          if (current.panes.some((pane) => pane.pane_id === selectedPaneId)) return;
          setSelectedPaneId(fallback(current));
          if (selectedPaneId !== null) setAutoSelected(true);
        });
        return () => { cancelled = true; };
      }
    }
    if (snapshot.panes.some((pane) => pane.pane_id === selectedPaneId)) return;
    if (selectedPaneId === null) { setSelectedPaneId(fallback(snapshot)); return; }
    // The combined roster is cached: a newly created pane can be selected before it
    // appears there. Confirm absence against this PC before discarding the selection.
    let cancelled = false;
    void fetchSession(selectedMachineId).then((current) => {
      if (cancelled || current.panes.some((pane) => pane.pane_id === selectedPaneId)) return;
      // a pane a tapped alert selected: the workspace the alert named opens, and says so
      const hint = selectionHint.current;
      selectionHint.current = null;
      if (hint && hint.machine === selectedMachineId && hint.pane === selectedPaneId) {
        const landed = resolveLink(current, { workspace: hint.workspace, workspaceSlug: null, pane: hint.pane });
        if (landed.note) setHeaderNote(landed.note);
        setSelectedPaneId(landed.pane ?? fallback(current));
        setAutoSelected(true);
        return;
      }
      setSelectedPaneId(fallback(current));
      setAutoSelected(true);
    }).catch(() => { /* a failed read is not evidence that the pane disappeared */ });
    return () => { cancelled = true; };
  }, [snapshot, selectedPaneId, selectedMachineId, selectedMachine?.state, linkTick]);
  // the pane each PC last showed in this window: switching back to a PC opens it again
  const lastPanes = useRef(new Map<string, string>());
  useEffect(() => {
    storeSelection(selectedMachineId, selectedPaneId);
    if (selectedPaneId !== null) lastPanes.current.set(selectedMachineId, selectedPaneId);
  }, [selectedMachineId, selectedPaneId]);
  const switchMachine = useCallback((machineId: string) => {
    if (machineId === selectedMachineRef.current) return;
    // a pane that closed meanwhile takes the usual fallback above
    selectTarget(machineId, lastPanes.current.get(machineId) ?? null);
    // a phone's drawer stays open on the PC picked: its workspaces are the next thing to choose
    if (!wideScreen) setDrawerOpen(true);
  }, [selectTarget, wideScreen]);

  const selectPane = useCallback((paneId: string, focusInput = true) => {
    pendingLink.current = null; setLinkLanded(true);
    selectionHint.current = null;
    setSelectedPaneId(paneId);
    setAutoSelected(!focusInput);
    if (focusInput) setFocusRequest((serial) => serial + 1);
    setDrawerOpen(false);
  }, []);

  // a layout call the palette made and the PC refused: a bridge from before the route says so
  // over the pane (the tab's own menu has a line of its own); anything else is logged, as
  // other background failures are
  const layoutRefused = useCallback((what: string, err: unknown): void => {
    if (routeMissing(err)) setLayoutNotice(t("This PC's bridge does not offer this yet"));
    else console.warn(what, err);
  }, [t]);

  // a tapped notification focuses this window and names the pane (public/sw.js). A pane not known
  // yet waits as a link does (this also keeps a cold start's link, which the worker names again
  // once the page is up), and so does one on a PC this roster lacks: a roster asked for now says
  // whether it was removed (the [machines] effect below) or set up since this one was read
  const takeNotificationTarget = useCallback((target: NotificationTarget): void => {
    const landing = notificationLanding(machinesRef.current, target);
    if (landing.kind === "select") {
      selectTargetRef.current(target.machine_id, target.pane_id);
      if (target.workspace_id) selectionHint.current = { machine: target.machine_id, pane: target.pane_id, workspace: target.workspace_id };
      return;
    }
    // the worker names one tap twice, before and after focus: the second leaves the first's lookup be
    if (sameLink(pendingLink.current, landing.link)) return;
    selectTargetRef.current(target.machine_id, target.pane_id);
    pendingLink.current = landing.link; setLinkLanded(false);
    linkSince.current = rosterSeq.current;
    setLinkTick((tick) => tick + 1);
    if (landing.stale) void load();
  }, [load]);
  // the tab's own alerts shown without a worker (lib/notifications.ts) land the same way
  const takeNotificationTargetRef = useRef(takeNotificationTarget); takeNotificationTargetRef.current = takeNotificationTarget;
  useEffect(() => onNotificationTarget(takeNotificationTarget), [takeNotificationTarget]);


  const selectedPane = snapshot?.panes.find((pane) => pane.pane_id === selectedPaneId) ?? null;
  useScreenWakeLock(settings.keepScreenOn && locked === false && selectedPane !== null);
  const selectedWorkspace = selectedPane
    ? (snapshot?.workspaces.find((workspace) => workspace.workspace_id === selectedPane.workspace_id) ?? null)
    : null;
  const selectedLayout = snapshot?.layouts.find((layout) => layout.tab_id === selectedPane?.tab_id);
  // Selection can precede rendering: in a zoomed tab the layout effect below redirects it,
  // but the sidebar's passive effect can still see that first selection. Only the selected
  // pane the canvas actually draws counts; paneInFront checks coverage at acknowledgement time.
  const presentedPaneId = !drawerOpen && selectedPane && !selectedPane.restore_error
    && (!selectedLayout?.panes.length || selectedLayout.panes.some((pane) => pane.pane_id === selectedPane.pane_id))
    && (!selectedLayout?.zoomed || selectedLayout.focused_pane_id === selectedPane.pane_id)
    ? selectedPane.pane_id : null;
  useLayoutEffect(() => {
    if (selectedLayout?.zoomed && selectedLayout.focused_pane_id !== selectedPaneId
      && snapshot?.panes.some((pane) => pane.pane_id === selectedLayout.focused_pane_id)) {
      setSelectedPaneId(selectedLayout.focused_pane_id);
      setAutoSelected(true);
    }
    // a pick of another pane of a zoomed tab lands on herdr's zoomed one too: herdr shows only it
  }, [selectedMachineId, selectedPaneId, selectedLayout?.zoomed, selectedLayout?.focused_pane_id]);
  const targetHerdr = selectedMachineId === "local" ? health?.herdr : selectedMachine?.herdr;
  const selectedTitle = selectedPane ? displayPaneTitle(selectedPane) : null;
  // the tab that governs the pane region, so the strip's tabs and the pane they select are
  // one thing to a screen reader (A4); null while no tab owns this pane
  const tabPanelLabel = paneTabPanelLabel(snapshot, selectedPane, t);
  // Focus mode (Settings.focusMode): with the sidebar shown on a wide screen, the tabs live under
  // their workspaces there (Sidebar) and the bar over the pane goes. A hidden sidebar hands them back
  // to the bar, so the tabs always have a place on screen.
  const focusLayout = settings.focusMode && wideScreen && !sidebarCollapsed;

  const contentKey = paneContentKey(selectedMachine, selectedPane);
  // App-owned coverage, plus dialogs/menus mounted by descendants (rename, worktree, confirmations).
  const [dialogCover, setDialogCover] = useState(false);
  const [contentReady, setContentReady] = useState(false);
  useEffect(() => {
    const update = () => {
      setDialogCover(paneCovered());
      setContentReady(paneContentPresented(contentKey));
    };
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open", "role", "aria-modal", "data-pane-content", "hidden", "inert", "aria-hidden", "class"] });
    update();
    return () => observer.disconnect();
  }, [contentKey]);
  const paneInFront = useCallback(() => locked === false && linkLanded
    && !drawerOpen && !settingsOpen
    && !machineDialog && !paletteOpen
    && !dialogCover && !paneCovered()
    && contentReady && paneContentPresented(contentKey),
  [locked, linkLanded, drawerOpen, settingsOpen, machineDialog, paletteOpen, dialogCover, contentReady, contentKey]);

  // The split view (lib/split.ts): drawn only where the sidebar stands beside the pane, and only
  // while a pane is selected; a narrower window shows the active half alone and keeps the split
  const otherMachine = split ? machines.find((m) => m.id === split.other.machineId) : undefined;
  const otherPane = split ? otherMachine?.snapshot?.panes.find((pane) => pane.pane_id === split.other.paneId) ?? null : null;
  // both halves may show one tab: slot b draws on a connection of its own (the slot's
  // MachineSessionsProvider below), so each half attaches and detaches the tab's panes by itself
  const splitOn = split !== null && wideScreen && selectedPaneId !== null;
  // the half that is not active, drawing the active half's tab too, shows it at the grid the active
  // half gives the pane: one pty has one size (PaneFollowContext)
  const sameTabs = splitOn && otherPane !== null && selectedPane !== null
    && split.other.machineId === selectedMachineId && otherPane.tab_id === selectedPane.tab_id;
  splitShownRef.current = splitOn;
  const otherWorkspace = otherPane ? otherMachine?.snapshot?.workspaces.find((workspace) => workspace.workspace_id === otherPane.workspace_id) ?? null : null;
  const otherHerdr = split?.other.machineId === "local" ? health?.herdr : otherMachine?.herdr;

  // the other half's pane closed: another pane of its tab takes its place, else back to one pane.
  // An offline PC's cached roster cannot say so, as for the selection itself
  const otherTabRef = useRef<{ key: string; tab: string } | null>(null);
  const otherKey = split ? `${split.other.machineId}:${split.other.paneId}` : null;
  if (otherPane && otherKey) otherTabRef.current = { key: otherKey, tab: otherPane.tab_id };
  else if (otherTabRef.current?.key !== otherKey) otherTabRef.current = null;
  useEffect(() => {
    if (!split || !machineRosterLoaded) return;
    if (!otherMachine) { endSplit(split.active); return; }
    if (!otherMachine.snapshot || otherMachine.state !== "connected") return;
    const panes = otherMachine.snapshot.panes;
    if (panes.some((pane) => pane.pane_id === split.other.paneId)) return;
    const tabId = otherTabRef.current?.tab ?? null;
    // a pane this page has not seen in the roster yet (a saved split, a pane made just before the page
    // loaded) may be newer than the cached roster: ask the PC before the split ends, as the selection does
    if (tabId === null) {
      let cancelled = false;
      const other = split.other;
      void fetchSession(other.machineId).then((current) => {
        if (!cancelled && !current.panes.some((pane) => pane.pane_id === other.paneId)) endSplit(split.active);
      }).catch(() => {
        // a failed read is not evidence that the pane closed: ask again on the next roster
        if (!cancelled) otherRecheck.current = true;
      });
      return () => { cancelled = true; };
    }
    const focused = otherMachine.snapshot.layouts.find((layout) => layout.tab_id === tabId)?.focused_pane_id;
    const heir = panes.find((pane) => pane.tab_id === tabId && pane.pane_id === focused) ?? panes.find((pane) => pane.tab_id === tabId);
    if (heir) setSplit({ ...split, other: { machineId: split.other.machineId, paneId: heir.pane_id } });
    else endSplit(split.active);
  }, [split, machineRosterLoaded, otherMachine, otherRosterTick, endSplit, setSplit]);

  /** A split change and the pane it selects. The half that becomes active keeps its terminals: only
   *  a half whose pane moves to another PC attaches again and reports its connection. */
  // `keepFocus`: the focus already went somewhere in the half made active (a Tab onto one of its
  // buttons): the half's terminal and composer must not take the keyboard from it (autoSelected)
  const applySplit = (next: SplitState | null, select: SplitTarget, keepFocus = false): void => {
    const was = splitOn ? split : null;
    const current: SplitTarget | null = selectedPaneId === null ? null : { machineId: selectedMachineId, paneId: selectedPaneId };
    const after: SplitSlot = next ? next.active : was && sameTarget(select, was.other) ? otherSlot(was.active) : was ? was.active : soloSlot;
    const before = was ? (was.active === after ? current : was.other) : after === soloSlot ? current : null;
    if (before === null || before.machineId !== select.machineId) { setConnected(false); setConnectedBefore(false); }
    if (next === null) endSplit(after); else setSplit(next);
    setSelectedMachineId(select.machineId); setSelectedPaneId(select.paneId); setAutoSelected(keepFocus); setOutputStopped(false);
    storeSelection(select.machineId, select.paneId);
  };
  const activateSlot = (slot: SplitSlot, keepFocus = false): void => {
    if (!splitOn || split.active === slot || selectedPaneId === null) return;
    applySplit({ other: { machineId: selectedMachineId, paneId: selectedPaneId }, bSide: split.bSide, active: slot }, split.other, keepFocus);
  };
  const closeSlot = (slot: SplitSlot): void => {
    if (!splitOn) return;
    if (slot !== split.active) { endSplit(split.active); return; }
    applySplit(null, split.other);
  };
  const selectInSlot = (slot: SplitSlot, machineId: string, paneId: string, focusInput = true): void => {
    const open = splitRef.current;
    if (!open || !splitOn || open.active === slot) { selectPane(paneId, focusInput); return; }
    if (selectedPaneId === null) return;
    // a pick in the other half (a press on a sibling pane of its tab, a tab opened there) makes that half
    // active with the picked pane selected, in one step. The press's own activation and this pick both
    // read the state from before the event: as two steps the second would undo the first
    applySplit({ other: { machineId: selectedMachineId, paneId: selectedPaneId }, bSide: open.bSide, active: slot }, { machineId, paneId }, !focusInput);
  };
  /** A pane opened in one half (a drop, the pane menu): that half shows it and is the active one; the
   *  other half keeps what it shows, the same tab included (lib/split.ts). */
  const dockSide = (dragged: SplitTarget, side: SplitSide): void => {
    if (!wideScreen || selectedPaneId === null) return;
    const result = dockPane(splitOn ? split : null, { machineId: selectedMachineId, paneId: selectedPaneId }, dragged, side, soloSlot);
    if (result) applySplit(result.split, result.select);
  };
  /** A pane dropped at a point: the half under it opens the pane. */
  const dockAt = (dragged: SplitTarget, x: number, y: number): void => {
    const box = paneAreaRef.current?.getBoundingClientRect();
    const inside = !!box && x >= box.left && x < box.right && y >= box.top && y < box.bottom;
    const side = box && inside ? dropSide(x, box.left, box.width, dropAtRef.current) : null;
    clearDropPreview();
    if (side !== null) dockSide(dragged, side);
  };
  const dockAtRef = useRef(dockAt); dockAtRef.current = dockAt;
  useEffect(() => {
    paneDrag.onDrop((target, x, y) => dockAtRef.current(target, x, y));
    return () => paneDrag.onDrop(null);
  }, []);
  // a tab dragged out of its strip: the guide follows it as a sidebar row's drag does below
  const splitDragOn = wideScreen && selectedPaneId !== null;
  useEffect(() => {
    if (!tabDrag || !splitDragOn) { if (!tabDrag) showDropTarget(null); return; }
    const box = paneAreaRef.current?.getBoundingClientRect();
    const point = tabDrag.point;
    const inside = !!box && !!point && point.x >= box.left && point.x < box.right && point.y >= box.top && point.y < box.bottom;
    showDropTarget(box && point && inside ? dropSide(point.x, box.left, box.width, dropAtRef.current) : null);
  }, [tabDrag, splitDragOn, showDropTarget]);
  // dragenter too: a drop hit-tests once more, and when the node under the pointer was replaced since
  // the last dragover (a transcript renders again) the new node gets a
  // dragenter instead. Chromium refuses a drop whose last drag event nobody accepted.
  const paneDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (!splitDragOn || !event.dataTransfer.types.includes(PANE_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setPaneDragging(true);
    const box = paneAreaRef.current?.getBoundingClientRect();
    if (box) showDropTarget(dropSide(event.clientX, box.left, box.width, dropAtRef.current));
  };
  const paneDragLeave = (event: DragEvent<HTMLDivElement>): void => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    // Some browsers omit relatedTarget when crossing a child. The pointer still being inside
    // the area must not clear the preview (or its stable side at the centre).
    const box = event.currentTarget.getBoundingClientRect();
    if (event.relatedTarget === null && event.clientX >= box.left && event.clientX < box.right && event.clientY >= box.top && event.clientY < box.bottom) return;
    showDropTarget(null);
  };
  const paneDrop = (event: DragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes(PANE_DRAG_TYPE)) return;
    // the composer and the terminal take dropped files: a dropped pane is not one
    event.preventDefault();
    event.stopPropagation();
    const dragged = draggedPane(event.dataTransfer.getData(PANE_DRAG_TYPE));
    if (dragged) dockAt(dragged, event.clientX, event.clientY);
    else clearDropPreview();
  };
  // Bubble phase: the sidebar row has put its pane type into DataTransfer by then.
  useEffect(() => {
    if (!splitDragOn) { clearDropPreview(); return; }
    const start = (event: globalThis.DragEvent): void => {
      if (event.dataTransfer?.types.includes(PANE_DRAG_TYPE)) {
        showDropTarget(null);
        setPaneDragging(true);
      }
    };
    const cancel = (event: KeyboardEvent): void => { if (event.key === "Escape") clearDropPreview(); };
    window.addEventListener("dragstart", start);
    window.addEventListener("dragend", clearDropPreview);
    window.addEventListener("drop", clearDropPreview);
    window.addEventListener("blur", clearDropPreview);
    window.addEventListener("keydown", cancel);
    return () => {
      window.removeEventListener("dragstart", start);
      window.removeEventListener("dragend", clearDropPreview);
      window.removeEventListener("drop", clearDropPreview);
      window.removeEventListener("blur", clearDropPreview);
      window.removeEventListener("keydown", cancel);
    };
  }, [splitDragOn, clearDropPreview, showDropTarget]);

  // The address follows the app (lib/deepLink.ts): opening another pane or PC is an entry of the
  // history, so Back returns to the last one; a Settings page or a pane the app picked
  // itself replace the entry. Nothing is written while locked or before the roster is in, so a
  // link survives the access gate and a slow first read.
  const writtenLink = useRef<AppLink | null>(null);
  // Back or Forward landed somewhere other than its entry said: that place is written over the entry
  const poppedTo = useRef(false);
  const linkWorkspaceId = selectedPane?.workspace_id ?? (selectedPaneId === null ? null : undefined);
  const linkSlug = slugOf(selectedWorkspace?.label) || null;
  useEffect(() => {
    if (locked !== false || machines.length === 0 || snapshot === null || linkWorkspaceId === undefined || !linkLanded) return;
    const link: AppLink = {
      machine: selectedMachineId, workspace: linkWorkspaceId, workspaceSlug: linkSlug, pane: selectedPaneId,
      settings: settingsOpen ? settingsPage : null, section: settingsOpen && settingsPage === settingsLinkPage ? settingsLinkSection : null,
      sidebar: wideScreen && sidebarCollapsed ? "hidden" : null,
    };
    const previous = writtenLink.current;
    writtenLink.current = link;
    const search = linkSearch(link, window.location.search);
    const popped = poppedTo.current;
    poppedTo.current = false;
    // Back and Forward land where the address already says: nothing to write
    if (search === window.location.search) return;
    const url = `${window.location.pathname}${search}${window.location.hash}`;
    if (previous !== null && !popped && !autoSelected && !settingsOpen && isNavigation(previous, link)) {
      window.history.pushState({ [NAV_KEY]: true }, "", url);
    } else window.history.replaceState(window.history.state, "", url);
  }, [locked, machines.length, snapshot, linkLanded, selectedMachineId, selectedPaneId, linkWorkspaceId, linkSlug, settingsOpen, settingsPage, settingsLinkPage, settingsLinkSection, wideScreen, sidebarCollapsed, autoSelected]);


  // Back and Forward between panes: the entry's address says which one. Settings' own entries
  // are its module's (lib/settingsHistory.ts)
  useEffect(() => {
    const onPop = (event: PopStateEvent): void => {
      if (settingsEntry(event.state) !== null) return;
      // a phone's sheet closing itself steps off its entry: not a Back, and what its item opened (a
      // worktree's shell, before the roster lists it) is written over the address once it is listed
      if (sheetSteppedOff()) return;
      const link = readLink(window.location.search);
      // before the PCs are in, nothing can say the entry's PC is still set up: it waits as a link
      // opened with the page does, settled against its roster or answered with a note once they are
      if (machinesRef.current.length === 0) {
        if (!link.pane && !link.workspace) return;
        selectTargetRef.current(link.machine, link.pane);
        pendingLink.current = link; setLinkLanded(false);
        linkSince.current = rosterSeq.current;
        poppedTo.current = true;
        return;
      }
      const machine = machinesRef.current.find((candidate) => candidate.id === link.machine);
      const missing = !machine && machinesRef.current.length > 0;
      // an entry naming a PC since removed leaves the app where it is and says so, as a link to it would
      if (missing) setHeaderNote("machine-missing");
      else {
        const pane = machine?.snapshot ? resolveLink(machine.snapshot, link).pane : link.pane;
        if (pane === null) return;
        const current = selectionRef.current;
        // where it lands is written over the entry, so Forward keeps the entries after it
        if (current.machineId !== link.machine || current.paneId !== pane) { poppedTo.current = true; selectTargetRef.current(link.machine, pane); return; }
      }
      // the same pane, or no PC to go to: the entry landed on may still say what is no longer shown
      // (the address a link to Settings opened the page with, under the dialog's own entries), so it says it now
      const shown = writtenLink.current;
      const search = shown ? linkSearch(shown, window.location.search) : window.location.search;
      if (search !== window.location.search) window.history.replaceState(window.history.state, "", `${window.location.pathname}${search}${window.location.hash}`);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);


  // The Alerts item says what this device does: alerts need the browser's permission, so without
  // it they are off, and the item asks for it.
  const bell: { state: string; title: string; on: boolean; run: () => Promise<unknown> } =
    !alertsOn
      ? { state: t("Off on this device"), title: t("Alerts off on this device. Tap to turn them on"), on: false, run: enableNotifications }
      : notifications !== "granted"
        ? { state: t("Off on this device"), title: t("Notify me when a pane needs input or finishes"), on: false, run: enableNotifications }
        : pushOn
          ? { state: t("On, pushed to this device"), title: t("Alerts on, pushed to this device, even with the app closed. Tap to turn them off"), on: true, run: disableNotifications }
          : {
              state: t("On in this tab"),
              // turning them off and on again retries the push subscription
              title: pushSupported()
                ? t("Alerts on while this tab is open. Tap to turn them off")
                : t("Alerts on while this tab is open (closed-app alerts need https, and on iPhone the home-screen app). Tap to turn them off"),
              on: true,
              run: disableNotifications,
            };
  // hidden where it could do nothing: the browser refused notifications or has none
  const bellVisible = notifications === "default" || notifications === "granted";
  const connWord = t(connected ? "live" : outputStopped ? "disconnected" : connectedBefore ? "reconnecting" : "connecting");

  useEffect(() => {
    document.title = selectedTitle ? `${selectedTitle} · T-Rex` : APP_TITLE;
  }, [selectedTitle]);

  // A new tab's workspace: the named one, else the selected pane's. Its folder is the workspace's:
  // a worktree's checkout, else where the pane in front (the selected one, else the one herdr has
  // in front, else the first) is. Read from refs, so the actions keep no stale roster.
  const newTabTarget = (target?: { machineId: string; workspaceId: string }) => {
    const machineId = target?.machineId ?? selectionRef.current.machineId;
    const roster = machinesRef.current.find((m) => m.id === machineId)?.snapshot;
    // pane ids repeat across PCs: the selected pane counts only on the PC the tab is for
    const selectedPaneId = selectionRef.current.machineId === machineId ? selectionRef.current.paneId : null;
    const workspaceId = target?.workspaceId ?? roster?.panes.find((pane) => pane.pane_id === selectedPaneId)?.workspace_id;
    const workspace = roster?.workspaces.find((candidate) => candidate.workspace_id === workspaceId);
    if (!roster || !workspace) return null;
    const panes = roster.panes.filter((pane) => pane.workspace_id === workspace.workspace_id);
    const inFront = panes.find((pane) => pane.pane_id === selectedPaneId)
      ?? panes.find((pane) => pane.pane_id === roster.layouts?.find((layout) => layout.tab_id === workspace.active_tab_id)?.focused_pane_id)
      ?? panes[0];
    return { machineId, workspace, cwd: workspace.worktree?.checkout_path ?? inFront?.cwd ?? null };
  };

  const terminalTab = async (target?: { machineId: string; workspaceId: string }): Promise<void> => {
    const found = newTabTarget(target);
    if (!found) return;
    const asked = selectionRef.current;
    const created = await createTab({ workspace_id: found.workspace.workspace_id, cwd: found.cwd, label: null, agent: null }, found.machineId);
    if (created.tab && created.pane) {
      snapshotRequests.current.invalidate();
      createdTabs.current.add(found.machineId, created);
      setMachines((machines) => createdTabs.current.apply(machines));
    }
    void load();
    // what the user went to while herdr answered is theirs to keep
    if (selectionStill(asked, selectionRef.current)) selectTargetRef.current(found.machineId, created.pane_id);
  };

  const actions = useMemo<AppActions>(
    () => ({
      selectPane,
      selectAdjacentPane: (direction) => {
        // the panes the sidebar lists: a step never lands on a viewer it leaves out
        const panes = rosterPanes(snapshotRef.current?.panes ?? [], selectedPaneId);
        if (panes.length === 0) return;
        const index = panes.findIndex((pane) => pane.pane_id === selectedPaneId);
        const next = panes[(index + direction + panes.length) % panes.length];
        if (next) selectPane(next.pane_id);
      },
      focusInput: () => paneControls.current?.focusInput(),
      scrollPage: (direction) => paneControls.current?.scrollPage(direction),
      openNewSession: (machineId = selectedMachineId) => {
        if (creatingWorkspace.current) return;
        creatingWorkspace.current = true;
        setDrawerOpen(false);
        const asked = selectionRef.current;
        // a shell in the PC's home: an agent or a project folder is a command away in it
        void createWorkspace({ cwd: "~", label: null, agent: null }, machineId)
          .then((created) => {
            void load();
            // what the user went to while herdr answered is theirs to keep
            if (selectionStill(asked, selectionRef.current)) selectTargetRef.current(machineId, created.pane_id);
          })
          .catch((reason: unknown) => setLayoutNotice(t("New workspace failed: {reason}", { reason: userErrorMessage(reason).message })))
          .finally(() => { creatingWorkspace.current = false; });
      },
      openNewTab: () => {
        void terminalTab().catch((reason: unknown) => setLayoutNotice(t("New terminal failed: {reason}", { reason: userErrorMessage(reason).message })));
      },
      openTerminalTab: terminalTab,
      openPalette,
      openFind: () => {
        if (selectedPaneId === null) return;
        setDrawerOpen(false);
        setFindRequest((request) => ({ paneId: selectedPaneId, serial: request.serial + 1 }));
      },
      openSettings: () => {
        setDrawerOpen(false);
        setSettingsSection(null);
        setSettingsOpen(true);
      },
      openAddPc: () => {
        // the new PC reports its progress in the sidebar: nothing should sit over it, and it is shown
        updateSettings({ showRemotePcs: true });
        setSettingsOpen(false);
        setUpdateRemote(false);
        addPcFocusReturn.current = true;
        setMachineDialog("new");
      },
      toggleSidebar: () => {
        if (window.matchMedia("(max-width: 768px)").matches) setDrawerOpen((open) => !open);
        else setSidebarCollapsed((collapsed) => !collapsed);
      },
      toggleFocusMode: () => updateSettings({ focusMode: !settings.focusMode }),
      toggleTheme: () => updateSettings({ theme: resolvedTheme === "dark" ? "light" : "dark" }),
      lock: canSignOut ? lock : null,
      enableNotifications: bellVisible && bell.run === enableNotifications ? () => void enableNotifications() : null,
      refresh: () => void load(),
      // herdr's layout calls on the selected pane (components/TabStrip.tsx has the same for the
      // tab's own menu): the new layout reaches every client as session-changed, so only a
      // refusal is left to say, and that is logged as other background failures are
      splitPane: selectedPaneId !== null ? (direction, focus = false) => {
        const asked = selectionRef.current;
        if (asked.paneId === null) return;
        void splitPane(asked.paneId, direction, focus, asked.machineId)
          .then((pane) => {
            void load();
            // herdr focused the new pane: the app follows, unless another pane or PC was opened
            // while herdr answered (over SSH, say): what the user went to is theirs to keep
            if (focus && selectionStill(asked, selectionRef.current)) selectPane(pane.pane_id);
          })
          .catch((err) => layoutRefused("pane split failed", err));
      } : null,
      zoomPane: selectedPaneId !== null ? (mode) => {
        const { machineId, paneId } = selectionRef.current;
        if (paneId === null) return;
        void zoomPane(paneId, mode, machineId).then(() => void load()).catch((err) => layoutRefused("pane zoom failed", err));
      } : null,
    }),
    [selectPane, selectedPaneId, selectedMachineId, updateSettings, settings.focusMode, resolvedTheme, canSignOut, lock, bellVisible, bell.run, enableNotifications, load, layoutRefused, t],
  );

  useShortcuts(actions, locked === false);

  // a link to a PC this app does not have lands on this PC instead, and says so: the roster lists
  // every configured PC, connected or not, so one missing from it is not set up here. So does a
  // selection of a PC removed since (a reload, a new window), here or on another device. Only a
  // roster the server sent after the PC was named decides (lib/notificationTarget.ts machineGone)
  useEffect(() => {
    const linked = pendingLink.current;
    const machineId = linked ? linked.machine : selectedMachineRef.current;
    const since = linked ? linkSince.current : selectionSince.current;
    if (!machineGone(machines, rosterSeq.current, since, machineId)) return;
    pendingLink.current = null;
    setLinkLanded(true);
    setHeaderNote("machine-missing");
    // no pane: the link's pane id means nothing on another PC, so the pane herdr has in front opens
    selectTargetRef.current("local", null);
  }, [machines, rosterTick, linkTick]);

  // the tab bar's place in the header: the solo pane's tab strip is drawn there through a portal,
  // so the header and the strip are one bar. A split view keeps a strip per half.
  const [tabBarHost, setTabBarHost] = useState<HTMLDivElement | null>(null);
  // the PC switcher's place in the sidebar's own top row (MachineSidebar, through a portal); a
  // phone's drawer heads its list with it instead
  const [switcherHost, setSwitcherHost] = useState<HTMLDivElement | null>(null);

  if (locked === null) {
    // the auth state is unknown until /api/health or /api/session answers (ten seconds when
    // herdr is down): show the shell without the terminal, and so without a WebSocket,
    // instead of a blank page
    return (
      <div className="app">
        <header className="app-header" />
        <div className="app-body">
          <aside className="sidebar">
            <ConnectingNote />
          </aside>
          <main className="terminal-host">
            <div className="terminal-placeholder">
              <div className="terminal-placeholder-inner">
                <span>{t("Connecting to T-Rex…")}</span>
              </div>
            </div>
          </main>
        </div>
      </div>
    );
  }
  if (locked) return <AccessGate reason={lockReason} initialCode={pairCode} onUnlocked={unlock} />;

  const sidebarKeys = formatKeys(shortcutDisplayKeys("toggle-sidebar", settings.shortcutOverrides)).join("+");
  const sidebarToggle = (
    <button
      type="button"
      className="icon-button header-desktop-only sidebar-toggle"
      aria-label={t(sidebarCollapsed ? "Show workspace list" : "Hide workspace list")}
      aria-pressed={!sidebarCollapsed}
      title={sidebarKeys ? t("Toggle sidebar ({keys})", { keys: sidebarKeys }) : t("Toggle sidebar")}
      onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
    >
      <PanelLeft />
    </button>
  );
  const headerMeta = (
    <div className="header-meta">
      <HeaderNote note={note} />
      <ConnectionChip
        connected={connected}
        word={connWord}
        title={[connected ? null : connWord, targetHerdr ? t("herdr {version} · protocol {protocol}", { version: targetHerdr.version, protocol: targetHerdr.protocol }) : null].filter((part) => part !== null).join(" · ") || undefined}
      />
      {/* the Host's herdr is away: the step to take is on that PC (the sidebar's state line says the same) */}
      {!targetHerdr && <span className="pill pill-offline" title={selectedMachineId === "local" ? t("Start herdr on this PC, or check HERDR_SOCKET.") : undefined}>{t("herdr offline")}</span>}
    </div>
  );

  return (
    <MachineSessionsProvider machineIds={machines.map((machine) => machine.id)}><MachineContext.Provider value={selectedMachineId}><div className={`app${sidebarCollapsed ? " sidebar-collapsed" : ""}${focusLayout ? " is-focus" : ""}`} style={sidebarWidth === null ? undefined : { "--sidebar-user-w": `${sidebarWidth}px` } as CSSProperties}>
      <header className="app-header is-zoned">
        {/* is-zoned tells this header from the connecting shell's, which has no zones to draw.
            .header-side is the sidebar's own top row from 769px (styles.css), the PC switcher in
            it; below that its button sits in the bar. Right of it, the sidebar toggle leads the
            pane's bar, open or collapsed, then the tab strip (TabStrip, through a portal). In focus
            mode the header is that top row alone: the toggle and the connection's state move into it */}
        <div className="header-side">
          <button
            type="button"
            className="icon-button drawer-toggle"
            aria-label={t(drawerOpen ? "Close workspace list" : "Open workspace list")}
            aria-expanded={drawerOpen}
            aria-controls="workspace-drawer"
            onClick={() => setDrawerOpen((open) => !open)}
          >
            {drawerOpen ? <X /> : <Menu />}
          </button>
          {wideScreen && <div ref={setSwitcherHost} className="header-switcher" />}
          {focusLayout && headerMeta}
          {focusLayout && sidebarToggle}
        </div>
        {!focusLayout && sidebarToggle}
        {!focusLayout && <div ref={setTabBarHost} className="header-tabs" />}
        {!focusLayout && headerMeta}
      </header>

      <div className="app-body">
        <aside id="workspace-drawer" className={`sidebar${drawerOpen ? " is-open" : ""}`}>
          {error && <div className="error-state" role="alert"><p>{error}</p><button className="btn" onClick={() => void load()}>{t("Retry")}</button></div>}
          {/* a sidebar that cannot be drawn leaves the panes working */}
          <RenderBoundary resetKey={null} fallback={(retry) => <RegionCrash message={t("The sidebar can't be shown.")} retry={retry} />}>
            <CrashProbe region="sidebar" />
            <MachineSidebar machines={shownMachines} selectedMachineId={selectedMachineId} selectedPaneId={selectedPaneId} presentedPaneId={presentedPaneId} paneInFront={paneInFront} actions={actions} switcherHost={wideScreen ? switcherHost : null} onSelect={selectTarget} onSwitch={switchMachine} onSetup={(machine, update = false) => { setUpdateRemote(update); setMachineDialog(machine); }} onNew={(id) => actions.openNewSession(id)} />
          </RenderBoundary>
          <SidebarResizer width={sidebarWidth} onResize={setSidebarWidth} />
        </aside>

        {/* kept on the page closed (styles.css): a swipe that begins on it closes the drawer */}
        <div className={`scrim${drawerOpen ? " is-open" : ""}`} aria-hidden="true" onClick={() => setDrawerOpen(false)} />

        <div className="pane-column">
        {/* over the pane only: a bar across the window would cut the sidebar off from its top row in the header */}
        <UpdateNotice updates={updates} onOpen={() => { setSettingsSection("updates"); setSettingsOpen(true); }} />
        <MachineActionBanner machines={shownMachines} onSetup={(machine, update = false) => { setDrawerOpen(false); setUpdateRemote(update); setMachineDialog(machine); }} />
        {layoutNotice && <p className="pane-notice" role="alert">{layoutNotice}</p>}
        {health?.lan_exposure && <LanExposureNotice host={health.lan_exposure.host} onOpen={() => { setSettingsLinkPage("devices"); setSettingsOpen(true); }} />}
        {/* the pane's tab, or two tabs side by side (lib/split.ts): a tab dragged down out of its strip,
            or a sidebar row dragged over this area, opens its pane in the half it is dropped on */}
        <div ref={paneAreaRef} className={`pane-split${splitOn ? " is-split" : ""}`} onDragEnterCapture={paneDragOver} onDragOverCapture={paneDragOver} onDragLeave={paneDragLeave} onDropCapture={paneDrop}>
          {(["a", "b"] as const).map((slot) => {
            // one pane: the solo slot, or a split's active half where the window is too narrow for both
            if (!splitOn && slot !== (split ? split.active : soloSlot)) return null;
            const active = !splitOn || split.active === slot;
            const machineId = active ? selectedMachineId : split.other.machineId;
            const paneId = active ? selectedPaneId : split.other.paneId;
            const machine = active ? selectedMachine : otherMachine;
            const herdr = active ? targetHerdr : otherHerdr;
            const pane = active ? selectedPane : otherPane;
            const workspace = active ? selectedWorkspace : otherWorkspace;
            const slotSnapshot = active ? snapshot : otherMachine?.snapshot ?? null;
            const onSelect = active ? selectPane : (id: string, focusInput = true) => selectInSlot(slot, machineId, id, focusInput);
            // one pane's panel keeps the page's own id, whichever slot draws it
            const slotPanelId = !splitOn || slot === "a" ? PANE_TABPANEL_ID : `${PANE_TABPANEL_ID}-${slot}`;
            // focus mode draws the solo pane's tabs in the sidebar, as plain rows: no tab strip governs the region
            const soloStrip = splitOn || !focusLayout;
            const slotPanelLabel = !soloStrip ? null : active ? tabPanelLabel : paneTabPanelLabel(slotSnapshot, pane, t);
            // a half's own close sits at the end of its tab strip. The row's free end is the
            // half's grip: its pane, dropped on a half of the pane area, opens there too (dockSide)
            const slotEnd = splitOn ? <div className="pane-slot-grip" draggable={paneId !== null}
              onDragStart={(event) => {
                if (paneId === null) return;
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData(PANE_DRAG_TYPE, paneDragData({ machineId, paneId }));
              }}>
              {machines.length > 1 && <span className="pane-slot-machine">{machine?.name ?? machineId}</span>}
              <button type="button" className="icon-button pane-slot-action" aria-label={t("Close this half")} title={t("Close this half")} onClick={() => closeSlot(slot)}>
                <X />
              </button>
            </div> : undefined;
            // a half with no strip to carry its close (its pane gone, or the half crashed) keeps one in a bar of its own
            const slotBar = splitOn ? <div className="pane-slot-bar"><span className="pane-slot-title">{pane ? displayPaneTitle(pane) : t("Pane closed")}</span>{slotEnd}</div> : null;
            return (
              <MachineContext.Provider key={slot} value={machineId}><SlotSessions slot={slot} machineIds={machines.map((item) => item.id)}><PaneFollowContext.Provider value={sameTabs && !active}>
              <div
                className={`pane-slot${splitOn ? active ? " is-active" : " is-inactive" : ""}`}
                data-slot={slot}
                data-side={splitOn ? slotSide(split, slot) : undefined}
                // a press or the focus in the other half makes it the active one, before the press acts;
                // its own bar's button (its close) acts on it as it is
                onPointerDownCapture={active ? undefined : (event) => {
                  if (event.button === 0 && !paneContextPress(event, apple) && !(event.target as Element).closest(".pane-slot-action")) activateSlot(slot);
                }}
                onFocusCapture={active ? undefined : (event) => { if (Date.now() - lastKeyAtRef.current < KEY_FOCUS_MS && !(event.target as Element).closest(".pane-slot-action")) activateSlot(slot, true); }}
                // a file or text dropped into the other half is for its pane: an upload's paths and the pasted
                // text reach only the active half's terminal, so the drop makes the half active first
                onDropCapture={active ? undefined : (event) => { if (!event.dataTransfer.types.includes(PANE_DRAG_TYPE)) activateSlot(slot); }}
              >
                {/* a pane this half cannot draw leaves the sidebar and the other half working; picking
                    another pane tries again */}
                <RenderBoundary resetKey={`${machineId}:${paneId ?? ""}`} fallback={(retry) => <>{slotBar}<RegionCrash message={t("This pane can't be shown.")} retry={retry} onShown={active ? paneLost : undefined} /></>}>
                <CrashProbe region="pane" />
                {!(slotSnapshot && pane && workspace) && slotBar}
                {slotSnapshot && pane && workspace && soloStrip && portalTo(splitOn ? null : tabBarHost,
                  <TabStrip snapshot={slotSnapshot} workspace={workspace} selectedPane={pane} panelId={slotPanelId} splitDrag={wideScreen} onSelectPane={onSelect} end={slotEnd}
                    onNewTerminal={() => actions.openTerminalTab(active ? undefined : { machineId, workspaceId: workspace.workspace_id })}
                    paneActions={active ? (paneId) => {
                      const target = snapshot?.panes.find((item) => item.pane_id === paneId);
                      if (!target || !paneActionsRef.current) return [];
                      // the strip renders before the canvas, so its items come from the canvas's previous render:
                      // an action runs against the canvas's latest one, where a snapshot change has landed
                      return paneActionsRef.current(target).map((item) => ({ ...item, run: () => (paneActionsRef.current?.(target).find((fresh) => fresh.id === item.id) ?? item).run() }));
                    } : undefined} />,
                )}
                {/* the tab strip's panel: its id is what each tab's aria-controls points at, one per half.
                    No tabIndex - the terminal (PaneTerminal) is the focusable thing inside it. */}
                <main className="terminal-host">
                  <div id={slotPanelId} className="terminal-tabpanel" role={slotPanelLabel === null ? undefined : "tabpanel"} aria-label={slotPanelLabel ?? undefined}>
                  <PaneCanvas key={machineId} snapshot={slotSnapshot} pane={pane} selectedPaneId={paneId} onSelect={onSelect} onChanged={actions.refresh} actionsRef={active ? paneActionsRef : undefined}
                    onOpenInHalf={wideScreen ? (id, side) => dockSide({ machineId, paneId: id }, side) : undefined}
                    renderPane={(item, itemActive) => <PaneTerminal
                        presentationKey={paneContentKey(machine, item)}
                        title={item ? displayPaneTitle(item) : active ? selectedTitle : null}
                        // Wait for the roster before attaching: the loading placeholder is replaced
                        // by the keyed tile, and must never claim the pane on a throwaway connection.
                        paneId={item?.restore_error ? null : item?.pane_id ?? null}
                        terminalId={item?.terminal_id ?? null}
                        mirrored={herdr ? herdr.terminal_attach === false || herdr.terminal_mirror === true : null}
                        restoreError={item?.restore_error ?? null}
                        agent={item?.agent ?? null}
                        agentStatus={item?.agent_status}
                        // the other half never takes the keyboard: a press in it makes it active first
                        active={active && itemActive}
                        // the paging shortcuts reach the selected pane of the active half only
                        controls={active && itemActive ? paneControls : undefined}
                        findRequest={active && findRequest.paneId === item?.pane_id ? findRequest.serial : 0}
                        autoSelected={active ? autoSelected : true}
                        focusRequest={focusRequest}
                        terminalFontSize={settings.terminalFontSize}
                        terminalWheelSpeed={settings.terminalWheelSpeed}
                        terminalFontFamily={settings.terminalFontFamily}
                        theme={resolvedEntry.mode}
                        palette={resolvedEntry.id}
                        onConnectionChange={active && itemActive ? (next, before) => { setConnected(next); setConnectedBefore(before); if (next) setOutputStopped(false); } : undefined}
                        onServerMessage={active && itemActive ? handleServerMessage : undefined}
                      />} />
                  </div>
                </main>
                </RenderBoundary>
              </div>
              </PaneFollowContext.Provider></SlotSessions></MachineContext.Provider>
            );
          })}
          <SplitDropPreview visible={splitDragOn && (paneDragging || tabDrag !== null)} side={dropAt} />
        </div>
        </div>
      </div>

      {machineDialog && <MachineDialog updateRemote={updateRemote} machine={machineDialog === "new" ? undefined : machineDialog} onClose={closeMachineDialog} onConnected={(id) => { closeMachineDialog(); selectTarget(id, null); void load(); }} />}
      <SettingsDialog auth={auth} herdrVersion={health?.herdr?.version ?? null} open={settingsOpen} section={settingsSection} linkPage={settingsLinkPage} linkSection={settingsLinkSection} onPage={onSettingsPage} onClose={closeSettings} actions={actions} updates={updates} onEnableNotifications={enableNotifications} saveError={settingsSaveError} />
      <CommandPalette key={selectedMachineId} machines={machines} onSelect={selectTarget} open={paletteOpen} initialQuery={paletteQuery} onClose={() => setPaletteOpen(false)} snapshot={snapshot} online={selectedMachine?.state === "connected"} selectedPaneId={selectedPaneId} actions={actions} />
    </div></MachineContext.Provider></MachineSessionsProvider>
  );
}

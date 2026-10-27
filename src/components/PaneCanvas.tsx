import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type DragEvent, type MouseEvent, type MutableRefObject, type PointerEvent, type ReactNode } from "react";
import { Columns2, Ellipsis, Eraser, Maximize2, Minimize2, Pencil, Rows2, ArrowLeftRight, SquareTerminal, X } from "lucide-react";
import { createPortal } from "react-dom";
import type { HerdrPane, PaneLayoutSnapshot, SessionSnapshot } from "../../shared/protocol.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { PANE_DRAG_TYPE, paneDragData, type SplitSide } from "../lib/split.ts";
import { PaneSubmitRetention } from "../lib/paneSubmitRetention.ts";
import { PaneCachedContext, PanePresentedContext, PaneShownContext, PaneSubmitContext } from "../lib/paneSubmitContext.ts";
import { cachedPaneCells, visitPaneTab } from "../lib/paneTabCache.ts";
import { routeMissing } from "../lib/api.ts";
import { layoutCells, zoomMode } from "../lib/layoutMap.ts";
import { cardPlace, layoutTopology, paneContextPress, paneFieldTarget, SOLO_PANE_QUERY, soloPane, splitPath, splitRatioAt, swappedCells, swapPending, type PaneSwap } from "../lib/paneCanvas.ts";
import { folderName } from "../lib/paneName.ts";
import { customTabLabel } from "../lib/tabName.ts";
import { useT } from "../lib/i18n.ts";
import { userErrorMessage, type UserError } from "../lib/userError.ts";
import { useFocusTrap } from "../lib/useFocusTrap.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { displayPaneTitle } from "./Sidebar.tsx";
import { AgentMark } from "./AgentMark.tsx";
import { RowMenu, type RowMenuItem } from "./RowMenu.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import "./PaneCanvas.css";

type PaneLayoutSplit = PaneLayoutSnapshot["splits"][number];

/** how far a pressed title moves before it is a drag, not a click */
const SORT_START_PX = 4;
/** how long a dropped pair is drawn traded without herdr's layout saying so */
const SWAP_WAIT_MS = 5000;

/** A motion token of src/styles.css, for an animation run from script (the Web Animations API). */
const token = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
/** a duration token in milliseconds: the built stylesheet may write `220ms` as `.22s` */
const tokenMs = (name: string): number => {
  const value = token(name);
  const amount = Number.parseFloat(value) || 0;
  return value.endsWith("ms") ? amount : value.endsWith("s") ? amount * 1000 : amount;
};
const reducedMotion = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// each card's latest move: the one that, when it ends, lowers the card back among the others
const lastMove = new WeakMap<HTMLElement, Animation>();
/**
 * A card's move from an offset back to its place (transform only), raised over the other cards
 * until it lands, so none crosses over it mid-flight.
 */
function playMove(frame: HTMLElement, from: string, layer: string, duration: number, easing: string): void {
  frame.style.zIndex = layer;
  const move = frame.animate([{ transform: from }, { transform: "none" }], { duration, easing });
  lastMove.set(frame, move);
  const lower = (): void => { if (lastMove.get(frame) === move) frame.style.zIndex = ""; };
  move.onfinish = lower;
  move.oncancel = lower;
}

/** A card held by its title: it rides the pointer until it is dropped on another pane of the tab, or let go. */
interface Sorting {
  paneId: string;
  frame: HTMLElement;
  head: HTMLElement;
  pointerId: number;
  startX: number;
  startY: number;
  moving: boolean;
  target: string | null;
}

interface Props {
  snapshot: SessionSnapshot | null;
  pane: HerdrPane | null;
  selectedPaneId: string | null;
  onSelect: (paneId: string, focusInput?: boolean) => void;
  onChanged: () => void;
  renderPane: (pane: HerdrPane | null, active: boolean) => ReactNode;
  /** filled with this canvas's pane actions on each render: a phone's tab menu offers them for the open pane (TabStrip) */
  actionsRef?: MutableRefObject<((target: HerdrPane) => RowMenuItem[]) | null>;
  /** where the split view can be drawn: a pane opened in a half of it, from its menu or by dragging its title (lib/split.ts) */
  onOpenInHalf?: (paneId: string, side: SplitSide) => void;
}
type Menu = { paneId: string; anchor: HTMLElement; point?: { x: number; y: number }; previousFocus: HTMLElement | null };
interface Drag {
  split: PaneLayoutSplit;
  layout: PaneLayoutSnapshot;
  path: boolean[];
  topology: string;
  box: DOMRect;
  pointerId: number;
  element: HTMLElement;
  latest: number | null;
  running: boolean;
  done: boolean;
  cancelled: boolean;
  lastSent: number;
  startX: number;
  startY: number;
  startRatio: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/** The active tab, drawn from herdr's rectangles. No browser-owned layout or PTY state. */
export function PaneCanvas({ snapshot, pane, selectedPaneId, onSelect, onChanged, renderPane, actionsRef, onOpenInHalf }: Props) {
  const t = useT();
  const machineId = useMachineId();
  const apple = /Mac|iPhone|iPad/.test(navigator.platform);
  const coarse = useMediaQuery("(pointer: coarse)");
  const narrow = useMediaQuery(SOLO_PANE_QUERY);
  const api = useMachineApi();
  const canvas = useRef<HTMLDivElement>(null);
  const [submits] = useState(() => new PaneSubmitRetention());
  const retainedIds = useSyncExternalStore(submits.subscribe, submits.snapshot, submits.snapshot);
  const lastCells = useRef(new Map<string, ReturnType<typeof layoutCells>[number]>());
  const visitedTabs = useRef<readonly string[]>([]);
  useEffect(() => {
    const live = new Set(snapshot?.panes.map((item) => item.pane_id) ?? []);
    submits.reconcile(live);
    for (const id of lastCells.current.keys()) if (!live.has(id)) lastCells.current.delete(id);
  }, [snapshot, submits]);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [renaming, setRenaming] = useState<HerdrPane | null>(null);
  const [closing, setClosing] = useState<HerdrPane | null>(null);
  const [error, setError] = useState<UserError | null>(null);
  // A new pane can be selected before its snapshot arrives, and a selected pane can close
  // before App confirms its replacement. Keep the prior tab's surviving mounts (and their
  // connection-owned pending sends) through either gap, with selection/input still pending.
  const previousPane = useRef(pane);
  if (pane) previousPane.current = pane;
  const previousTab = previousPane.current?.tab_id;
  const previousLayout = snapshot?.layouts.find((item) => item.tab_id === previousTab);
  const presented = pane
    ?? snapshot?.panes.find((item) => item.pane_id === previousPane.current?.pane_id)
    ?? snapshot?.panes.find((item) => item.tab_id === previousTab && item.pane_id === previousLayout?.focused_pane_id)
    ?? snapshot?.panes.find((item) => item.tab_id === previousTab)
    ?? null;
  const layout = snapshot?.layouts.find((item) => item.tab_id === presented?.tab_id) ?? null;
  const topology = layout ? layoutTopology(layout) : "";
  const latest = useRef({ topology, tabId: presented?.tab_id, paneId: selectedPaneId, selection: 0 });
  latest.current = { topology, tabId: presented?.tab_id, paneId: selectedPaneId,
    selection: latest.current.selection + (latest.current.paneId === selectedPaneId ? 0 : 1) };
  const alive = useRef(true);
  const drag = useRef<Drag | null>(null);
  // a card dragged by its title onto another pane of the tab trades places with it (herdr's
  // pane.swap): it rides the pointer, and the pair is drawn traded before herdr answers
  const sorting = useRef<Sorting | null>(null);
  const [sort, setSort] = useState<{ paneId: string; target: string | null } | null>(null);
  const [swap, setSwap] = useState<PaneSwap | null>(null);
  // the click that ends a drag is not a press on the title
  const sorted = useRef(false);
  // the cards' places before a change the canvas plays (FLIP): each moves from there once drawn
  const flip = useRef<{ before: Map<string, DOMRect>; dropped: string | null } | null>(null);
  // a split asked for from this canvas (a card's button, its menu): the pane it makes grows in from
  // the side it split from. One made by a shortcut, the palette or herdr itself just appears
  const splitting = useRef<{ tabId: string; direction: "right" | "down" } | null>(null);
  const seenPanes = useRef<{ tabId: string | undefined; ids: ReadonlySet<string> } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const fail = (reason: unknown): void => {
    if (!alive.current) return;
    if (routeMissing(reason)) { setError({ message: t("This PC's bridge does not offer this yet"), detail: null }); return; }
    const failure = userErrorMessage(reason);
    setError({ message: t("Layout change failed: {reason}", { reason: failure.message }), detail: failure.detail });
  };
  const cancelDrag = (): void => {
    const current = drag.current;
    if (!current) return;
    current.cancelled = true;
    if (current.timer !== null) clearTimeout(current.timer);
    if (current.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId);
    drag.current = null;
  };
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; cancelDrag(); };
  }, []);
  useEffect(() => { cancelDrag(); }, [topology]);
  useEffect(() => { setMenu(null); setRenaming(null); setClosing(null); setError(null); }, [presented?.tab_id]);
  useEffect(() => { if (menu && !snapshot?.panes.some((item) => item.pane_id === menu.paneId)) setMenu(null); }, [snapshot, menu]);

  const run = (operation: () => Promise<unknown>): void => {
    const tabId = pane?.tab_id;
    setError(null);
    void operation().then(() => { if (alive.current) onChanged(); }).catch((reason) => {
      if (latest.current.tabId === tabId) fail(reason);
    });
  };
  const showMenu = (target: HerdrPane, anchor: HTMLElement, point?: { x: number; y: number }): void => {
    setMenu({ paneId: target.pane_id, anchor, point,
      previousFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null });
  };
  // a long press on a touch screen is the phone's own: select text, copy (the tab's menu has the pane's actions)
  const touchPress = useRef(false);
  const context = (event: MouseEvent<HTMLElement>, target: HerdrPane): void => {
    const pointer = (event.nativeEvent as Partial<globalThis.PointerEvent>).pointerType;
    // Android Chrome ends a dragged text selection with a second contextmenu typed "mouse" and no
    // press of its own: only a mouse or the keyboard pressing since the touch makes it the app's
    if (pointer === "touch" || pointer === "pen" || touchPress.current || paneFieldTarget(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    showMenu(target, event.currentTarget, { x: event.clientX || rect.left + 8, y: event.clientY || rect.top + 8 });
  };
  const split = async (target: HerdrPane, direction: "right" | "down"): Promise<void> => {
    const tabId = latest.current.tabId;
    const selection = latest.current.selection;
    splitting.current = { tabId: target.tab_id, direction };
    const made = await api.splitPane(target.pane_id, direction, true).catch((reason: unknown) => {
      splitting.current = null;
      throw reason;
    });
    if (alive.current && latest.current.tabId === tabId && latest.current.selection === selection) onSelect(made.pane_id);
  };
  const zoom = (target: HerdrPane): void => run(async () => {
    const tabId = latest.current.tabId;
    const selection = latest.current.selection;
    await api.zoomPane(target.pane_id, layout ? zoomMode(layout, target.pane_id) : "on");
    if (alive.current && latest.current.tabId === tabId && latest.current.selection === selection) onSelect(target.pane_id);
  });
  const requestClose = (target: HerdrPane): void => {
    const inWorkspace = snapshot?.panes.filter((item) => item.workspace_id === target.workspace_id).length ?? 1;
    if (inWorkspace === 1 || target.agent_status === "working" || target.agent_status === "blocked") setClosing(target);
    else run(() => api.closePane(target.pane_id));
  };
  const target = menu ? snapshot?.panes.find((item) => item.pane_id === menu.paneId) : null;
  const itemsFor = (target: HerdrPane): RowMenuItem[] => [
    { id: "rename", label: t("Rename pane"), icon: Pencil, run: () => setRenaming(target) },
    ...(target.label ? [{ id: "clear-name", label: t("Clear pane name"), icon: Eraser, run: () => run(() => api.renamePane(target.pane_id, "")) }] : []),
    ...(pane && target.pane_id !== pane.pane_id ? [{ id: "swap-focused", label: t("Swap with focused pane"), icon: ArrowLeftRight,
      run: () => run(() => api.swapPaneWith(pane.pane_id, target.pane_id)) }] : []),
    { id: "split-right", label: t("Split right"), icon: Columns2, run: () => run(() => split(target, "right")) },
    { id: "split-down", label: t("Split down"), icon: Rows2, run: () => run(() => split(target, "down")) },
    { id: "zoom", label: t(layout && zoomMode(layout, target.pane_id) === "off" ? "Unzoom pane" : "Zoom pane"), icon: Maximize2,
      run: () => zoom(target) },
    { id: "close", label: t("Close pane"), icon: X, danger: true, run: () => requestClose(target) },
  ];
  const items = target ? itemsFor(target) : [];
  if (actionsRef) actionsRef.current = itemsFor;

  // One in-flight ratio at a time; retain only the newest position and always flush release.
  const flush = (current: Drag): void => {
    if (current.cancelled || current.running || current.latest === null || latest.current.topology !== current.topology) return;
    const delay = 33 - (performance.now() - current.lastSent);
    if (!current.done && delay > 0) {
      if (current.timer === null) current.timer = setTimeout(() => { current.timer = null; flush(current); }, delay);
      return;
    }
    const ratio = current.latest;
    current.latest = null; current.running = true; current.lastSent = performance.now();
    void api.setSplitRatio(current.layout.tab_id, current.path, ratio).then(() => {
      if (!current.cancelled && alive.current) onChanged();
    }).catch((reason) => { if (!current.cancelled) fail(reason); current.cancelled = true; }).finally(() => {
      current.running = false;
      if (current.cancelled) return;
      if (current.latest !== null) flush(current);
      else if (current.done && drag.current === current) drag.current = null;
    });
  };
  const startDrag = (event: PointerEvent<HTMLDivElement>, item: PaneLayoutSplit): void => {
    const path = splitPath(item.id);
    if (event.button !== 0 || !layout || !canvas.current || path === null) return;
    event.preventDefault(); event.stopPropagation(); cancelDrag();
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    drag.current = { split: item, layout, path, topology, box: canvas.current.getBoundingClientRect(),
      pointerId: event.pointerId, element, latest: null, running: false, done: false, cancelled: false, lastSent: 0, timer: null,
      startX: event.clientX, startY: event.clientY, startRatio: item.ratio };
  };
  const moveDrag = (event: PointerEvent<HTMLDivElement>, done = false): void => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId || current.cancelled) return;
    event.preventDefault(); event.stopPropagation();
    const initial = splitRatioAt(current.split, current.layout, current.box, current.startX, current.startY);
    current.latest = Math.max(0.1, Math.min(0.9, current.startRatio + splitRatioAt(current.split, current.layout, current.box, event.clientX, event.clientY) - initial));
    current.done = done;
    if (done && current.element.hasPointerCapture(event.pointerId)) current.element.releasePointerCapture(event.pointerId);
    flush(current);
  };
  const laid = layout ? layoutCells(layout) : pane ? [{ paneId: pane.pane_id, left: 0, top: 0, width: 100, height: 100, focused: true }] : [];
  const swapShown = swapPending(laid, swap, layout?.tab_id);
  const cells = swappedCells(laid, swap, layout?.tab_id);
  const alone = soloPane(layout, cells.map((cell) => cell.paneId), selectedPaneId, narrow);
  const stacked = alone !== null && !layout?.zoomed;
  // a tab's panes trade places by their titles where they are drawn side by side, with a mouse
  const sortable = !coarse && alone === null && cells.length > 1 && !swapShown;

  const measure = (): Map<string, DOMRect> => {
    const boxes = new Map<string, DOMRect>();
    for (const frame of canvas.current?.querySelectorAll<HTMLElement>(".pane-frame[data-layout-pane]:not(.is-hidden)") ?? []) {
      boxes.set(frame.dataset["layoutPane"] ?? "", frame.getBoundingClientRect());
    }
    return boxes;
  };
  // herdr's layout has the pair traded (or moved on): its own cells are drawn from here
  useEffect(() => { if (swap && !swapShown) setSwap(null); }, [swap, swapShown]);
  // no answer from herdr: the pair goes back where its layout still has them
  useEffect(() => {
    if (!swap) return;
    const timer = setTimeout(() => {
      flip.current = { before: measure(), dropped: null };
      setSwap(null);
    }, SWAP_WAIT_MS);
    return () => clearTimeout(timer);
  }, [swap]);
  // The canvas's motion, played once the new places are drawn and before they are painted. A move
  // animates transform alone: each card is laid out at its new place once (one pty resize) and plays
  // from where it was. A pane that joins the tab on screen grows in from the side it split from.
  useLayoutEffect(() => {
    const host = canvas.current;
    const moved = flip.current;
    flip.current = null;
    const still = reducedMotion();
    if (host && moved && !still) {
      for (const frame of host.querySelectorAll<HTMLElement>(".pane-frame[data-layout-pane]:not(.is-hidden)")) {
        const id = frame.dataset["layoutPane"] ?? "";
        const was = moved.before.get(id);
        if (!was) continue;
        // a move still playing gives way to this one, which starts where the card is seen
        for (const running of frame.getAnimations()) running.cancel();
        const now = frame.getBoundingClientRect();
        const dx = was.left + was.width / 2 - (now.left + now.width / 2);
        const dy = was.top + was.height / 2 - (now.top + now.height / 2);
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
        // the dropped card settles from the pointer as an answer to the release; the one it displaced moves across
        const dropped = id === moved.dropped;
        playMove(frame, `translate(${dx}px, ${dy}px)`, dropped ? "var(--z-popover)" : "var(--z-banner)",
          tokenMs("--dur-modal"), token(dropped ? "--ease-out" : "--ease-in-out"));
      }
    }
    const ids = new Set(cells.map((cell) => cell.paneId));
    const seen = seenPanes.current;
    seenPanes.current = { tabId: presented?.tab_id, ids };
    const asked = splitting.current;
    if (asked && asked.tabId !== presented?.tab_id) splitting.current = null;
    if (!host || !seen || seen.tabId !== presented?.tab_id || !asked || asked.tabId !== presented?.tab_id) return;
    const joined = [...ids].find((id) => !seen.ids.has(id));
    if (joined === undefined) return;
    // the split's pane has come: the direction is spent, also where the tab shows one pane alone
    splitting.current = null;
    if (alone !== null) return;
    const origin = asked.direction === "right" ? "left center" : "center top";
    host.querySelector<HTMLElement>(`[data-layout-pane="${CSS.escape(joined)}"]`)?.animate(still
      ? [{ opacity: 0 }, { opacity: 1 }]
      : [{ opacity: 0, transform: "scale(0.97)", transformOrigin: origin }, { opacity: 1, transform: "none", transformOrigin: origin }],
    { duration: tokenMs("--dur-base"), easing: token("--ease-out") });
  });

  const startSort = (event: PointerEvent<HTMLDivElement>, item: HerdrPane): void => {
    sorted.current = false;
    if (!sortable || event.button !== 0 || paneContextPress(event, apple) || (event.target instanceof Element && event.target.closest("button"))) return;
    const head = event.currentTarget;
    const frame = head.parentElement;
    if (!frame) return;
    head.setPointerCapture(event.pointerId);
    sorting.current = { paneId: item.pane_id, frame, head, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moving: false, target: null };
  };
  const moveSort = (event: PointerEvent<HTMLDivElement>): void => {
    const current = sorting.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    if (!current.moving) {
      if (Math.hypot(dx, dy) < SORT_START_PX) return;
      current.moving = true;
      // a card picked up while it still moves into place is taken from its place, at the held layer at once
      for (const running of current.frame.getAnimations()) running.cancel();
      lastMove.delete(current.frame);
      current.frame.style.zIndex = "";
      setSort({ paneId: current.paneId, target: null });
    }
    // the card rides the pointer: a style write per move, never a render
    current.frame.style.transform = `translate(${dx}px, ${dy}px)`;
    const target = document.elementsFromPoint(event.clientX, event.clientY)
      .map((element) => element.closest<HTMLElement>(".pane-frame[data-layout-pane]"))
      .find((frame) => frame !== null && frame !== current.frame && !frame.classList.contains("is-hidden") && canvas.current?.contains(frame))
      ?.dataset["layoutPane"] ?? null;
    if (target === current.target) return;
    current.target = target;
    setSort({ paneId: current.paneId, target });
  };
  // let go over another pane: the two trade places, here at once and in herdr; anywhere else the card goes back
  const settleSort = (current: Sorting, target: string | null): void => {
    const dragged = cells.find((cell) => cell.paneId === current.paneId);
    const other = target === null ? undefined : cells.find((cell) => cell.paneId === target);
    if (!dragged || !other || !layout) {
      const from = current.frame.style.transform;
      current.frame.style.transform = "";
      if (from && !reducedMotion()) playMove(current.frame, from, "var(--z-popover)", tokenMs("--dur-base"), token("--ease-out"));
      return;
    }
    const tabId = layout.tab_id;
    flip.current = { before: measure(), dropped: dragged.paneId };
    current.frame.style.transform = "";
    setSwap({ tabId, a: dragged.paneId, b: other.paneId, cellA: dragged, cellB: other });
    setError(null);
    onSelect(dragged.paneId);
    void api.swapPaneWith(dragged.paneId, other.paneId).then(() => { if (alive.current) onChanged(); }).catch((reason: unknown) => {
      if (!alive.current) return;
      flip.current = { before: measure(), dropped: null };
      setSwap(null);
      if (latest.current.tabId === tabId) fail(reason);
    });
  };
  const endSort = (event: PointerEvent<HTMLDivElement>, drop: boolean): void => {
    const current = sorting.current;
    if (!current || current.pointerId !== event.pointerId) return;
    sorting.current = null;
    if (current.head.hasPointerCapture(event.pointerId)) current.head.releasePointerCapture(event.pointerId);
    if (!current.moving) return;
    sorted.current = true;
    setSort(null);
    settleSort(current, drop ? current.target : null);
  };
  const settleSortRef = useRef(settleSort); settleSortRef.current = settleSort;
  // Escape lets go of a held card without a swap; a layout that changes under it does too
  const holding = sort !== null;
  useEffect(() => {
    if (!holding) return;
    const key = (event: KeyboardEvent): void => {
      const current = sorting.current;
      if (event.key !== "Escape" || !current) return;
      event.preventDefault();
      event.stopPropagation();
      sorting.current = null;
      if (current.head.hasPointerCapture(current.pointerId)) current.head.releasePointerCapture(current.pointerId);
      sorted.current = true;
      setSort(null);
      settleSortRef.current(current, null);
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [holding]);
  useEffect(() => {
    const current = sorting.current;
    if (!current) return;
    sorting.current = null;
    current.frame.style.transform = "";
    setSort(null);
  }, [topology]);
  for (const cell of cells) lastCells.current.set(cell.paneId, alone === cell.paneId || stacked
    ? { ...cell, left: 0, top: 0, width: 100, height: 100 } : cell);
  const shownIds = new Set(cells.map((cell) => cell.paneId));
  visitedTabs.current = visitPaneTab(visitedTabs.current, presented?.tab_id ?? null,
    new Set(snapshot?.panes.map((item) => item.tab_id) ?? []));
  const cachedCells = cachedPaneCells(visitedTabs.current, presented?.tab_id ?? null, snapshot?.panes ?? [], lastCells.current, shownIds);
  const cachedIds = new Set(cachedCells.map((cell) => cell.paneId));
  // Every frame stays under the same keyed array, including a frame returning before its ACK.
  // Retention ends when the submit/queue settles, on disconnect, native close, or PC canvas teardown.
  // the sections stay in one order whatever herdr's layout does: a swap moves the cards on screen,
  // never their nodes in the document, which would take the focus from the terminal in one
  const mountedCells = [...[...cells].sort((a, b) => a.paneId.localeCompare(b.paneId, undefined, { numeric: true })).map((cell) => ({ ...cell, retained: false, cached: false })),
    ...cachedCells.map((cell) => ({ ...cell, retained: retainedIds.includes(cell.paneId), cached: true })),
    ...retainedIds.flatMap((id) => {
    const cell = lastCells.current.get(id);
    return !shownIds.has(id) && !cachedIds.has(id) && cell ? [{ ...cell, retained: true, cached: false }] : [];
  })];
  const mountedIds = new Set(mountedCells.map((cell) => cell.paneId));
  for (const id of lastCells.current.keys()) if (!mountedIds.has(id)) lastCells.current.delete(id);
  // a card says what runs in it: a lone pane by its tab's name, as the sidebar's row does, each of a
  // split's panes by its own title; then the folder it works in, unless the title already says it
  const cardName = (item: HerdrPane): string => {
    if (cells.length !== 1) return displayPaneTitle(item);
    const tabs = snapshot?.tabs.filter((tab) => tab.workspace_id === item.workspace_id) ?? [];
    const place = tabs.findIndex((tab) => tab.tab_id === item.tab_id);
    return (place < 0 ? null : customTabLabel(tabs[place]!, place + 1)) ?? displayPaneTitle(item);
  };
  const cardFolder = (item: HerdrPane): string | null => {
    const cwd = item.foreground_cwd || item.cwd;
    const folder = cwd ? folderName(cwd) : null;
    return folder === null || folder === cardName(item) ? null : folder;
  };
  // herdr's zoomed pane, whatever the web selected: the selection follows it (App). A phone has
  // no room for a split, so it shows the selected pane alone the same way and leaves herdr's
  // layout as it is; the tab's menu lists the other panes (TabStrip).
  // a phone's hidden siblings take the whole canvas too, so each keeps the grid it is shown with
  return <PaneSubmitContext.Provider value={submits}><div className={`pane-canvas${!pane && presented ? " is-pending" : ""}${sortable ? " is-sortable" : ""}${sort ? " is-sorting" : ""}`} ref={canvas} aria-busy={!pane && presented ? true : undefined}>
    {cells.length === 0 && renderPane(pane, true)}
    {mountedCells.map((cell) => {
      const item = snapshot?.panes.find((item) => item.pane_id === cell.paneId);
      if (!item) return null;
      const offTab = cell.retained || cell.cached;
      const active = !offTab && item.pane_id === selectedPaneId;
      const hidden = offTab || (alone !== null && alone !== item.pane_id);
      const single = offTab ? cell.width === 100 && cell.height === 100 : cells.length === 1 || alone === item.pane_id;
      const zoomed = layout !== null && zoomMode(layout, item.pane_id) === "off";
      const zoomLabel = t(zoomed ? "Unzoom pane" : "Zoom pane");
      const folder = cardFolder(item);
      // Capture contextmenu before the terminal focuses its field; the menu keeps focus on the original pane.
      return <section key={item.pane_id} data-layout-pane={item.pane_id}
        className={`pane-frame${active ? " is-current" : ""}${single ? " is-single" : ""}${hidden ? " is-hidden" : ""}${sort?.paneId === item.pane_id ? " is-lifted" : ""}${sort?.target === item.pane_id ? " is-swap-target" : ""}`}
        aria-label={displayPaneTitle(item)} aria-current={active ? "true" : undefined} aria-hidden={hidden || undefined} inert={hidden || undefined} tabIndex={-1}
        style={!offTab && (alone === item.pane_id || stacked) ? { left: 0, top: 0, width: "100%", height: "100%" } : cardPlace(cell)}
        // a menu asked for from the keyboard (Shift+F10, the Menu key) comes with no pointer: the last touch is not it
        onKeyDownCapture={() => { touchPress.current = false; }}
        onPointerDownCapture={(event) => {
          touchPress.current = event.pointerType === "touch" || event.pointerType === "pen";
          // A right press must not change focus before the menu's Swap with focused pane.
          if (event.button === 0 && !paneContextPress(event, apple) && !active) {
            onSelect(item.pane_id, false);
          }
          const element = event.target instanceof Element ? event.target : null;
          const titleOrFrame = element?.closest(".pane-frame-head") || element === event.currentTarget;
          if (event.button === 0 && !paneContextPress(event, apple) && !coarse && titleOrFrame && !element?.closest("button")) {
            // Cancelling pointerdown also cancels the title's native mouse drag.
            // A click focuses below; a drag suppresses that click.
            if (onOpenInHalf && element?.closest(".pane-frame-head")) return;
            // A title has no native focus action. Prevent its default blur and take typing
            // even when this pane was already selected but a menu/tab still held focus.
            event.preventDefault();
            const frame = event.currentTarget;
            const input = frame.querySelector<HTMLElement>(".secret-input input")
              ?? frame.querySelector<HTMLElement>(".find-bar input")
              ?? (frame.querySelector(".terminal-stack.is-chat")
                ? frame.querySelector<HTMLElement>(".composer-text")
                : frame.querySelector<HTMLElement>(".terminal-input textarea") ?? frame.querySelector<HTMLElement>(".terminal-ime"));
            input?.focus({ preventScroll: true });
          }
        }}
        onDropCapture={() => { if (!active) onSelect(item.pane_id, false); }}
        onFocusCapture={(event) => { if (!active && event.currentTarget.contains(event.target)) onSelect(item.pane_id, false); }}
        onMouseDownCapture={(event) => {
          if (paneContextPress(event, apple) && !paneFieldTarget(event.target)) { event.preventDefault(); event.stopPropagation(); }
        }}
        onMouseUpCapture={(event) => {
          if (paneContextPress(event, apple) && !paneFieldTarget(event.target)) { event.preventDefault(); event.stopPropagation(); }
        }}
        onContextMenuCapture={(event) => context(event, item)}>
        <div className="pane-frame-head" draggable={onOpenInHalf !== undefined && !coarse && !sortable}
          onPointerDown={(event) => startSort(event, item)} onPointerMove={moveSort}
          onPointerUp={(event) => endSort(event, true)} onPointerCancel={(event) => endSort(event, false)}
          onLostPointerCapture={(event) => endSort(event, false)}
          onClick={(event) => {
            if (sorted.current) { sorted.current = false; return; }
            if (!onOpenInHalf || coarse || paneContextPress(event, apple) || (event.target instanceof Element && event.target.closest("button"))) return;
            const frame = event.currentTarget.parentElement;
            const input = frame?.querySelector<HTMLElement>(".secret-input input")
              ?? frame?.querySelector<HTMLElement>(".find-bar input")
              ?? (frame?.querySelector(".terminal-stack.is-chat")
                ? frame.querySelector<HTMLElement>(".composer-text")
                : frame?.querySelector<HTMLElement>(".terminal-input textarea") ?? frame?.querySelector<HTMLElement>(".terminal-ime"));
            input?.focus({ preventScroll: true });
          }}
          onDragStart={(event: DragEvent<HTMLDivElement>) => {
            // dropped on a half of the pane area, the title opens its pane there (App's drop)
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData(PANE_DRAG_TYPE, paneDragData({ machineId, paneId: item.pane_id }));
          }}>
          <span className="pane-frame-mark" aria-hidden="true">{item.agent ? <AgentMark agent={item.agent} size={14} /> : <SquareTerminal />}</span>
          <span className="pane-frame-title">{cardName(item)}{folder !== null && <span className="pane-frame-folder">{folder}</span>}</span>
          <div className="pane-frame-actions">
            <button type="button" className="icon-button" aria-label={t("Split right")} title={t("Split right")} onClick={() => run(() => split(item, "right"))}><Columns2 aria-hidden="true" /></button>
            <button type="button" className="icon-button" aria-label={t("Split down")} title={t("Split down")} onClick={() => run(() => split(item, "down"))}><Rows2 aria-hidden="true" /></button>
            <button type="button" className="icon-button" aria-label={zoomLabel} title={zoomLabel} aria-pressed={zoomed} disabled={!zoomed && cells.length < 2} onClick={() => zoom(item)}>
              {zoomed ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
            </button>
            <button type="button" className="icon-button" aria-label={t("Close pane")} title={t("Close pane")} onClick={() => requestClose(item)}><X aria-hidden="true" /></button>
          </div>
          <button type="button" className="icon-button pane-frame-menu" aria-label={t("Pane actions for {name}", { name: displayPaneTitle(item) })}
            onClick={(event) => showMenu(item, event.currentTarget)}><Ellipsis aria-hidden="true" /></button>
        </div>
        <div className="pane-frame-body"><PaneCachedContext.Provider value={cell.cached && !cell.retained}><PanePresentedContext.Provider value={!offTab}><PaneShownContext.Provider value={!hidden}>{renderPane(item, active)}</PaneShownContext.Provider></PanePresentedContext.Provider></PaneCachedContext.Provider></div>
      </section>;
    })}
    {alone === null && layout?.splits.map((item) => {
      const vertical = item.direction === "right";
      const path = splitPath(item.id);
      if (path === null) return null;
      const area = layout.area;
      const left = ((item.rect.x - area.x + (vertical ? item.rect.width * item.ratio : 0)) / Math.max(1, area.width)) * 100;
      const top = ((item.rect.y - area.y + (vertical ? 0 : item.rect.height * item.ratio)) / Math.max(1, area.height)) * 100;
      return <div key={item.id} role="separator" tabIndex={0} aria-label={t("Resize split")}
        aria-orientation={vertical ? "vertical" : "horizontal"} aria-valuemin={10} aria-valuemax={90} aria-valuenow={Math.round(item.ratio * 100)}
        className={`pane-divider ${vertical ? "is-vertical" : "is-horizontal"}`}
        style={vertical ? { left: `${left}%`, top: `${top}%`, height: `${item.rect.height / area.height * 100}%` }
          : { left: `${left}%`, top: `${top}%`, width: `${item.rect.width / area.width * 100}%` }}
        onPointerDown={(event) => startDrag(event, item)} onPointerMove={(event) => moveDrag(event)} onPointerUp={(event) => moveDrag(event, true)}
        onPointerCancel={cancelDrag} onLostPointerCapture={() => { if (drag.current && !drag.current.done) cancelDrag(); }}
        onKeyDown={(event) => {
          const step = event.key === (vertical ? "ArrowLeft" : "ArrowUp") ? -0.05 : event.key === (vertical ? "ArrowRight" : "ArrowDown") ? 0.05 : 0;
          if (!step) return;
          event.preventDefault(); event.stopPropagation();
          run(() => api.setSplitRatio(layout.tab_id, path, Math.max(0.1, Math.min(0.9, item.ratio + step))));
        }} />;
    })}
    {error && <div className="pane-canvas-error" role="alert">{error.message}{error.detail !== null && <><br /><code>{error.detail}</code></>}<button className="icon-button" aria-label={t("Dismiss")} onClick={() => setError(null)}><X /></button></div>}
    {menu && target && <RowMenu anchor={menu.anchor} point={menu.point} restoreFocusTo={menu.previousFocus} title={t("Pane actions for {name}", { name: displayPaneTitle(target) })} items={items} onClose={closeMenu} />}
    {renaming && <PaneRename pane={renaming} onClose={() => setRenaming(null)} onSave={async (label) => { await api.renamePane(renaming.pane_id, label); onChanged(); }} />}
    {closing && <ConfirmDialog title={t("Close pane {name}?", { name: displayPaneTitle(closing) })}
      body={t("The pane's running processes will stop. Closing its last pane also closes the workspace.")}
      confirmLabel={t("Close pane")} onClose={() => setClosing(null)} onConfirm={async () => { await api.closePane(closing.pane_id); setClosing(null); onChanged(); }} />}
  </div></PaneSubmitContext.Provider>;
}

function PaneRename({ pane, onClose, onSave }: { pane: HerdrPane; onClose: () => void; onSave: (label: string) => Promise<void> }) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const surface = useFocusTrap<HTMLDivElement>(true, { initialFocus: input });
  const [value, setValue] = useState(pane.label ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UserError | null>(null);
  usePhoneSheetBack(() => { if (busy) return false; onClose(); });
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!busy) onClose(); } };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [busy, onClose]);
  return createPortal(<div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div ref={surface} className="modal" role="dialog" aria-modal="true" aria-label={t("Rename pane")}>
      <form className="pane-rename-form" onSubmit={(event) => { event.preventDefault(); if (busy) return; setBusy(true); void onSave(value.trim()).then(onClose, (reason) => { setError(userErrorMessage(reason)); setBusy(false); }); }}>
        <header className="modal-header"><h2 className="modal-title">{t("Rename pane")}</h2></header>
        <div className="modal-body"><label>{t("Pane name")}<input ref={input} className="input" value={value} disabled={busy} maxLength={80} onFocus={(event) => event.currentTarget.select()} onChange={(event) => setValue(event.target.value)} /></label>{error && <p role="alert">{error.message}{error.detail !== null && <><br /><code>{error.detail}</code></>}</p>}</div>
        <footer className="modal-footer"><button type="button" className="btn" disabled={busy} onClick={onClose}>{t("Cancel")}</button><button className="btn btn-primary" disabled={busy}>{t("Save")}</button></footer>
      </form>
    </div>
  </div>, document.body);
}

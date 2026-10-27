import { useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import type { HerdrTab, TabMoved, TabTransferred } from "../../shared/protocol.ts";
import { adjacentTabBoundary, liftRow, liftShift, nearestSlot, type RowColumn, type RowLift, type RowSlot } from "./tabOrder.ts";
import { edgeScrollStep } from "./touchReorder.ts";

/** --dur-base: the held row settling into its slot, or back into its place */
const SETTLE_MS = 180;
/** a refused move: the row goes back across the list, on screen, so ease-in-out */
const ROLLBACK_MS = 220;
/** everything in the list that steps aside for a held row (Sidebar.tsx) */
const SHIFTED = ".workspace-header, .workspace-tab, .sidebar-inline-error, .sidebar-pinned-label";

export interface TabRowDrag {
  tabId: string;
  workspaceId: string;
  /** a workspace's last tab held over another workspace: its place says the shell that will keep the workspace */
  away: boolean;
  /** let go: the row is gliding into its slot or back into its place */
  settling: boolean;
}

/** A move sent and not yet seen in herdr's order: the rows show it meanwhile. */
export interface TabRowCarry<P> {
  tabId: string;
  from: string;
  to: string;
  /** the tab's index among `to`'s tabs once moved */
  final: number;
  /** its place where it was (herdr names an unnamed tab by its place) */
  place: number;
  tab: HerdrTab;
  /** its panes when it went: on the way they leave it one by one */
  panes: readonly P[];
  /** `to`'s tabs when it went: a tab arriving there meanwhile is the move's own, half made */
  known: ReadonlySet<string>;
  /** the id herdr gave it in `to` */
  newId: string | null;
  /** it was the open tab: it stays the open one, though its pane leaves before herdr answers */
  open: boolean;
}

type Press = { tabId: string; workspaceId: string; pointerId: number; element: HTMLElement; x: number; y: number; startX: number; startY: number; started: boolean; grab: number | null };
type Lift = RowLift & { held: HTMLElement; grab: number; items: { element: HTMLElement; top: number }[]; target: RowSlot | null | undefined };
type Operation = { workspaceId: string; expected: string | null; settled: boolean; timer?: number };
type Flip = { tops: Map<string, number>; ms: number; easing: string };

const reducedMotion = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Focus mode's tab rows (Sidebar) move as a phone's list rows do: a mouse drag lifts the row, it
 * follows the pointer, and the rows step aside where it would land, in its own workspace or in
 * another (on that workspace's name: before its first tab). Let go, it glides into the opened slot
 * and the rows show the new order at once, the row waiting on herdr; herdr's order takes over once
 * it shows the move, and a refused move glides back. One drag and one move at a time, for the whole
 * list. Touch keeps its scroll; a row's menu has the moves within its workspace.
 */
export function useTabRowDrag<P>({ owner, root, tabs, openTabId, panesOf, moveTab, transferTab, transferred, failed, stale }: {
  owner: string;
  /** the sidebar's workspace list: `.workspace-group[data-workspace]` rows, their tab rows `.workspace-tabs > .workspace-tab[data-key][data-index]` */
  root: RefObject<HTMLElement | null>;
  /** herdr's tabs, each workspace's in its order */
  tabs: readonly HerdrTab[];
  /** the tab of the pane open now */
  openTabId: string | null;
  panesOf: (tabId: string) => readonly P[];
  moveTab: (tabId: string, boundary: number) => Promise<TabMoved>;
  transferTab: (tabId: string, workspaceId: string, boundary: number) => Promise<TabTransferred>;
  /** herdr's answer to a move into another workspace: the panes there have new ids */
  transferred: (result: TabTransferred) => void;
  failed: (error: unknown, workspaceId: string) => void;
  stale: (workspaceId: string) => void;
}) {
  const [drag, setDrag] = useState<TabRowDrag | null>(null);
  const [carry, setCarry] = useState<TabRowCarry<P> | null>(null);
  const [moving, setMoving] = useState(false);
  const orders = new Map<string, string[]>();
  for (const tab of tabs) orders.set(tab.workspace_id, [...(orders.get(tab.workspace_id) ?? []), tab.tab_id]);
  const key = JSON.stringify([...orders]);
  const current = useRef({ owner, key, tabs, orders, openTabId, panesOf, moveTab, transferTab, transferred, failed, stale });
  current.current = { owner, key, tabs, orders, openTabId, panesOf, moveTab, transferTab, transferred, failed, stale };
  const press = useRef<Press | null>(null);
  const lifted = useRef<Lift | null>(null);
  const operation = useRef<Operation | null>(null);
  const suppressClick = useRef(false);
  const animation = useRef<number | null>(null);
  const settleTimer = useRef<number | null>(null);
  // what the next layout effect does once React has drawn a move: put the lift down, glide the rows
  const putDown = useRef<Lift | null>(null);
  const flip = useRef<Flip | null>(null);
  // rows that arrive by a move: they do not enter as a new tab does
  const quiet = useRef(new Set<string>());
  const orderOf = (workspaceId: string): string => JSON.stringify(current.current.orders.get(workspaceId) ?? []);

  const scroller = (): HTMLElement | null => root.current?.closest<HTMLElement>(".machine-list") ?? null;
  /** a height in the list's own coordinates, which scrolling does not change */
  const inList = (clientY: number): number => {
    const box = scroller();
    return box ? clientY - box.getBoundingClientRect().top + box.scrollTop : clientY;
  };
  const rowTops = (): Map<string, number> => {
    const tops = new Map<string, number>();
    for (const row of root.current?.querySelectorAll<HTMLElement>(".workspace-tab[data-key]") ?? []) tops.set(`tab:${row.dataset["key"]}`, row.getBoundingClientRect().top);
    for (const group of root.current?.querySelectorAll<HTMLElement>(".workspace-group[data-workspace]") ?? []) {
      const header = group.querySelector<HTMLElement>(":scope > .workspace-header");
      if (header) tops.set(`ws:${group.dataset["workspace"]}`, header.getBoundingClientRect().top);
    }
    return tops;
  };
  /** rows drawn somewhere else than a moment ago glide there from where they were */
  const glide = ({ tops, ms, easing }: Flip): void => {
    if (reducedMotion()) return;
    const moved: HTMLElement[] = [];
    const from = (element: HTMLElement, at: string): void => {
      const top = tops.get(at);
      if (top === undefined) return;
      const dy = top - element.getBoundingClientRect().top;
      if (Math.abs(dy) < 0.5) return;
      element.style.transition = "none";
      element.style.transform = `translateY(${dy}px)`;
      moved.push(element);
    };
    for (const row of root.current?.querySelectorAll<HTMLElement>(".workspace-tab[data-key]") ?? []) from(row, `tab:${row.dataset["key"]}`);
    for (const group of root.current?.querySelectorAll<HTMLElement>(".workspace-group[data-workspace]") ?? []) {
      const header = group.querySelector<HTMLElement>(":scope > .workspace-header");
      if (header) from(header, `ws:${group.dataset["workspace"]}`);
    }
    if (moved.length === 0) return;
    void root.current?.offsetHeight;
    for (const element of moved) {
      element.style.transition = `transform ${ms}ms ${easing}`;
      element.style.transform = "";
    }
    window.setTimeout(() => { for (const element of moved) element.style.transition = ""; }, ms + 30);
  };
  /** everything back as drawn, at once */
  const clearLift = (lift: Lift): void => {
    const moved = [lift.held, ...lift.items.map(({ element }) => element)];
    for (const element of moved) { element.style.transition = "none"; element.style.transform = ""; }
    if (root.current) root.current.style.paddingBottom = "";
    for (const list of root.current?.querySelectorAll<HTMLElement>(".workspace-tabs") ?? []) list.style.removeProperty("--vacated-shift");
    void root.current?.offsetHeight;
    for (const element of moved) element.style.transition = "";
  };

  const releasePress = (): Press | null => {
    const held = press.current;
    press.current = null;
    if (held?.element.hasPointerCapture(held.pointerId)) held.element.releasePointerCapture(held.pointerId);
    if (animation.current !== null) cancelAnimationFrame(animation.current);
    animation.current = null;
    return held;
  };
  /** the held row goes back into its place, and the rows with it */
  const cancelDrag = (): void => {
    const held = releasePress();
    if (!held?.started) return;
    suppressClick.current = true;
    const lift = lifted.current;
    lifted.current = null;
    if (!lift) { setDrag(null); return; }
    const ms = reducedMotion() ? 0 : SETTLE_MS;
    lift.held.style.transition = `transform ${ms}ms var(--ease-out)`;
    lift.held.style.transform = "";
    for (const { element } of lift.items) element.style.transform = "";
    if (root.current) root.current.style.paddingBottom = "";
    setDrag((old) => old && { ...old, away: false, settling: true });
    settleTimer.current = window.setTimeout(() => {
      settleTimer.current = null;
      clearLift(lift);
      setDrag(null);
    }, ms);
  };
  const finishOperation = (op: Operation): void => {
    if (operation.current !== op) return;
    if (op.timer !== undefined) window.clearTimeout(op.timer);
    operation.current = null;
    setMoving(false);
    setCarry(null);
  };
  /** herdr's order as it is, the rows gliding back from the move they showed */
  const rollBack = (op: Operation): void => {
    flip.current = { tops: rowTops(), ms: ROLLBACK_MS, easing: "var(--ease-in-out)" };
    finishOperation(op);
  };

  const measure = (held: Press): Lift | null => {
    const list = root.current;
    const row = held.element.closest<HTMLElement>(".workspace-tab");
    if (!list || !row) return null;
    const columns: RowColumn[] = [];
    for (const group of list.querySelectorAll<HTMLElement>(".workspace-group[data-workspace]")) {
      const rows = group.querySelector<HTMLElement>(":scope > .workspace-tabs");
      const box = rows?.getBoundingClientRect();
      if (!rows || !box || box.height === 0) continue;
      columns.push({ workspaceId: group.dataset["workspace"]!, top: inList(box.top), rows: [...rows.querySelectorAll<HTMLElement>(":scope > .workspace-tab[data-key][data-index]")].map((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return { tabId: candidate.dataset["key"]!, index: Number(candidate.dataset["index"]), top: inList(rect.top), bottom: inList(rect.bottom) };
      }) });
    }
    const alone = (current.current.orders.get(held.workspaceId)?.length ?? 0) === 1;
    const lift = liftRow(columns, held.tabId, alone);
    if (!lift) return null;
    const items = [...list.querySelectorAll<HTMLElement>(SHIFTED)].flatMap((element) => {
      const rect = element.getBoundingClientRect();
      return element === row || rect.height === 0 ? [] : [{ element, top: inList(rect.top) }];
    });
    // where the pointer took the row, kept as the list scrolls and rows come and go
    held.grab ??= inList(held.startY) - lift.top;
    return { ...lift, held: row, grab: held.grab, items, target: undefined };
  };
  const paint = (held: Press): void => {
    const lift = lifted.current;
    if (!lift) return;
    const y = inList(held.y);
    lift.held.style.transform = `translateY(${y - lift.grab - lift.top}px)`;
    // off the list's side, the row goes nowhere
    const side = root.current?.getBoundingClientRect();
    const target = side && held.x >= side.left && held.x <= side.right ? nearestSlot(lift.slots, y - lift.grab) : null;
    if (target === lift.target) return;
    lift.target = target;
    for (const { element, top } of lift.items) {
      const dy = liftShift(top, lift, target);
      element.style.transform = dy === 0 ? "" : `translateY(${dy}px)`;
    }
    // a workspace's last tab carried off: its place stays, saying so, and moves as the rows do; the
    // slot opens too, so the list grows by a row
    const away = !lift.removed && target !== null && !target.home;
    if (root.current) root.current.style.paddingBottom = away ? `${lift.bottom - lift.top}px` : "";
    if (!lift.removed) lift.held.parentElement?.style.setProperty("--vacated-shift", `${liftShift(lift.top, lift, target)}px`);
    setDrag((old) => (old && old.away !== away ? { ...old, away } : old));
  };

  useLayoutEffect(() => {
    return () => {
      const lift = lifted.current ?? putDown.current;
      releasePress();
      if (lift) clearLift(lift);
      lifted.current = null;
      putDown.current = null;
      flip.current = null;
      if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
      settleTimer.current = null;
      const op = operation.current;
      if (op?.timer !== undefined) window.clearTimeout(op.timer);
      operation.current = null;
    };
  }, [owner]);
  useLayoutEffect(() => {
    setDrag(null);
    setCarry(null);
    setMoving(false);
    suppressClick.current = false;
    quiet.current.clear();
  }, [owner]);
  useLayoutEffect(() => {
    // a held row whose tab has gone (closed elsewhere) is let go; rows that came or went under it
    // are measured again
    const held = press.current;
    if (held?.started && lifted.current) {
      if (!current.current.orders.get(held.workspaceId)?.includes(held.tabId)) cancelDrag();
      else {
        clearLift(lifted.current);
        lifted.current = measure(held);
        paint(held);
      }
    }
    // A sent move holds the gate until the order in its answer has been seen: a snapshot that came
    // before the answer is not one, and must not let another move go with stale places.
    const op = operation.current;
    if (op?.settled && orderOf(op.workspaceId) === op.expected) finishOperation(op);
  }, [key, owner]);
  // React has drawn a move or a refusal: the lifted rows come down where they now stand
  useLayoutEffect(() => {
    const lift = putDown.current;
    putDown.current = null;
    if (lift) clearLift(lift);
    const glided = flip.current;
    flip.current = null;
    if (glided) glide(glided);
  });

  const requestMove = (tabId: string, from: string, target: Pick<RowSlot, "workspaceId" | "boundary" | "final">): boolean => {
    const saved = current.current;
    const own = saved.orders.get(from) ?? [];
    const tab = saved.tabs.find((candidate) => candidate.tab_id === tabId);
    const { workspaceId, boundary, final } = target;
    const into = saved.orders.get(workspaceId);
    if (operation.current || !tab || !into || (workspaceId === from ? final === own.indexOf(tabId) : final > into.length)) return false;
    const op: Operation = { workspaceId, expected: null, settled: false };
    operation.current = op;
    quiet.current.add(tabId);
    setMoving(true);
    setCarry({ tabId, from, to: workspaceId, final, place: own.indexOf(tabId) + 1, tab, panes: saved.panesOf(tabId), known: new Set(into), newId: null, open: saved.openTabId === tabId });
    const sent = workspaceId === from ? saved.moveTab(tabId, boundary) : saved.transferTab(tabId, workspaceId, boundary).then((result) => {
      if (current.current.owner === saved.owner) {
        quiet.current.add(result.tab_id);
        setCarry((old) => (old?.tabId === tabId ? { ...old, newId: result.tab_id } : old));
        saved.transferred(result);
      }
      return result;
    });
    void sent.then((result) => {
      if (operation.current !== op || current.current.owner !== saved.owner) return;
      op.expected = JSON.stringify(result.tabs.map((entry) => entry.tab_id));
      op.settled = true;
      if (orderOf(workspaceId) === op.expected) finishOperation(op);
      // an edit made elsewhere meanwhile may replace this order before it shows: the gate gives
      // up after a while, says the order never came and shows herdr's
      else op.timer = window.setTimeout(() => {
        if (operation.current !== op) return;
        rollBack(op);
        current.current.stale(workspaceId);
      }, 8000);
    }).catch((reason: unknown) => {
      if (operation.current !== op || current.current.owner !== saved.owner) return;
      rollBack(op);
      saved.failed(reason, from);
    });
    return true;
  };
  // by key and from the menu: the order changes at once, nothing glides
  const moveAdjacent = (tabId: string, workspaceId: string, direction: -1 | 1): void => {
    const order = current.current.orders.get(workspaceId) ?? [];
    const boundary = adjacentTabBoundary(order, tabId, direction);
    if (boundary !== null) requestMove(tabId, workspaceId, { workspaceId, boundary, final: order.indexOf(tabId) + direction });
  };
  /** let go over a slot: the row glides into it, then the rows show the move */
  const drop = (held: Press, lift: Lift, target: RowSlot): void => {
    const ms = reducedMotion() ? 0 : SETTLE_MS;
    lift.held.style.transition = `transform ${ms}ms var(--ease-out)`;
    lift.held.style.transform = `translateY(${target.y - lift.top}px)`;
    setDrag((old) => old && { ...old, settling: true });
    settleTimer.current = window.setTimeout(() => {
      settleTimer.current = null;
      if (current.current.owner !== owner) return;
      flip.current = { tops: rowTops(), ms: SETTLE_MS, easing: "var(--ease-out)" };
      putDown.current = lift;
      if (!requestMove(held.tabId, held.workspaceId, target)) { flip.current = null; putDown.current = null; clearLift(lift); }
      setDrag(null);
    }, ms);
  };

  // near the list's top or bottom edge the list scrolls under the held row, as under a finger's (lib/touchReorder.ts)
  const tick = (): void => {
    const held = press.current;
    const box = scroller();
    if (!held?.started || !box) { animation.current = null; return; }
    const rect = box.getBoundingClientRect();
    const step = held.x >= rect.left && held.x <= rect.right ? edgeScrollStep(held.y, rect.top, rect.bottom) : 0;
    if (step !== 0) { box.scrollTop += step; paint(held); }
    animation.current = requestAnimationFrame(tick);
  };
  const onPointerDown = (event: PointerEvent<HTMLElement>, tabId: string, workspaceId: string): void => {
    if (event.pointerType !== "mouse" || event.button !== 0 || event.ctrlKey || !event.isPrimary) return;
    suppressClick.current = false;
    const { orders: now } = current.current;
    // a lone tab can still go to another workspace
    if (operation.current || drag || press.current || ((now.get(workspaceId)?.length ?? 0) < 2 && now.size < 2)) return;
    const element = event.currentTarget;
    press.current = { tabId, workspaceId, pointerId: event.pointerId, element, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, started: false, grab: null };
    element.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>): void => {
    const held = press.current;
    if (!held || event.pointerId !== held.pointerId) return;
    held.x = event.clientX; held.y = event.clientY;
    if (!held.started) {
      if (Math.hypot(held.x - held.startX, held.y - held.startY) < 6) return;
      lifted.current = measure(held);
      if (!lifted.current) { releasePress(); return; }
      held.started = true;
      suppressClick.current = true;
      setDrag({ tabId: held.tabId, workspaceId: held.workspaceId, away: false, settling: false });
      animation.current = requestAnimationFrame(tick);
    }
    paint(held);
  };
  const onPointerUp = (event: PointerEvent<HTMLElement>): void => {
    const held = press.current;
    if (!held || event.pointerId !== held.pointerId) return;
    held.x = event.clientX; held.y = event.clientY;
    const lift = lifted.current;
    if (!held.started || !lift) { releasePress(); return; }
    paint(held);
    const target = lift.target;
    if (!target || target.home || operation.current) { cancelDrag(); return; }
    releasePress();
    lifted.current = null;
    drop(held, lift, target);
  };
  useLayoutEffect(() => {
    if (!drag || drag.settling) return;
    const escape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation(); cancelDrag();
    };
    window.addEventListener("keydown", escape, true);
    window.addEventListener("blur", cancelDrag);
    return () => { window.removeEventListener("keydown", escape, true); window.removeEventListener("blur", cancelDrag); };
  }, [drag?.tabId, drag?.settling]);

  /** a workspace's tabs as the rows show them: herdr's order, with the move sent meanwhile */
  const shown = (workspaceId: string): HerdrTab[] => {
    const own = tabs.filter((tab) => tab.workspace_id === workspaceId);
    if (!carry) return own;
    if (workspaceId === carry.to) {
      const rest = own.filter((tab) => tab.tab_id !== carry.tabId && tab.tab_id !== carry.newId && (carry.from === carry.to || carry.known.has(tab.tab_id)));
      const tab = own.find((candidate) => candidate.tab_id === carry.tabId) ?? carry.tab;
      return [...rest.slice(0, carry.final), tab, ...rest.slice(carry.final)];
    }
    return workspaceId === carry.from ? own.filter((tab) => tab.tab_id !== carry.tabId) : own;
  };

  return { drag, carry, moving, shown, moveAdjacent, cancelDrag, onPointerDown, onPointerMove, onPointerUp,
    arrivedByMove: (tabId: string): boolean => quiet.current.has(tabId),
    consumeClick: (detail: number): boolean => { const suppress = detail !== 0 && suppressClick.current; suppressClick.current = false; return suppress; } };
}

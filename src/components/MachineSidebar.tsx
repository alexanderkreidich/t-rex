import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronsUpDown, Monitor, Plus, Settings, SlidersHorizontal, X } from "lucide-react";
import type { Machine, MachineState, MachineUpdate } from "../../shared/machines.ts";
import { MachineContext } from "../lib/machineContext.tsx";
import { answerMachineSetup, machineRequest } from "../lib/api.ts";
import { describeProgress } from "../lib/bridgeProgress.ts";
import { keepDismissed, noticeKey, readDismissed, waitingMachines, writeDismissed } from "../lib/machineNotice.ts";
import type { AppActions } from "../lib/actions.ts";
import { RowMenu, type RowMenuItem } from "./RowMenu.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { SidebarActivityProvider, useSidebarActivity, useSidebarActivityState } from "../lib/sidebarActivity.tsx";
import "./Machines.css";
import { useT } from "../lib/i18n.ts";
import { useAnnouncedText } from "../lib/useAnnouncedText.ts";
import { saysHerdrAway } from "../lib/userError.ts";

/** A PC's state word; "connected" is the quiet default and says nothing, every other state writes its word over the PC's workspaces. */
export const STATE_WORD: Readonly<Record<MachineState, string>> = {
  connecting: "Connecting…",
  connected: "Connected",
  reconnecting: "Reconnecting…",
  disconnected: "Disconnected",
  error: "Connection error",
};

/** `switcherHost`: the sidebar's own top row in the header (App, from 769px); without one the switcher heads the list (a phone's drawer) */
interface Props { machines: Machine[]; selectedMachineId: string; selectedPaneId: string | null; presentedPaneId: string | null; paneInFront: () => boolean; actions: AppActions; switcherHost: HTMLElement | null; onSelect(machineId: string, paneId: string | null): void; onSwitch(machineId: string): void; onNew(machineId: string): void; onSetup(machine: Machine, update?: boolean): void }
export function MachineSidebar(props: Props) {
  const t = useT();
  // the PC whose controls panel is open (the switcher's Manage item): another PC picked closes it
  const [managing, setManaging] = useState<string | null>(null);
  // both lists draw from it: live counters per PC and the finishes looked at here (lib/sidebarActivity.tsx)
  const activity = useSidebarActivityState(props.machines, props.selectedMachineId, props.presentedPaneId, props.paneInFront);
  // the roster's wait is a live region that is in the list from its first render, clipped while empty (never
  // display: none), and its words land a frame after it (lib/useAnnouncedText.ts)
  const loadingWords = useAnnouncedText(props.machines.length === 0 ? t("Loading PCs…") : null);
  // a PC whose removal is in flight: the selection has already moved to the Host (MachineGroup's
  // mutate), and the PC stays on screen with its busy Remove PC, or its error, until the answer
  const [removing, setRemoving] = useState<string | null>(null);
  // one PC at a time: the one on screen, which the switcher changes
  const machine = props.machines.find((candidate) => candidate.id === (removing ?? props.selectedMachineId))
    ?? props.machines.find((candidate) => candidate.id === props.selectedMachineId) ?? props.machines[0];
  // the top row: the switcher, and at the row's far edge the + that starts a workspace on the PC on screen
  const switcher = machine && <>
    <PcSwitcher machines={props.machines} current={machine} managing={managing === machine.id} onManage={() => setManaging(managing === machine.id ? null : machine.id)} onSwitch={props.onSwitch} onAddPc={props.actions.openAddPc} />
    <button className="sidebar-row-action pc-new" disabled={machine.state !== "connected"} aria-label={t("New workspace on {name}", { name: machine.name })} title={t("New workspace")} onClick={() => props.onNew(machine.id)}><Plus aria-hidden="true" /></button>
  </>;
  return <SidebarActivityProvider value={activity}><div className="sidebar-shell">
    {switcher && (props.switcherHost ? createPortal(switcher, props.switcherHost) : <div className="sidebar-top">{switcher}</div>)}
    {/* a click on no control (the empty space under the rows) leaves the keyboard nowhere: it goes
        back to the terminal, unless the click selected text or a finger made it (no soft keyboard) */}
    <div className="machine-list" aria-label={t("PCs and workspaces")} onClick={() => {
      if (document.activeElement === document.body && window.getSelection()?.isCollapsed !== false && !window.matchMedia("(pointer: coarse)").matches) props.actions.focusInput();
    }}>
      {machine && <MachineGroup key={machine.id} {...props} machine={machine} editing={managing === machine.id} onRemoving={(on) => setRemoving(on ? machine.id : null)} />}
      <p className={loadingWords === null ? "visually-hidden" : "tree-state"} role="status">{loadingWords}</p>
    </div>
    <footer className="sidebar-footer">
      <div className="sidebar-footer-row">
        <button className="btn btn-ghost sidebar-footer-action sidebar-footer-settings" aria-label={t("Settings")} title={t("Settings (⌘⇧,)")} onClick={props.actions.openSettings}><Settings aria-hidden="true" /></button>
      </div>
    </footer>
  </div></SidebarActivityProvider>;
}

/** A PC's initial on its own colour, telling the PCs of the switcher's menu apart; the Host takes the accent. */
function PcMark({ machine }: { machine: Machine }) {
  let hue = 0;
  if (machine.kind !== "local") {
    let hash = 0;
    for (const char of machine.id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
    hue = 1 + Math.abs(hash) % 5;
  }
  return <span className="pc-mark" data-hue={hue} aria-hidden="true">{[...machine.name.trim()][0]?.toUpperCase() ?? "?"}</span>;
}

/** The sidebar's top row: the PC whose workspaces the list shows, and the menu that picks another. */
function PcSwitcher({ machines, current, managing, onManage, onSwitch, onAddPc }: { machines: Machine[]; current: Machine; managing: boolean; onManage(): void; onSwitch(machineId: string): void; onAddPc(): void }) {
  const t = useT();
  const activity = useSidebarActivity();
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const needsInput = (machine: Machine) => machine.state === "connected" && (machine.snapshot?.panes.some((pane) => activity.status(machine.id, pane) === "blocked") ?? false);
  // what a PC in the menu waits on, or how it is; a connected PC with nothing to say says nothing
  const hint = (machine: Machine): string | undefined => {
    if (machine.updating) return t("Updating the bridge");
    if (machine.action_required === "setup") return t("Setup needed");
    if (machine.action_required === "update_bridge") return t("Bridge update needed");
    if (machine.action_required === "connect") return t("Saved in herdr");
    if (machine.action_required === "bridge_conflict") return t("Bridge connection conflict");
    if (machine.state !== "connected") return t(STATE_WORD[machine.state]);
    if (needsInput(machine)) return t("Needs input");
    return machine.kind === "local" ? t("Host") : undefined;
  };
  // another PC waits on the user: a point on the chevron says the menu has something to look at
  const elsewhere = machines.some((machine) => machine.id !== current.id && (machine.action_required || machine.updating || needsInput(machine)));
  const dot = current.action_required === "setup" ? "setup" : current.state === "connected" ? null : current.state;
  const items: RowMenuItem[] = [
    ...machines.map((machine): RowMenuItem => ({ id: machine.id, label: machine.name, hint: hint(machine), title: machine.kind === "local" ? t("The computer this app runs on") : undefined, icon: Monitor, glyph: <PcMark machine={machine} />, current: machine.id === current.id, run: () => onSwitch(machine.id) })),
    // the controls panel of the PC on screen (rename, connect, update, remove); the Host has none
    ...(current.kind === "ssh" ? [{ id: "manage", label: t("Manage {name}", { name: current.name }), icon: SlidersHorizontal, divider: true, checked: managing, run: onManage }] : []),
    { id: "add", label: t("Add PC"), icon: Plus, divider: current.kind !== "ssh", run: onAddPc },
  ];
  return <>
    <button type="button" className="pc-switch" aria-haspopup="menu" aria-expanded={anchor !== null} title={t("Switch PC")} onClick={(event) => setAnchor(anchor ? null : event.currentTarget)}>
      <span className="pc-switch-name">{current.name}</span>
      {dot && <span className={`machine-dot is-${dot}`} title={dot === "setup" ? t("Setup needed") : t(STATE_WORD[dot])} aria-hidden="true" />}
      <span className="pc-switch-chevron"><ChevronsUpDown aria-hidden="true" />{elsewhere && <span className="pc-switch-attention" title={t("Another PC needs you")}><span className="visually-hidden">{t("Another PC needs you")}</span></span>}</span>
    </button>
    {anchor && <RowMenu anchor={anchor} title={t("PCs")} align="start" items={items} onClose={() => setAnchor(null)} />}
  </>;
}

function MachineGroup({ machine, editing, onRemoving, ...props }: Props & { machine: Machine; editing: boolean; onRemoving(on: boolean): void }) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const online = machine.state === "connected";
  // a PC that waits on the user, or is updating, shows its notice in the state line's place
  const noticed = Boolean(machine.action_required || machine.updating);
  // the state line under the name is a live region in the group from its first render, kept through the
  // notice (clipped and empty while it shows): its word lands a frame after the line (lib/useAnnouncedText.ts),
  // and every later state change, or the notice clearing, at once
  const stateWord = useAnnouncedText(noticed ? null : t(STATE_WORD[machine.state]));
  // the Host's herdr is away (the server's words name the socket it tried): the step to take is on
  // that PC, not in this browser, so it follows the words
  const nextStep = !noticed && machine.kind === "local" && machine.error !== null && saysHerdrAway(machine.error) ? t("Start herdr on this PC, or check HERDR_SOCKET.") : null;
  // one request at a time: a double-clicked Disconnect/Connect can otherwise race and leave this
  // UI's idea of the state opposite the server's until the next refetch. The method in flight is
  // kept so only a removal marks Remove PC busy (Machines.css dims that one less)
  const [busy, setBusy] = useState<string | null>(null);
  // the state disables the buttons; the ref refuses a second click that lands before that render
  const inFlight = useRef(false);
  const mutate = async (method: string, body?: unknown) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(method);
    // The selected PC moves to this one before it is removed: the server tells every tab the
    // roster without it before it answers, and a selection on a PC the roster has dropped reads
    // as one removed elsewhere ("That link's PC is not set up here"). A failure puts it back.
    const leaving = method === "DELETE" && props.selectedMachineId === machine.id ? { pane: props.selectedPaneId } : null;
    if (method === "DELETE") onRemoving(true);
    if (leaving) props.onSelect("local", null);
    try { await machineRequest(`/${machine.id}`, method, body); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); if (leaving) props.onSelect(machine.id, leaving.pane); }
    finally { inFlight.current = false; setBusy(null); if (method === "DELETE") onRemoving(false); }
  };
  const actions: AppActions = { ...props.actions, selectPane: (id) => props.onSelect(machine.id, id), openNewSession: () => props.onNew(machine.id) };
  return <section className={`machine-group${online ? "" : " is-offline"}`} aria-label={t("PC {name}", { name: machine.name })}>
    {/* connected is the norm and says nothing new; every other state is spelled out */}
    {noticed && <MachineActionNotice machine={machine} onSetup={props.onSetup} />}
    <p className={`machine-state is-${machine.state}${online || stateWord === null ? " visually-hidden" : ""}`} role="status" title={noticed ? undefined : machine.error ?? undefined}>
      <span className="machine-state-word">{stateWord}</span>
      {!noticed && machine.error && <span className="machine-state-detail">{machine.error}</span>}
      {nextStep !== null && <span className="machine-state-next">{nextStep}</span>}
    </p>
    {editing && <MachineControls machine={machine} busy={busy} mutate={mutate} onSetup={props.onSetup} />}
    {error && <p className="machine-error" role="alert">{error}</p>}
    <div className={online ? "" : "machine-offline"} inert={!online}>
      {!online && !machine.snapshot ? <p className="tree-state machine-empty" role="status">{t("No saved sessions")}</p> : <MachineContext.Provider value={machine.id}><Sidebar snapshot={machine.snapshot} online={online} selectedPaneId={props.selectedMachineId === machine.id ? props.selectedPaneId : null} actions={actions} /></MachineContext.Provider>}
    </div>
  </section>;
}

/** An SSH PC's controls, open from the switcher's Manage item; closing it disarms a removal and drops an unsent name. */
function MachineControls({ machine, busy, mutate, onSetup }: { machine: Machine; busy: string | null; mutate(method: string, body?: unknown): Promise<void>; onSetup(machine: Machine, update?: boolean): void }) {
  const t = useT();
  const [name, setName] = useState(machine.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  return <div className="machine-controls">
    {machine.herdr_profile_id ? <p className="field-hint">{t("Managed by herdr. Rename, disable or remove it there.")}</p> : <form onSubmit={(e) => { e.preventDefault(); void mutate("PATCH", { name }); }}><label className="field"><span className="field-label">{t("PC name")}</span><input className="input" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} /></label><button className="btn" type="submit" disabled={busy !== null}>{t("Rename")}</button></form>}
    {/* The first removal click only arms the action; the second is destructive. */}
    <div className="machine-control-buttons">
      {!machine.herdr_profile_id && <button className="btn" disabled={busy !== null} onClick={() => void mutate("PATCH", { enabled: !machine.enabled })}>{t(machine.enabled ? "Disconnect" : "Connect")}</button>}
      {!["setup", "connect"].includes(machine.action_required ?? "") && <button className="btn" disabled={!machine.enabled || !machine.target} onClick={() => onSetup(machine)}>{t("Reconnect / setup")}</button>}
      {machine.action_required !== "connect" && <button className="btn" disabled={!machine.enabled || !machine.target} onClick={() => onSetup(machine, true)}>{t("Update bridge…")}</button>}
      {!machine.herdr_profile_id && <button className="btn btn-danger" disabled={busy !== null} aria-busy={busy === "DELETE" || undefined} onClick={() => { if (confirmDelete) void mutate("DELETE"); else setConfirmDelete(true); }}>{t(confirmDelete ? "Confirm remove PC" : "Remove PC")}</button>}
    </div>
    {confirmDelete && <p className="field-hint">{t("Removes this registration. Remote sessions keep running.")}</p>}
  </div>;
}

/** Seconds since the stage began, ticking on this device: install and restart have no bytes to show. */
function useStageSeconds(update: MachineUpdate): number {
  const key = `${update.job_id}:${update.progress?.stage ?? ""}`;
  const [start, setStart] = useState(() => ({ key, at: Date.now() - (update.progress?.elapsed_ms ?? 0) }));
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (start.key !== key) setStart({ key, at: Date.now() - (update.progress?.elapsed_ms ?? 0) }); }, [key]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  return Math.max(0, Math.round((now - start.at) / 1000));
}

/** A bridge install in words and a bar: the step, the bytes, and roughly how long is left. */
export function BridgeUpdateProgress({ update }: { update: MachineUpdate }) {
  const view = describeProgress(update.progress);
  const seconds = useStageSeconds(update);
  if (!view) return <p className="bridge-progress-step">{update.step}</p>;
  return <div className="bridge-progress">
    <p className="bridge-progress-step"><span>{view.label}</span><span className="bridge-progress-count">{view.step}</span></p>
    <div className="bridge-progress-bar" role="progressbar" aria-label={view.label} aria-valuemin={0} aria-valuemax={100} {...(view.percent === null ? {} : { "aria-valuenow": view.percent })}>
      <span className={view.percent === null ? "is-indeterminate" : ""} style={view.percent === null ? undefined : { width: `${view.percent}%` }} />
    </div>
    <p className="bridge-progress-detail">{view.detail ?? `${seconds} s`}</p>
  </div>;
}

/** Retrying can't reconnect this PC: say what the user has to do, with the button that does it. */
function MachineActionNotice({ machine, onSetup }: { machine: Machine; onSetup(machine: Machine, update?: boolean): void }) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (request: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await request(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  if (machine.updating) {
    const updating = machine.updating;
    return <div className="machine-action is-updating" role="status">
      <p className="machine-action-text"><strong>{t("Updating the bridge")}</strong><span>{t("You can keep using the app; this PC reconnects when it is done.")}</span></p>
      <BridgeUpdateProgress update={updating} />
      <button type="button" className="btn" disabled={busy} onClick={() => void run(() => answerMachineSetup(updating.job_id, { action: "cancel" }))}>{t("Cancel update")}</button>
      {error && <p className="machine-error" role="alert">{error}</p>}
    </div>;
  }
  if (machine.action_required === "connect") return <div className="machine-action is-setup" role="status">
    <p className="machine-action-text"><strong>{t("Saved in herdr")}</strong><span>{t("Connect once to enable automatic reconnection. Installation and startup need separate approval.")}</span></p>
    <button type="button" className="btn btn-primary" onClick={() => onSetup(machine, false)}>{t("Connect")}</button>
  </div>;
  // another app's bridge runs on this PC: neither an update from here nor an approval fixes that,
  // so it is named as what it is, with the server's reason and a plain reconnect
  if (machine.action_required === "bridge_conflict") return <div className="machine-action" role="alert">
    <p className="machine-action-text"><strong>{t("Bridge connection conflict")}</strong><span>{t("Update the apps connected to this PC to the same version, or disconnect the other app, then reconnect here. Sessions keep running.")}</span>{machine.error && <span className="machine-action-reason">{machine.error}</span>}</p>
    <button type="button" className="btn btn-primary" onClick={() => onSetup(machine, false)}>{t("Reconnect")}</button>
  </div>;
  const update = machine.action_required === "update_bridge";
  return <div className={`machine-action${update ? "" : " is-setup"}`} role={update ? "alert" : "status"}>
    <p className="machine-action-text">
      <strong>{t(update ? "Bridge update needed" : "Setup needed")}</strong>
      <span>{t(update ? "This PC runs a bridge from a different version of T-Rex. Update it to reconnect; herdr sessions keep running." : "Browser access uses a bridge on this PC. Review any installation or startup changes before connecting.")}</span>
      {/* the two generic reasons only repeat the sentence above */}
      {machine.error && !/different version|setup needs approval/.test(machine.error) && <span className="machine-action-reason">{machine.error}</span>}
    </p>
    {update ? <div className="machine-action-buttons">
      {/* a PC saved in herdr that has not connected yet is refused a direct update: its dialog connects first */}
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run(() => machineRequest(`/${encodeURIComponent(machine.id)}/update-bridge`, "POST").catch((e) => { if (!machine.herdr_profile_id) throw e; onSetup(machine, true); }))}>{t("Update bridge")}</button>
      {/* a PC that needs a password or a new host key goes through its dialog */}
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => onSetup(machine, true)}>{t("Sign in and update…")}</button>
    </div> : <button type="button" className="btn btn-primary" onClick={() => onSetup(machine, false)}>{t("Set up web access")}</button>}
    {error && <p className="machine-error" role="alert">{error}</p>}
  </div>;
}

/** The app-wide line for PCs that wait on the user, so a closed drawer on a phone still says so. */
export function MachineActionBanner({ machines, onSetup }: { machines: Machine[]; onSetup(machine: Machine, update?: boolean): void }) {
  const t = useT();
  // a PC that cannot be updated right now would hold this line open for good: it can be closed,
  // and the PC's own row in the sidebar keeps saying what it needs
  const [dismissed, setDismissed] = useState(readDismissed);
  useEffect(() => {
    const kept = keepDismissed(dismissed, machines);
    if (kept.length !== dismissed.length) { setDismissed(kept); writeDismissed(kept); }
  }, [machines, dismissed]);
  const running = machines.find((machine) => machine.updating);
  if (running?.updating) {
    const view = describeProgress(running.updating.progress);
    return <div className="update-notice" role="status">
      <span>{t("Updating the bridge on {name}", { name: running.name })}{view ? ` · ${t(view.label)}${view.percent === null ? "" : ` ${view.percent}%`}` : "…"}</span>
    </div>;
  }
  const waiting = waitingMachines(machines, dismissed);
  const first = waiting[0];
  if (!first) return null;
  const conflict = first.action_required === "bridge_conflict";
  const update = first.action_required === "update_bridge";
  const others = waiting.length > 1 ? t(" (+{n} more)", { n: waiting.length - 1 }) : "";
  return <div className="update-notice" role="status">
    <span>{t(conflict ? "{name} has a bridge connection conflict{others}." : update ? "{name} needs a bridge update to reconnect{others}." : "{name} needs web access setup{others}.", { name: first.name, others })}</span>
    <button type="button" className="btn" onClick={() => update ? void machineRequest(`/${encodeURIComponent(first.id)}/update-bridge`, "POST").catch(() => onSetup(first, true)) : onSetup(first, false)}>{t(conflict ? "Reconnect" : update ? "Update bridge" : "Set up web access")}</button>
    <button type="button" className="icon-button update-notice-dismiss" aria-label={t("Dismiss")} title={t("Dismiss")} onClick={() => { const next = [...dismissed, ...waiting.map(noticeKey)]; setDismissed(next); writeDismissed(next); }}><X /></button>
  </div>;
}

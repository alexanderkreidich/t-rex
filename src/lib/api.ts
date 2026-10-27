import type { PreferencesChange, SharedPreferences } from "../../shared/preferences.ts";
import { resumeConnectionTraces } from "./connectionTrace.ts";
import { machinePath, type BridgeHealth, type HerdrIdentity, type Machine, type SetupAction, type SetupJob, type SetupRequest } from "../../shared/machines.ts";
import type {
  AgentKind,
  AgentRenameRequest,
  CreateWorktreeRequest,
  CreateTabRequest,
  CreateWorkspaceRequest,
  DirectoryListing,
  FocusPaneRequest,
  HealthAuth,
  IntegrationsResponse,
  LanExposure,
  MoveTabRequest,
  TabMoved,
  TransferTabRequest,
  TabTransferred,
  OpenWorktreeRequest,
  PairedDevice,
  PairingCode,
  PaneDirection,
  PaneInfo,
  PaneResized,
  PaneSplit,
  PaneSwapped,
  PaneZoomed,
  PaneFindRequest,
  PaneFindResponse,
  PushKey,
  RemoteAccess,
  RemoveWorktreeRequest,
  ResizePaneRequest,
  SessionSnapshot,
  SetSplitRatioRequest,
  SplitPaneDirection,
  SplitPaneRequest,
  SwapPaneRequest,
  TabCreated,
  WorkspaceCreated,
  PluginActionRequest,
  PluginActionResult,
  PluginActions,
  PluginActionsResponse,
  WorktreeListing,
  WorktreeOpened,
  WorktreeRemoved,
  ZoomPaneRequest,
} from "../../shared/protocol.ts";
import { SUPPORTED_AGENT_KINDS } from "../../shared/supported-agents.ts";
import type { PaneScrollInfo } from "../../shared/herdr-api.generated.ts";
import { readInstalledNotes, readUpdateNotes, type HerdrUpdateStatus, type InstalledNotes, type UpdateCommand, type UpdateNotes, type UpdateStatus } from "../../shared/update.ts";
import type { AlertPrefs } from "../../shared/notify-policy.ts";
import { MAX_ATTACHMENT_BYTES } from "../../shared/attachments.ts";
import { t } from "./i18n.ts";

/** Settings → Phone: what Tailscale on the server's PC already serves, or the command to run. */
export function fetchRemoteAccess(): Promise<RemoteAccess> {
  return getJson<RemoteAccess>("/api/access");
}

export function fetchUpdateStatus(): Promise<UpdateStatus> {
  return getJson<UpdateStatus>("/api/updates");
}

/** What the available update brings. A server older than the notes answers with an error. */
export async function fetchUpdateNotes(): Promise<UpdateNotes> {
  return readUpdateNotes(await getJson<unknown>("/api/updates/notes"));
}

/** What the last update brought. A server older than the question answers with an error. */
export async function fetchInstalledNotes(): Promise<InstalledNotes> {
  return readInstalledNotes(await getJson<unknown>("/api/updates/installed"));
}

export async function requestUpdate(command: UpdateCommand): Promise<void> {
  const url = `/api/updates/${command}`;
  const response = await fetch(url, { method: "POST", headers: { "x-herdr-update": "1" } });
  if (!response.ok) throw await errorFrom(url, response);
}

/** Settings → Updates: herdr itself, on the PC the server runs on. */
export function fetchHerdrUpdate(): Promise<HerdrUpdateStatus> {
  return getJson<HerdrUpdateStatus>("/api/herdr/update");
}

export async function requestHerdrUpdate(): Promise<void> {
  const url = "/api/herdr/update";
  const response = await fetch(url, { method: "POST", headers: { "x-herdr-update": "1" } });
  if (!response.ok) throw await errorFrom(url, response);
}

/** Anonymous install and update counts; null from a server that sends none (404). */
/** What every browser of this server shares (shared/preferences.ts); null where the server predates it. */
export async function fetchPreferences(): Promise<SharedPreferences | null> {
  try { return await getJson<SharedPreferences>("/api/preferences"); }
  catch (error) { if (error instanceof ApiError && error.status === 404) return null; throw error; }
}

export async function savePreferences(body: PreferencesChange): Promise<SharedPreferences> {
  const url = "/api/preferences";
  const response = await fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw await errorFrom(url, response);
  return (await response.json()) as SharedPreferences;
}

/**
 * A non-2xx answer from the T-Rex API. `code` is the server's error-envelope
 * code when it sent one, so callers can branch on `status` (401 = the token gate)
 * without parsing the message.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  /** the server's own words, without the URL and status the message starts with */
  readonly detail: string;

  constructor(url: string, status: number, detail: string, code: string | null) {
    super(`${url} failed (${status}): ${detail}`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/**
 * A 404 for the route itself, not for what it was asked about: a PC whose bridge is from before
 * the route, whose answer the local server passes through (server/machine-api.ts). What herdr
 * refuses comes with a code of its own (pane_not_found).
 */
export const routeMissing = (error: unknown): boolean => error instanceof ApiError && error.status === 404 && error.code === "not_found";

async function errorFrom(url: string, response: Response): Promise<ApiError> {
  let detail = response.statusText;
  let code: string | null = null;
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    if (body.error?.message) detail = body.error.message;
    if (body.error?.code) code = body.error.code;
  } catch {
    /* non-JSON error body */
  }
  return new ApiError(url, response.status, detail, code);
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw await errorFrom(url, response);
  return (await response.json()) as T;
}

export async function fetchSession(machineId = "local"): Promise<SessionSnapshot> {
  const body = await getJson<{ snapshot: SessionSnapshot }>(machinePath(machineId, "session"));
  return body.snapshot;
}

export interface HealthInfo {
  ok: boolean;
  herdr: HerdrIdentity;
  web_ui?: { boot_id: string | null; revision: string | null };
  /** Absent only on a server that predates the token gate. */
  auth?: HealthAuth;
  /** present only while this server is reachable beyond this PC with no token and nothing paired */
  lan_exposure?: LanExposure;
}

export async function fetchHealth(): Promise<HealthInfo> {
  return await getJson<HealthInfo>("/api/health");
}

/**
 * POST /api/auth. Resolves once the server has set its HttpOnly session cookie;
 * there is nothing to store client-side. Throws ApiError (401 `invalid_token`) on
 * a mismatch.
 */
export async function authenticate(token: string): Promise<void> {
  const response = await fetch("/api/auth", {
    method: "POST",
    headers: { "content-type": "application/json", "x-herdr-machine": "1" },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) throw await errorFrom("/api/auth", response);
  resumeConnectionTraces();
}

/** POST /api/devices/pair: the code shown on the PC, once; the server answers with this device's own HttpOnly cookie. */
export async function pairDevice(code: string, label: string): Promise<void> {
  const response = await fetch("/api/devices/pair", { method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify({ code, label }) });
  if (!response.ok) throw await errorFrom("/api/devices/pair", response);
  resumeConnectionTraces();
}

export async function fetchDevices(): Promise<PairedDevice[]> {
  return (await getJson<{ devices: PairedDevice[] }>("/api/devices")).devices;
}

export async function startPairing(): Promise<PairingCode> {
  return (await sendJson("/api/devices/pair/start", "POST", {})).json();
}

export async function renameDevice(id: string, label: string): Promise<PairedDevice> {
  return (await sendJson(`/api/devices/${encodeURIComponent(id)}`, "PATCH", { label })).json();
}

export async function revokeDevice(id: string): Promise<void> {
  await sendJson(`/api/devices/${encodeURIComponent(id)}`, "DELETE", {});
}

/** DELETE /api/auth: clears the session and device cookies, so the next health check reports the gate again. */
export async function signOut(): Promise<void> {
  const response = await fetch("/api/auth", { method: "DELETE" });
  if (!response.ok) throw await errorFrom("/api/auth", response);
}

/** Chunked btoa: the naive one-liner blows the stack on multi-MB screenshots. */
function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/** Megabytes to one decimal, rounded up: a file just over the limit never reads as the limit itself. */
const megabytes = (bytes: number): string => `${Math.ceil((bytes / (1024 * 1024)) * 10) / 10} MB`;

/** A file over the attachment limit. Its message is what the person reads: the file, its size, the limit. */
export class AttachmentTooLargeError extends Error {
  readonly fileName: string;
  readonly size: number;

  constructor(fileName: string, size: number) {
    super(t("Too large to attach: {name} ({size}). A file can be up to {limit}.", { name: fileName, size: megabytes(size), limit: megabytes(MAX_ATTACHMENT_BYTES) }));
    this.name = "AttachmentTooLargeError";
    this.fileName = fileName;
    this.size = size;
  }
}

/** Throws for a file the server would refuse, before any of it is read or sent. */
export function assertAttachable(file: Blob): void {
  if (file.size > MAX_ATTACHMENT_BYTES) throw new AttachmentTooLargeError(file instanceof File && file.name ? file.name : file.type || "file", file.size);
}

/**
 * POST /api/pane/image: stores one pasted or file-picked image next to the pane and
 * resolves to the absolute path the prompt should reference (the composer inserts
 * `@path`). AttachmentTooLargeError for a file over the limit, with nothing sent;
 * ApiError 413 image_too_large from a server whose limit is lower.
 */
/** Any file: an image is stored as a paste, anything else under its own (sanitised) name. */
export async function uploadPaneImage(paneId: string, image: Blob, machineId = "local"): Promise<string> {
  assertAttachable(image);
  const data_base64 = base64FromBytes(new Uint8Array(await image.arrayBuffer()));
  const response = await fetch(machinePath(machineId, "pane/image"), {
    method: "POST",
    headers: { "content-type": "application/json", "x-herdr-machine": "1" },
    body: JSON.stringify({ pane_id: paneId, content_type: image.type, data_base64, ...(image instanceof File ? { name: image.name } : {}) }),
  });
  if (!response.ok) throw await errorFrom(machinePath(machineId, "pane/image"), response);
  return ((await response.json()) as { path: string }).path;
}

async function sendJson(url: string, method: "POST" | "PATCH" | "DELETE", body: unknown): Promise<Response> {
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json", "x-herdr-machine": "1" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await errorFrom(url, response);
  return response;
}

/** GET /api/plugins/actions: the PC's herdr plugins and the actions it can run. */
export async function fetchPluginActions(machineId = "local"): Promise<PluginActions[]> {
  return (await getJson<PluginActionsResponse>(machinePath(machineId, "plugins/actions"))).plugins;
}

/** POST /api/plugin/action: runs one plugin action, against the pane named when there is one. */
export async function runPluginAction(request: PluginActionRequest, machineId = "local"): Promise<PluginActionResult> {
  const response = await sendJson(machinePath(machineId, "plugin/action"), "POST", request);
  return (await response.json()) as PluginActionResult;
}

/** GET /api/plugin/action: where a run the POST answered `running` for stands now. */
export async function fetchPluginActionStatus(pluginId: string, logId: string, machineId = "local"): Promise<PluginActionResult> {
  return getJson<PluginActionResult>(machinePath(machineId, `plugin/action?plugin_id=${encodeURIComponent(pluginId)}&log_id=${encodeURIComponent(logId)}`));
}

/** GET /api/pane/scroll: where the pane's viewport sits in its history (null: herdr reports none). */
export async function fetchPaneScroll(paneId: string, machineId = "local"): Promise<PaneScrollInfo | null> {
  return (await getJson<{ scroll: PaneScrollInfo | null }>(machinePath(machineId, `pane/scroll?pane_id=${encodeURIComponent(paneId)}`))).scroll;
}

/** POST /api/pane/scroll: moves the viewport; herdr redraws the attached terminal. */
export async function scrollPane(paneId: string, offsetFromBottom: number, machineId = "local"): Promise<PaneScrollInfo | null> {
  const response = await sendJson(machinePath(machineId, "pane/scroll"), "POST", { pane_id: paneId, offset_from_bottom: offsetFromBottom });
  return ((await response.json()) as { scroll: PaneScrollInfo | null }).scroll;
}

export async function findPane(request: PaneFindRequest, machineId = "local"): Promise<PaneFindResponse> {
  return (await sendJson(machinePath(machineId, "pane/find"), "POST", request)).json();
}

/** A cell in a pane's whole history: rows count from the top of the scrollback. */
export interface PaneTextPoint { row: number; col: number }

/** GET /api/pane/selection: the text between two history cells, both inclusive, wrapped lines joined. */
export async function fetchPaneSelection(paneId: string, anchor: PaneTextPoint, cursor: PaneTextPoint, machineId = "local"): Promise<string> {
  const query = new URLSearchParams({
    pane_id: paneId,
    anchor_row: String(anchor.row), anchor_col: String(anchor.col),
    cursor_row: String(cursor.row), cursor_col: String(cursor.col),
  });
  return (await getJson<{ text: string }>(machinePath(machineId, `pane/selection?${query.toString()}`))).text;
}

/**
 * POST /api/pane/close: closes the pane in herdr itself (the `pane.close` RPC).
 * The sidebar updates on its own when the server's session-changed broadcast lands;
 * a failure (e.g. the pane already gone) throws ApiError and the 5s poll reconciles.
 */
export async function closePane(paneId: string, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "pane/close"), "POST", { pane_id: paneId });
}

/** POST /api/pane/focus: herdr brings this pane and its tab/workspace to the front. */
export async function focusPane(paneId: string, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "pane/focus"), "POST", { pane_id: paneId } satisfies FocusPaneRequest);
}

/** POST /api/pane/rename: sets the pane's label in herdr (an empty label clears it). */
export async function renamePane(paneId: string, label: string, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "pane/rename"), "POST", { pane_id: paneId, label });
}

/** POST /api/agent/rename: the live name of the agent in the pane, what `herdr agent prompt <name>` addresses; null clears it. */
export async function renameAgent(paneId: string, name: string | null, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "agent/rename"), "POST", { pane_id: paneId, name } satisfies AgentRenameRequest);
}

/**
 * POST /api/pane/split: a new pane beside this one in herdr (its prefix+v / prefix+-), answered as
 * herdr lists it. herdr's focus stays put unless `focus` asks for the new pane; the sidebar and the
 * tab strip learn of it from the server's session-changed broadcast.
 */
export async function splitPane(paneId: string, direction: SplitPaneDirection, focus = false, machineId = "local"): Promise<PaneInfo> {
  const response = await sendJson(machinePath(machineId, "pane/split"), "POST", { pane_id: paneId, direction, ...(focus ? { focus: true } : {}) } satisfies SplitPaneRequest);
  return ((await response.json()) as PaneSplit).pane;
}

/** POST /api/pane/zoom: herdr's prefix+z on that pane; `zoomed` is the tab's state after it. */
export async function zoomPane(paneId: string, mode: ZoomPaneRequest["mode"] = "toggle", machineId = "local"): Promise<PaneZoomed> {
  const response = await sendJson(machinePath(machineId, "pane/zoom"), "POST", { pane_id: paneId, mode } satisfies ZoomPaneRequest);
  return (await response.json()) as PaneZoomed;
}

/** POST /api/pane/swap: the pane and its neighbour on that side change places; `changed` false when it has none there. */
export async function swapPane(paneId: string, direction: PaneDirection, machineId = "local"): Promise<PaneSwapped> {
  const response = await sendJson(machinePath(machineId, "pane/swap"), "POST", { pane_id: paneId, direction } satisfies SwapPaneRequest);
  return (await response.json()) as PaneSwapped;
}

/** POST /api/pane/swap: swap this pane with an explicit pane, keeping herdr's same-tab rule. */
export async function swapPaneWith(paneId: string, targetPaneId: string, machineId = "local"): Promise<PaneSwapped> {
  const response = await sendJson(machinePath(machineId, "pane/swap"), "POST", { pane_id: paneId, target_pane_id: targetPaneId } satisfies SwapPaneRequest);
  return (await response.json()) as PaneSwapped;
}

/** POST /api/layout/ratio: set the split identified by its binary path to the dragged ratio. */
export async function setSplitRatio(tabId: string, path: boolean[], ratio: number, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "layout/ratio"), "POST", { tab_id: tabId, path, ratio } satisfies SetSplitRatioRequest);
}

/** POST /api/pane/resize: the border the pane shares with a neighbour moves that way, by herdr's default share (0.05) of the split the border belongs to. */
export async function resizePane(paneId: string, direction: PaneDirection, machineId = "local"): Promise<PaneResized> {
  const response = await sendJson(machinePath(machineId, "pane/resize"), "POST", { pane_id: paneId, direction } satisfies ResizePaneRequest);
  return (await response.json()) as PaneResized;
}

/** POST /api/pane/clear: clears the pane's terminal screen in herdr. */
export async function clearPane(paneId: string, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "pane/clear"), "POST", { pane_id: paneId });
}

/** GET /api/agents: of the agent kinds herdr can start, the ones this app supports and that PC has installed, for the worktree dialog. */
export async function fetchAgentKinds(machineId = "local"): Promise<AgentKind[]> {
  // filtered here, not on the server: a remote PC's older bridge still answers every manifest,
  // and says nothing of what is installed, so its supported kinds are all offered
  return (await getJson<{ agents: AgentKind[] }>(machinePath(machineId, "agents"))).agents.filter((agent) => SUPPORTED_AGENT_KINDS.has(agent.kind) && agent.installed !== false);
}

/** GET /api/integrations: herdr's agent integrations on that PC and whether each is installed. */
export async function fetchIntegrations(machineId = "local"): Promise<IntegrationsResponse["integrations"]> {
  return (await getJson<IntegrationsResponse>(machinePath(machineId, "integrations"))).integrations;
}

/** GET /api/workspace/directories: the folders in `path` (empty: home), for the palette's folder browsing. */
export async function fetchDirectories(path: string, hidden: boolean, machineId = "local"): Promise<DirectoryListing> {
  const query = new URLSearchParams({ path, ...(hidden ? { hidden: "1" } : {}) });
  return getJson<DirectoryListing>(machinePath(machineId, `workspace/directories?${query.toString()}`));
}

export type { CreateTabRequest, CreateWorkspaceRequest } from "../../shared/protocol.ts";

/**
 * POST /api/workspace/create: a new herdr workspace (and an agent started in its root
 * pane when `agent` is given). Slow when an agent starts: herdr waits for the agent's
 * interactive prompt (up to 60s) before answering.
 */
export async function createWorkspace(request: CreateWorkspaceRequest, machineId = "local"): Promise<WorkspaceCreated> {
  const response = await sendJson(machinePath(machineId, "workspace/create"), "POST", request);
  return (await response.json()) as WorkspaceCreated;
}

/** POST /api/worktree/create: a git worktree of the workspace's repository, opened as a workspace grouped with it. */
export async function createWorktree(request: CreateWorktreeRequest, machineId = "local"): Promise<WorktreeOpened> {
  const response = await sendJson(machinePath(machineId, "worktree/create"), "POST", request);
  return (await response.json()) as WorktreeOpened;
}

/** GET /api/worktree/list: every checkout of the workspace's repository, with the workspace each is open in. */
export function listWorktrees(workspaceId: string, machineId = "local"): Promise<WorktreeListing> {
  return getJson<WorktreeListing>(`${machinePath(machineId, "worktree/list")}?workspace_id=${encodeURIComponent(workspaceId)}`);
}

/** POST /api/worktree/open: an existing checkout as a workspace; the one it already has when it is open. */
export async function openWorktree(request: OpenWorktreeRequest, machineId = "local"): Promise<WorktreeOpened> {
  const response = await sendJson(machinePath(machineId, "worktree/open"), "POST", request);
  return (await response.json()) as WorktreeOpened;
}

/** POST /api/tab/create: another tab in an existing workspace, with the same agent launch. */
export async function createTab(request: CreateTabRequest, machineId = "local"): Promise<TabCreated> {
  const response = await sendJson(machinePath(machineId, "tab/create"), "POST", request);
  return (await response.json()) as TabCreated;
}

/** POST /api/tab/rename: the tab's name in herdr; an empty one is refused. */
export async function renameTab(tabId: string, label: string, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "tab/rename"), "POST", { tab_id: tabId, label });
}

/** Move within its workspace without changing the selected pane or tab. */
export async function moveTab(tabId: string, insertIndex: number, machineId = "local"): Promise<TabMoved> {
  const request: MoveTabRequest = { tab_id: tabId, insert_index: insertIndex };
  const response = await sendJson(machinePath(machineId, "tab/move"), "POST", request);
  return (await response.json()) as TabMoved;
}

/** Into another workspace of the PC, at a boundary of its tabs; the panes go with their shells and get new ids. */
export async function transferTab(tabId: string, workspaceId: string, insertIndex: number, machineId = "local"): Promise<TabTransferred> {
  const request: TransferTabRequest = { tab_id: tabId, workspace_id: workspaceId, insert_index: insertIndex };
  const response = await sendJson(machinePath(machineId, "tab/transfer"), "POST", request);
  return (await response.json()) as TabTransferred;
}

/** POST /api/tab/close: the tab and every pane in it; a workspace's last tab takes the workspace with it. */
export async function closeTab(tabId: string, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "tab/close"), "POST", { tab_id: tabId });
}

export async function renameWorkspace(workspaceId: string, label: string, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "workspace/rename"), "POST", { workspace_id: workspaceId, label });
}

/** POST /api/workspace/move: places the workspace at `insertIndex` in herdr's order (the sidebar order). */
export async function moveWorkspace(workspaceId: string, insertIndex: number, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "workspace/move"), "POST", { workspace_id: workspaceId, insert_index: insertIndex });
}

/** closeGroup takes the repository's open worktree workspaces with it; herdr refuses to close over them otherwise. */
export async function closeWorkspace(workspaceId: string, machineId = "local", closeGroup = false): Promise<void> {
  await sendJson(machinePath(machineId, "workspace/close"), "POST", { workspace_id: workspaceId, ...(closeGroup ? { close_group: true } : {}) });
}

/** POST /api/worktree/remove: deletes the checkout and closes its workspace; the branch stays. */
export async function removeWorktree(request: RemoveWorktreeRequest, machineId = "local"): Promise<WorktreeRemoved> {
  const response = await sendJson(machinePath(machineId, "worktree/remove"), "POST", request);
  return (await response.json()) as WorktreeRemoved;
}

/** GET /api/push: the server's VAPID key, the `applicationServerKey` this device subscribes with. */
export async function fetchPushKey(): Promise<string> {
  return (await getJson<PushKey>("/api/push")).public_key;
}

/** `alerts`: what this device wants to hear about; the server applies it to every alert it sends here. */
export async function registerPushSubscription(subscription: PushSubscriptionJSON, alerts?: AlertPrefs): Promise<void> {
  await sendJson("/api/push/subscribe", "POST", alerts === undefined ? { subscription } : { subscription, alerts });
}

export async function unregisterPushSubscription(endpoint: string): Promise<void> {
  await sendJson("/api/push/subscribe", "DELETE", { endpoint });
}

/** One confirmation push to this device only; ApiError 502 `push_failed` when the push service refused it. */
export async function sendTestPush(endpoint: string): Promise<void> {
  await sendJson("/api/push/test", "POST", { endpoint });
}

export function fetchBridgeHealth(): Promise<BridgeHealth> { return getJson("/api/health?scope=bridge"); }
export async function fetchMachines(signal?: AbortSignal): Promise<Machine[]> {
  const response = await fetch("/api/machines", { signal });
  if (!response.ok) throw await errorFrom("/api/machines", response);
  return ((await response.json()) as { machines: Machine[] }).machines;
}
export async function machineRequest<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`/api/machines${path}`, { method, headers: { "content-type": "application/json", "x-herdr-machine": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw await errorFrom("/api/machines", response);
  return response.json();
}
export const startMachineSetup = (request: SetupRequest) => machineRequest<SetupJob>("/setup", "POST", request);
export const fetchMachineSetup = (id: string) => machineRequest<SetupJob>(`/setup/${encodeURIComponent(id)}`);
export const answerMachineSetup = (id: string, action: SetupAction) => machineRequest<SetupJob>(`/setup/${encodeURIComponent(id)}`, "POST", action);


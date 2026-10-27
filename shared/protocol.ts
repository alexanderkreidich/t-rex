/**
 * T-Rex's own HTTP/WebSocket contract, shared by the Bun server and the React client.
 *
 * The herdr WIRE types are NOT hand-written here: they are generated from herdr's
 * published API schema into ./herdr-api.generated.ts and re-exported below, so a
 * herdr upgrade shows up as a failing `bun run generate:types --check` instead of
 * types that quietly disagree with the server.
 */

export type {
  AgentInfo,
  AgentSessionInfo,
  AgentStatus,
  PaneInfo,
  PaneLayoutPane,
  PaneLayoutRect,
  PaneLayoutSnapshot,
  PaneReadResult,
  PaneScrollInfo,
  ReadFormat,
  ReadSource,
  Subscription as HerdrSubscriptionSpec,
  TabInfo,
  WorkspaceInfo,
} from "./herdr-api.generated.ts";

import type { FrameDiff } from "./ssp.ts";
import type { TerminalDisplayTheme } from "./terminal-theme.ts";
import type { GraphicsChunk } from "./ssp-assets.ts";
import type { AgentStatus, PaneInfo, PaneScrollInfo, SessionSnapshot as HerdrSnapshot, TabInfo, WorkspaceInfo } from "./herdr-api.generated.ts";

/** Friendly aliases used across the UI. */
export type HerdrWorkspace = WorkspaceInfo;
export type HerdrTab = TabInfo;
/**
 * `background_tasks`: an OmO pane's `task` children, or a Claude Code pane's subagents and background commands, still running, counted by the server; absent when none.
 * `background_wait`: the pane is at rest while work its turn started still runs, and the turn goes on when it ends (server/background-wait.ts); absent when not.
 */
export type HerdrPane = PaneInfo & {
  background_tasks?: number; background_wait?: true;
  /** This bridge's counter of transitions into displayed DONE, scoped by finish_epoch. */
  finish_id?: number;
};
/** Missing finish fields on an older bridge mean no finish can be acknowledged here. */
export type SessionSnapshot = Omit<HerdrSnapshot, "panes"> & {
  panes: HerdrPane[];
  /** Random per bridge start and observed herdr socket/marker replacement, independently per PC. */
  finish_epoch?: string;
};

export type { Machine, MachineEvent, PaneTarget, SetupJob, SetupRequest, SetupAction, BridgeIdentity, BridgeHealth } from "./machines.ts";

/** Machine API (same token gate; mutations require X-Herdr-Machine: 1 + same origin)
 * GET /api/health?scope=bridge -> BridgeHealth, never waits for herdr
 * GET /api/bridge -> authenticated BridgeIdentity (socket + runtime compatibility)
 * GET /api/machines -> { machines: Machine[] }; GET /api/machines/events -> MachineEvent SSE
 * Machine action_required=connect: a saved herdr PC awaits explicit POST /api/machines/setup before SSH.
 * Connection permission survives successful setup; installation/startup approval remains separate.
 * SetupJob/Machine action_required=bridge_conflict: align app versions, then retry setup without update_remote.
 * POST /api/machines/setup -> SetupJob; GET/POST/DELETE /api/machines/setup/:job_id
 * PATCH /api/machines/:id { name?, enabled? }; DELETE /api/machines/:id
 * /api/machines/:id/{session,agents,pane/*,workspace/*} -> existing target-local API
 * /ws?machine_id=:id -> immutable target, unchanged role + output ACK protocol
 * Legacy paths and missing machine IDs continue to mean local.
 */

/** HTTP API
 *  GET    /api/health                    -> { ok: true, herdr: HerdrIdentity (shared/machines.ts; terminal_attach false on a
 *                                          Windows herdr and on a bridge that cannot run the PTY sidecar; terminal_mirror: its
 *                                          terminal lens is the pane's screen, repainted; /api/bridge tells the same herdr), auth: HealthAuth,
 *                                          web_ui: { boot_id: string | null, revision: string | null } }
 *  GET    /api/session                   -> { snapshot: SessionSnapshot }
 *  GET    /api/access                    -> RemoteAccess (how a phone can reach this server: what
 *         Tailscale on this PC already serves, or the command to run), no-store
 *  GET    /api/updates                   -> UpdateStatus (shared/update.ts), no-store
 *  POST   /api/updates/check             -> 202 { accepted: true }
 *  POST   /api/updates/install           -> 202 { accepted: true }
 *         Update POSTs require X-Herdr-Update: 1, same-origin browser requests,
 *         and the usual token gate. Managed starts only; status is polled during restart.
 *  POST   /api/connection-diagnostics    -> 204; ClientConnectionTrace, metadata only, same-origin
 *         and authenticated (watch devices included). 400 invalid_trace, 413 trace_too_large,
 *         429 trace_rate_limited. At most 16 events and 8192 bytes; never input or credentials.
 *  GET    /api/agents                    -> { agents: AgentKind[] } (herdr's agent manifests: the
 *         kinds `agent.start` accepts, plus omo and gjc when they are on this server's PATH,
 *         each with `installed`: whether its command is on this server's PATH; for the
 *         New worktree dialog)
 *  GET    /api/integrations              -> IntegrationsResponse (herdr's `integration.list`, in
 *         herdr's order; read only: nothing here installs or removes one, Settings shows the
 *         `herdr integration install` command instead)
 *  GET    /api/plugins/actions           -> PluginActionsResponse (plugin.list + plugin.action.list:
 *         every installed plugin with its enabled state and the manifest actions this PC's
 *         platform can run; herdr lists a disabled plugin's actions too, and refuses to run them)
 *  POST   /api/plugin/action { plugin_id, action_id, pane_id? } -> PluginActionResult
 *         (plugin.action.invoke. With pane_id the action gets that pane's whole context: herdr
 *         fills a field the caller left out from its OWN focus, not from the pane named, so what
 *         the pane does not have (an agent, a git checkout, a cwd) goes as empty strings, never
 *         left out. Without pane_id herdr uses its focus throughout. herdr answers as soon as the
 *         command started, so the server waits a few seconds for its log entry: `running` means it
 *         had not ended by then, and the GET below says how it ended. A failed command is a 200
 *         with status `failed`; a refused invoke is herdr's own error: plugin_not_found,
 *         plugin_action_not_found, plugin_disabled, platform_unsupported)
 *  GET    /api/plugin/action?plugin_id=&log_id= -> PluginActionResult (plugin.log.list: where the
 *         run a POST answered `running` for stands now; `log_id` is that answer's. 404
 *         plugin_log_not_found once herdr's log no longer holds it)
 *  GET    /api/pane/read?pane_id=&source=&format=&lines=  -> { read: PaneReadResult }
 *  GET    /api/pane/scroll?pane_id=      -> { scroll: PaneScrollInfo | null } (where the
 *         viewport sits: its top row in the history is max_offset_from_bottom - offset_from_bottom)
 *  POST   /api/pane/scroll { pane_id, offset_from_bottom } -> { scroll } (pane.scroll; herdr
 *         redraws every attached terminal)
 *  POST   /api/pane/find -> PaneFindResponse; PaneFindRequest searches literal text in herdr's
 *         stored history and scrolls the shared viewport to the match, unless jump:false only
 *         reads the native match window. No copy mode is entered. The answer includes at most
 *         1024 matches around the current result and the shared scroll position; total is exact.
 *         A previous match is reused only while content_revision still matches; 409 stale_content
 *         means output or the viewport changed during the read, so the user can search again.
 *  GET    /api/pane/selection?pane_id=&anchor_row=&anchor_col=&cursor_row=&cursor_col=
 *         -> { text } (pane.selection.read: both cells inclusive, rows from the top of the
 *         history, soft-wrapped lines joined; a terminal selection that outlives one screen)
 *  POST   /api/pane/input  { pane_id, text }   -> { ok: true }
 *  POST   /api/pane/close { pane_id }         -> { ok: true } (pane.close RPC; the collector's
 *         session-changed broadcast removes it from every client's sidebar)
 *  POST   /api/pane/rename { pane_id, label } -> { ok: true } (pane.rename; empty label clears it)
 *  POST   /api/pane/focus { pane_id } -> { ok: true } (pane.focus: herdr brings its workspace,
 *         tab and pane to the front, also while the tab is zoomed)
 *  POST   /api/agent/rename { pane_id, name } -> { ok: true } (agent.rename on the pane's live agent:
 *         the name other tools address it by, `herdr agent prompt <name>`; null clears it. herdr
 *         owns the rule (shared/agent-name.ts) and answers invalid_agent_name, agent_name_taken or,
 *         for a pane without a live agent, agent_not_found; the name is read back from
 *         `snapshot.agents[].name`, and pane.updated carries the change to every client)
 *  POST   /api/pane/split  { pane_id, direction: right|down, focus? } -> PaneSplit { ok: true, pane }
 *         (pane.split beside that pane, herdr's prefix+v and prefix+-: `pane` is the new one; focus
 *         false, the default, leaves herdr's focus where it is, true moves it to the new pane as --focus does)
 *  POST   /api/pane/zoom   { pane_id, mode?: toggle|on|off } -> PaneZoomed { ok: true, zoomed, changed, reason }
 *         (pane.zoom, prefix+z: the tab shows that pane alone; herdr focuses the pane it zooms; changed
 *         false names why: single_pane, already_zoomed, already_unzoomed)
 *  POST   /api/pane/swap   { pane_id, direction: left|right|up|down } OR { pane_id, target_pane_id }
 *         -> PaneSwapped { ok: true, changed, reason, target_pane_id } (pane.swap with the neighbour
 *         on that side, prefix+shift+hjkl, or an explicit pane; exactly one destination is required;
 *         changed false names no_neighbor, same_pane, cross_tab or not_found)
 *  POST   /api/pane/resize { pane_id, direction: left|right|up|down, amount? } -> PaneResized { ok: true, changed, reason }
 *         (pane.resize, herdr's resize mode: the border the pane shares with a neighbour moves that way
 *         by `amount` of the split the border belongs to, not of the tab (0 < amount <= 0.5, herdr's
 *         own cap; its 0.05 when absent); changed false, reason unchanged, when no border of the
 *         pane can move that way)
 *  POST   /api/pane/clear  { pane_id } -> { ok: true } (pane.clear: clears the pane's terminal screen)
 *  POST   /api/layout/ratio { tab_id, path: boolean[], ratio } -> { ok: true }
 *         (layout.set_split_ratio: a split in that tab, root at [], false follows the first child,
 *         true the second; finite ratio in 0.1..0.9; an absent split answers split_not_found)
 *  POST   /api/pane/image  { pane_id, content_type, data_base64 } -> { ok: true, path }
 *         pasted image -> file under <pane cwd>/.t-rex/ (under HERDR_WEB_PASTE_DIR when the
 *         server's environment sets it), path for the prompt
 *  POST   /api/workspace/create { cwd?, label?, agent?: { kind, name?, args? } }
 *         -> WorkspaceCreated (workspace.create, then agent.start in the root pane when `agent` is given;
 *         omo and gjc, which herdr cannot start, are typed into the root pane's shell)
 *  POST   /api/tab/create { workspace_id, cwd?, label?, agent?: { kind, name?, args? } }
 *         -> TabCreated (tab.create in that workspace, then the same agent launch in the tab's root
 *         pane; without cwd herdr uses the workspace's folder, without label the tab's number)
 *         Both creates trim `label`; a blank one counts as not given, one over MAX_LABEL_CHARS
 *         (shared/labels.ts) is refused with 400 label_too_long.
 *  POST   /api/tab/rename { tab_id, label } -> { ok: true } (tab.rename; an empty label is refused:
 *         herdr would keep it as the name; over MAX_LABEL_CHARS: 400 label_too_long)
 *  POST   /api/tab/move { tab_id, insert_index } -> TabMoved
 *         (tab.move: an insertion boundary in the original workspace tab order, 0..tab count;
 *         preserves the active tab/pane and returns the authoritative workspace tab order)
 *  POST   /api/tab/transfer { tab_id, workspace_id, insert_index } -> TabTransferred
 *         (the tab into another workspace, at that boundary of its tabs, 0..their count: herdr's
 *         pane.move carries each pane over with its terminal and rebuilds the split layout, a zoom
 *         included; the panes get new ids. herdr closes the old tab; a workspace's last tab leaves a
 *         new shell tab behind, opened first, so the workspace stays. Its own workspace is a plain
 *         tab.move. A failure halfway leaves the panes moved so far.)
 *  POST   /api/tab/close  { tab_id } -> { ok: true } (tab.close: every pane in the tab closes, and
 *         a workspace's last tab takes the workspace with it)
 *  POST   /api/workspace/rename { workspace_id, label } -> { ok: true } (trimmed; empty: 400
 *         missing_label, over MAX_LABEL_CHARS: 400 label_too_long)
 *  POST   /api/workspace/move   { workspace_id, insert_index } -> { ok: true } (sidebar reorder)
 *  POST   /api/workspace/close  { workspace_id, close_group? } -> { ok: true } (close_group takes the
 *         repository's open worktree workspaces with it; without it herdr refuses: workspace_group_close_required)
 *  POST   /api/worktree/create { workspace_id, branch, base?, label?, path?, agent?: { kind, name?, args? } } -> WorktreeOpened
 *         (worktree.create: a git worktree of that workspace's repo, checked out under herdr's
 *         worktree directory unless `path` says where, and opened as a new workspace grouped with it;
 *         409 repository_without_commits when no base is named and the repository has no commit yet;
 *         both worktree routes refuse a label over MAX_LABEL_CHARS with 400 label_too_long)
 *  GET    /api/worktree/list?workspace_id= -> WorktreeListing (worktree.list: the repo's checkouts)
 *  POST   /api/worktree/open   { workspace_id, path | branch, label? } -> WorktreeOpened
 *         (worktree.open: an existing checkout as a workspace; already_open names the one it has)
 *  POST   /api/worktree/remove { workspace_id, force? } -> WorktreeRemoved (worktree.remove: deletes the
 *         checkout and closes its workspace, keeps the branch; a dirty checkout is refused without force:
 *         dirty_worktree_requires_force)
 *  POST   /api/auth        { token }     -> 204 + Set-Cookie herdr_web_token (401 invalid_token on mismatch)
 *  DELETE /api/auth                      -> 204, clears the token and the device cookies
 *  GET    /api/devices                   -> { devices: PairedDevice[] } (the paired devices; `current` marks the caller's)
 *  POST   /api/devices/pair/start        -> PairingCode: a six-digit code good for ten minutes, replacing any pending one
 *         (X-Herdr-Machine: 1 + same origin, from a client with full access)
 *  POST   /api/devices/pair { code, label? } -> 204 + Set-Cookie herdr_web_device (public, like /api/auth;
 *         401 invalid_code when the code is wrong, spent after five tries, or expired)
 *  PATCH  /api/devices/:id  { label }    -> PairedDevice;  DELETE /api/devices/:id -> 204 (revoked at its next request)
 *  GET    /api/push                      -> PushKey (the VAPID application server key)
 *  POST   /api/push/subscribe { subscription }  -> 204 (a browser PushSubscription JSON; upsert by endpoint)
 *         | 410 subscription_gone (its push service answered 404/410 for that endpoint since the server
 *         started: the browser must unsubscribe and subscribe anew; an older server never says it)
 *  DELETE /api/push/subscribe { endpoint }      -> 204
 *  POST   /api/push/test      { endpoint }      -> 204 | 404 subscription_not_found | 410 subscription_gone | 502 push_failed
 *  Errors: non-2xx with { error: { code, message } }
 *
 *  Access: every route above except /api/health, /api/auth and /api/devices/pair, plus the
 *  /ws upgrade, needs the request to be one of: from this PC itself (no proxy in front);
 *  the PC's own Tailscale login, as `tailscale serve` states it — or, where
 *  HERDR_WEB_TAILSCALE_SERVE_ONLY=1 declares serve the only ingress on a tailnet one login
 *  owns with no tagged node, a serve request that states no login; a paired device's cookie;
 *  the shared token (HERDR_WEB_TOKEN) as cookie or `Authorization: Bearer <token>`. With a
 *  token configured, only the last two count, this PC and its Tailscale login included. Without one, and while no
 *  device is paired, anything that reaches the server is let in as before (the startup
 *  warning says so). Refusals answer 401 `unauthorized` (403 `other_user` for another Tailscale
 *  login, when no token is configured); the upgrade is refused. Static files are always public.
 */
export interface ApiError {
  error: { code: string; message: string };
}

export interface PaneFindMatch {
  start: { row: number; col: number };
  end: { row: number; col: number };
}

export interface PaneFindRequest {
  pane_id: string;
  query: string;
  direction: "forward" | "backward";
  /** Defaults to true. False reads matches without moving the shared viewport. */
  jump?: boolean;
  previous?: PaneFindMatch;
  content_revision?: number;
}

export interface PaneFindResponse {
  total: number;
  /** One-based ordinal, or null when no match was found. */
  current: number | null;
  match: PaneFindMatch | null;
  content_revision: number;
  /** Native window around current, at most 1024; absent on older bridges. End cells are inclusive. */
  matches?: PaneFindMatch[];
  /** Viewport mapping at the searched revision; absent on older bridges. */
  scroll?: PaneScrollInfo | null;
}

/** How a request got in, when it did. */
export type AccessVia = "local" | "tailscale" | "device" | "token" | "open";
/** Why a request did not. */
export type AccessRefusal = "other_user" | "pairing_required" | "token_required";
/** What a paired device may do: drive (type, answer, manage) or only watch. */
export type DeviceRole = "drive" | "watch";

/** GET /api/health `auth`: `authenticated` is whether this request got in; `required` is the opposite, kept for older clients. */
export interface HealthAuth {
  readonly required: boolean;
  readonly authenticated: boolean;
  readonly via?: AccessVia;
  /** with `via: "token"`: the token came in an `Authorization` header (a proxy sends it), so signing out of this browser would change nothing */
  readonly bearer?: true;
  readonly role?: DeviceRole;
  readonly reason?: AccessRefusal;
}

/**
 * GET /api/health, authenticated requests only: this server answers on an address beyond this
 * PC while no access token is set and no device has ever been paired, so anything that can
 * reach that address is let in (`open` in `server/access.ts`). It is a warning, never a gate:
 * nothing about who is let in changes because this field exists.
 *
 * Never sent to a request that did not get in. "This host runs T-Rex with no token"
 * is reconnaissance for whoever is asking, not help.
 */
export interface LanExposure {
  /** the address the server is bound to, so the warning can name where it is reachable */
  readonly host: string;
}

export interface PairedDevice {
  readonly id: string;
  readonly label: string;
  readonly role: DeviceRole;
  readonly created_at: string;
  readonly last_seen_at: string | null;
  /** the device this request came from */
  readonly current: boolean;
}

/** POST /api/devices/pair/start */
export interface PairingCode {
  readonly code: string;
  readonly expires_at: string;
}

/** GET /api/access: how a phone can reach this server, as far as the server can tell (Settings → Phone). */
export interface RemoteAccess {
  /** the port this server listens on; the tailscale command names it */
  readonly port: number;
  readonly tailscale: TailscaleAccess;
}

/** Read from `tailscale status --json` and `tailscale serve status --json`, never by changing anything. */
export interface TailscaleAccess {
  /** missing: no tailscale CLI on this PC; stopped: the CLI is there but the daemon is not running or not logged in */
  readonly state: "missing" | "stopped" | "running";
  /** this PC's MagicDNS name, without the trailing dot */
  readonly dns_name: string | null;
  /** the HTTPS address Tailscale already proxies to this server, when there is one */
  readonly serving_url: string | null;
  /** otherwise, the command that publishes it on the lowest free of the usual HTTPS ports ... */
  readonly serve_command: string | null;
  /** ... and the address that command gives, when the DNS name is known */
  readonly serve_url: string | null;
}

/** GET /api/push: base64url VAPID public key, the `applicationServerKey` a browser subscribes with. */
export interface PushKey {
  readonly public_key: string;
}

/** One subagent or background command of a Claude Code session, read from its files: what the pane's background count is made of. */
export interface OmoTask {
  id: string;
  /** the task's summary, else its description or name */
  title: string;
  /** the category or agent type it ran as */
  category: string | null;
  model: string | null;
  /** `lost`: OmO's process that ran it is gone, or the pane no longer runs the Claude Code session that started it */
  status: "running" | "completed" | "failed" | "cancelled" | "lost";
  started_at: string | null;
  ended_at: string | null;
  turns: number | null;
  tool_calls: number | null;
  tokens: number | null;
}

/** Where a plugin manifest says an action applies. herdr may add more, so it stays open. */
export type PluginActionContext = "global" | "workspace" | "tab" | "pane" | "selection" | (string & {});

/** One manifest action of a herdr plugin. Its command line stays on the server. */
export interface PluginAction {
  /** local to its plugin: herdr's global name is `<plugin_id>.<action_id>` */
  action_id: string;
  title: string;
  description: string | null;
  /** empty when the manifest names none */
  contexts: PluginActionContext[];
}

/** GET /api/plugins/actions: one installed plugin and the actions this PC can run. */
export interface PluginActions {
  plugin_id: string;
  name: string;
  version: string;
  description: string | null;
  /** herdr refuses a disabled plugin's actions (`plugin_disabled`) */
  enabled: boolean;
  actions: PluginAction[];
}

export interface PluginActionsResponse {
  plugins: PluginActions[];
}

/** POST /api/plugin/action. Without `pane_id` herdr runs the action in its own focus. */
export interface PluginActionRequest {
  plugin_id: string;
  action_id: string;
  pane_id?: string;
}

/** POST /api/plugin/action: what herdr's plugin command log said by the time the server answered. */
export interface PluginActionResult {
  /** herdr's log entry of this run: what GET /api/plugin/action is asked about while it is `running` */
  log_id: string;
  /** `running`: the command had not ended when the wait ran out */
  status: "running" | "succeeded" | "failed";
  exit_code: number | null;
  /** a failed command's own words (spawn error, else the end of stderr, else of stdout); null otherwise */
  output: string | null;
  /**
   * The pane this run's own output says it opened with focus (the answer of `herdr plugin pane
   * open --focus`), while that pane still exists. Null for everything else: a command that
   * printed no such answer, a popup (it has no pane ID), and a pane that merely appeared while
   * the command ran, which nothing ties to it.
   */
  opened_pane_id: string | null;
}

/** GET /api/agents: one agent kind herdr can start (`agent.start` kind), with a display label. */
/** GET /api/workspace/directories: the folders inside one directory, for the folder browser. */
export interface DirectoryListing {
  /** the directory listed, absolute */
  path: string;
  /** its parent, or null at the root */
  parent: string | null;
  /** the user's home, so the browser can show `~` and offer a way back */
  home: string;
  /** folder names, sorted; hidden ones only when asked for */
  directories: string[];
  /** more folders than the list holds */
  truncated: boolean;
}

/**
 * POST /api/workspace/directories: makes one folder `name` directly inside `path` (absolute,
 * `~` or `~/…`), for the folder browser's New folder. 201 with the folder made; 400
 * invalid_cwd / invalid_name (empty, `.`, `..`, a separator, over 255 bytes), 403
 * permission_denied, 409 folder_exists. Nothing is made recursively or overwritten.
 */
export interface CreateDirectoryRequest {
  path: string;
  name: string;
}

export interface DirectoryCreated {
  /** the folder made, absolute */
  path: string;
}

export interface AgentKind {
  kind: string;
  label: string;
  /** whether the server finds the agent's command (its kind) on its PATH; absent from an older bridge */
  installed?: boolean;
}

/**
 * GET /api/integrations: one of herdr's built-in agent integrations (`integration.list`, herdr
 * 0.9.3; the saved schema predates it, so the shape is written out here). `state` widens like the
 * generated enums: a newer herdr may report one this build does not know.
 */
export interface AgentIntegration {
  /** herdr's integration target, e.g. `claude`, `antigravity_cli` */
  target: string;
  /** the name herdr shows, also the argument `herdr integration install` takes */
  label: string;
  /** the agent's executable */
  command: string;
  /** whether that executable is on the PATH of the PC herdr runs on */
  available: boolean;
  state: "not_installed" | "current" | "outdated" | (string & {});
}

export interface IntegrationsResponse {
  integrations: AgentIntegration[];
}

export interface CreateWorkspaceRequest {
  cwd?: string | null;
  label?: string | null;
  agent?: { kind: string; name?: string; args?: string[] } | null;
}

/** POST /api/tab/move: the boundary is counted BEFORE removing the source tab. */
export interface MoveTabRequest { tab_id: string; insert_index: number; }
export interface TabMoved {
  ok: true;
  tabs: HerdrTab[];
}

/** POST /api/tab/transfer: the boundary is in the target workspace's tab order. */
export interface TransferTabRequest { tab_id: string; workspace_id: string; insert_index: number; }
/** The tab's id where it went, that workspace's tabs, and each pane's new id by its old one. */
export interface TabTransferred {
  ok: true;
  tab_id: string;
  tabs: HerdrTab[];
  pane_ids: Record<string, string>;
}

/** POST /api/tab/create: the workspace is required; `label` names the new tab. */
export interface CreateTabRequest extends CreateWorkspaceRequest {
  workspace_id: string;
}

/** POST /api/workspace/create: the workspace herdr made and the pane the agent (if any) runs in. */
/** POST /api/worktree/create: branch is the new checkout's branch (created from base, or HEAD, unless it exists). */
export interface CreateWorktreeRequest {
  workspace_id: string;
  branch: string;
  base?: string | null;
  label?: string | null;
  /** an absolute checkout path; herdr's `<worktrees.directory>/<repo>/<branch>` when absent */
  path?: string | null;
  /** started in the new workspace's root pane, as /api/workspace/create starts one */
  agent?: { kind: string; name?: string; args?: string[] } | null;
}

/** POST /api/worktree/open: one of path or branch names the checkout. */
export interface OpenWorktreeRequest {
  workspace_id: string;
  path?: string | null;
  branch?: string | null;
  label?: string | null;
}

/** The workspace a worktree is open in, and its root pane. `already_open` when open before the call. */
export interface WorktreeOpened {
  workspace_id: string;
  pane_id: string;
  already_open: boolean;
  path: string;
  branch: string | null;
  /** create with `agent` only: whether herdr reported it ready in the root pane */
  agent_started?: boolean;
  /** The worktree's workspace still exists when its requested agent could not start. */
  error?: { code: string; message: string };
}

/** POST /api/agent/rename: the live name of the agent in the pane; null clears it. */
export interface AgentRenameRequest {
  pane_id: string;
  name: string | null;
}

/** POST /api/worktree/remove: `git worktree remove` of the workspace's checkout; force when git refuses a dirty one. */
export interface RemoveWorktreeRequest {
  workspace_id: string;
  force?: boolean;
}

export interface WorktreeRemoved {
  ok: true;
  path: string;
  forced: boolean;
}

/** One checkout of a repository, from herdr's `worktree.list` (git worktree list, annotated). */
export interface WorktreeEntry {
  path: string;
  branch: string | null;
  label: string;
  is_linked_worktree: boolean;
  is_bare: boolean;
  is_detached: boolean;
  is_prunable: boolean;
  /** the herdr workspace this checkout is open in, if any */
  open_workspace_id: string | null;
}

/** GET /api/worktree/list: the repository the workspace is in, and every checkout of it. */
export interface WorktreeListing {
  source: { repo_key: string; repo_name: string; repo_root: string; source_checkout_path: string; source_workspace_id: string | null };
  worktrees: WorktreeEntry[];
}

export interface WorkspaceCreated {
  workspace_id: string;
  pane_id: string;
  /** true when `agent` was requested and herdr reported it ready in the root pane */
  agent_started: boolean;
  /** The workspace still exists when its requested agent could not start. */
  error?: { code: string; message: string };
}

/**
 * POST /api/tab/create: the existing workspace and the new tab's root pane. A failed agent
 * launch leaves the tab there, reachable through pane_id, as workspace creation does.
 */
export type TabCreated = WorkspaceCreated & {
  /** The new tab and pane as herdr created them: clients can mount before refreshing the roster.
   * Older bridges omit them, in which case the client waits for its normal roster refresh. */
  tab?: HerdrTab;
  pane?: HerdrPane;
};

/** The two ways herdr splits a pane: a new pane to its right, or below it. */
export type SplitPaneDirection = "right" | "down";

/** A neighbour's side, for swapping and resizing: herdr's own left/right/up/down. */
export type PaneDirection = "left" | "right" | "up" | "down";

/** POST /api/pane/split: `focus` true moves herdr's focus to the new pane (its --focus); false, the default, leaves it. */
export interface SplitPaneRequest {
  pane_id: string;
  direction: SplitPaneDirection;
  focus?: boolean;
}

/** The pane herdr made, as its snapshot lists it (focused only when `focus` asked for it). */
export interface PaneSplit {
  ok: true;
  pane: PaneInfo;
}

/** POST /api/pane/zoom: a toggle by default; `on` and `off` set the state instead. */
export interface ZoomPaneRequest {
  pane_id: string;
  mode?: "toggle" | "on" | "off";
}

/** `zoomed` is the tab's state after the call; `reason` says why `changed` is false (single_pane, already_zoomed, already_unzoomed). */
export interface PaneZoomed {
  ok: true;
  zoomed: boolean;
  changed: boolean;
  reason: string | null;
}

/** POST /api/pane/focus: focus this exact pane in herdr, including its workspace and tab. */
export interface FocusPaneRequest { pane_id: string }

/** POST /api/pane/swap: exactly one of a neighbouring side or an explicit pane in the same tab. */
export type SwapPaneRequest = { pane_id: string } & (
  | { direction: PaneDirection; target_pane_id?: never }
  | { target_pane_id: string; direction?: never }
);

/** `target_pane_id` is the requested pane or neighbour; unchanged reasons include no_neighbor, same_pane, cross_tab and not_found. */
export interface PaneSwapped {
  ok: true;
  changed: boolean;
  reason: string | null;
  target_pane_id: string | null;
}

/**
 * POST /api/pane/resize: the border the pane shares with a neighbour moves `direction`-wards by
 * `amount` of the split that border belongs to, which herdr measures on the split's own extent,
 * not the tab's (0.25 in a 60-column half of a 120-column tab moves the border 15 columns, not
 * 30). herdr caps the amount at 0.5 and holds a split's ratio to 0.1..0.9, so the server refuses
 * more than 0.5 (invalid_amount) rather than let herdr quietly take less; its own 0.05 when
 * absent. Measured on herdr 0.9.3.
 */
export interface ResizePaneRequest {
  pane_id: string;
  direction: PaneDirection;
  amount?: number;
}

/** `changed` false with reason unchanged: no border of the pane could move that way. */
export interface PaneResized {
  ok: true;
  changed: boolean;
  reason: string | null;
}

/** POST /api/layout/ratio: false takes the first branch, true the second; [] names the root split. */
export interface SetSplitRatioRequest {
  tab_id: string;
  path: boolean[];
  /** finite, inclusive 0.1..0.9, the bounds of herdr's split drag */
  ratio: number;
}

/**
 * The JSON inside every web push, decrypted by the device's service worker (public/sw.js)
 * and shown as a notification. `pane_id` is null for the enable-confirmation push; `tag`
 * is shared with the in-tab notification of the same pane, so one replaces the other.
 */
export interface PushPayload {
  /** Absent in legacy payloads means local. */
  machine_id?: string;
  pane_id: string | null;
  /** The workspace the pane was last seen in, so the tap of an ended pane opens that workspace. Absent when not known. */
  workspace_id?: string;
  title: string;
  body: string;
  tag: string;
}

/** WebSocket at /ws
 *
 *  Client -> server frames: attach {pane_id, cols, rows, sync?, resume?} | detach {pane_id}
 *    | input {pane_id, text, seq?} | keys {pane_id, keys, seq?} | resize {pane_id, cols, rows}
 *    | release-size {pane_id} | role {mode} | ssp-ack {pane_id, stream, num}
 *    | secret {id, pane_id, prompt, secret} | watch {pane_id, cols, rows} | unwatch {pane_id}
 *    | submit {id, pane_id, text, payload, typed?}
 *  Server -> client frames: snapshot | ssp | pty-data | pty-exit | pane-geometry | role-ack
 *    | pane-status | pane-exited | session-changed | secret-result | submit-result
 *    | watch-data | watch-end | error
 *
 *  attach {sync:"ssp"} (feature "ssp") syncs the pane's screen instead of streaming its bytes
 *  (shared/ssp.ts): `ssp` frames carry the difference from a screen the client has to the current
 *  one, and `ssp-ack` says which screen the client has now. A client that falls behind skips
 *  screens; nothing is replayed. `resume` names the stream and screen a client had on a connection
 *  that dropped: while the pane's attachment lives, the next screen comes as a difference from it.
 *  `seq` numbers a client's input to a pane; each `ssp` frame's `echo` is the newest the program has
 *  had time to echo (the client's local echo checks its guesses against that screen).
 *  An attach without `sync` (an older client) gets the raw byte stream as `pty-data`, and a
 *  connection whose transport backs up closes with code 4008.
 *
 *  Roles: a connection starts as `interact`. `role {mode:"observe"}` demotes it server-side:
 *  input/keys/resize then answer a `read_only` error frame and attaching never resizes the
 *  shared pty - the observer instead receives `pane-geometry` and adopts the pty's grid, so
 *  a phone watching a pane can never change the size the operator's PC sees. The client
 *  re-sends its role before the attach replay on reconnect.
 *  secret requires the "secret-input" feature, an interact attachment, a matching fresh
 *  prompt and an idle input queue. Its result contains only ok/code, never the value.
 *  watch requires the "watch" feature: a read-only view of the pane drawn for the client's grid
 *  (`herdr terminal session observe`), which, unlike an attach, leaves the pane at the size herdr's
 *  own window gives it. It is not an attach: no input, resize, ACK or input-ready. A tab out of use
 *  detaches and watches; it attaches again when the user is back. One watch per pane and connection;
 *  a second watch for the same pane starts it again at the new grid. watch-end: the view ended
 *  (unwatch does not answer one), and a pane the view could not start for gets one at once.
 */

/** A connection's authority over the shared ptys: `interact` types and resizes, `observe` only watches. */
export type ClientRole = "interact" | "observe";

export type ClientMessage =
  /** keep_size: the grid is not shown here (a hidden pane, a tab out of use), so the attach leaves the shared pty's size as it is */
  | { type: "attach"; pane_id: string; cols: number; rows: number; keep_size?: boolean; sync?: "ssp"; graphics?: boolean; resume?: { stream: string; num: number }; theme?: TerminalDisplayTheme }
  | { type: "detach"; pane_id: string }
  /** a pane another web bridge holds (`attach_held`): take herdr's attach slot from it, here, now */
  | { type: "take-over"; pane_id: string }
  | { type: "input"; pane_id: string; text: string; seq?: number }
  | { type: "keys"; pane_id: string; keys: string[]; seq?: number }
  /** the terminal's input line, sent to servers whose snapshot lists "submit": the server types
   * `payload` (the line shaped for the pane's bracketed-paste mode) like the keyboard would, then its
   * own Enter after a short gap, and answers with a submit-result of the same id. `text` is the line
   * as written. `typed` is what an older client says of every line it sends; the server types each. */
  | { type: "submit"; id: number; pane_id: string; text: string; payload: string; typed?: boolean }
  /** Masked input: revalidate the visible prompt, type literal bytes + Enter immediately.
   * Never queued, retried, sent through agent.prompt, or echoed in a result. */
  | { type: "secret"; id: number; pane_id: string; prompt: string; secret: string }
  | { type: "resize"; pane_id: string; cols: number; rows: number; theme?: TerminalDisplayTheme }
  /** this client's terminal is no longer shown: if the pty has its grid, the server sizes
   * the pty for the latest grid of another interact client still showing the terminal, or leaves it.
   * Never answered; an older server ignores it, so it needs no feature. */
  | { type: "release-size"; pane_id: string }
  /** the newest screen of `stream` this client has (ssp) */
  | { type: "ssp-ack"; pane_id: string; stream: string; num: number }
  | { type: "ssp-asset-ack"; pane_id: string; stream: string; key: string; offset: number }
  | { type: "role"; mode: ClientRole }
  /** whether this page is in use: visible and focused. While any connection of a server says
   * so, that server sends no web push to any device (#751). Sent on connect and on every change,
   * also through a remote PC's socket (the connection server reads it there too); an older
   * server ignores it, so it needs no feature. */
  | { type: "presence"; active: boolean }
  /** a read-only view of the pane at this grid, for a tab out of use (feature "watch"); never resizes the pane */
  | { type: "watch"; pane_id: string; cols: number; rows: number }
  | { type: "unwatch"; pane_id: string }
  /** liveness only (feature "ping"): answered at once with a `pong` of the same id, for any role. The
   * client sends it when the page comes back, the network changes or nothing arrived for a while,
   * and drops a socket that stays silent: a half-open one still reads OPEN in the browser. A remote
   * PC's socket relays it unchanged, so the remote server's snapshot decides whether it is sent. */
  | { type: "ping"; id: number };

/** Local-only diagnostic metadata. This contract never contains a message, URL or credential. */
export type ClientConnectionEventKind = "connect" | "open" | "connect_timeout" | "close" | "socket_error"
  | "pagehide" | "pageshow" | "hidden" | "visible" | "online" | "probe" | "probe_retry"
  | "probe_overdue" | "probe_drop" | "pong" | "submit_sent" | "submit_result" | "submit_timeout"
  | "submit_disconnect" | "input_held" | "probe_input_blocked" | "closing_wait";
export interface ClientConnectionEvent {
  seq: number;
  at: number;
  connection: number;
  kind: ClientConnectionEventKind;
  socket_state: number | null;
  visibility: "visible" | "hidden" | "unknown";
  online: boolean | null;
  code?: number;
  elapsed_ms?: number;
  pending?: number;
  request_id?: number;
  attempt?: number;
  result?: "ok" | "refused";
}
export interface ClientConnectionTrace {
  client_id: string;
  target: "local" | "remote";
  events: ClientConnectionEvent[];
}

/** What a server supports beyond the base protocol, listed in its first snapshot; older bridges list nothing. */
export type ServerFeature = "submit" | "secret-input" | "input-ready" | "take-over" | "watch" | "ping" | "ssp";

export type ServerMessage =
  | { type: "snapshot"; snapshot: SessionSnapshot; features?: ServerFeature[] }
  /** raw PTY bytes: append to the terminal, never repaint over it. A mirrored pane (HerdrIdentity.terminal_mirror) sends whole screens the same way. */
  /** the pane's screen, as the difference from one the client has (attach sync "ssp") */
  | ({ type: "ssp"; pane_id: string } & FrameDiff)
  | ({ type: "ssp-asset"; pane_id: string; stream: string } & GraphicsChunk)
  | { type: "pty-data"; pane_id: string; data: string }
  | { type: "pty-exit"; pane_id: string; code: number | null }
  /** a pane that waited for another web bridge to let go of its terminal (error `attach_held`) is attached again */
  | { type: "attach-resumed"; pane_id: string }
  /** Attachment readiness (omitted ready means true); false revokes it during retry. Never a typed-text acknowledgement. */
  | { type: "input-ready"; pane_id: string; ready?: boolean }
  /** the shared pty's grid changed: observe clients adopt it, interact clients drive it. `fixed`: the grid is the pane's own in herdr (a mirrored pane), so every client adopts it and none resizes */
  | { type: "pane-geometry"; pane_id: string; cols: number; rows: number; fixed?: boolean }
  | { type: "role-ack"; mode: ClientRole }
  /** ok after Enter delivery; never an agent execution acknowledgement */
  | { type: "submit-result"; id: number; pane_id: string; ok: boolean; code?: string; message?: string }
  | { type: "secret-result"; id: number; pane_id: string; ok: boolean; code?: string }
  /** agent-status push for ANY pane, attached or not (server-side status collector) */
  | { type: "pane-status"; pane_id: string; agent_status: AgentStatus; finish_id?: number; finish_epoch?: string; /** a pane's running background tasks (OmO's, or a Claude Code pane's subagents and commands), when the frame is about them: it changes no status */ background_tasks?: number; /** every frame says it: absent, the pane does not wait on its turn's background work */ background_wait?: true }
  /** a pane's process exited (pushed even when nobody is attached to it) */
  | { type: "pane-exited"; pane_id: string }
  /** session structure changed (pane created/closed): refetch /api/session */
  | { type: "session-changed" }
  /** a watched pane's screen as herdr draws it for the watch's grid: whole screens and changes, written as they come; never acknowledged */
  | { type: "watch-data"; pane_id: string; data: string }
  /** the watch ended (pane gone, herdr closed it, or this herdr has no read-only view); the client keeps its last screen */
  | { type: "watch-end"; pane_id: string }
  /** the answer to a `ping`, with its id; only this frame, for a ping in flight, ends the client's liveness probe */
  | { type: "pong"; id: number }
  /** `pane_id` names the pane an error is about, when it is about one (`attach_held`) */
  | { type: "error"; code: string; message: string; pane_id?: string };

/** herdr's default socket, under XDG_CONFIG_HOME when set, as herdr itself resolves it. */
export const HERDR_SOCKET_PATH = `${process.env["XDG_CONFIG_HOME"] || `${process.env["HOME"] ?? ""}/.config`}/herdr/herdr.sock`;
export const DEFAULT_PORT = 7317;

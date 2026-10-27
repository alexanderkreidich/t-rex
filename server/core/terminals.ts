/**
 * Each pane's terminal and who shows it: the attachment every client of a pane shares, the one
 * still being created, the one whose process is still exiting, and the output each client is
 * sent.
 */
import type { ClientMessage, ServerMessage } from "../../shared/protocol.ts";
import { validTerminalTheme } from "../../shared/terminal-theme.ts";
import { HerdrError, terminalSetTheme } from "../herdr/client.ts";
import { TerminalDisplay } from "../../shared/ssp-display.ts";
import { type SightingFacts, sightingFacts } from "../input-guard.ts";
import type { GraphicsChunk } from "../../shared/ssp-assets.ts";
import { OUTPUT_HARD_BYTES, OUTPUT_HIGH_BYTES, OUTPUT_STALL_MS } from "../transport-limits.ts";
import { EchoClock, SyncSender } from "../ssp/sync.ts";
import { type Client, connectionOf, send } from "./connections.ts";
import { ATTACH_HELD_MESSAGE, createSpawnAttachment, type PaneAttachment } from "./terminal-process.ts";

/** how long a stream a client left may be resumed, and how many a pane keeps */
const RESUME_FOR_MS = 60_000;
const RESUME_MAX = 16;

type Frame<T extends ClientMessage["type"]> = Extract<ClientMessage, { type: T }>;

/** What the server outside the registry reads of a pane's attachment: its grid, and whether another web bridge holds its terminal. */
export type AttachmentView = { readonly cols: number; readonly rows: number; readonly held?: boolean };

/**
 * What a connection saw of a pane's terminal before an await, held as references and never
 * copied: `facts()` compares them with the pane's terminal now, so an attach or a session that
 * replaced the one seen never passes for it.
 */
export interface TerminalSighting {
  /**
   * The attachment the connection was in when it saw the pane, that attachment's session, and the
   * connection's claim then. For comparing two sightings with `===` only.
   */
  readonly origin: unknown;
  readonly pty: unknown;
  readonly claim: unknown;
  facts(): SightingFacts;
  /** Writes into the session seen, as typing into its pty does (a mirror sends it through herdr). */
  write(data: string): boolean | void;
}

/** Clamp surface for the shared pty, mirroring the sidecar's own limits. */
export function validGeometry(cols: unknown, rows: unknown): { cols: number; rows: number } | null {
  if (typeof cols !== "number" || typeof rows !== "number" || !Number.isInteger(cols) || !Number.isInteger(rows)) {
    return null;
  }
  if (cols < 1 || cols > 1000 || rows < 1 || rows > 1000) return null;
  return { cols, rows };
}

/**
 * The server's terminals. `stopped` is read through a getter, as `stop()` sets it later, and `end`
 * is called through one, as the connections are built after the terminals.
 */
export function createTerminalRegistry({ clients, stopped, terminalAttach, holdFor, heldRetry, retryFor, relookupFor, end }: {
  options: object;
  clients: Set<Client>;
  stopped: () => boolean;
  terminalAttach: () => Promise<boolean>;
  holdFor: number;
  heldRetry: number;
  retryFor: number;
  relookupFor: number;
  end: (client: Client, reason: "stalled" | "revoked" | "closed") => void;
}) {
  const attachments = new Map<string, PaneAttachment>();
  const themeWrites = new WeakMap<PaneAttachment, { process: unknown; driver?: Client; claim?: unknown; key?: string; tail: Promise<void> }>();

  function syncTheme(paneId: string): void {
    const attachment = attachments.get(paneId);
    if (attachment?.kind !== "pty" || !attachment.ready || attachment.held || !attachment.terminalId) return;
    const driver = attachment.driver;
    const claim = driver?.data.attached.get(paneId);
    const theme = driver && connectionOf(driver).mode === "interact" && !connectionOf(driver).closing && !claim?.keepSize ? claim?.theme ?? null : null;
    let state = themeWrites.get(attachment);
    if (!theme && !state) return;
    if (!state) {
      state = { process: attachment.process, tail: Promise.resolve() };
      themeWrites.set(attachment, state);
    }
    const process = attachment.process;
    const terminalId = attachment.terminalId;
    const key = JSON.stringify(theme);
    if (state.process === process && state.driver === driver && state.claim === claim && state.key === key) return;
    state.process = process;
    state.driver = driver;
    state.claim = claim;
    state.key = key;
    const queued = state;
    const current = () => attachments.get(paneId) === attachment && attachment.process === process
      && queued.key === key && attachment.ready && !attachment.held && attachment.driver === driver
      && (!driver || (driver.data.attached.get(paneId) === claim && !claim?.keepSize
        && connectionOf(driver).mode === "interact" && !connectionOf(driver).closing));
    queued.tail = queued.tail.then(async () => {
      if (current()) await terminalSetTheme(terminalId, theme, current);
    }).catch((error: unknown) => {
      if (queued.key === key) queued.key = undefined;
      if (!(error instanceof HerdrError && error.code === "cancelled")) console.error(`terminal theme for ${paneId}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /** attachments still resolving their terminal, so concurrent attaches share one pty */
  const pendingAttachments = new Map<string, Promise<PaneAttachment>>();
  // herdr releases its exclusive attach slot only after the old process exits.
  const retiringAttachments = new Map<string, Promise<void>>();

  /**
   * A client of the raw stream (an older page) whose transport stays backed up is closed (4008):
   * nothing waits for it. The pty is never paused, as the screen takes everything it draws, and a
   * synced client that fell behind skips to the current screen.
   */
  function reconcileOutput(paneId: string): void {
    const attachment = attachments.get(paneId);
    if (!attachment) return;
    for (const client of attachment.clients) {
      const sender = client.data.sync.get(paneId);
      if (sender) {
        sender.drain();
        continue;
      }
      const buffered = client.getBufferedAmount();
      if (buffered < OUTPUT_HIGH_BYTES) {
        attachment.stalled.delete(client);
        continue;
      }
      const since = attachment.stalled.get(client) ?? Date.now();
      attachment.stalled.set(client, since);
      if (Date.now() - since >= OUTPUT_STALL_MS || buffered >= OUTPUT_HARD_BYTES) end(client, "stalled");
    }
  }

  /** The attachment's terminal drew `data`: the screen takes it, and so does every client. */
  function output(paneId: string, attachment: PaneAttachment, data: string): void {
    const replies = attachment.screen.write(data);
    let raw = false;
    for (const client of attachment.clients) {
      const sender = client.data.sync.get(paneId);
      if (sender) sender.schedule();
      else {
        raw = true;
        sendRaw(client, paneId, data);
      }
    }
    // the screen answers the attach's queries (device attributes, cursor position), unless a
    // client of the raw stream is there: its own terminal answers them, and a second answer
    // would reach the pane as typing
    if (replies && !raw && attachment.kind === "pty") attachment.process.write(replies);
    reconcileOutput(paneId);
  }

  function sendRaw(client: Client, paneId: string, data: string): void {
    if (client.getBufferedAmount() >= OUTPUT_HARD_BYTES) {
      end(client, "stalled");
      return;
    }
    send(client, { type: "pty-data", pane_id: paneId, data });
  }

  function broadcast(paneId: string, message: ServerMessage): void {
    const attachment = attachments.get(paneId);
    if (!attachment) return;
    for (const client of attachment.clients) send(client, message);
    if (message.type === "input-ready" && message.ready !== false) syncTheme(paneId);
  }

  /** Stops syncing `client` with the pane; what it last had stays resumable for a while. */
  function stopSync(client: Client, paneId: string, attachment: PaneAttachment | undefined): void {
    const sender = client.data.sync.get(paneId);
    if (!sender) return;
    client.data.sync.delete(paneId);
    sender.dispose();
    const resume = sender.resumable();
    if (!attachment || !resume) return;
    const now = Date.now();
    for (const [stream, entry] of attachment.resumable) if (entry.until <= now) attachment.resumable.delete(stream);
    attachment.resumable.set(resume.stream, { ...resume, until: now + RESUME_FOR_MS });
    while (attachment.resumable.size > RESUME_MAX) attachment.resumable.delete(attachment.resumable.keys().next().value!);
  }

  /** The newest input of `client` the program in the pane has had time to echo. */
  function echoClock(client: Client, paneId: string): EchoClock {
    let clock = client.data.echo.get(paneId);
    if (!clock) {
      clock = new EchoClock();
      client.data.echo.set(paneId, clock);
    }
    return clock;
  }

  /** `client`'s input `seq` reached the pane's program: its next screen says so once the echo is due. */
  function inputApplied(client: Client, paneId: string, seq: number | undefined): void {
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq <= 0) return;
    const due = echoClock(client, paneId).mark(seq);
    const sender = client.data.sync.get(paneId);
    // a timer may fire a moment early, before the echo is due: a millisecond late, it is due
    if (sender) setTimeout(() => { if (client.data.sync.get(paneId) === sender) sender.schedule(); }, Math.max(0, due - Date.now()) + 1);
  }

  const { spawnAttachment } = createSpawnAttachment({ attachments, retiringAttachments, terminalAttach, isStopped: stopped, closeAttachment, broadcast, output, holdFor, heldRetry, retryFor, relookupFor });

  function closeAttachment(paneId: string): void {
    const attachment = attachments.get(paneId);
    if (!attachment) return;
    attachments.delete(paneId);
    clearTimeout(attachment.retry);
    clearTimeout(attachment.relookup);
    // its members hold nothing on this pane any more (a pty that exited leaves them on
    // the "terminal ended" screen): a stale entry would read as a live claim in
    // releaseUnclaimed and keep a later, empty pty on this pane running
    for (const member of attachment.clients) member.data.attached.delete(paneId);
    for (const member of attachment.clients) stopSync(member, paneId, undefined);
    attachment.resumable.clear();
    attachment.screen.dispose();
    const retired = attachment.process.exited.finally(() => {
      if (retiringAttachments.get(paneId) === retired) retiringAttachments.delete(paneId);
    });
    retiringAttachments.set(paneId, retired);
    attachment.process.kill();
  }

  /** An interact client's terminal sizes the pty: the grid is remembered as this client's, and it drives. */
  function drivePty(paneId: string, client: Client, cols: number, rows: number): void {
    const attachment = attachments.get(paneId);
    const claim = client.data.attached.get(paneId);
    if (claim) claim.keepSize = false;
    if (attachment && attachment.kind !== "mirror") {
      attachment.grids.delete(client);
      attachment.grids.set(client, { cols, rows });
      attachment.driver = client;
    }
    resizePty(paneId, cols, rows);
    syncTheme(paneId);
  }

  function releaseDriver(paneId: string, client: Client, attachment: PaneAttachment): void {
    attachment.grids.delete(client);
    if (attachment.driver !== client) return;
    attachment.driver = undefined;
    const next = [...attachment.grids].reverse().find(([other]) => connectionOf(other).mode === "interact"
      && attachment.clients.has(other) && other.data.attached.get(paneId)?.keepSize === false);
    if (next) drivePty(paneId, next[0], next[1].cols, next[1].rows);
    else syncTheme(paneId);
  }

  function resizePty(paneId: string, cols: number, rows: number): void {
    const attachment = attachments.get(paneId);
    // a mirrored pane's grid is herdr's own: no browser resizes it
    if (!attachment || attachment.kind === "mirror" || (attachment.cols === cols && attachment.rows === rows)) return;
    attachment.cols = cols;
    attachment.rows = rows;
    attachment.process.resize(cols, rows);
    // the screen takes the new grid now; herdr redraws it whole for the new size
    attachment.screen.resize(cols, rows);
    broadcast(paneId, { type: "pane-geometry", pane_id: paneId, cols, rows });
  }

  function ensureAttachment(paneId: string, cols: number, rows: number, forObserver: boolean): Promise<PaneAttachment> {
    const existing = attachments.get(paneId);
    if (existing) return Promise.resolve(existing);
    // a second attach arriving while the first is still resolving the terminal joins
    // that creation: two creations would spawn two ptys, and the orphaned one keeps
    // streaming into the surviving attachment and kills it when it exits
    const pending = pendingAttachments.get(paneId);
    if (pending) return pending;

    const created = spawnAttachment(paneId, cols, rows, forObserver).finally(() => pendingAttachments.delete(paneId));
    pendingAttachments.set(paneId, created);
    return created;
  }

  function detach(paneId: string, client: Client): void {
    const attachment = attachments.get(paneId);
    stopSync(client, paneId, attachment);
    client.data.echo.delete(paneId);
    if (!attachment) return;
    attachment.clients.delete(client);
    attachment.stalled.delete(client);
    releaseDriver(paneId, client, attachment);
    if (attachment.clients.size === 0) closeAttachment(paneId);
    else reconcileOutput(paneId);
  }

  /** An ending connection leaves its panes while its claims still count, then drops them (dropClaims). */
  function detachClaimed(client: Client): void {
    for (const paneId of client.data.attached.keys()) detach(paneId, client);
  }

  function dropClaims(client: Client): void {
    client.data.attached.clear();
    for (const sender of client.data.sync.values()) sender.dispose();
    client.data.sync.clear();
    client.data.echo.clear();
  }

  /**
   * Closes an attachment whose creating client detached or disconnected before it was
   * ready, unless a client still wants it: every attach records its pane in
   * `attached` before awaiting, so a joiner of the same creation that has not resumed
   * yet still counts and is not left holding a dead record.
   */
  function releaseUnclaimed(paneId: string, attachment: PaneAttachment): void {
    if (attachments.get(paneId) !== attachment || attachment.clients.size > 0) return;
    for (const other of clients) if (other.data.attached.has(paneId)) return;
    closeAttachment(paneId);
  }

  /** What `client` sees of the pane's terminal now, for the checks it makes after an await. */
  function sight(client: Client, paneId: string): TerminalSighting {
    const attachment = attachments.get(paneId);
    const member = attachment?.clients.has(client) === true;
    const process = attachment?.process;
    const claim = client.data.attached.get(paneId);
    const seen = { attachment, process, claim, member };
    return {
      origin: member ? attachment : undefined,
      pty: member ? process : undefined,
      claim,
      facts: () => sightingFacts(seen, { attachment: attachments.get(paneId), claim: client.data.attached.get(paneId) }, client),
      write: (data) => process!.write(data),
    };
  }

  /** Something was typed into the pane: a mirrored screen is read at once for its echo, not at its next idle read. */
  function poke(paneId: string): void {
    const attachment = attachments.get(paneId);
    if (attachment?.kind === "mirror") attachment.process.poke();
  }

  /** A connection whose transport queue drained: its panes' output may flow again. */
  function drainOutput(client: Client): void {
    for (const paneId of client.data.attached.keys()) reconcileOutput(paneId);
  }

  /** The terminal frames a connection sends, each handled as its `case` in the socket's frame switch was. */
  const terminalFrames = {
    async attach(client: Client, message: Frame<"attach">): Promise<void> {
      const geometry = validGeometry(message.cols, message.rows);
      if (!geometry) {
        send(client, { type: "error", code: "invalid_geometry", message: "cols and rows must be integers in 1..1000" });
        return;
      }
      if (message.theme !== undefined && !validTerminalTheme(message.theme)) {
        send(client, { type: "error", code: "invalid_theme", message: "theme must contain RGB defaults and 16 ANSI colours" });
        return;
      }
      // record the pane before the await: a detach (switching panes) or a close
      // that lands while the terminal is looked up must cancel this attach, and
      // neither can see a client that only joins the attachment afterwards
      const claim: { keepSize: boolean; theme?: Frame<"attach">["theme"] } = client.data.attached.get(message.pane_id) ?? { keepSize: false };
      claim.keepSize = message.keep_size === true;
      if (message.theme !== undefined) claim.theme = message.theme;
      if (!client.data.attached.has(message.pane_id)) client.data.attached.set(message.pane_id, claim);
      let attachment: PaneAttachment;
      try {
        // a covered grid (keep_size) creates the pty at the pane's own size, as an observer does
        attachment = await ensureAttachment(message.pane_id, geometry.cols, geometry.rows, connectionOf(client).mode === "observe" || message.keep_size === true);
      } catch (error) {
        if (client.data.attached.get(message.pane_id) === claim) client.data.attached.delete(message.pane_id);
        throw error;
      }
      if (stopped() || connectionOf(client).closing || client.data.attached.get(message.pane_id) !== claim) {
        releaseUnclaimed(message.pane_id, attachment);
        return;
      }
      // A pane that ended during creation must not gain clients.
      if (attachments.get(message.pane_id) !== attachment) {
        client.data.attached.delete(message.pane_id);
        send(client, { type: "pty-exit", pane_id: message.pane_id, code: null });
        return;
      }
      // An idempotent attach must not start the screen over.
      const alreadyAttached = attachment.clients.has(client);
      attachment.clients.add(client);
      // a mirrored screen is drawn for the pane's own grid: the client takes that size
      // before the screen, or the rows would wrap in a grid of another width
      if (attachment.kind === "mirror") send(client, { type: "pane-geometry", pane_id: message.pane_id, cols: attachment.cols, rows: attachment.rows, fixed: true });
      // the newcomer starts from the current screen: a synced client from the screen it had, if it
      // names one this pane still keeps, an older page from the screen drawn whole
      if (!alreadyAttached && message.sync === "ssp") {
        const resume = message.resume && typeof message.resume.stream === "string" ? attachment.resumable.get(message.resume.stream) : undefined;
        const base = resume && resume.until > Date.now() && Number.isInteger(message.resume!.num) ? resume.frames.get(message.resume!.num) : undefined;
        if (resume) attachment.resumable.delete(resume.stream);
        const paneId = message.pane_id;
        const sender = new SyncSender(attachment.screen, {
          send: (diff) => send(client, { type: "ssp", pane_id: paneId, ...diff }) !== 0,
          ...(message.graphics === true ? { sendAsset: (chunk: GraphicsChunk, stream: string) => send(client, { type: "ssp-asset", pane_id: paneId, stream, ...chunk }) !== 0 } : {}),
          buffered: () => client.getBufferedAmount(),
          echo: () => client.data.echo.get(paneId)?.echo() ?? 0,
        }, base ? { stream: resume!.stream, base } : undefined);
        client.data.sync.set(paneId, sender);
        sender.schedule();
      } else if (!alreadyAttached && attachment.screen.drawn) {
        const screen = attachment.screen.frame();
        sendRaw(client, message.pane_id, new TerminalDisplay().draw(screen, (id) => attachment.screen.styleOf(id)));
      }
      // a pane waiting for another web bridge to let go says so to each newcomer, too
      if (!alreadyAttached && attachment.held) send(client, { type: "error", code: "attach_held", message: ATTACH_HELD_MESSAGE, pane_id: message.pane_id });
      reconcileOutput(message.pane_id);
      if (connectionOf(client).closing) return;
      if (attachment.ready && !attachment.held) send(client, { type: "input-ready", pane_id: message.pane_id });
      if (attachment.kind === "mirror") return;
      if (connectionOf(client).mode === "interact" && !claim.keepSize) {
        // an operator's viewport owns the shared grid
        drivePty(message.pane_id, client, geometry.cols, geometry.rows);
      } else {
        // a covered grid is not a terminal showing: a release never hands the pty to it
        attachment.grids.delete(client);
        // an observer, or a client that keeps its size, adopts the grid the operators left behind
        send(client, {
          type: "pane-geometry",
          pane_id: message.pane_id,
          cols: attachment.cols,
          rows: attachment.rows,
        });
      }
      return;
    },
    "take-over"(client: Client, message: Frame<"take-over">): void {
      if (connectionOf(client).mode === "observe") {
        send(client, { type: "error", code: "read_only", message: "this connection is in observe mode" });
        return;
      }
      const attachment = attachments.get(message.pane_id);
      if (attachment?.kind === "pty" && attachment.clients.has(client)) attachment.takeOver?.(client);
      return;
    },
    detach(client: Client, message: Frame<"detach">): void {
      client.data.attached.delete(message.pane_id);
      detach(message.pane_id, client);
      return;
    },
    "ssp-ack"(client: Client, message: Frame<"ssp-ack">): void {
      // Observers acknowledge screens too: they are synced like everyone else, they only never type.
      const sender = client.data.sync.get(message.pane_id);
      if (!sender || sender.stream !== message.stream) return;
      if (!sender.ack(message.num)) send(client, { type: "error", code: "invalid_ack", message: "num must name a screen already sent", pane_id: message.pane_id });
    },
    "ssp-asset-ack"(client: Client, message: Frame<"ssp-asset-ack">): void {
      const sender = client.data.sync.get(message.pane_id);
      if (!sender || sender.stream !== message.stream) return;
      if (typeof message.key !== "string" || message.key.length > 200 || !sender.assetAck(message.key, message.offset))
        send(client, { type: "error", code: "invalid_ack", message: "offset must name an image chunk already sent", pane_id: message.pane_id });
    },
    async resize(client: Client, message: Frame<"resize">): Promise<void> {
      if (connectionOf(client).mode === "observe") {
        send(client, { type: "error", code: "read_only", message: "this connection is in observe mode" });
        return;
      }
      const geometry = validGeometry(message.cols, message.rows);
      if (!geometry) {
        send(client, { type: "error", code: "invalid_geometry", message: "cols and rows must be integers in 1..1000" });
        return;
      }
      if (message.theme !== undefined && !validTerminalTheme(message.theme)) {
        send(client, { type: "error", code: "invalid_theme", message: "theme must contain RGB defaults and 16 ANSI colours" });
        return;
      }
      // the pty is still being created (an attach that kept its size, then a resize before
      // the terminal was looked up): the resize waits for it. Dropped,
      // it would leave the pty at the pane's own grid under a terminal fitted to another.
      const claim = client.data.attached.get(message.pane_id);
      if (claim) {
        claim.keepSize = false;
        if (message.theme !== undefined) claim.theme = message.theme;
      }
      const creating = attachments.has(message.pane_id) ? undefined : pendingAttachments.get(message.pane_id);
      if (creating && client.data.attached.has(message.pane_id)) {
        try { await creating; } catch { return; }
        if (connectionOf(client).closing || connectionOf(client).mode !== "interact" || client.data.attached.get(message.pane_id) !== claim || claim?.keepSize) return;
      }
      drivePty(message.pane_id, client, geometry.cols, geometry.rows);
      return;
    },
    "release-size"(client: Client, message: Frame<"release-size">): void {
      // this client's terminal is hidden or out of use: if its grid is the pty's, the pty
      // goes back to the latest grid of another interact client still showing the terminal (#472).
      // Nothing to hand it to, or another client drove since: the size stays. Never an error, as
      // an older server ignores the frame.
      if (connectionOf(client).mode !== "interact") return;
      const claim = client.data.attached.get(message.pane_id);
      if (!claim) return;
      // Remember the release before looking up the attachment: its initial creation can
      // still be awaiting herdr, and must not revive this hidden grid when it completes.
      claim.keepSize = true;
      const attachment = typeof message.pane_id === "string" ? attachments.get(message.pane_id) : undefined;
      if (!attachment || attachment.kind === "mirror") return;
      releaseDriver(message.pane_id, client, attachment);
      return;
    },
  };

  // the same live records, read through their grid and held state only: the server outside reaches a
  // pane's terminal through `sight`, `poke` and the frames
  const views: ReadonlyMap<string, AttachmentView> = attachments;
  return { attachments: views, reconcileOutput, closeAttachment, detachClaimed, dropClaims, sight, poke, drainOutput, inputApplied, terminalFrames };
}

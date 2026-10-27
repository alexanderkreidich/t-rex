/**
 * One client's view of one pane's screen (screen.ts), kept in step by sending differences.
 *
 * Mosh's sender, over a WebSocket: each frame goes as the difference from the newest screen the
 * client is assumed to have — the newest one sent, while its acknowledgement is not overdue, else
 * the newest acknowledged. Nothing queues: a client that falls behind gets the current screen next,
 * the ones in between are never sent. The pace follows the round trip: half a smoothed RTT between
 * frames, within SEND_INTERVAL_MIN_MS and SEND_INTERVAL_MAX_MS, and a frame sent and not
 * acknowledged within the retransmission timeout goes again from the acknowledged screen.
 */
import { diffFrames, type Frame, type FrameDiff } from "../../shared/ssp.ts";
import type { Screen } from "./screen.ts";
import { graphicsMetadata, type GraphicsChunk } from "../../shared/ssp-assets.ts";
import { GraphicsSender } from "./assets.ts";

/** after a change, output that follows within this joins the same frame */
export const SEND_MIN_DELAY_MS = 3;
export const SEND_INTERVAL_MIN_MS = 8;
export const SEND_INTERVAL_MAX_MS = 250;
const RTO_MIN_MS = 50;
const RTO_MAX_MS = 1000;
/** frames sent and not yet acknowledged, past which the sender waits for an acknowledgement */
const MAX_IN_FLIGHT = 8;
/** bytes queued on the socket past which the sender waits for it to drain */
const MAX_BUFFERED_BYTES = 256 * 1024;

export interface SyncTarget {
  /** sends the difference; false when the connection can take nothing more */
  send(diff: FrameDiff): boolean;
  sendAsset?(chunk: GraphicsChunk, stream: string): boolean;
  /** bytes the connection has queued */
  buffered(): number;
  /** the newest of this client's input the program has had time to echo */
  echo(): number;
}

interface Sent {
  frame: Frame;
  at: number;
  /** sent again: its acknowledgement measures no round trip */
  again: boolean;
}

/** What a sender leaves behind for a client that comes back on a new connection (resume). */
export interface SyncResume {
  stream: string;
  /** the screens the client may have: the acknowledged one and every one sent after it */
  frames: Map<number, Frame>;
}

let streams = 0;
function newStream(): string {
  streams += 1;
  return `${Date.now().toString(36)}-${streams.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class SyncSender {
  readonly stream: string;
  private acked: Frame | null;
  private readonly sent: Sent[] = [];
  private srtt: number | null = null;
  private rttvar = 0;
  private lastSendAt = 0;
  private lastEcho = 0;
  private changedAt: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerAt = Infinity;
  /** consecutive timeouts double the next one */
  private backoff = 1;
  private disposed = false;
  private readonly assets: GraphicsSender | null;

  constructor(private readonly screen: Screen, private readonly target: SyncTarget, resume?: { stream: string; base: Frame }, private readonly now: () => number = Date.now) {
    this.stream = resume?.stream ?? newStream();
    this.acked = resume?.base ?? null;
    this.assets = target.sendAsset ? new GraphicsSender({ send: (chunk) => target.sendAsset!(chunk, this.stream), buffered: () => target.buffered() }, now) : null;
  }

  assetAck(key: string, offset: number): boolean { return this.assets?.ack(key, offset) ?? false; }

  /** the smoothed round trip in ms, once measured */
  get rtt(): number | null {
    return this.srtt;
  }

  private get rto(): number {
    if (this.srtt === null) return RTO_MAX_MS;
    return Math.min(RTO_MAX_MS, Math.max(RTO_MIN_MS, this.srtt + 4 * this.rttvar));
  }

  private get interval(): number {
    if (this.srtt === null) return SEND_INTERVAL_MIN_MS;
    return Math.min(SEND_INTERVAL_MAX_MS, Math.max(SEND_INTERVAL_MIN_MS, Math.ceil(this.srtt / 2)));
  }

  /** The screen or this client's echo changed: a frame goes when the pace allows. */
  schedule(): void {
    if (this.disposed) return;
    this.changedAt ??= this.now();
    this.tick();
  }

  /** The client has screen `num`: false when it names one this stream never sent. */
  ack(num: number): boolean {
    if (this.disposed) return true;
    if (!Number.isInteger(num)) return false;
    // looked up before the acknowledged screen: the acknowledged screen sent again (only the echo
    // moved, or a resumed stream's first frame) is acknowledged here, or it would be resent forever
    const index = this.sent.findIndex((entry) => entry.frame.num === num);
    if (index === -1 && this.acked && num <= this.acked.num) { this.syncAssets(this.acked); return true; }
    if (index === -1) return num <= (this.sent.at(-1)?.frame.num ?? this.acked?.num ?? 0);
    const entry = this.sent[index]!;
    if (!entry.again) this.measure(this.now() - entry.at);
    this.acked = entry.frame;
    this.syncAssets(entry.frame);
    this.sent.splice(0, index + 1);
    this.backoff = 1;
    this.tick();
    return true;
  }

  private syncAssets(frame: Frame): void {
    if (!this.assets) return;
    const wanted = new Set(frame.graphics?.assets.map((asset) => asset.key));
    const source = this.screen.frame().graphics;
    this.assets.setScene(wanted.size ? { assets: source?.assets.filter((asset) => wanted.has(asset.key)) ?? [], placements: frame.graphics?.placements ?? [] } : undefined);
  }

  private measure(rtt: number): void {
    // RFC 6298's estimator
    if (this.srtt === null) {
      this.srtt = rtt;
      this.rttvar = rtt / 2;
    } else {
      this.rttvar = 0.75 * this.rttvar + 0.25 * Math.abs(this.srtt - rtt);
      this.srtt = 0.875 * this.srtt + 0.125 * rtt;
    }
  }

  private wait(at: number): void {
    if (this.timer !== null && this.timerAt <= at) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timerAt = at;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.timerAt = Infinity;
      this.tick();
    }, Math.max(0, at - this.now()));
  }

  private tick(): void {
    // a screen the attach has not drawn yet is no screen: the client keeps waiting for the pane
    if (this.disposed || !this.screen.drawn) return;
    const now = this.now();
    const newest = this.sent.at(-1);
    const echo = this.target.echo();
    // the first frame goes even when it changes nothing: a client coming back learns it resumed
    const first = this.lastSendAt === 0;
    const behind = first || this.screen.version !== (newest?.frame.num ?? this.acked?.num);
    // a frame sent and not acknowledged in time is assumed lost: it goes again, from the acknowledged screen
    const timeout = this.rto * this.backoff;
    const overdue = newest !== undefined && now - newest.at >= timeout;
    if (!behind && echo <= this.lastEcho && !overdue) {
      this.changedAt = null;
      if (newest) this.wait(newest.at + timeout);
      return;
    }
    // the first screen goes at once: a client joining, or coming back, waits for nothing else
    if (behind && !first && this.changedAt !== null && now - this.changedAt < SEND_MIN_DELAY_MS) return this.wait(this.changedAt + SEND_MIN_DELAY_MS);
    const paced = this.lastSendAt + this.interval;
    if (now < paced) return this.wait(paced);
    if (this.target.buffered() > MAX_BUFFERED_BYTES || (!overdue && this.sent.length >= MAX_IN_FLIGHT)) {
      // the acknowledgement, the socket draining (drain()) or the timeout takes it from here
      return this.wait(newest ? newest.at + timeout : now + SEND_INTERVAL_MAX_MS);
    }
    const current = this.screen.frame();
    const frame: Frame = { ...current, graphics: this.assets ? graphicsMetadata(current.graphics) : undefined };
    const base = overdue ? this.acked : (newest?.frame ?? this.acked);
    const diff = diffFrames(this.stream, base, frame, this.acked?.num ?? 0, echo, (id) => this.screen.styleOf(id));
    if (this.srtt !== null) diff.rtt = Math.round(this.srtt);
    if (!this.target.send(diff)) return;
    this.lastSendAt = now;
    this.lastEcho = echo;
    this.changedAt = null;
    if (overdue) {
      for (const entry of this.sent) entry.again = true;
      this.backoff = Math.min(this.backoff * 2, 8);
    }
    if (newest?.frame.num === frame.num) {
      newest.at = now;
      newest.again = true;
    } else this.sent.push({ frame, at: now, again: overdue });
    // a client that never acknowledges is sent again from its acknowledged screen, so screens sent
    // before the newest few are no use as a base: they go, and its memory stays bounded
    if (this.sent.length > MAX_IN_FLIGHT * 2) this.sent.splice(0, this.sent.length - MAX_IN_FLIGHT * 2);
    this.wait(now + this.rto * this.backoff);
  }

  /** The connection's queue drained: a sender waiting on it may go on. */
  drain(): void {
    this.tick();
    this.assets?.drain();
  }

  /** What a client coming back on a new connection may resume from. */
  resumable(): SyncResume | null {
    const frames = new Map<number, Frame>();
    if (this.acked) frames.set(this.acked.num, this.acked);
    for (const entry of this.sent) frames.set(entry.frame.num, entry.frame);
    return frames.size ? { stream: this.stream, frames } : null;
  }

  dispose(): void {
    this.disposed = true;
    this.assets?.dispose();
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

/**
 * The input each client typed into each pane, numbered by the client, and when it went in: the
 * screen tells a client which of its input the program has had ECHO_DELAY_MS to echo.
 */
export const ECHO_DELAY_MS = 50;

export class EchoClock {
  private readonly applied: { seq: number; at: number }[] = [];
  private newest = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** input `seq` reached the program; returns when its echo is due */
  mark(seq: number): number {
    const at = this.now();
    if (seq > this.newest) {
      this.applied.push({ seq, at });
      this.newest = seq;
    }
    return at + ECHO_DELAY_MS;
  }

  /** the newest input applied at least ECHO_DELAY_MS ago */
  echo(): number {
    const due = this.now() - ECHO_DELAY_MS;
    let echo = 0;
    while (this.applied.length > 1 && this.applied[1]!.at <= due) this.applied.shift();
    const first = this.applied[0];
    if (first && first.at <= due) echo = first.seq;
    return echo;
  }
}

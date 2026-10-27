/**
 * One terminal's side of the State Synchronization Protocol (shared/ssp.ts): the screens the bridge
 * sent for the pane, the local echo laid over the newest one (predict.ts), and the drawing of the
 * result into the terminal renderer (shared/ssp-display.ts).
 *
 * The renderer only ever draws what this view writes: the bridge's screen, cut or padded to the
 * renderer's own grid while the two differ (a resize on its way), with the guesses on top.
 */
import {
  PLAIN_STYLE, STYLE_INVISIBLE, UNDERLINE_MASK, UNDERLINE_SHIFT, UNDERLINE_SINGLE,
  applyDiff, blankRow, decodeRow, encodeRow, frameText, makeRow,
  type Cell, type Frame, type FrameDiff, type Row, type Style,
} from "../../../shared/ssp.ts";
import { TerminalDisplay } from "../../../shared/ssp-display.ts";
import { GraphicsReceiver, type GraphicsChunk } from "../../../shared/ssp-assets.ts";
import { PredictionEngine, type PredictionDisplay } from "./predict.ts";

/** how often outstanding guesses are checked again while no screen comes */
const PREDICTION_TICK_MS = 50;
/** frames this view keeps beyond the ones the sender may still name as a base */
const MAX_FRAMES = 32;

export interface SspViewOptions {
  /** writes VT output into the renderer */
  write(data: string): void;
  /** tells the bridge this view has screen `num` of `stream` */
  ack(stream: string, num: number): void;
  ackAsset?(stream: string, key: string, offset: number): void;
  /** the program asked for the clipboard to be set (OSC 52): its payload as written */
  clipboard?(payload: string): void;
  /** OSC 8 links this app cannot open are drawn as text */
  linkAllowed?(uri: string): boolean;
  /** the newest screen changed (after it was drawn) */
  screen?(frame: Frame): void;
  predictions?: PredictionDisplay;
}

export class SspView {
  private stream: string | null = null;
  private readonly frames = new Map<number, Frame>();
  private readonly styles = new Map<number, Style>([[0, PLAIN_STYLE]]);
  /** client-local styles (negative ids): an underlined copy of a stream style, for flagged guesses */
  private readonly underlinedIds = new Map<number, number>();
  private newest: Frame | null = null;
  private echo = 0;
  private clipSeq: number | null = null;
  private readonly display: TerminalDisplay;
  private readonly assets = new GraphicsReceiver();
  readonly predictions: PredictionEngine;
  private cols = 0;
  private rows = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly options: SspViewOptions) {
    this.display = new TerminalDisplay(options.linkAllowed ? { linkAllowed: options.linkAllowed } : {});
    this.predictions = new PredictionEngine({ display: options.predictions ?? "adaptive" });
  }

  /** the newest screen the bridge sent */
  get screen(): Frame | null {
    return this.newest;
  }

  /** the screen's text, one line per row */
  text(): string {
    return this.newest ? frameText(this.newest).join("\n") : "";
  }

  /** The OSC 8 link of a cell of the newest screen, or null. */
  linkAt(row: number, col: number): string | null {
    const frame = this.newest;
    const line = frame?.lines[row];
    if (!frame || !line) return null;
    const cell = decodeRow(line.wire, frame.cols)[col];
    return cell ? (this.styles.get(cell.style)?.link ?? null) : null;
  }

  /** What the terminal shows: the newest screen with the guesses on top, its cursor, and how many of its cells are underlined. */
  shown(): { text: string; cursor: { row: number; col: number }; underlined: number } {
    if (!this.newest) return { text: "", cursor: { row: 0, col: 0 }, underlined: 0 };
    const frame = this.predictions.overlay(this.newest, (id) => this.underlined(id));
    let underlined = 0;
    for (const line of frame.lines) {
      for (const cell of decodeRow(line.wire, frame.cols)) {
        if (cell.width > 0 && ((this.styles.get(cell.style) ?? PLAIN_STYLE).flags & UNDERLINE_MASK) !== 0) underlined++;
      }
    }
    return { text: frameText(frame).join("\n"), cursor: { row: frame.cursor.row, col: frame.cursor.col }, underlined };
  }

  /** The renderer's grid: frames are cut or padded to it. A change redraws everything. */
  setSize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.predictions.reset();
    this.display.invalidate();
    this.draw();
  }

  /** Something else was written to the renderer (a read-only view's stream, a reset): the next draw is whole. */
  invalidate(): void {
    this.display.invalidate();
  }

  /** A new attach of the pane: what came before is another stream. */
  reset(): void {
    this.stream = null;
    this.frames.clear();
    this.assets.reset();
    this.newest = null;
    this.echo = 0;
    this.clipSeq = null;
    this.predictions.reset();
    this.display.invalidate();
    this.stopTimer();
  }

  /** A difference from the bridge: applied to the screen it names, acknowledged, drawn. */
  receive(diff: FrameDiff): void {
    if (this.disposed) return;
    if (diff.stream !== this.stream) {
      // a new stream starts from a blank screen; a difference against a screen of a stream this view never had is unusable
      if (diff.base !== 0) return;
      this.stream = diff.stream;
      this.frames.clear();
      this.assets.reset();
      this.newest = null;
      this.clipSeq = null;
      this.predictions.reset();
      this.display.invalidate();
    }
    const base = diff.base === 0 ? null : this.frames.get(diff.base);
    if (diff.base !== 0 && !base) {
      // a base this view no longer has (it cannot happen on one connection): say what it has instead
      if (this.newest) this.options.ack(diff.stream, this.newest.num);
      return;
    }
    const frame = applyDiff(base ?? null, diff, this.styles);
    this.frames.set(frame.num, frame);
    for (const num of this.frames.keys()) if (num < diff.throwaway && num !== frame.num) this.frames.delete(num);
    if (this.frames.size > MAX_FRAMES) for (const num of [...this.frames.keys()].sort((a, b) => a - b).slice(0, this.frames.size - MAX_FRAMES)) this.frames.delete(num);
    // the echo and the round trip hold for the newest screen too: an input applied long enough
    // before an older screen was before the newer one. The sender says a new echo with the same
    // screen again when only the echo changed: a guess is confirmed then, not at the next change
    const echoed = diff.echo > this.echo;
    this.echo = Math.max(this.echo, diff.echo);
    if (typeof diff.rtt === "number") this.predictions.setRtt(diff.rtt);
    if (this.newest && frame.num <= this.newest.num) {
      // the same screen again, or an older one arrived late: kept as a base, never drawn over a newer one
      this.options.ack(diff.stream, this.newest.num);
      if (echoed) {
        this.predictions.confirm(this.newest, this.echo);
        this.draw();
      }
      return;
    }
    const first = this.newest === null;
    this.newest = frame;
    this.assets.scene(frame.graphics);
    this.options.ack(diff.stream, frame.num);
    // a clipboard write is an event: the one a joining client finds on the screen is old news
    if (first) this.clipSeq = frame.clip?.seq ?? null;
    else if (frame.clip && frame.clip.seq !== this.clipSeq) {
      this.clipSeq = frame.clip.seq;
      this.options.clipboard?.(frame.clip.payload);
    }
    this.predictions.confirm(frame, this.echo);
    this.draw();
    this.options.screen?.(frame);
  }

  receiveAsset(stream: string, chunk: GraphicsChunk): void {
    if (this.disposed || stream !== this.stream) return;
    const offset = this.assets.accept(chunk);
    if (offset === null) return;
    this.options.ackAsset?.(stream, chunk.key, offset);
    if (offset === chunk.total) this.draw();
  }

  /** Text that went to the pty as input `seq`: guessed at, drawn at once. */
  typed(data: string, seq: number): void {
    if (!this.newest) return;
    this.predictions.typed(data, seq, this.newest);
    this.draw();
  }

  /** A key that went through herdr's key API as input `seq`. */
  key(name: string, seq: number): void {
    if (!this.newest) return;
    this.predictions.key(name, seq, this.newest);
    this.draw();
  }

  /** Guessing is off (a masked prompt, observing, no input): what was guessed goes. */
  setPredicting(enabled: boolean): void {
    this.predictions.setEnabled(enabled);
    this.draw();
  }

  /** Draws the newest screen with the guesses on top, if anything changed since the last drawing. */
  draw(): void {
    if (this.disposed || !this.newest || this.cols <= 0 || this.rows <= 0) return;
    const shown = this.predictions.overlay(this.newest, (id) => this.underlined(id));
    const output = this.display.draw(fitFrame({ ...shown, graphics: this.assets.hydrate(shown.graphics) }, this.cols, this.rows), (id) => this.styles.get(id) ?? PLAIN_STYLE);
    if (output) this.options.write(output);
    if (this.predictions.pending) this.startTimer();
    else this.stopTimer();
  }

  private underlined(id: number): number {
    let derived = this.underlinedIds.get(id);
    if (derived === undefined) {
      const style = this.styles.get(id) ?? PLAIN_STYLE;
      derived = -(this.underlinedIds.size + 1);
      this.styles.set(derived, { ...style, flags: (style.flags & ~UNDERLINE_MASK & ~STYLE_INVISIBLE) | (UNDERLINE_SINGLE << UNDERLINE_SHIFT) });
      this.underlinedIds.set(id, derived);
    }
    return derived;
  }

  private startTimer(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.newest) return;
      this.predictions.confirm(this.newest, this.echo);
      this.draw();
    }, PREDICTION_TICK_MS);
  }

  private stopTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  dispose(): void {
    this.disposed = true;
    this.assets.reset();
    this.stopTimer();
  }
}

/** The frame cut or padded to `cols` x `rows`: a wide cell cut in half at the edge goes blank. */
export function fitFrame(frame: Frame, cols: number, rows: number): Frame {
  if (frame.cols === cols && frame.rows === rows) return frame;
  const blank = blankRow(cols);
  const lines: Row[] = [];
  for (let row = 0; row < rows; row++) {
    const line = frame.lines[row];
    if (!line) {
      lines.push(blank);
      continue;
    }
    const cells: Cell[] = decodeRow(line.wire, frame.cols).slice(0, cols);
    const last = cells[cols - 1];
    if (last?.width === 2) cells[cols - 1] = { text: " ", width: 1, style: last.style };
    while (cells.length < cols) cells.push({ text: " ", width: 1, style: 0 });
    lines.push(makeRow(encodeRow(cells)));
  }
  const cursor = { ...frame.cursor, row: Math.min(frame.cursor.row, rows - 1), col: Math.min(frame.cursor.col, cols - 1) };
  return { ...frame, cols, rows, lines, cursor };
}

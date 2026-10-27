/**
 * Predictive local echo, after Mosh's model (Winstein and Balakrishnan, USENIX ATC 2012): what the
 * user types is drawn at once as a guess of what the program will echo, and each guess is checked
 * against the bridge's screen: it comes true once a screen shows it, and is wrong when it is still
 * missing after the bridge says the program has had time to echo that input (`FrameDiff.echo`,
 * shared/ssp.ts).
 *
 * - Guesses come in epochs. A new epoch starts tentative: its guesses are kept but not shown until
 *   one of them comes true. Anything this cannot guess (Enter, a control key, a paste, a wide
 *   character, the last column) starts a new epoch, so after it nothing shows until the program has
 *   echoed something again. A password prompt never echoes: its first guess fails and nothing shows.
 * - One wrong guess that was shown takes every guess back.
 * - Guesses show only while an echo is slow to come: the round trip, or the time a guessed
 *   character takes to show on the bridge's screen (herdr draws the pane at its own pace, so that is
 *   longer on a fast link too), over 30 ms, until both drop to 20 ms; or while one has waited past
 *   GLITCH_MS for its echo. They are underlined until confirmed when the round trip is over 80 ms
 *   (until 50 ms), or a guess has waited past GLITCH_FLAG_MS.
 *
 * Mosh's code is GPL; this is a new implementation of the published model.
 */
import { decodeRow, encodeRow, makeRow, type Cell, type Frame, type Row } from "../../../shared/ssp.ts";

export type PredictionDisplay = "adaptive" | "always" | "never";

export interface PredictionOptions {
  now?: () => number;
  display?: PredictionDisplay;
}

const SRTT_SHOW_MS = 30;
const SRTT_HIDE_MS = 20;
const FLAG_ON_MS = 80;
const FLAG_OFF_MS = 50;
/** a guess still waiting for its echo this long shows guesses on a fast link too, for a while */
const GLITCH_MS = 250;
/** ...and this long underlines them */
const GLITCH_FLAG_MS = 5000;
/** quick confirmations it takes to stop showing guesses after a glitch */
const GLITCH_REPAIR = 10;
const GLITCH_REPAIR_INTERVAL_MS = 150;
/** a guess whose input the bridge never acknowledged (a refused send) is given up after this */
const ABANDON_MS = 10_000;
/**
 * After the bridge says the program has had time to echo an input, a screen that does not show the
 * guess yet may still be on its way: herdr draws the pane at its own pace, after the program. A guess
 * is wrong only once it is still not on screen this long after that.
 */
const ECHO_GRACE_MS = 200;
/** more text than this in one go is a paste: guessed at as nothing */
const MAX_TYPED = 16;

interface Guess {
  /** the input that made it */
  seq: number;
  epoch: number;
  at: number;
  /** when the bridge first said the program had time to echo it */
  echoedAt?: number;
}

interface CellGuess extends Guess {
  text: string;
  style: number;
  /** what the cell held before: the echo showing one of these earns no confirmation */
  originals: Set<string>;
}

interface CursorGuess extends Guess {
  row: number;
  col: number;
}

type Verdict = "pending" | "correct" | "unearned" | "wrong";

export class PredictionEngine {
  display: PredictionDisplay;
  private readonly now: () => number;
  /** guessed cells by row, then column */
  private readonly cells = new Map<number, Map<number, CellGuess>>();
  private readonly cursors: CursorGuess[] = [];
  private epoch = 1;
  private confirmedEpoch = 0;
  private enabled = true;
  private srttTrigger = false;
  /** the bridge's smoothed round trip */
  private linkRtt = 0;
  /** the time from a guess to a screen that shows it, smoothed as the round trip is; null until measured */
  private echoRtt: number | null = null;
  private flagging = false;
  private glitch = 0;
  private lastQuickConfirmation = 0;
  private grid: { cols: number; rows: number } | null = null;

  constructor(options: PredictionOptions = {}) {
    this.now = options.now ?? Date.now;
    this.display = options.display ?? "adaptive";
  }

  setRtt(srtt: number): void {
    this.linkRtt = srtt;
    this.trigger();
    if (srtt > FLAG_ON_MS) this.flagging = true;
    else if (srtt <= FLAG_OFF_MS) this.flagging = false;
  }

  private measureEcho(ms: number): void {
    this.echoRtt = this.echoRtt === null ? ms : 0.875 * this.echoRtt + 0.125 * ms;
    this.trigger();
  }

  private trigger(): void {
    const latency = Math.max(this.linkRtt, this.echoRtt ?? 0);
    if (latency > SRTT_SHOW_MS) this.srttTrigger = true;
    else if (latency <= SRTT_HIDE_MS) this.srttTrigger = false;
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.clear();
    this.becomeTentative();
  }

  get pending(): boolean {
    return this.cursors.length > 0 || this.cells.size > 0;
  }

  reset(): void {
    this.clear();
    this.grid = null;
    this.becomeTentative();
  }

  private clear(): void {
    this.cells.clear();
    this.cursors.length = 0;
  }

  private becomeTentative(): void {
    this.epoch++;
  }

  private get showing(): boolean {
    if (this.display === "never") return false;
    if (this.display === "always") return true;
    return this.srttTrigger || this.glitch > 0;
  }

  private shown(guess: Guess): boolean {
    return guess.epoch <= this.confirmedEpoch;
  }

  /** The cursor as guessed: the newest guess, else the screen's. */
  private cursor(screen: Frame): { row: number; col: number } {
    const guess = this.cursors.at(-1);
    return guess ? { row: guess.row, col: guess.col } : { row: screen.cursor.row, col: screen.cursor.col };
  }

  /** A row as guessed: the screen's cells with the guesses on top. */
  private row(screen: Frame, row: number): Cell[] {
    const cells = decodeRow(screen.lines[row]!.wire, screen.cols);
    for (const [col, guess] of this.cells.get(row) ?? []) cells[col] = { text: guess.text, width: 1, style: guess.style };
    return cells;
  }

  /** Each guess is made on the screen as already guessed, so typing ahead builds on itself. */
  private guessCell(screen: Frame, row: number, col: number, cell: Cell, seq: number, now: number): void {
    let line = this.cells.get(row);
    if (!line) {
      line = new Map();
      this.cells.set(row, line);
    }
    const previous = line.get(col);
    const actual = decodeRow(screen.lines[row]!.wire, screen.cols)[col]!;
    const originals = previous ? new Set(previous.originals).add(previous.text) : new Set([actual.text]);
    line.set(col, { text: cell.text, style: cell.style, originals, seq, epoch: this.epoch, at: now });
  }

  private guessCursor(row: number, col: number, seq: number, now: number): void {
    this.cursors.push({ row, col, seq, epoch: this.epoch, at: now });
  }

  /** Whether the screen can be guessed on at all: same grid, a visible cursor. */
  private usable(screen: Frame): boolean {
    if (this.grid && (this.grid.cols !== screen.cols || this.grid.rows !== screen.rows)) this.reset();
    this.grid = { cols: screen.cols, rows: screen.rows };
    return this.enabled && this.display !== "never" && screen.cursor.visible;
  }

  typed(data: string, seq: number, screen: Frame): void {
    if (!this.usable(screen)) return;
    this.confirm(screen, -1);
    const now = this.now();
    if (data.length > MAX_TYPED || data.startsWith("\x1b[200~")) {
      this.becomeTentative();
      return;
    }
    for (let i = 0; i < data.length;) {
      const rest = data.slice(i);
      const arrow = /^\x1b(?:\[|O)([CD])/.exec(rest);
      if (arrow) {
        this.move(screen, arrow[1] === "D" ? -1 : 1, seq, now);
        i += arrow[0].length;
        continue;
      }
      const char = String.fromCodePoint(rest.codePointAt(0)!);
      i += char.length;
      if (char === "\x7f" || char === "\b") this.backspace(screen, seq, now);
      else if (char === "\r") this.enter(screen, seq, now);
      else if (printable(char)) this.insert(screen, char, seq, now);
      else this.becomeTentative();
    }
  }

  key(name: string, seq: number, screen: Frame): void {
    if (!this.usable(screen)) return;
    this.confirm(screen, -1);
    const now = this.now();
    if (name === "ArrowLeft") this.move(screen, -1, seq, now);
    else if (name === "ArrowRight") this.move(screen, 1, seq, now);
    else if (name === "Backspace") this.backspace(screen, seq, now);
    else if (name === "Enter") this.enter(screen, seq, now);
    else this.becomeTentative();
  }

  private insert(screen: Frame, char: string, seq: number, now: number): void {
    const { row, col } = this.cursor(screen);
    // the last column wraps, which this does not guess
    if (col + 1 >= screen.cols) {
      this.becomeTentative();
      return;
    }
    const cells = this.row(screen, row);
    if (cells.slice(col).some((cell) => cell.width !== 1)) {
      this.becomeTentative();
      return;
    }
    // typing inserts: what follows moves right, as a shell's line editor does
    for (let at = screen.cols - 1; at > col; at--) {
      const from = cells[at - 1]!;
      if (from.text !== cells[at]!.text || from.style !== cells[at]!.style) this.guessCell(screen, row, at, from, seq, now);
    }
    this.guessCell(screen, row, col, { text: char, width: 1, style: cells[col]!.style }, seq, now);
    this.guessCursor(row, col + 1, seq, now);
  }

  private backspace(screen: Frame, seq: number, now: number): void {
    const { row, col } = this.cursor(screen);
    if (col === 0) {
      this.becomeTentative();
      return;
    }
    const cells = this.row(screen, row);
    if (cells.slice(col - 1).some((cell) => cell.width !== 1)) {
      this.becomeTentative();
      return;
    }
    for (let at = col - 1; at < screen.cols; at++) {
      const from = at + 1 < screen.cols ? cells[at + 1]! : { text: " ", width: 1 as const, style: cells[at]!.style };
      if (from.text !== cells[at]!.text || from.style !== cells[at]!.style) this.guessCell(screen, row, at, from, seq, now);
    }
    this.guessCursor(row, col - 1, seq, now);
  }

  private move(screen: Frame, by: -1 | 1, seq: number, now: number): void {
    const { row, col } = this.cursor(screen);
    const next = col + by;
    if (next < 0 || next >= screen.cols) {
      this.becomeTentative();
      return;
    }
    this.guessCursor(row, next, seq, now);
  }

  /** Enter: what the program does with the line is anyone's guess; the cursor most likely starts the next row. */
  private enter(screen: Frame, seq: number, now: number): void {
    const { row } = this.cursor(screen);
    this.becomeTentative();
    if (row + 1 < screen.rows) this.guessCursor(row + 1, 0, seq, now);
  }

  /** Checks the guesses against a screen the bridge sent (or again on a timer: timeouts apply). */
  confirm(screen: Frame, echo: number): void {
    if (this.grid && (this.grid.cols !== screen.cols || this.grid.rows !== screen.rows)) {
      this.reset();
      return;
    }
    const now = this.now();
    if (echo >= 0) this.echo = Math.max(this.echo, echo);
    for (const [row, line] of this.cells) {
      for (const [col, guess] of line) {
        const verdict = this.judgeCell(screen, row, col, guess, now);
        if (verdict === "pending") continue;
        if (verdict === "wrong") return this.wrong(guess);
        line.delete(col);
        if (verdict === "correct") {
          this.measureEcho(now - guess.at);
          this.correct(guess, now);
        }
      }
      if (line.size === 0) this.cells.delete(row);
    }
    // only the newest cursor guess is judged: the screen that echoes an older one may already show
    // newer input too (the echo is said a moment after the input went in), so an older one, once
    // echoed, was a step on the way and goes
    for (let i = 0; i < this.cursors.length - 1;) {
      if (this.echo >= this.cursors[i]!.seq) this.cursors.splice(i, 1);
      else i++;
    }
    const newest = this.cursors.at(-1);
    if (newest) {
      const verdict = this.judgeCursor(screen, newest, now);
      if (verdict === "wrong") return this.wrong(newest);
      if (verdict !== "pending") {
        this.cursors.pop();
        if (verdict === "correct") this.correct(newest, now);
      }
    }
  }

  private echo = 0;

  private waiting(guess: Guess, now: number): Verdict | null {
    if (this.echo >= guess.seq) {
      guess.echoedAt ??= now;
      return null;
    }
    const waited = now - guess.at;
    if (waited >= ABANDON_MS) return "wrong";
    if (waited >= GLITCH_FLAG_MS) this.glitch = GLITCH_REPAIR * 2;
    else if (waited >= GLITCH_MS && this.glitch < GLITCH_REPAIR) this.glitch = GLITCH_REPAIR;
    return "pending";
  }

  private judgeCell(screen: Frame, row: number, col: number, guess: CellGuess, now: number): Verdict {
    if (row >= screen.rows || col >= screen.cols) return "wrong";
    const text = decodeRow(screen.lines[row]!.wire, screen.cols)[col]!.text;
    // the echo is on screen before the bridge says it is due (ECHO_DELAY_MS after the input): a
    // guess that came true counts at once, so the keys typed after a line's first show without that
    // wait. Only the echo's absence needs it, to be read as a wrong guess
    if (text === guess.text && !guess.originals.has(text)) return "correct";
    const waiting = this.waiting(guess, now);
    if (waiting) return waiting;
    if (text !== guess.text) return this.late(guess, now) ? "pending" : "wrong";
    return guess.originals.has(text) ? "unearned" : "correct";
  }

  private judgeCursor(screen: Frame, guess: CursorGuess, now: number): Verdict {
    const waiting = this.waiting(guess, now);
    if (waiting) return waiting;
    if (screen.cursor.row === guess.row && screen.cursor.col === guess.col) return "correct";
    return this.late(guess, now) ? "pending" : "wrong";
  }

  /** The echo may be on its way still (ECHO_GRACE_MS). */
  private late(guess: Guess, now: number): boolean {
    return now - (guess.echoedAt ?? now) < ECHO_GRACE_MS;
  }

  private correct(guess: Guess, now: number): void {
    if (guess.epoch > this.confirmedEpoch) this.confirmedEpoch = guess.epoch;
    // a glitch heals with quick confirmations, spaced out
    if (now - guess.at < GLITCH_MS && this.glitch > 0 && now - this.lastQuickConfirmation >= GLITCH_REPAIR_INTERVAL_MS) {
      this.glitch--;
      this.lastQuickConfirmation = now;
    }
  }

  /** A wrong guess: one that was shown takes everything back; a tentative one only ends its epoch. */
  private wrong(guess: Guess): void {
    if (this.shown(guess)) {
      this.clear();
      this.becomeTentative();
      return;
    }
    for (const [row, line] of this.cells) {
      for (const [col, cell] of line) if (cell.epoch >= guess.epoch) line.delete(col);
      if (line.size === 0) this.cells.delete(row);
    }
    for (let i = this.cursors.length - 1; i >= 0; i--) if (this.cursors[i]!.epoch >= guess.epoch) this.cursors.splice(i, 1);
    this.becomeTentative();
  }

  overlay(screen: Frame, underlined: (styleId: number) => number): Frame {
    if (!this.showing || !this.pending || (this.grid && (this.grid.cols !== screen.cols || this.grid.rows !== screen.rows))) return screen;
    const flag = this.flagging || this.glitch > GLITCH_REPAIR;
    let lines: Row[] | null = null;
    for (const [row, line] of this.cells) {
      let cells: Cell[] | null = null;
      for (const [col, guess] of line) {
        if (!this.shown(guess)) continue;
        cells ??= decodeRow(screen.lines[row]!.wire, screen.cols);
        cells[col] = { text: guess.text, width: 1, style: flag ? underlined(guess.style) : guess.style };
      }
      if (!cells) continue;
      lines ??= [...screen.lines];
      lines[row] = makeRow(encodeRow(cells));
    }
    let cursor = screen.cursor;
    for (let i = this.cursors.length - 1; i >= 0; i--) {
      const guess = this.cursors[i]!;
      if (!this.shown(guess)) continue;
      cursor = { ...cursor, row: guess.row, col: guess.col };
      break;
    }
    if (!lines && cursor === screen.cursor) return screen;
    return { ...screen, lines: lines ?? screen.lines, cursor };
  }
}

/** One column wide and drawn: letters, digits, punctuation, most scripts; not a control, a mark or a wide character. */
function printable(char: string): boolean {
  const code = char.codePointAt(0)!;
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return false;
  if (code < 0x300) return true;
  // combining marks, wide and emoji ranges, and anything astral: not guessed
  if (/[\p{M}\p{Extended_Pictographic}]/u.test(char) || code > 0xffff) return false;
  return !(code >= 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6)));
}

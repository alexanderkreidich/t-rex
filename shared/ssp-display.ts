/**
 * Draws SSP frames (ssp.ts) into a terminal emulator: for the next frame, the VT output that takes
 * a terminal showing this display's last drawing to it. The browser draws a pane's screen with it,
 * and the bridge draws the current screen for clients that take a byte stream. Mosh's
 * Display::new_frame plays this part there; the model is Mosh's, the code is not.
 *
 * Positions come from the frame, never from the terminal's idea of character widths, which may not
 * be the bridge's: the cursor is placed with CUP after any cell that is not one ASCII column, and
 * nothing relies on autowrap. Rows are compared by key, so an unchanged row costs one comparison.
 */
import {
  RGB_COLOR, STYLE_BLINK, STYLE_BOLD, STYLE_FAINT, STYLE_INVERSE, STYLE_INVISIBLE, STYLE_ITALIC,
  STYLE_OVERLINE, STYLE_STRIKETHROUGH, UNDERLINE_SHIFT, blankRow, decodeRow, detectScroll, modesEqual, scrollRows,
  type Cell, type Color, type Cursor, type Frame, type Modes, type Row, type Style,
} from "./ssp.ts";

import { fitGraphics, GraphicsDisplay } from "./ssp-graphics.ts";

export interface DisplayOptions {
  /** OSC 8 links for which this returns false are drawn as plain text (the app opens only http(s) links) */
  linkAllowed?: (uri: string) => boolean;
}

const CSI = "\x1b[";
const PLAIN_SGR = "\x1b[0m";
const CLOSE_LINK = "\x1b]8;;\x1b\\";
/** A CUP costs about this much: unchanged runs no longer than this are rewritten instead of skipped. */
const MERGE_GAP = 4;
/** Trailing blanks from this many on are erased (EL) rather than written. */
const ERASE_MIN = 4;
const MOUSE_TRACKING = [9, 1000, 1002, 1003];
const MOUSE_ENCODING = [1005, 1006, 1015, 1016];
/** underline styles (flags >> UNDERLINE_SHIFT & 7): none, single, double, curly, dotted, dashed */
const UNDERLINE_SGR = ["", "4", "4:2", "4:3", "4:4", "4:5", "4", "4"];
/** C0 and C1 controls: a cell's text or a link's target that holds one would be read as a sequence */
const CONTROLS = /[\x00-\x1f\x7f-\x9f]/;
const CONTROLS_ALL = /[\x00-\x1f\x7f-\x9f]/g;

/** How the terminal's pen is set for a style. */
interface Pen {
  readonly sgr: string;
  /** the OSC 8 target drawn: null for none, and for a link the display may not draw */
  readonly link: string | null;
  /** what a cleared screen holds: the reset pen and no link */
  readonly plain: boolean;
  /** an erase (EL) in this pen leaves cells of exactly this style: background colour erase keeps nothing else */
  readonly erase: boolean;
}

function colorSgr(color: Color, normal: number, bright: number, extended: number): string {
  if (!Number.isInteger(color) || color < 0) return "";
  if (color >= RGB_COLOR) {
    if (color >= RGB_COLOR * 2) return "";
    return `${extended};2;${(color >> 16) & 255};${(color >> 8) & 255};${color & 255}`;
  }
  if (color < 8 && normal >= 0) return `${normal + color}`;
  if (color < 16 && bright >= 0) return `${bright + color - 8}`;
  return color < 256 ? `${extended};5;${color}` : "";
}

function flagsSgr(flags: number): string[] {
  const params: string[] = [];
  if (flags & STYLE_BOLD) params.push("1");
  if (flags & STYLE_FAINT) params.push("2");
  if (flags & STYLE_ITALIC) params.push("3");
  const underline = UNDERLINE_SGR[(flags >> UNDERLINE_SHIFT) & 7]!;
  if (underline) params.push(underline);
  if (flags & STYLE_BLINK) params.push("5");
  if (flags & STYLE_INVERSE) params.push("7");
  if (flags & STYLE_INVISIBLE) params.push("8");
  if (flags & STYLE_STRIKETHROUGH) params.push("9");
  if (flags & STYLE_OVERLINE) params.push("53");
  return params;
}

/** The DECSCUSR parameter for a cursor's shape and blink. */
function cursorStyle(cursor: Cursor): number {
  if (cursor.shape === 1) return cursor.blink ? 5 : 6;
  if (cursor.shape === 2) return cursor.blink ? 3 : 4;
  return cursor.blink ? 1 : 2;
}

function sameCursor(a: Cursor, b: Cursor): boolean {
  return a.row === b.row && a.col === b.col && a.visible === b.visible && a.shape === b.shape && a.blink === b.blink;
}

function sameRow(a: Row, b: Row): boolean {
  return a === b || a.key === b.key;
}

function sameCell(a: Cell, b: Cell): boolean {
  return a.text === b.text && a.width === b.width && a.style === b.style;
}

/** A number a sequence can carry: anything else would put a stray character in it. */
function param(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/** The terminal-mode sequences from `from` (null: unknown, so all of them) to `to`. */
function modeChanges(from: Modes | null, to: Modes, kittyUnknown: boolean): string {
  let out = "";
  if (!from || from.mouse !== to.mouse) {
    // a terminal has one tracking mode at a time and turns it off on the reset of any: reset, then set
    if (!from) out += `${CSI}?${MOUSE_TRACKING.join(";")}l`;
    else if (MOUSE_TRACKING.includes(from.mouse)) out += `${CSI}?${from.mouse}l`;
    if (MOUSE_TRACKING.includes(to.mouse)) out += `${CSI}?${to.mouse}h`;
  }
  if (!from || from.mouseEncoding !== to.mouseEncoding) {
    if (!from) out += `${CSI}?${MOUSE_ENCODING.join(";")}l`;
    else if (MOUSE_ENCODING.includes(from.mouseEncoding)) out += `${CSI}?${from.mouseEncoding}l`;
    if (MOUSE_ENCODING.includes(to.mouseEncoding)) out += `${CSI}?${to.mouseEncoding}h`;
  }
  if (!from || from.cursorKeys !== to.cursorKeys) out += `${CSI}?1${to.cursorKeys ? "h" : "l"}`;
  if (!from || from.keypad !== to.keypad) out += to.keypad ? "\x1b=" : "\x1b>";
  if (!from || from.bracketedPaste !== to.bracketedPaste) out += `${CSI}?2004${to.bracketedPaste ? "h" : "l"}`;
  if (!from || from.focusEvents !== to.focusEvents) out += `${CSI}?1004${to.focusEvents ? "h" : "l"}`;
  if (!from || from.alternateScroll !== to.alternateScroll) out += `${CSI}?1007${to.alternateScroll ? "h" : "l"}`;
  if (!from || kittyUnknown || from.kittyKeyboard !== to.kittyKeyboard) out += `${CSI}=${param(to.kittyKeyboard)};1u`;
  if (!from || from.modifyOtherKeys !== to.modifyOtherKeys) out += `${CSI}>4;${param(to.modifyOtherKeys)}m`;
  return out;
}

export class TerminalDisplay {
  private readonly linkAllowed: (uri: string) => boolean;
  private readonly graphics = new GraphicsDisplay();
  /** what the terminal shows: the last frame drawn (null before the first draw and after invalidate()) */
  private last: Frame | null = null;
  /** the SGR sequence the terminal's pen was last set with */
  private pen = PLAIN_SGR;
  /** the OSC 8 target open in the terminal */
  private link: string | null = null;
  /**
   * The terminal's cursor during a draw; col -1 when unknown: after a cell the terminal may see as
   * wider or narrower than the frame does, and after a write in the last column, whose wrap is pending.
   */
  private row = 0;
  private col = -1;
  private out = "";
  private readonly pens = new WeakMap<Style, Pen>();
  private marks = new Uint8Array(0);
  private blank: Row | null = null;

  constructor(options: DisplayOptions = {}) {
    this.linkAllowed = options.linkAllowed ?? (() => true);
  }

  /**
   * VT output that takes a terminal showing this display's last drawing to `frame`.
   * `styleOf` resolves the style ids in the frame's rows (ids may be negative: client-local derived styles).
   * The first draw, and the first after invalidate(), draws everything.
   */
  draw(frame: Frame, styleOf: (id: number) => Style): string {
    const { cols, rows } = frame;
    if (cols < 1 || rows < 1) {
      this.invalidate();
      return "";
    }
    const byId = new Map<number, Pen>();
    const penOf = (id: number): Pen => {
      let pen = byId.get(id);
      if (pen === undefined) {
        pen = this.penFor(styleOf(id));
        byId.set(id, pen);
      }
      return pen;
    };
    const last = this.last;
    this.out = "";
    const whole = last === null || last.cols !== cols || last.rows !== rows || last.modes.altScreen !== frame.modes.altScreen;
    if (whole) this.drawWhole(frame, last, penOf);
    else this.drawChanges(frame, last, penOf);
    const graphics = this.graphics.draw(fitGraphics(frame.graphics, cols, rows), whole, this.out.length > 0);
    if (graphics) this.out += `\x1b7${graphics}\x1b8`;
    this.last = frame;
    const out = this.out;
    this.out = "";
    return out;
  }

  /** the terminal no longer shows what this display drew (other output was written to it, it was reset or resized): the next draw is whole */
  invalidate(): void {
    this.last = null;
  }

  private drawWhole(frame: Frame, last: Frame | null, penOf: (id: number) => Pen): void {
    const { cols, rows } = frame;
    // The screen switch comes first: a terminal keeps a cursor, and with it the pen, per screen.
    // Then the state the drawing counts on, whatever was written before: no link open, ASCII in G0
    // and G0 in use, the reset pen, the full scroll region, absolute origin, autowrap, replace mode.
    this.out += `${CSI}?25l${CSI}?1047${frame.modes.altScreen ? "h" : "l"}${CLOSE_LINK}\x1b(B\x0f`
      + `${PLAIN_SGR}${CSI}r${CSI}?6l${CSI}?7h${CSI}4l${CSI}H${CSI}2J`;
    this.pen = PLAIN_SGR;
    this.link = null;
    this.row = 0;
    this.col = 0;
    if (this.blank?.wire.t.length !== cols) this.blank = blankRow(cols);
    const blank = this.blank;
    for (let row = 0; row < rows; row++) {
      const line = frame.lines[row] ?? blank;
      if (!sameRow(line, blank)) this.drawRow(row, null, line, cols, penOf);
    }
    // modes outlive a resize and a screen switch, all but the kitty keyboard flags, which each screen keeps
    this.finish(frame, last?.modes ?? null, last !== null && last.modes.altScreen !== frame.modes.altScreen, true);
  }

  /** Draws what changed since `last`, a frame of the same size and screen; false when nothing did. */
  private drawChanges(frame: Frame, last: Frame, penOf: (id: number) => Pen): boolean {
    const { cols, rows } = frame;
    if (this.blank?.wire.t.length !== cols) this.blank = blankRow(cols);
    const blank = this.blank;
    let shown: readonly Row[] = last.lines;
    let changed = 0;
    for (let row = 0; row < rows; row++) if (!sameRow(shown[row] ?? blank, frame.lines[row] ?? blank)) changed++;
    if (changed === 0 && sameCursor(last.cursor, frame.cursor) && modesEqual(last.modes, frame.modes)) return false;
    if (last.cursor.visible) this.out += `${CSI}?25l`;
    this.row = Math.min(Math.max(last.cursor.row, 0), rows - 1);
    this.col = Math.min(Math.max(last.cursor.col, 0), cols - 1);
    // a scroll can spare a quarter of the screen only when at least that many rows changed
    if (changed >= rows / 4 && shown.length === rows && frame.lines.length === rows) {
      const shift = detectScroll(shown, frame.lines);
      if (shift > 0) {
        // the rows that come in take the pen's background: the frame's are plain
        this.closeLink();
        this.setPen(PLAIN_SGR);
        this.out += `${CSI}${shift}S`;
        this.col = -1;
        shown = scrollRows(shown, shift, cols);
      }
    }
    for (let row = 0; row < rows; row++) {
      const before = shown[row] ?? blank;
      const after = frame.lines[row] ?? blank;
      if (!sameRow(before, after)) this.drawRow(row, before, after, cols, penOf);
    }
    this.finish(frame, last.modes, false, last.cursor.shape !== frame.cursor.shape || last.cursor.blink !== frame.cursor.blink);
    return true;
  }

  private finish(frame: Frame, modesFrom: Modes | null, kittyUnknown: boolean, shape: boolean): void {
    this.closeLink();
    this.out += modeChanges(modesFrom, frame.modes, kittyUnknown);
    const { cursor } = frame;
    this.moveTo(Math.min(Math.max(cursor.row, 0), frame.rows - 1), Math.min(Math.max(cursor.col, 0), frame.cols - 1));
    if (shape) this.out += `${CSI}${cursorStyle(cursor)} q`;
    if (cursor.visible) this.out += `${CSI}?25h`;
  }

  /** Redraws the columns of `after` that differ from `before` (null: a cleared row). */
  private drawRow(row: number, before: Row | null, after: Row, cols: number, penOf: (id: number) => Pen): void {
    const next = decodeRow(after.wire, cols);
    const prev = before === null ? null : decodeRow(before.wire, cols);
    if (this.marks.length !== cols) this.marks = new Uint8Array(cols);
    const marks = this.marks;
    marks.fill(0);
    let any = false;
    for (let col = 0; col < cols; col++) {
      const cell = next[col]!;
      const differs = prev === null ? cell.text !== " " || cell.width !== 1 || !penOf(cell.style).plain : !sameCell(prev[col]!, cell);
      if (differs) {
        marks[col] = 1;
        any = true;
      }
    }
    if (!any) return;
    // Overwriting either half of a wide cell blanks the other half, so a span takes whole cells of
    // both rows: back over the second column of a wide cell, forward over the first.
    for (let col = cols - 1; col > 0; col--) {
      if (marks[col] && (next[col]!.width === 0 || prev?.[col]!.width === 0)) marks[col - 1] = 1;
    }
    for (let col = 0; col < cols - 1; col++) {
      if (marks[col] && (next[col]!.width === 2 || prev?.[col]!.width === 2)) marks[col + 1] = 1;
    }
    // where the blanks an erase can make run to the end of the row
    const eraser = penOf(next[cols - 1]!.style);
    let erase = cols;
    if (eraser.erase) {
      while (erase > 0) {
        const cell = next[erase - 1]!;
        if (cell.text !== " " || cell.width !== 1) break;
        const pen = penOf(cell.style);
        if (!pen.erase || pen.sgr !== eraser.sgr) break;
        erase--;
      }
    }
    for (let start = 0; start < cols;) {
      if (!marks[start]) {
        start++;
        continue;
      }
      let end = start + 1;
      for (;;) {
        while (end < cols && marks[end]) end++;
        let gap = end;
        while (gap < cols && !marks[gap] && gap - end < MERGE_GAP) gap++;
        if (gap < cols && marks[gap]) end = gap;
        else break;
      }
      // worth it from ERASE_MIN blanks that would be written otherwise
      const from = Math.max(erase, start);
      const stop = end - from >= ERASE_MIN ? from : end;
      for (let col = start; col < stop; col++) {
        const cell = next[col]!;
        if (cell.width !== 0) this.drawCell(row, col, cell, penOf(cell.style), cols);
      }
      if (stop < end) {
        // the erase also covers the unchanged cells after the span, blanks in this pen already
        this.moveTo(row, stop);
        this.closeLink();
        this.setPen(eraser.sgr);
        this.out += `${CSI}K`;
        break;
      }
      start = end;
    }
  }

  private drawCell(row: number, col: number, cell: Cell, pen: Pen, cols: number): void {
    this.moveTo(row, col);
    this.setPen(pen.sgr);
    if (this.link !== pen.link) {
      this.out += pen.link === null ? CLOSE_LINK : `\x1b]8;;${pen.link}\x1b\\`;
      this.link = pen.link;
    }
    const text = cell.text;
    const code = text.length === 1 ? text.charCodeAt(0) : 0;
    if (cell.width === 1 && code >= 0x20 && code <= 0x7e) {
      this.out += text;
      this.col = col + 1 < cols ? col + 1 : -1;
      return;
    }
    let drawn = CONTROLS.test(text) ? text.replace(CONTROLS_ALL, "") : text;
    if (drawn === "") drawn = " ";
    // In the last column a terminal that takes the text for wide would wrap it, and on the last row
    // scroll the screen: without autowrap it drops the text instead.
    if (col >= cols - 1) this.out += `${CSI}?7l${drawn}${CSI}?7h`;
    else this.out += drawn;
    this.col = -1;
  }

  private moveTo(row: number, col: number): void {
    if (this.row === row && this.col === col) return;
    this.closeLink();
    this.out += col === 0 ? (row === 0 ? `${CSI}H` : `${CSI}${row + 1}H`) : `${CSI}${row + 1};${col + 1}H`;
    this.row = row;
    this.col = col;
  }

  private setPen(sgr: string): void {
    if (this.pen === sgr) return;
    this.out += sgr;
    this.pen = sgr;
  }

  private closeLink(): void {
    if (this.link === null) return;
    this.out += CLOSE_LINK;
    this.link = null;
  }

  private penFor(style: Style): Pen {
    let pen = this.pens.get(style);
    if (pen !== undefined) return pen;
    const params = flagsSgr(style.flags);
    const fg = colorSgr(style.fg, 30, 90, 38);
    if (fg) params.push(fg);
    const ul = colorSgr(style.ul, -1, -1, 58);
    if (ul) params.push(ul);
    // an erase keeps the background colour alone: only a style with nothing else is made by one
    const onlyBg = params.length === 0;
    const bg = colorSgr(style.bg, 40, 100, 48);
    if (bg) params.push(bg);
    const sgr = params.length === 0 ? PLAIN_SGR : `${CSI}0;${params.join(";")}m`;
    const uri = style.link;
    const link = uri !== null && uri !== "" && !CONTROLS.test(uri) && this.linkAllowed(uri) ? uri : null;
    pen = { sgr, link, plain: sgr === PLAIN_SGR && link === null, erase: onlyBg && link === null };
    this.pens.set(style, pen);
    return pen;
  }
}


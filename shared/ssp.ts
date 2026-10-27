/**
 * State Synchronization Protocol: the screen model the bridge and the browser share, and the
 * difference between two screens as it crosses the wire.
 *
 * Mosh's model (Winstein and Balakrishnan, USENIX ATC 2012), not its code: the bridge keeps the
 * authoritative screen of each attached pane and sends a client the difference from a screen the
 * client already has to the current one. A client that falls behind skips the screens in between;
 * nothing is replayed. The browser keeps the screens it was sent, applies each difference to the one
 * it names, acknowledges the newest, and draws it (src/lib/ssp/).
 *
 * A screen is rows of cells. A row crosses the wire as `WireRow`: one UTF-16 unit per column for the
 * common cell, an exception list for the rest, and style runs. Equal rows have equal `key`s, which is
 * all the difference needs to compare.
 */

import { applyGraphics, graphicsDiff, type GraphicsScene } from "./ssp-graphics.ts";

/** A colour: -1 the terminal's default, 0–255 a palette index, or `RGB | 0x1000000`. */
export type Color = number;

export const DEFAULT_COLOR = -1;
export const RGB_COLOR = 0x1000000;

/** Ghostty's style flags: one bit each, then the underline style in bits 8–10. */
export const STYLE_BOLD = 1;
export const STYLE_ITALIC = 2;
export const STYLE_FAINT = 4;
export const STYLE_BLINK = 8;
export const STYLE_INVERSE = 16;
export const STYLE_INVISIBLE = 32;
export const STYLE_STRIKETHROUGH = 64;
export const STYLE_OVERLINE = 128;
export const UNDERLINE_SHIFT = 8;
export const UNDERLINE_MASK = 7 << UNDERLINE_SHIFT;
/** underline styles in `flags >> UNDERLINE_SHIFT & 7`: none, single, double, curly, dotted, dashed */
export const UNDERLINE_SINGLE = 1;

export interface Style {
  readonly fg: Color;
  readonly bg: Color;
  /** underline colour; DEFAULT_COLOR draws it in the foreground */
  readonly ul: Color;
  readonly flags: number;
  /** an OSC 8 hyperlink's target */
  readonly link: string | null;
}

/** [fg, bg, ul, flags, link?] */
export type WireStyle = [Color, Color, Color, number] | [Color, Color, Color, number, string];

export const PLAIN_STYLE: Style = { fg: DEFAULT_COLOR, bg: DEFAULT_COLOR, ul: DEFAULT_COLOR, flags: 0, link: null };

export function styleKey(style: Style): string {
  return `${style.fg},${style.bg},${style.ul},${style.flags}${style.link === null ? "" : `,${style.link}`}`;
}

export function wireStyle(style: Style): WireStyle {
  return style.link === null ? [style.fg, style.bg, style.ul, style.flags] : [style.fg, style.bg, style.ul, style.flags, style.link];
}

export function fromWireStyle(wire: WireStyle): Style {
  const [fg, bg, ul, flags, link] = wire;
  if (fg === DEFAULT_COLOR && bg === DEFAULT_COLOR && ul === DEFAULT_COLOR && flags === 0 && link === undefined) return PLAIN_STYLE;
  return { fg, bg, ul, flags, link: link ?? null };
}

/** Stands in `WireRow.t` for a cell whose text is in `x`, and for the second column of a wide cell. */
export const EXCEPTION = "\ufffc";

/**
 * A row on the wire. `t` has one UTF-16 unit per column: the cell's character, or EXCEPTION where
 * `x` has the cell (text that is not one unit, or a wide cell) and in the column after a wide cell.
 * `s` is [columns, style id] pairs covering the row, ids from the stream's style table.
 */
export interface WireRow {
  t: string;
  /** [column, text, width]: width 2 takes the next column too */
  x?: [number, string, 1 | 2][];
  s: number[];
}

/** A row as both sides hold it: `key` is equal exactly when two rows draw the same. */
export interface Row {
  readonly key: string;
  readonly wire: WireRow;
}

export function rowKey(wire: WireRow): string {
  return `${wire.t}\u0000${wire.x ? JSON.stringify(wire.x) : ""}\u0000${wire.s.join(",")}`;
}

export function makeRow(wire: WireRow): Row {
  return { key: rowKey(wire), wire };
}

/** The blank row a screen starts with, and scrolling brings in: style id 0 is always PLAIN_STYLE. */
export function blankRow(cols: number): Row {
  return makeRow({ t: " ".repeat(cols), s: [cols, 0] });
}

/** One decoded cell: its text ("" for the second column of a wide cell) and the columns it takes. */
export interface Cell {
  text: string;
  width: 0 | 1 | 2;
  style: number;
}

/** The cells of a row, one per column. */
export function decodeRow(wire: WireRow, cols: number): Cell[] {
  const cells: Cell[] = [];
  const exceptions = new Map<number, [string, 1 | 2]>();
  for (const [col, text, width] of wire.x ?? []) exceptions.set(col, [text, width]);
  let run = 0;
  let left = wire.s[0] ?? cols;
  let style = wire.s[1] ?? 0;
  for (let col = 0; col < cols; col++) {
    while (left <= 0 && run + 2 < wire.s.length) {
      run += 2;
      left = wire.s[run]!;
      style = wire.s[run + 1]!;
    }
    left--;
    const exception = exceptions.get(col);
    if (exception) {
      cells.push({ text: exception[0], width: exception[1], style });
      continue;
    }
    const previous = cells[col - 1];
    if (previous?.width === 2) {
      cells.push({ text: "", width: 0, style });
      continue;
    }
    cells.push({ text: wire.t[col] ?? " ", width: 1, style });
  }
  return cells;
}

/** The row for these cells: the inverse of decodeRow. */
export function encodeRow(cells: readonly Cell[]): WireRow {
  let t = "";
  const x: [number, string, 1 | 2][] = [];
  const s: number[] = [];
  for (let col = 0; col < cells.length; col++) {
    const cell = cells[col]!;
    if (cell.width === 0) t += EXCEPTION;
    else if (cell.width === 2 || cell.text.length !== 1 || cell.text === EXCEPTION) {
      t += EXCEPTION;
      x.push([col, cell.text, cell.width === 2 ? 2 : 1]);
    } else t += cell.text;
    if (s.length > 0 && s[s.length - 1] === cell.style) s[s.length - 2]! += 1;
    else s.push(1, cell.style);
  }
  return x.length ? { t, x, s } : { t, s };
}

/** The row's text as copied: wide cells once, trailing blanks kept (the caller trims). */
export function rowText(wire: WireRow, cols: number): string {
  return decodeRow(wire, cols).map((cell) => cell.text).join("");
}

/** DECSCUSR's shapes as ghostty reports them: block, bar, underline. */
export type CursorShape = 0 | 1 | 2;

export interface Cursor {
  readonly row: number;
  readonly col: number;
  readonly visible: boolean;
  readonly shape: CursorShape;
  readonly blink: boolean;
}

/** [row, col, visible, shape, blink] */
export type WireCursor = [number, number, 0 | 1, CursorShape, 0 | 1];

/**
 * The terminal modes the browser's input encoding follows. The program sets them in the stream
 * (DECSET and the rest); the browser's terminal never sees that stream, so the screen carries them.
 */
export interface Modes {
  /** mouse tracking: 0 off, or the DECSET that turned it on (9, 1000, 1002, 1003) */
  readonly mouse: number;
  /** mouse encoding: 0 default, or 1005, 1006, 1015, 1016 */
  readonly mouseEncoding: number;
  /** DECCKM: application cursor keys */
  readonly cursorKeys: boolean;
  /** DECKPAM: application keypad */
  readonly keypad: boolean;
  readonly bracketedPaste: boolean;
  readonly focusEvents: boolean;
  /** 1007: the wheel scrolls with arrow keys in the alternate screen */
  readonly alternateScroll: boolean;
  /** the alternate screen is up */
  readonly altScreen: boolean;
  /** kitty keyboard protocol flags */
  readonly kittyKeyboard: number;
  /** xterm modifyOtherKeys level */
  readonly modifyOtherKeys: number;
}

export const DEFAULT_MODES: Modes = {
  mouse: 0, mouseEncoding: 0, cursorKeys: false, keypad: false, bracketedPaste: false, focusEvents: false,
  alternateScroll: false, altScreen: false, kittyKeyboard: 0, modifyOtherKeys: 0,
};

export function modesEqual(a: Modes, b: Modes): boolean {
  return a.mouse === b.mouse && a.mouseEncoding === b.mouseEncoding && a.cursorKeys === b.cursorKeys && a.keypad === b.keypad
    && a.bracketedPaste === b.bracketedPaste && a.focusEvents === b.focusEvents && a.alternateScroll === b.alternateScroll
    && a.altScreen === b.altScreen && a.kittyKeyboard === b.kittyKeyboard && a.modifyOtherKeys === b.modifyOtherKeys;
}

/** A clipboard write the program asked for (OSC 52): its payload as written, numbered so a repeat is a new write. */
export interface Clip {
  readonly seq: number;
  readonly payload: string;
}

/** One screen of a pane, numbered in its stream. */
export interface Frame {
  readonly num: number;
  readonly cols: number;
  readonly rows: number;
  readonly lines: readonly Row[];
  readonly cursor: Cursor;
  readonly modes: Modes;
  readonly clip: Clip | null;
  readonly graphics?: GraphicsScene;
}

export function blankFrame(cols: number, rows: number): Frame {
  const row = blankRow(cols);
  return {
    num: 0, cols, rows, lines: Array.from({ length: rows }, () => row),
    cursor: { row: 0, col: 0, visible: true, shape: 0, blink: false }, modes: DEFAULT_MODES, clip: null,
  };
}

/**
 * The difference from screen `base` to screen `num` of `stream` (base 0: from a blank screen of
 * this size). The receiver keeps screens from `throwaway` on: the sender never names an older base.
 */
export interface FrameDiff {
  stream: string;
  num: number;
  base: number;
  throwaway: number;
  cols: number;
  rows: number;
  /** the base's rows move up by this many first, blank rows coming in at the bottom */
  scroll?: number;
  /** [row, its new content] for each row that differs after the scroll */
  lines: [number, WireRow][];
  /** [id, style] for each style the rows in `lines` use */
  styles: [number, WireStyle][];
  cursor: WireCursor;
  modes: Modes;
  clip?: [number, string];
  /** Visible placements plus pixels absent from the named base frame. */
  graphics?: GraphicsScene;
  /** the newest input of this client the program has had time to echo (local echo checks its guesses against this screen) */
  echo: number;
  /** the sender's smoothed round trip in ms, once measured: local echo shows its guesses on a slow link only */
  rtt?: number;
}

function wireCursor(cursor: Cursor): WireCursor {
  return [cursor.row, cursor.col, cursor.visible ? 1 : 0, cursor.shape, cursor.blink ? 1 : 0];
}

export function fromWireCursor(wire: WireCursor): Cursor {
  return { row: wire[0], col: wire[1], visible: wire[2] === 1, shape: wire[3], blink: wire[4] === 1 };
}

/** How far the screen scrolled from `base` to `next`, when that saves rows (0: not a scroll). */
export function detectScroll(base: readonly Row[], next: readonly Row[]): number {
  const rows = next.length;
  if (base.length !== rows || rows < 4) return 0;
  let unchanged = 0;
  for (let row = 0; row < rows; row++) if (base[row]!.key === next[row]!.key) unchanged++;
  let best = 0;
  let bestMatches = unchanged;
  const first = next[0]!.key;
  for (let shift = 1; shift < rows; shift++) {
    if (base[shift]!.key !== first) continue;
    let matches = 0;
    for (let row = 0; row + shift < rows; row++) if (base[row + shift]!.key === next[row]!.key) matches++;
    if (matches > bestMatches) {
      best = shift;
      bestMatches = matches;
    }
  }
  // worth it when it spares a quarter of the screen over sending the rows that moved
  return bestMatches - unchanged >= rows / 4 ? best : 0;
}

/** Rows moved up by `shift`, blank rows in at the bottom. */
export function scrollRows(lines: readonly Row[], shift: number, cols: number): Row[] {
  const blank = blankRow(cols);
  return lines.map((_, row) => lines[row + shift] ?? blank);
}

/**
 * The difference from `base` (null: a blank screen) to `next`. `styleOf` looks a style id up in
 * the sender's table, for the styles the changed rows use.
 */
export function diffFrames(stream: string, base: Frame | null, next: Frame, throwaway: number, echo: number, styleOf: (id: number) => Style): FrameDiff {
  const sameGrid = base !== null && base.cols === next.cols && base.rows === next.rows;
  const from = sameGrid ? base : blankFrame(next.cols, next.rows);
  const scroll = sameGrid ? detectScroll(from.lines, next.lines) : 0;
  const before = scroll ? scrollRows(from.lines, scroll, next.cols) : from.lines;
  const lines: [number, WireRow][] = [];
  const used = new Set<number>();
  for (let row = 0; row < next.rows; row++) {
    const line = next.lines[row]!;
    if (before[row]!.key === line.key) continue;
    lines.push([row, line.wire]);
    for (let run = 1; run < line.wire.s.length; run += 2) used.add(line.wire.s[run]!);
  }
  const diff: FrameDiff = {
    stream, num: next.num, base: sameGrid ? base.num : 0, throwaway, cols: next.cols, rows: next.rows,
    lines, styles: [...used].sort((a, b) => a - b).map((id) => [id, wireStyle(styleOf(id))]),
    cursor: wireCursor(next.cursor), modes: next.modes, echo,
  };
  if (scroll) diff.scroll = scroll;
  if (next.clip && next.clip.seq !== from.clip?.seq) diff.clip = [next.clip.seq, next.clip.payload];
  const graphics = graphicsDiff(from.graphics, next.graphics);
  if (graphics) diff.graphics = graphics;
  return diff;
}

/**
 * The screen `diff` makes of `base` (null when it starts from a blank screen). `styles` is the
 * receiver's style table; the diff's styles are added to it.
 */
export function applyDiff(base: Frame | null, diff: FrameDiff, styles: Map<number, Style>): Frame {
  for (const [id, style] of diff.styles) styles.set(id, fromWireStyle(style));
  const from = base !== null && diff.base !== 0 && base.cols === diff.cols && base.rows === diff.rows ? base : blankFrame(diff.cols, diff.rows);
  const lines = diff.scroll ? scrollRows(from.lines, diff.scroll, diff.cols) : [...from.lines];
  for (const [row, wire] of diff.lines) if (row >= 0 && row < diff.rows) lines[row] = makeRow(wire);
  return {
    num: diff.num, cols: diff.cols, rows: diff.rows, lines, cursor: fromWireCursor(diff.cursor), modes: diff.modes,
    clip: diff.clip ? { seq: diff.clip[0], payload: diff.clip[1] } : from.clip,
    ...(diff.graphics || from.graphics ? { graphics: applyGraphics(from.graphics, diff.graphics) } : {}),
  };
}

/** The screen's text, one line per row, trailing blanks trimmed. */
export function frameText(frame: Frame): string[] {
  return frame.lines.map((line) => rowText(line.wire, frame.cols).trimEnd());
}

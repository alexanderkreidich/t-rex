/**
 * The authoritative screen of one attached pane: a headless terminal (restty's libghostty-vt in
 * WASM) fed by herdr's attach stream, read out as numbered frames (shared/ssp.ts).
 *
 * The browsers' themes differ, so palette and default colours must cross the wire as what they are,
 * not as one theme's RGB. The headless terminal resolves every colour to RGB, so its palette and
 * default colours are set to sentinels that map back: palette index i draws as rgb(1, 2, i), the
 * default foreground as rgb(1, 3, 0) and the default background as rgb(1, 3, 1). A program that asks
 * for exactly one of those truecolours gets the palette colour instead.
 */
import { createHeadlessTerminal, type ResttyHeadlessSnapshot, type ResttyHeadlessTerminal } from "restty/headless";
import {
  DEFAULT_COLOR, EXCEPTION, PLAIN_STYLE, RGB_COLOR, makeRow, styleKey,
  type Color, type CursorShape, type Frame, type Row, type Style, type WireRow,
} from "../../shared/ssp.ts";
import { ModeTracker } from "./modes.ts";
import { GraphicsSnapshot, GRAPHICS_CELL_WIDTH, GRAPHICS_CELL_HEIGHT } from "./graphics.ts";

/** Grapheme clustering (mode 2027): herdr gives a whole emoji sequence two cells, and so must this screen. */
const SCREEN_SETUP = "\x1b[?2027h";
/** A program cycling through truecolours would grow the table without end: past this it starts again. */
const MAX_STYLES = 8192;

type ResttyWasm = ResttyHeadlessTerminal["wasm"];

let wasmLoad: Promise<ResttyWasm> | null = null;
/** One WASM instance for every screen of the bridge (each load compiles the module again). */
function sharedWasm(): Promise<ResttyWasm> {
  wasmLoad ??= createHeadlessTerminal({ cols: 1, rows: 1, maxScrollbackBytes: 0, replay: false }).then((term) => {
    const wasm = term.wasm;
    term.dispose();
    return wasm;
  });
  return wasmLoad;
}

function decodeColor(bytes: Uint8Array, cell: number): Color {
  const at = cell * 4;
  const r = bytes[at]!, g = bytes[at + 1]!, b = bytes[at + 2]!;
  if (r === 1 && g === 2) return b;
  if (r === 1 && g === 3 && b <= 1) return DEFAULT_COLOR;
  return RGB_COLOR | (r << 16) | (g << 8) | b;
}

/** The cell's raw data equals the same cell of the previous snapshot. */
function sameCells(a: ResttyHeadlessSnapshot, b: ResttyHeadlessSnapshot, from: number, to: number): boolean {
  for (let cell = from; cell < to; cell++) {
    if (a.codepoints![cell] !== b.codepoints![cell] || a.wide![cell] !== b.wide![cell] || a.styleFlags![cell] !== b.styleFlags![cell]
      || a.linkIds![cell] !== b.linkIds![cell] || a.graphemeLen![cell] !== b.graphemeLen![cell] || a.contentTags![cell] !== b.contentTags![cell]) return false;
  }
  for (const key of ["fgBytes", "bgBytes", "ulBytes"] as const) {
    const left = a[key]!, right = b[key]!;
    for (let at = from * 4; at < to * 4; at++) if (left[at] !== right[at]) return false;
  }
  // a cluster's tail may change under the same first code point
  for (let cell = from; cell < to; cell++) {
    const length = a.graphemeLen![cell]!;
    if (length === 0) continue;
    const offsetA = a.graphemeOffset![cell]!, offsetB = b.graphemeOffset![cell]!;
    for (let i = 0; i < length; i++) if (a.graphemeBuffer![offsetA + i] !== b.graphemeBuffer![offsetB + i]) return false;
  }
  return true;
}

export class Screen {
  private readonly modes = new ModeTracker();
  private readonly graphics = new GraphicsSnapshot();
  private readonly styleIds = new Map<string, number>([[styleKey(PLAIN_STYLE), 0]]);
  private styles: Style[] = [PLAIN_STYLE];
  /** bumped when the style table starts again: every row's key changes with it */
  private styleEpoch = 0;
  private revision = 1;
  private cached: Frame | null = null;
  private previous: { snapshot: ResttyHeadlessSnapshot; lines: Row[]; epoch: number } | null = null;
  private disposed = false;

  private constructor(private readonly term: ResttyHeadlessTerminal) {
    this.setup();
  }

  static async create(cols: number, rows: number): Promise<Screen> {
    const wasm = await sharedWasm();
    return new Screen(await createHeadlessTerminal({ wasm, cols, rows, pixelWidth: cols * GRAPHICS_CELL_WIDTH, pixelHeight: rows * GRAPHICS_CELL_HEIGHT, maxScrollbackBytes: 0, replay: false }));
  }

  get cols(): number {
    return this.term.cols;
  }

  get rows(): number {
    return this.term.rows;
  }

  /** The attach has drawn something: until then there is no screen to show anyone. */
  get drawn(): boolean {
    return this.wrote;
  }

  private wrote = false;

  /** The number the next frame() has: it moves with every change to the screen. */
  get version(): number {
    return this.revision;
  }

  private setup(): void {
    const exports = this.term.wasm.exports;
    const palette = new Uint8Array(256 * 3);
    for (let index = 0; index < 256; index++) palette.set([1, 2, index], index * 3);
    const pointer = exports.restty_alloc(palette.length);
    new Uint8Array(exports.memory.buffer, pointer, palette.length).set(palette);
    exports.restty_set_palette?.(this.term.handle, pointer, palette.length);
    exports.restty_free(pointer, palette.length);
    exports.restty_set_default_colors?.(this.term.handle, 0x010300, 0x010301, 0x010302);
    this.term.write(SCREEN_SETUP, { recordReplay: false });
  }

  /**
   * Takes the attach stream's next output. Returns what the terminal answers the program's
   * queries with (device attributes, cursor position): the attach is owed it on its input.
   */
  write(data: string): string {
    if (this.disposed || !data) return "";
    this.wrote = true;
    this.modes.feed(data);
    this.term.wasm.write(this.term.handle, data);
    if (this.modes.resetSeen) this.term.wasm.write(this.term.handle, SCREEN_SETUP);
    this.revision++;
    return this.term.drainOutput();
  }

  resize(cols: number, rows: number): void {
    if (this.disposed || (cols === this.term.cols && rows === this.term.rows)) return;
    this.term.resize(cols, rows);
    this.term.setPixelSize(cols * GRAPHICS_CELL_WIDTH, rows * GRAPHICS_CELL_HEIGHT);
    this.revision++;
  }

  styleOf(id: number): Style {
    return this.styles[id] ?? PLAIN_STYLE;
  }

  private intern(style: Style): number {
    const key = styleKey(style);
    let id = this.styleIds.get(key);
    if (id === undefined) {
      if (this.styles.length >= MAX_STYLES) {
        this.styleIds.clear();
        this.styleIds.set(styleKey(PLAIN_STYLE), 0);
        this.styles = [PLAIN_STYLE];
        this.styleEpoch++;
      }
      id = this.styles.length;
      this.styles.push(style);
      this.styleIds.set(key, id);
    }
    return id;
  }

  /** The screen now, as frame number `version`; the same object until the stream changes it. */
  frame(): Frame {
    if (this.cached && this.cached.num === this.revision) return this.cached;
    this.term.renderUpdate();
    const snapshot = this.term.snapshot();
    const cols = snapshot?.cols ?? this.term.cols;
    const rows = snapshot?.rows ?? this.term.rows;
    const previous = this.previous && this.previous.snapshot.cols === cols && this.previous.snapshot.rows === rows ? this.previous : null;
    let lines: Row[] = [];
    if (snapshot) {
      const epoch = this.styleEpoch;
      const reusable = previous?.epoch === epoch ? previous : null;
      for (let row = 0; row < rows; row++) {
        const from = row * cols;
        const old = reusable?.lines[row];
        lines.push(old && sameCells(snapshot, reusable.snapshot, from, from + cols) ? old : makeRow(this.encodeRow(snapshot, row, cols)));
      }
      // the table started again partway: the rows before that point name the old ids
      if (this.styleEpoch !== epoch) lines = Array.from({ length: rows }, (_, row) => makeRow(this.encodeRow(snapshot, row, cols)));
    }
    const cursor = snapshot?.cursor;
    const shape = cursor ? ([0, 1, 2].includes(cursor.style) ? cursor.style : 0) as CursorShape : 0;
    const modes = this.modes.current;
    const kitty = this.term.getKittyKeyboardFlags();
    this.cached = {
      num: this.revision, cols, rows, lines,
      cursor: { row: cursor?.row ?? 0, col: cursor?.col ?? 0, visible: (cursor?.visible ?? 1) === 1, shape, blink: (cursor?.blinking ?? 0) === 1 },
      modes: kitty === modes.kittyKeyboard ? { ...modes } : { ...modes, kittyKeyboard: kitty },
      clip: this.modes.clip,
      graphics: this.graphics.read(this.term),
    };
    if (snapshot) this.previous = { snapshot, lines, epoch: this.styleEpoch };
    return this.cached;
  }

  private encodeRow(snapshot: ResttyHeadlessSnapshot, row: number, cols: number): WireRow {
    let t = "";
    const x: [number, string, 1 | 2][] = [];
    const s: number[] = [];
    const links = this.links(snapshot);
    for (let col = 0; col < cols; col++) {
      const cell = row * cols + col;
      const wide = snapshot.wide![cell]!;
      const codepoint = snapshot.codepoints![cell]!;
      let text = codepoint === 0 ? " " : String.fromCodePoint(codepoint);
      const extra = snapshot.graphemeLen![cell]!;
      if (extra > 0 && codepoint !== 0) {
        const offset = snapshot.graphemeOffset![cell]!;
        for (let i = 0; i < extra; i++) text += String.fromCodePoint(snapshot.graphemeBuffer![offset + i]!);
      }
      if (wide === 2) t += EXCEPTION; // the second column of a wide cell
      else if (wide === 1) {
        t += EXCEPTION;
        x.push([col, text, 2]);
      } else if (wide === 3 || text.length !== 1 || text === EXCEPTION) {
        // a wide character that did not fit at the row's end leaves a blank (spacer head)
        if (wide === 3) t += " ";
        else {
          t += EXCEPTION;
          x.push([col, text, 1]);
        }
      } else t += text;
      const fg = decodeColor(snapshot.fgBytes!, cell);
      const ul = decodeColor(snapshot.ulBytes!, cell);
      const linkId = snapshot.linkIds![cell]!;
      const id = this.intern({
        fg, bg: decodeColor(snapshot.bgBytes!, cell),
        // an underline in no colour of its own is drawn in the foreground's: equal reads as none
        ul: ul === fg ? DEFAULT_COLOR : ul,
        flags: snapshot.styleFlags![cell]!,
        link: linkId > 0 ? links[linkId - 1] ?? null : null,
      });
      if (s.length > 0 && s[s.length - 1] === id) s[s.length - 2]! += 1;
      else s.push(1, id);
    }
    return x.length ? { t, x, s } : { t, s };
  }

  private linkCache: { snapshot: ResttyHeadlessSnapshot; links: string[] } | null = null;

  private links(snapshot: ResttyHeadlessSnapshot): string[] {
    if (this.linkCache?.snapshot === snapshot) return this.linkCache.links;
    const links: string[] = [];
    const decoder = new TextDecoder();
    const offsets = snapshot.linkOffsets, lengths = snapshot.linkLengths, buffer = snapshot.linkBuffer;
    if (offsets && lengths && buffer) {
      for (let i = 0; i < offsets.length; i++) links.push(decoder.decode(buffer.subarray(offsets[i]!, offsets[i]! + lengths[i]!)));
    }
    this.linkCache = { snapshot, links };
    return links;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.previous = null;
    this.cached = null;
    this.linkCache = null;
    this.term.dispose();
  }
}

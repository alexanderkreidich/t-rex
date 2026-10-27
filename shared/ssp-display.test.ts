import { describe, expect, it } from "bun:test";
import { Screen } from "../server/ssp/screen.ts";
import { TerminalDisplay, type DisplayOptions } from "./ssp-display.ts";
import {
  DEFAULT_MODES, PLAIN_STYLE, RGB_COLOR, blankRow, decodeRow, encodeRow, makeRow, styleKey,
  type Cell, type Cursor, type CursorShape, type Frame, type Modes, type Row, type Style,
} from "./ssp.ts";

// Convergence against a real terminal: a target frame (a source Screen fed VT, or rows built with
// encodeRow) is drawn by the display into a second Screen, whose own frame must then show the same
// cells, styles, cursor and modes. Style ids differ between the two screens' tables, so styles are
// compared resolved.

type StyleOf = (id: number) => Style;

const httpOnly = (uri: string) => /^https?:\/\//.test(uri);

/** What a frame shows, one string per row plus the cursor, modes and size: equal pictures draw the same. */
function picture(frame: Frame, styleOf: StyleOf, linkAllowed: (uri: string) => boolean = () => true): string[] {
  const lines: string[] = [];
  for (let row = 0; row < frame.rows; row++) {
    const cells = decodeRow((frame.lines[row] ?? blankRow(frame.cols)).wire, frame.cols);
    lines.push(cells.map((cell) => {
      const style = styleOf(cell.style);
      const link = style.link !== null && linkAllowed(style.link) ? style.link : null;
      return `${JSON.stringify(cell.text)}:${cell.width}:${styleKey({ ...style, link })}`;
    }).join(" "));
  }
  const { cursor, modes } = frame;
  lines.push(`size ${frame.cols}x${frame.rows}`);
  lines.push(`cursor ${cursor.row},${cursor.col} visible=${cursor.visible} shape=${cursor.shape} blink=${cursor.blink}`);
  lines.push(`modes ${(Object.keys(DEFAULT_MODES) as (keyof Modes)[]).map((key) => `${key}=${modes[key]}`).join(" ")}`);
  return lines;
}

/** A terminal the display draws into. */
class Target {
  readonly outputs: string[] = [];

  private constructor(readonly screen: Screen, readonly display: TerminalDisplay, private readonly options: DisplayOptions) {}

  static async create(cols: number, rows: number, options: DisplayOptions = {}): Promise<Target> {
    return new Target(await Screen.create(cols, rows), new TerminalDisplay(options), options);
  }

  draw(frame: Frame, styleOf: StyleOf): string {
    const out = this.display.draw(frame, styleOf);
    this.outputs.push(out);
    this.screen.write(out);
    return out;
  }

  /** Draws `frame` and checks the terminal now shows it. */
  sync(frame: Frame, styleOf: StyleOf): string {
    const out = this.draw(frame, styleOf);
    this.expectShows(frame, styleOf);
    return out;
  }

  expectShows(frame: Frame, styleOf: StyleOf): void {
    const drawn = this.screen.frame();
    expect(picture(drawn, (id) => this.screen.styleOf(id))).toEqual(picture(frame, styleOf, this.options.linkAllowed));
  }
}

/** A source screen fed VT and the target the display draws it into. */
class Pair {
  private constructor(readonly source: Screen, readonly target: Target) {}

  static async create(cols: number, rows: number, options: DisplayOptions = {}): Promise<Pair> {
    return new Pair(await Screen.create(cols, rows), await Target.create(cols, rows, options));
  }

  get frame(): Frame {
    return this.source.frame();
  }

  readonly styleOf: StyleOf = (id) => this.source.styleOf(id);

  /** Feeds the source, draws its frame into the target and checks they agree; returns the drawing. */
  feed(vt: string): string {
    this.source.write(vt);
    return this.target.sync(this.source.frame(), this.styleOf);
  }

  resize(cols: number, rows: number): string {
    this.source.resize(cols, rows);
    this.target.screen.resize(cols, rows);
    return this.target.sync(this.source.frame(), this.styleOf);
  }
}

function frameOf(cols: number, rows: number, cells: Cell[][], extra: { cursor?: Partial<Cursor>; modes?: Partial<Modes>; num?: number } = {}): Frame {
  const lines: Row[] = [];
  for (let row = 0; row < rows; row++) lines.push(cells[row] ? makeRow(encodeRow(cells[row]!)) : blankRow(cols));
  return {
    num: extra.num ?? 1, cols, rows, lines,
    cursor: { row: 0, col: 0, visible: true, shape: 0, blink: false, ...extra.cursor },
    modes: { ...DEFAULT_MODES, ...extra.modes }, clip: null,
  };
}

function textCells(text: string, cols: number, style = 0): Cell[] {
  const cells: Cell[] = [...text].slice(0, cols).map((char) => ({ text: char, width: 1, style }));
  while (cells.length < cols) cells.push({ text: " ", width: 1, style: 0 });
  return cells;
}

describe("TerminalDisplay", () => {
  it("draws plain text and the cursor", async () => {
    const pair = await Pair.create(20, 4);
    const out = pair.feed("hello\r\nworld  again\x1b[3;7H");
    expect(out).toContain("hello");
    expect(out).toContain("\x1b[?25h");
  });

  it("draws every SGR attribute", async () => {
    const pair = await Pair.create(16, 3);
    pair.feed([
      "\x1b[1ma\x1b[0;2mb\x1b[0;3mc\x1b[0;5md\x1b[0;7me\x1b[0;8mf\x1b[0;9mg\x1b[0;53mh",
      "\x1b[0;1;2;3;5;7;9;53mi\x1b[0;1;31mj\x1b[0;7;32;44mk\x1b[0m\r\n",
      "\x1b[4ma\x1b[0;4:2mb\x1b[0;4:3mc\x1b[0;4:4md\x1b[0;4:5me",
      "\x1b[0;4;58;5;3mf\x1b[0;4:3;58;2;200;10;30mg\x1b[0;58;5;99mh\x1b[0;31;4;58;5;1mi\x1b[0;4;58;5;12mj\x1b[0m",
    ].join(""));
  });

  it("draws palette, RGB and default colours, foreground and background", async () => {
    const pair = await Pair.create(64, 9);
    let vt = "";
    for (let index = 0; index < 256; index++) vt += `\x1b[38;5;${index};48;5;${255 - index}m${String.fromCharCode(0x21 + (index % 90))}`;
    vt += "\x1b[0m\r\n\x1b[38;2;10;20;30;48;2;250;240;230mrgb\x1b[39mdefault-fg\x1b[49;38;2;0;0;0mdefault-bg\x1b[0m";
    vt += "\x1b[31;41mr\x1b[91;101mR\x1b[39;49md";
    pair.feed(vt);
  });

  it("draws wide, emoji sequence and combining cells at the frame's columns", async () => {
    const pair = await Pair.create(24, 4);
    const out = pair.feed("a你好b\r\n👨‍👩‍👧x😀y⚠\ufe0fz🇺🇸\r\ne\u0301é─→λ\x1b[2;24H");
    expect(out).toContain("👨‍👩‍👧");
    // a cell after a non-ASCII one is placed by the frame, not by the terminal's widths
    expect(out).toMatch(/👨‍👩‍👧\x1b\[2;3Hx/);
    pair.feed("\x1b[1;2H\x1b[31m你\x1b[1;5Hzz");
    pair.feed("\x1b[1;3Hq");
    pair.feed("\x1b[2;1Hab");
  });

  it("draws allowed links and leaves the others as plain text", async () => {
    const pair = await Pair.create(30, 3, { linkAllowed: httpOnly });
    const out = pair.feed("\x1b]8;;https://example.com/a\x1b\\link\x1b]8;;\x1b\\ \x1b]8;;file:///etc/passwd\x1b\\file\x1b]8;;\x1b\\ \x1b]8;;http://x.y/\x1b\\é你z\x1b]8;;\x1b\\");
    expect(out).toContain("\x1b]8;;https://example.com/a\x1b\\link");
    expect(out).not.toContain("file://");
    // every link is closed before the output ends
    expect(out.lastIndexOf("\x1b]8;;\x1b\\")).toBeGreaterThan(out.lastIndexOf("\x1b]8;;http"));
    pair.feed("\x1b[1;2H\x1b]8;;https://example.com/b\x1b\\IN\x1b]8;;\x1b\\");
  });

  it("erases trailing blanks in a background colour with EL", async () => {
    const pair = await Pair.create(30, 4);
    const out = pair.feed("\x1b[44mstatus\x1b[K\x1b[0m\r\n\x1b[48;2;9;9;9m\x1b[K\x1b[0m\r\nplain");
    expect(out).toContain("\x1b[0;44m");
    expect(out.match(/\x1b\[K/g)?.length).toBe(2);
    expect(out).not.toContain("      ");
    pair.feed("\x1b[1;3Hxx\x1b[3;1H\x1b[41m\x1b[K");
    pair.feed("\x1b[1;1H\x1b[0m\x1b[K");
  });

  it("writes the last column without wrapping or scrolling", async () => {
    const pair = await Pair.create(10, 3);
    pair.feed("0123456789\r\nabcdefghij\r\nklmnopqrst");
    expect(pair.frame.cursor).toMatchObject({ row: 2, col: 9 });
    pair.feed("\x1b[3;10HZ");
    pair.feed("\x1b[1;9H你");
    pair.feed("\x1b[3;10Hé\x1b[1;1H");
  });

  it("guards a non-ASCII cell in the last column against a terminal that takes it for wide", async () => {
    const target = await Target.create(6, 2);
    const cells = [textCells("ab", 6), textCells("cdefg", 6)];
    cells[1]![5] = { text: "😀", width: 1, style: 0 };
    const out = target.draw(frameOf(6, 2, cells), () => PLAIN_STYLE);
    expect(out).toContain("\x1b[?7l😀\x1b[?7h");
    // ghostty takes it for wide and drops it rather than scroll the screen
    const drawn = target.screen.frame();
    expect(decodeRow(drawn.lines[0]!.wire, 6).map((cell) => cell.text).join("")).toBe("ab    ");
  });

  it("follows rows changing between frames", async () => {
    const pair = await Pair.create(20, 6);
    pair.feed("first line\r\nsecond\r\n\x1b[32mthird\x1b[0m");
    pair.feed("\x1b[2;3HCOND");
    pair.feed("\x1b[1;1H\x1b[2K\x1b[35mreplaced\x1b[0m");
    pair.feed("\x1b[6;15Hcorner\x1b[1;1H");
    pair.feed("\x1b[4;1H\x1b[1;44m      \x1b[0m tail");
    pair.feed("\x1b[2J\x1b[H");
  });

  it("follows a scrolling screen, with SU when it spares rows", async () => {
    const pair = await Pair.create(16, 8);
    for (let line = 0; line < 8; line++) pair.source.write(`line ${line}\r\n`);
    pair.target.sync(pair.frame, pair.styleOf);
    const scrolled = pair.feed("line 8\r\nline 9\r\n");
    expect(scrolled).toMatch(/\x1b\[2S/);
    for (let line = 10; line < 30; line++) pair.feed(`\x1b[3${line % 8}mline ${line}\x1b[0m\r\n`);
    // a scroll region scrolls only part of the screen
    pair.feed("\x1b[2;6r\x1b[6;1H\nregion\n\x1b[r");
  });

  it("switches to and from the alternate screen", async () => {
    const pair = await Pair.create(20, 5);
    pair.feed("shell prompt $ \x1b[=1;1u");
    const enter = pair.feed("\x1b[?1049h\x1b[H\x1b[2J\x1b[44m\x1b[Kfull screen app\x1b[0m\x1b[=5;1u");
    expect(enter).toContain("\x1b[?1047h");
    pair.feed("\x1b[3;3Hedit");
    const exit = pair.feed("\x1b[?1049l");
    expect(exit).toContain("\x1b[?1047l");
    pair.feed("ls\r\n");
  });

  it("follows mode changes", async () => {
    const pair = await Pair.create(10, 3);
    pair.feed("x");
    const steps = [
      "\x1b[?1000h", "\x1b[?1006h", "\x1b[?1002h", "\x1b[?1003h\x1b[?1015h", "\x1b[?1003l", "\x1b[?9h\x1b[?1006l\x1b[?1005h",
      "\x1b[?1h\x1b=", "\x1b[?2004h\x1b[?1004h\x1b[?1007h", "\x1b[=13;1u", "\x1b[>4;2m", "\x1b[>4;1m", "\x1b[>4;0m",
      "\x1b[?1l\x1b>\x1b[?2004l", "\x1b[?1004l\x1b[?1007l\x1b[=0;1u\x1b[?9l\x1b[?1016h", "\x1b[?1016l",
    ];
    for (const step of steps) {
      const out = pair.feed(step);
      expect(out).not.toBe("");
      expect(out).not.toContain("\x1b[2J");
    }
  });

  it("follows the cursor's position, visibility and shape", async () => {
    const pair = await Pair.create(10, 3);
    pair.feed("\x1b[?25l");
    pair.feed("\x1b[2;5H");
    pair.feed("\x1b[?25h\x1b[5 q");
    pair.feed("\x1b[6 q");
    pair.feed("\x1b[3 q\x1b[3;10H");
    pair.feed("\x1b[4 q");
    pair.feed("\x1b[1 q");
    const out = pair.feed("\x1b[0 q\x1b[1;1H");
    expect(out).toBe("\x1b[?25l\x1b[H\x1b[2 q\x1b[?25h");
  });

  it("draws whole after a resize", async () => {
    const pair = await Pair.create(12, 4);
    pair.feed("abc\r\n\x1b[41mdef\x1b[0m\r\n\x1b[?2004h");
    const out = pair.resize(16, 6);
    expect(out).toContain("\x1b[2J");
    pair.feed("more text here!!");
    pair.resize(8, 3);
    pair.feed("\x1b[Hx");
  });

  it("draws whole after invalidate(), whatever was written meanwhile", async () => {
    const pair = await Pair.create(12, 5);
    pair.feed("\x1b[1;31mred\x1b[0m\r\n\x1b[?1000hplain\x1b[?25l");
    // another writer leaves a pen, a link, a scroll region, origin and insert mode, a charset, modes
    pair.target.screen.write("\x1b[42;7m\x1b]8;;https://junk\x1b\\\x1b[2;4r\x1b[?6h\x1b[4h\x1b(0\x1b[?7l\x1b[?1003h\x1b[?25hqqq\x1b[5;5Hjunk");
    pair.target.display.invalidate();
    const out = pair.target.sync(pair.frame, pair.styleOf);
    expect(out).toContain("\x1b[2J");
    pair.feed("\x1b[5;1Hlast row");
  });

  it("returns nothing when nothing changed", async () => {
    const pair = await Pair.create(12, 4);
    pair.feed("text\x1b[?1000h");
    expect(pair.target.draw(pair.frame, pair.styleOf)).toBe("");
    // equal rows in new objects are unchanged too
    const copy: Frame = { ...pair.frame, lines: pair.frame.lines.map((line) => makeRow(JSON.parse(JSON.stringify(line.wire)))), cursor: { ...pair.frame.cursor }, modes: { ...pair.frame.modes } };
    expect(pair.target.draw(copy, pair.styleOf)).toBe("");
  });

  it("never draws the clipboard", async () => {
    const pair = await Pair.create(12, 3);
    const out = pair.feed("\x1b]52;c;aGVsbG8=\x07x");
    expect(pair.frame.clip).not.toBeNull();
    expect(out).not.toContain("52;");
  });

  it("draws one changed row of a large screen in much less than the whole", async () => {
    const pair = await Pair.create(200, 60);
    let vt = "";
    for (let row = 0; row < 60; row++) vt += `\x1b[${row + 1};1H\x1b[3${row % 8}m${`row ${row} `.repeat(30).slice(0, 200)}`;
    const whole = pair.feed(`${vt}\x1b[0m`);
    const one = pair.feed("\x1b[30;50H\x1b[1;35mchanged\x1b[0m");
    expect(one.length).toBeLessThan(whole.length / 100);
    // and it is cheap to compute: unchanged rows are compared by key only
    const frame = pair.frame;
    const display = new TerminalDisplay();
    display.draw(frame, pair.styleOf);
    const lines = [...frame.lines];
    const started = performance.now();
    for (let step = 0; step < 200; step++) {
      lines[step % 60] = makeRow(encodeRow(textCells(`step ${step}`, 200)));
      display.draw({ ...frame, num: frame.num + step + 1, lines: [...lines] }, pair.styleOf);
    }
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("skips the unchanged stretch between two distant changes", async () => {
    const pair = await Pair.create(80, 3);
    pair.feed(`${"0123456789".repeat(8)}`);
    const out = pair.feed("\x1b[1;6HA\x1b[1;71HB");
    // the cursor ends after the B, where the drawing left it: no CUP
    expect(out).toBe("\x1b[?25l\x1b[1;6HA\x1b[1;71HB\x1b[?25h");
  });

  it("rewrites a wide cell whole when one of its columns changed", async () => {
    const styleOf: StyleOf = (id) => (id === 1 ? { ...PLAIN_STYLE, bg: 3 } : PLAIN_STYLE);
    const display = new TerminalDisplay();
    const row: Cell[] = [...textCells("ab", 2), { text: "你", width: 2, style: 0 }, { text: "", width: 0, style: 0 }, ...textCells("cd", 2)];
    display.draw(frameOf(6, 1, [row]), styleOf);
    // only the second column differs (in style): the span starts at the first
    const tail = [...row];
    tail[3] = { text: "", width: 0, style: 1 };
    expect(display.draw(frameOf(6, 1, [tail]), styleOf)).toContain("\x1b[1;3H你");
    // a narrow cell over the first column of the old wide cell takes its second column along
    const narrow = [...row];
    narrow[2] = { text: "x", width: 1, style: 0 };
    narrow[3] = { text: "d", width: 1, style: 0 };
    display.draw(frameOf(6, 1, [row]), styleOf);
    expect(display.draw(frameOf(6, 1, [narrow]), styleOf)).toContain("\x1b[1;3Hxd");
  });

  it("draws frames built from rows, with client-local style ids", async () => {
    const styles = new Map<number, Style>([
      [0, PLAIN_STYLE],
      [1, { fg: 2, bg: -1, ul: -1, flags: 1, link: null }],
      [-1, { fg: -1, bg: -1, ul: -1, flags: 1 << 8, link: null }],
      [-2, { fg: -1, bg: RGB_COLOR | 0x203040, ul: -1, flags: 0, link: null }],
    ]);
    const styleOf: StyleOf = (id) => styles.get(id) ?? PLAIN_STYLE;
    const target = await Target.create(12, 3);
    const row0 = textCells("prompt$ ls", 12, 1);
    row0[8] = { text: "l", width: 1, style: -1 };
    row0[9] = { text: "s", width: 1, style: -1 };
    const row1: Cell[] = [{ text: "你", width: 2, style: -1 }, { text: "", width: 0, style: -1 }, ...textCells("", 10, -2)];
    target.sync(frameOf(12, 3, [row0, row1], { cursor: { row: 0, col: 10 } }), styleOf);
    row0[10] = { text: "x", width: 1, style: -1 };
    target.sync(frameOf(12, 3, [row0, row1], { cursor: { row: 0, col: 11 } }), styleOf);
  });
});

/** mulberry32: the same transitions on every run, so a failure can be replayed */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("TerminalDisplay, random frames", () => {
  const styles = new Map<number, Style>([
    [0, PLAIN_STYLE],
    [1, { fg: 1, bg: -1, ul: -1, flags: 1, link: null }],
    [2, { fg: -1, bg: 4, ul: -1, flags: 0, link: null }],
    [3, { fg: -1, bg: RGB_COLOR | 0x102030, ul: -1, flags: 0, link: null }],
    [4, { fg: 200, bg: 17, ul: RGB_COLOR | 0xff8000, flags: 3 << 8 | 2, link: null }],
    [5, { fg: -1, bg: -1, ul: -1, flags: 16, link: null }],
    [6, { fg: 12, bg: -1, ul: -1, flags: 0, link: "https://example.com/x" }],
    [7, { fg: -1, bg: -1, ul: -1, flags: 0, link: "file:///etc/passwd" }],
    [8, { fg: RGB_COLOR | 0xa0b0c0, bg: 9, ul: 3, flags: 4 | 8 | 32 | 64 | 128 | 5 << 8, link: null }],
    [9, { fg: -1, bg: 2, ul: -1, flags: 0, link: "https://example.com/y" }],
    // drawn with style 2's SGR, but an erase would lose the link
    [10, { fg: -1, bg: 4, ul: -1, flags: 0, link: "https://example.com/z" }],
    [-1, { fg: -1, bg: -1, ul: -1, flags: 1 << 8, link: null }],
    [-2, { fg: -1, bg: 4, ul: -1, flags: 0, link: null }],
  ]);
  const styleOf: StyleOf = (id) => styles.get(id) ?? PLAIN_STYLE;
  const ids = [...styles.keys()];
  const ascii = [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456789-_=+[]{}<>/\\|~`!@#$%^&*().,;:'\"?"];
  const narrow = ["é", "e\u0301", "ß", "λ", "─", "→", "\u00a0"];
  const wide = ["你", "好", "😀", "👨‍👩‍👧", "⚠\ufe0f", "🇺🇸"];

  it("converges after every incremental draw", async () => {
    const random = prng(0x5eed);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    let cols = 12, rows = 5;
    const target = await Target.create(cols, rows, { linkAllowed: httpOnly });

    const randomCell = (style: number): Cell => {
      const roll = random();
      if (roll < 0.3) return { text: " ", width: 1, style };
      if (roll < 0.4) return { text: pick(narrow), width: 1, style };
      return { text: pick(ascii), width: 1, style };
    };
    /** cells [from, to) of `cells` anew, wide ones among them; then every wide cell whole again */
    const fill = (cells: Cell[], from: number, to: number): void => {
      let style = pick(ids);
      for (let col = from; col < to; col++) {
        if (random() < 0.3) style = pick(ids);
        if (random() < 0.12 && col + 1 < cells.length) {
          cells[col] = { text: pick(wide), width: 2, style };
          cells[col + 1] = { text: "", width: 0, style };
          col++;
        } else cells[col] = randomCell(style);
      }
      for (let col = 0; col < cells.length; col++) {
        const cell = cells[col]!;
        if (cell.width === 2) {
          if (col + 1 >= cells.length || cells[col + 1]!.width !== 0) cells[col] = { text: " ", width: 1, style: cell.style };
          else {
            cells[col + 1] = { text: "", width: 0, style: cell.style };
            col++;
          }
        } else if (cell.width === 0) cells[col] = { text: " ", width: 1, style: cell.style };
      }
      // trailing blanks: mostly in a background colour, as an erase makes them, else in styles an erase cannot make
      if (random() < 0.4) {
        const pool = random() < 0.7 ? [2, -2, 3] : [1, 4, 5, 6, 10, 2];
        let style = pick(pool);
        const from = Math.floor(random() * cells.length);
        if (cells[from - 1]?.width !== 2) {
          for (let col = from; col < cells.length; col++) {
            if (random() < 0.15) style = pick(pool);
            cells[col] = { text: " ", width: 1, style };
          }
        }
      }
    };
    const newRow = (): Cell[] => {
      const cells = Array.from({ length: cols }, (): Cell => ({ text: " ", width: 1, style: 0 }));
      if (random() < 0.85) fill(cells, 0, cols);
      return cells;
    };

    let grid: Cell[][] = Array.from({ length: rows }, newRow);
    let lines: Row[] = grid.map((cells) => makeRow(encodeRow(cells)));
    let cursor: Cursor = { row: 0, col: 0, visible: true, shape: 0, blink: false };
    let modes: Modes = { ...DEFAULT_MODES };
    let num = 0;
    let sizes = 0, scrolls = 0, invalidations = 0, switches = 0, empty = 0;

    for (let step = 0; step < 400; step++) {
      const roll = random();
      if (roll < 0.03) {
        cols = 8 + Math.floor(random() * 8);
        rows = 3 + Math.floor(random() * 4);
        grid = Array.from({ length: rows }, newRow);
        lines = grid.map((cells) => makeRow(encodeRow(cells)));
        cursor = { ...cursor, row: Math.min(cursor.row, rows - 1), col: Math.min(cursor.col, cols - 1) };
        target.screen.resize(cols, rows);
        sizes++;
      } else if (roll < 0.1) {
        const shift = 1 + Math.floor(random() * 2);
        grid = [...grid.slice(shift), ...Array.from({ length: shift }, () => Array.from({ length: cols }, (): Cell => ({ text: " ", width: 1, style: 0 })))];
        lines = [...lines.slice(shift), ...Array.from({ length: shift }, () => blankRow(cols))];
        const row = rows - 1;
        grid[row] = newRow();
        lines[row] = makeRow(encodeRow(grid[row]!));
        scrolls++;
      } else if (roll < 0.14) {
        target.screen.write(pick(["\x1b[41;1mjunk\x1b(0qq", "\x1b[2;3r\x1b[?6h\x1b[4hins", "\x1b]8;;https://junk\x1b\\x\x1b[?1003h", "\x1bc"]));
        target.display.invalidate();
        invalidations++;
      } else if (roll < 0.17) {
        modes = { ...modes, altScreen: !modes.altScreen };
        switches++;
      } else {
        const changes = 1 + Math.floor(random() * 3);
        for (let change = 0; change < changes; change++) {
          const row = Math.floor(random() * rows);
          if (random() < 0.3) grid[row] = newRow();
          else {
            const from = Math.floor(random() * cols);
            const to = Math.min(cols, from + 1 + Math.floor(random() * 5));
            grid[row] = [...grid[row]!];
            fill(grid[row]!, from, to);
          }
          lines[row] = makeRow(encodeRow(grid[row]!));
        }
        // the same rows in new objects
        if (random() < 0.1) lines = lines.map((line) => makeRow(JSON.parse(JSON.stringify(line.wire))));
      }
      if (random() < 0.3) cursor = { ...cursor, row: Math.floor(random() * rows), col: Math.floor(random() * cols) };
      if (random() < 0.08) cursor = { ...cursor, visible: !cursor.visible };
      if (random() < 0.08) cursor = { ...cursor, shape: pick([0, 1, 2] as CursorShape[]), blink: random() < 0.5 };
      if (random() < 0.1) {
        modes = {
          ...modes,
          mouse: pick([0, 9, 1000, 1002, 1003]), mouseEncoding: pick([0, 1005, 1006, 1015, 1016]),
          cursorKeys: random() < 0.5, keypad: random() < 0.5, bracketedPaste: random() < 0.5, focusEvents: random() < 0.5,
          alternateScroll: random() < 0.5, kittyKeyboard: Math.floor(random() * 32), modifyOtherKeys: pick([0, 1, 2]),
        };
      }
      const frame: Frame = { num: ++num, cols, rows, lines: [...lines], cursor, modes, clip: null };
      const out = target.draw(frame, styleOf);
      if (out === "") empty++;
      target.expectShows(frame, styleOf);
    }
    // the walk went through every kind of transition
    expect(Math.min(sizes, scrolls, invalidations, switches)).toBeGreaterThan(3);
    expect(empty).toBeLessThan(400 / 4);
  });

  it("draws an unchanged random frame as nothing, and a whole one after invalidate()", async () => {
    const target = await Target.create(12, 5);
    const random = prng(7);
    const cells = Array.from({ length: 5 }, () => textCells(Array.from({ length: 12 }, () => ascii[Math.floor(random() * ascii.length)]).join(""), 12, 1));
    const frame = frameOf(12, 5, cells, { cursor: { row: 4, col: 11 } });
    const whole = target.sync(frame, styleOf);
    expect(target.draw(frame, styleOf)).toBe("");
    target.display.invalidate();
    expect(target.draw(frame, styleOf)).toBe(whole);
  });
});

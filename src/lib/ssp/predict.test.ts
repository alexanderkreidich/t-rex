import { describe, expect, it } from "bun:test";
import { blankFrame, decodeRow, encodeRow, makeRow, type Cell, type Frame } from "../../../shared/ssp.ts";
import { PredictionEngine } from "./predict.ts";

const COLS = 20;
const ROWS = 3;
/** a style id the tests read as "underlined" */
const UNDERLINED = 99;

/** A screen with `text` on row 0 and the cursor where given. */
function screen(text: string, col = text.length, num = 1, row = 0, visible = true): Frame {
  const base = blankFrame(COLS, ROWS);
  const cells: Cell[] = Array.from({ length: COLS }, (_, i) => ({ text: text[i] ?? " ", width: 1, style: 0 }));
  const lines = [...base.lines];
  lines[0] = makeRow(encodeRow(cells));
  return { ...base, num, lines, cursor: { ...base.cursor, row, col, visible } };
}

function shown(engine: PredictionEngine, frame: Frame): { text: string; col: number; underlined: boolean } {
  const out = engine.overlay(frame, () => UNDERLINED);
  const cells = decodeRow(out.lines[0]!.wire, COLS);
  return { text: cells.map((cell) => cell.text).join("").trimEnd(), col: out.cursor.col, underlined: cells.some((cell) => cell.style === UNDERLINED) };
}

function engine(rtt = 100) {
  let now = 0;
  const predictions = new PredictionEngine({ now: () => now });
  predictions.setRtt(rtt);
  return { predictions, tick: (ms: number) => { now += ms; } };
}

describe("PredictionEngine", () => {
  it("shows nothing until the first guess comes true, then shows the next keystrokes at once", () => {
    const { predictions, tick } = engine();
    const prompt = screen("$ ");
    predictions.typed("l", 1, prompt);
    // the first epoch is tentative
    expect(shown(predictions, prompt)).toEqual({ text: "$", col: 2, underlined: false });
    tick(100);
    const echoed = screen("$ l", 3, 2);
    predictions.confirm(echoed, 1);
    expect(predictions.pending).toBe(false);
    predictions.typed("s", 2, echoed);
    // confirmed: shown at once, underlined on a slow link
    expect(shown(predictions, echoed)).toEqual({ text: "$ ls", col: 4, underlined: true });
    tick(100);
    const done = screen("$ ls", 4, 3);
    predictions.confirm(done, 2);
    expect(predictions.pending).toBe(false);
    expect(predictions.overlay(done, () => UNDERLINED)).toBe(done);
  });

  it("takes a guess the screen already shows as confirmed before the bridge says the echo is due", () => {
    const { predictions, tick } = engine();
    const prompt = screen("$ ");
    predictions.typed("l", 1, prompt);
    tick(90);
    // the program's echo is on screen; the bridge says input 1 is due only 50 ms after it went in
    const echoed = screen("$ l", 3, 2);
    predictions.confirm(echoed, 0);
    predictions.typed("s", 2, echoed);
    expect(shown(predictions, echoed).text).toBe("$ ls");
  });

  it("does not confirm early on a cell that already showed the guess", () => {
    const { predictions, tick } = engine();
    const before = screen("$ x", 2);
    predictions.typed("x", 1, before);
    tick(90);
    predictions.confirm(before, 0);
    predictions.typed("y", 2, before);
    expect(shown(predictions, before).text).toBe("$ x");
  });

  it("waits a moment for an echo herdr has not drawn yet before calling a guess wrong", () => {
    const { predictions, tick } = engine();
    let frame = screen("$ ");
    predictions.typed("a", 1, frame);
    tick(60);
    frame = screen("$ a", 3, 2);
    predictions.confirm(frame, 1);
    predictions.typed("b", 2, frame);
    // the echo is due, but the screen still shows the line without it
    tick(60);
    predictions.confirm(frame, 2);
    expect(shown(predictions, frame).text).toBe("$ ab");
    tick(100);
    frame = screen("$ ab", 4, 3);
    predictions.confirm(frame, 2);
    expect(predictions.pending).toBe(false);
    // and the epoch stays confirmed: the next key shows at once
    predictions.typed("c", 3, frame);
    expect(shown(predictions, frame).text).toBe("$ abc");
  });

  it("takes a screen that already shows newer input for an echo of the older one", () => {
    const { predictions, tick } = engine();
    let frame = screen("$ ");
    predictions.typed("a", 1, frame);
    tick(60);
    frame = screen("$ a", 3, 2);
    predictions.confirm(frame, 1);
    predictions.typed("b", 2, frame);
    predictions.typed("c", 3, frame);
    // the echo says input 2 went in long enough ago; the screen also has 3, the cursor past it
    tick(300);
    frame = screen("$ abc", 5, 3);
    predictions.confirm(frame, 2);
    tick(300);
    predictions.confirm(frame, 2);
    expect(shown(predictions, frame)).toMatchObject({ text: "$ abc", col: 5 });
    predictions.typed("d", 4, frame);
    expect(shown(predictions, frame).text).toBe("$ abcd");
  });

  it("never shows anything at a prompt that does not echo", () => {
    const { predictions, tick } = engine();
    const prompt = screen("Password: ");
    for (const [i, char] of [..."secret"].entries()) {
      predictions.typed(char, i + 1, prompt);
      expect(shown(predictions, prompt).text).toBe("Password:");
      tick(60);
      predictions.confirm(prompt, i + 1);
    }
    expect(shown(predictions, prompt).text).toBe("Password:");
  });

  it("guesses Backspace and the arrows, typed or as keys", () => {
    const { predictions, tick } = engine();
    let frame = screen("$ ab");
    predictions.typed("c", 1, frame);
    tick(60);
    frame = screen("$ abc", 5, 2);
    predictions.confirm(frame, 1);
    predictions.typed("\x7f", 2, frame);
    expect(shown(predictions, frame)).toMatchObject({ text: "$ ab", col: 4 });
    predictions.typed("\x1b[D", 3, frame);
    expect(shown(predictions, frame).col).toBe(3);
    predictions.key("ArrowLeft", 4, frame);
    expect(shown(predictions, frame).col).toBe(2);
    predictions.key("ArrowRight", 5, frame);
    predictions.typed("\x1bOC", 6, frame);
    expect(shown(predictions, frame).col).toBe(4);
  });

  it("inserts in the middle of a row", () => {
    const { predictions, tick } = engine();
    let frame = screen("$ ac", 3);
    predictions.typed("x", 1, frame);
    tick(60);
    frame = screen("$ axc", 4, 2);
    predictions.confirm(frame, 1);
    predictions.typed("b", 2, frame);
    expect(shown(predictions, frame)).toMatchObject({ text: "$ axbc", col: 5 });
  });

  it("takes every shown guess back when one turns out wrong", () => {
    const { predictions, tick } = engine();
    let frame = screen("$ ");
    predictions.typed("a", 1, frame);
    tick(60);
    frame = screen("$ a", 3, 2);
    predictions.confirm(frame, 1);
    predictions.typed("b", 2, frame);
    predictions.typed("c", 3, frame);
    expect(shown(predictions, frame).text).toBe("$ abc");
    tick(60);
    // the program drew something else for b: wrong once herdr has had time to draw the echo
    frame = screen("$ aB", 4, 3);
    predictions.confirm(frame, 2);
    expect(predictions.pending).toBe(true);
    tick(250);
    predictions.confirm(frame, 2);
    expect(predictions.pending).toBe(false);
    expect(shown(predictions, frame).text).toBe("$ aB");
    // and the next guess is tentative again
    predictions.typed("d", 4, frame);
    expect(shown(predictions, frame).text).toBe("$ aB");
  });

  it("does not guess at the last column, at a wide character or at a hidden cursor", () => {
    const { predictions } = engine();
    const confirmed = (predictions as unknown as { confirmedEpoch: number });
    const full = screen("x".repeat(COLS - 1), COLS - 1);
    confirmed.confirmedEpoch = 1_000;
    predictions.typed("y", 1, full);
    expect(predictions.pending).toBe(false);
    predictions.typed("中", 2, screen("$ "));
    expect(predictions.pending).toBe(false);
    predictions.typed("a", 3, screen("$ ", 2, 1, 0, false));
    expect(predictions.pending).toBe(false);
  });

  it("treats a paste and control keys as the start of a new epoch", () => {
    const { predictions, tick } = engine();
    let frame = screen("$ ");
    predictions.typed("a", 1, frame);
    tick(60);
    frame = screen("$ a", 3, 2);
    predictions.confirm(frame, 1);
    predictions.typed("\x1b[200~pasted text\x1b[201~", 2, frame);
    predictions.typed("b", 3, frame);
    expect(shown(predictions, frame).text).toBe("$ a");
    predictions.typed("\x03", 4, frame);
    predictions.typed("c", 5, frame);
    expect(shown(predictions, frame).text).toBe("$ a");
  });

  it("guesses the cursor at the next row's start after Enter, tentatively", () => {
    const { predictions, tick } = engine();
    let frame = screen("$ ");
    predictions.typed("a", 1, frame);
    tick(60);
    frame = screen("$ a", 3, 2);
    predictions.confirm(frame, 1);
    predictions.typed("\r", 2, frame);
    expect(predictions.overlay(frame, () => UNDERLINED).cursor).toEqual(frame.cursor);
  });

  it("shows guesses only on a slow link, with hysteresis, and underlines above 80 ms", () => {
    const { predictions, tick } = engine(10);
    let frame = screen("$ ");
    predictions.typed("a", 1, frame);
    tick(10);
    frame = screen("$ a", 3, 2);
    predictions.confirm(frame, 1);
    predictions.typed("b", 2, frame);
    expect(shown(predictions, frame).text).toBe("$ a");
    predictions.setRtt(40);
    expect(shown(predictions, frame)).toMatchObject({ text: "$ ab", underlined: false });
    predictions.setRtt(25);
    expect(shown(predictions, frame).text).toBe("$ ab");
    predictions.setRtt(15);
    expect(shown(predictions, frame).text).toBe("$ a");
    predictions.setRtt(90);
    expect(shown(predictions, frame).underlined).toBe(true);
    predictions.setRtt(60);
    expect(shown(predictions, frame).underlined).toBe(true);
    predictions.setRtt(45);
    expect(shown(predictions, frame).underlined).toBe(false);
  });

  it("shows guesses on a fast link when the echo itself takes long to show (herdr draws at its own pace)", () => {
    const { predictions, tick } = engine(2);
    let frame = screen("$ ");
    predictions.typed("a", 1, frame);
    tick(45);
    frame = screen("$ a", 3, 2);
    predictions.confirm(frame, 0);
    predictions.typed("b", 2, frame);
    expect(shown(predictions, frame)).toMatchObject({ text: "$ ab", underlined: false });
  });

  it("shows nothing on a fast link whose echo shows quickly", () => {
    const { predictions, tick } = engine(2);
    let frame = screen("$ ");
    predictions.typed("a", 1, frame);
    tick(10);
    frame = screen("$ a", 3, 2);
    predictions.confirm(frame, 0);
    predictions.typed("b", 2, frame);
    expect(shown(predictions, frame).text).toBe("$ a");
  });

  it("shows guesses on a fast link while an echo is late, and confirm() on a timer applies that", () => {
    const { predictions, tick } = engine(5);
    let frame = screen("$ ");
    predictions.typed("a", 1, frame);
    tick(5);
    frame = screen("$ a", 3, 2);
    predictions.confirm(frame, 1);
    predictions.typed("b", 2, frame);
    expect(shown(predictions, frame).text).toBe("$ a");
    tick(300);
    predictions.confirm(frame, 1);
    expect(shown(predictions, frame).text).toBe("$ ab");
  });

  it("clears everything when turned off, and on reset or a new grid", () => {
    const { predictions, tick } = engine();
    let frame = screen("$ ");
    predictions.typed("a", 1, frame);
    tick(60);
    frame = screen("$ a", 3, 2);
    predictions.confirm(frame, 1);
    predictions.typed("b", 2, frame);
    predictions.setEnabled(false);
    expect(predictions.pending).toBe(false);
    predictions.typed("c", 3, frame);
    expect(predictions.pending).toBe(false);
    predictions.setEnabled(true);
    predictions.typed("c", 4, frame);
    expect(predictions.pending).toBe(true);
    predictions.reset();
    expect(predictions.pending).toBe(false);
    predictions.typed("d", 5, frame);
    predictions.confirm({ ...blankFrame(COLS + 1, ROWS), num: 9 }, 0);
    expect(predictions.pending).toBe(false);
  });

  it("reuses the rows it does not touch", () => {
    const { predictions, tick } = engine();
    let frame = screen("$ ");
    predictions.typed("a", 1, frame);
    tick(60);
    frame = screen("$ a", 3, 2);
    predictions.confirm(frame, 1);
    predictions.typed("b", 2, frame);
    const out = predictions.overlay(frame, () => UNDERLINED);
    expect(out).not.toBe(frame);
    expect(out.lines[1]).toBe(frame.lines[1]);
    expect(out.lines[0]).not.toBe(frame.lines[0]);
  });
});

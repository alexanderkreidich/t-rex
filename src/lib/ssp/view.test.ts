import { describe, expect, it } from "bun:test";
import { PLAIN_STYLE, blankFrame, diffFrames, encodeRow, makeRow, type Cell, type Frame } from "../../../shared/ssp.ts";
import { SspView } from "./view.ts";

const COLS = 20;
const ROWS = 3;

/** Screen `num`: `text` on row 0, the cursor after it. */
function screen(num: number, text: string): Frame {
  const base = blankFrame(COLS, ROWS);
  const cells: Cell[] = Array.from({ length: COLS }, (_, i) => ({ text: text[i] ?? " ", width: 1, style: 0 }));
  const lines = [...base.lines];
  lines[0] = makeRow(encodeRow(cells));
  return { ...base, num, lines, cursor: { ...base.cursor, row: 0, col: text.length, visible: true } };
}

describe("SspView", () => {
  it("takes the echo from a screen sent again unchanged, so a guess is confirmed without waiting for the next change", () => {
    const view = new SspView({ write: () => {}, ack: () => {} });
    view.setSize(COLS, ROWS);
    const send = (base: Frame | null, next: Frame, echo: number) => {
      const diff = diffFrames("s", base, next, base?.num ?? 0, echo, () => PLAIN_STYLE);
      diff.rtt = 100;
      view.receive(diff);
    };
    const prompt = screen(1, "$ ");
    send(null, prompt, 0);
    view.typed("l", 1);
    // the program echoed, but the bridge does not yet say it had the time to
    const echoed = screen(2, "$ l");
    send(prompt, echoed, 0);
    expect(view.predictions.pending).toBe(true);
    // the same screen again, now with the echo due (sync.ts sends it when only the echo changed)
    send(echoed, echoed, 1);
    expect(view.predictions.pending).toBe(false);
    // the epoch is confirmed: the next key shows at once
    view.typed("s", 2);
    expect(view.shown().text.split("\n")[0]).toBe("$ ls");
    view.dispose();
  });
});

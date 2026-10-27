import { describe, expect, it } from "bun:test";
import { DEFAULT_MODES } from "../../shared/ssp.ts";
import { ModeTracker } from "./modes.ts";

function track(...chunks: string[]): ModeTracker {
  const tracker = new ModeTracker();
  for (const chunk of chunks) tracker.feed(chunk);
  return tracker;
}

describe("ModeTracker", () => {
  it("follows the modes the browser's input encoding needs", () => {
    const tracker = track("\x1b[?1h\x1b=\x1b[?2004h\x1b[?1004h\x1b[?1007h\x1b[?1049h\x1b[?1002;1006h\x1b[>4;2m");
    expect(tracker.current).toEqual({
      ...DEFAULT_MODES, cursorKeys: true, keypad: true, bracketedPaste: true, focusEvents: true, alternateScroll: true,
      altScreen: true, mouse: 1002, mouseEncoding: 1006, modifyOtherKeys: 2,
    });
    tracker.feed("\x1b[?1002l\x1b[?1006l\x1b>\x1b[?1l\x1b[>4n");
    expect(tracker.current.mouse).toBe(0);
    expect(tracker.current.mouseEncoding).toBe(0);
    expect(tracker.current.keypad).toBe(false);
    expect(tracker.current.cursorKeys).toBe(false);
    expect(tracker.current.modifyOtherKeys).toBe(0);
  });

  it("reads a sequence split at any byte", () => {
    const sequence = "\x1b[?1000;1006h\x1b]52;c;aGk=\x07";
    for (let cut = 1; cut < sequence.length; cut++) {
      const tracker = track(sequence.slice(0, cut), sequence.slice(cut));
      expect(tracker.current.mouse).toBe(1000);
      expect(tracker.current.mouseEncoding).toBe(1006);
      expect(tracker.clip).toEqual({ seq: 1, payload: "c;aGk=" });
    }
  });

  it("turning a mode off that another replaced leaves the newer one", () => {
    expect(track("\x1b[?1000h\x1b[?1003h\x1b[?1000l").current.mouse).toBe(1003);
  });

  it("never reads a string's text as a sequence", () => {
    const tracker = track("\x1b]0;[?1000h title\x07\x1bP[?2004h\x1b\\\x1b_Gq=2;[?1h\x9b?1h\x1b\\");
    expect(tracker.current).toEqual(DEFAULT_MODES);
  });

  it("an ESC inside a string ends it, as in a terminal", () => {
    expect(track("\x1b]0;title\x1b[?2004h").current.bracketedPaste).toBe(true);
  });

  it("numbers each clipboard write, ST or BEL ended, and keeps the payload as written", () => {
    const tracker = track("\x1b]52;c;b25l\x1b\\", "text", "\x1b]52;c;dHdv\x07");
    expect(tracker.clip).toEqual({ seq: 2, payload: "c;dHdv" });
    // an OSC that is not 52 is skipped unread
    tracker.feed("\x1b]8;;https://example.com\x07");
    expect(tracker.clip?.seq).toBe(2);
  });

  it("starts over on a full reset and says so", () => {
    const tracker = track("\x1b[?1h\x1b[?2004h");
    tracker.feed("x\x1bcy");
    expect(tracker.resetSeen).toBe(true);
    expect(tracker.current).toEqual(DEFAULT_MODES);
    tracker.feed("z");
    expect(tracker.resetSeen).toBe(false);
  });

  it("a soft reset turns the cursor keys and keypad back to normal", () => {
    const tracker = track("\x1b[?1h\x1b=\x1b[?2004h\x1b[!p");
    expect(tracker.current.cursorKeys).toBe(false);
    expect(tracker.current.keypad).toBe(false);
    expect(tracker.current.bracketedPaste).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";
import { keyboardHoldsGrid } from "./keyboard.ts";

/** The transcript's listeners, on a stand-in node and document, with the keyboard up. */

/** #1045: the keyboard takes the bottom of the screen, not the pane; the shared pty keeps its grid */
describe("keyboardHoldsGrid", () => {
  test("a host that only lost height under the keyboard keeps its grid (regression: fails on main)", () => {
    expect(keyboardHoldsGrid(true, 390, 390)).toBe(true);
  });

  test("a first fit under the keyboard waits for it to go (regression: fails on main)", () => {
    expect(keyboardHoldsGrid(true, 390, null)).toBe(true);
  });

  test("a host whose width changed under the keyboard (a rotation) refits (control)", () => {
    expect(keyboardHoldsGrid(true, 430, 390)).toBe(false);
    expect(keyboardHoldsGrid(true, 390, 430)).toBe(false);
  });

  test("without the keyboard every resize refits, the first one too (control)", () => {
    expect(keyboardHoldsGrid(false, 390, 390)).toBe(false);
    expect(keyboardHoldsGrid(false, 390, null)).toBe(false);
    expect(keyboardHoldsGrid(false, 450, 390)).toBe(false);
  });
});

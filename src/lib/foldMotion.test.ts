import { describe, expect, it } from "bun:test";
import { milliseconds } from "./foldMotion.ts";

describe("milliseconds", () => {
  // the build minifies `--dur-fold: 420ms` to `.42s`; read as 0.42ms, the fold would not move
  it("reads a CSS time in either unit", () => {
    expect(milliseconds("420ms")).toBe(420);
    expect(milliseconds(" .42s")).toBe(420);
    expect(milliseconds("0.36s")).toBe(360);
  });

  it("reads anything else as no time", () => {
    expect(milliseconds("")).toBe(0);
    expect(milliseconds("var(--dur-fold)")).toBe(0);
    expect(milliseconds("420")).toBe(0);
  });
});

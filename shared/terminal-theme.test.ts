import { expect, it } from "bun:test";
import { validTerminalTheme } from "./terminal-theme.ts";

const rgb = { r: 26, g: 27, b: 38 };
const theme = { foreground: rgb, background: rgb, palette: Array.from({ length: 16 }, () => rgb) };

it("accepts complete RGB terminal themes, not partial or malformed palettes", () => {
  expect(validTerminalTheme(theme)).toBe(true);
  for (const value of [null, [], {}, { ...theme, foreground: null }, { ...theme, palette: theme.palette.slice(1) }, { ...theme, palette: [...theme.palette, rgb] }]) {
    expect(validTerminalTheme(value)).toBe(false);
  }
  for (const channel of [-1, 256, 1.5, NaN, "26"]) {
    expect(validTerminalTheme({ ...theme, background: { ...rgb, r: channel } })).toBe(false);
    expect(validTerminalTheme({ ...theme, palette: [{ ...rgb, b: channel }, ...theme.palette.slice(1)] })).toBe(false);
  }
});

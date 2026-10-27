import { expect, it } from "bun:test";
import { terminalColors } from "../themes.ts";
import { ghosttyThemeNames, resttyTheme, terminalColorsTheme, terminalDisplayTheme } from "./theme.ts";
import { validTerminalTheme } from "../../../shared/terminal-theme.ts";

it("publishes the RGB defaults and ANSI palette actually drawn for both appearances", () => {
  for (const mode of ["dark", "light"] as const) {
    const rendered = resttyTheme(terminalColors("amber", mode));
    const theme = terminalDisplayTheme(rendered)!;
    expect(validTerminalTheme(theme)).toBe(true);
    expect(theme.background).toEqual(rendered.colors.background!);
    expect(theme.foreground).toEqual(rendered.colors.foreground!);
    expect(theme.palette[4]).toEqual(rendered.colors.palette[4]!);
  }
});

it("honours a separate Ghostty theme instead of publishing the app's colours", () => {
  const name = ghosttyThemeNames().find((name) => /tokyo.*night/i.test(name));
  expect(name).toBeDefined();
  const app = terminalColors("amber", "light");
  const rendered = terminalColorsTheme(name!, app);
  const theme = terminalDisplayTheme(rendered)!;
  expect(validTerminalTheme(theme)).toBe(true);
  expect(theme.background).toEqual(rendered.colors.background!);
  expect(theme.background).not.toEqual(resttyTheme(app).colors.background!);
  expect(terminalDisplayTheme({ colors: { palette: [] }, raw: {} })).toBeNull();
});

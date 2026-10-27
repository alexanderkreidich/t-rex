/**
 * The terminal's colours as restty takes them: a Ghostty theme built from the app theme's
 * `--term-*` tokens (lib/themes.ts). A dark row names no ANSI colours and keeps Ghostty's own;
 * restty keeps a palette it was given until another replaces it, so every theme here names all
 * sixteen, and switching from a light row back to a dark one cannot leave its colours behind.
 */
import { getBuiltinTheme, isBuiltinThemeName, listBuiltinThemeNames, parseGhosttyTheme, type GhosttyTheme } from "restty";
import type { TerminalColors } from "../themes.ts";
import type { LIGHT_ANSI_ROLES } from "../themeRoles.ts";
import type { TerminalDisplayTheme } from "../../../shared/terminal-theme.ts";

/** Ghostty's default palette (src/terminal/color.zig), drawn where a theme row names none. */
const GHOSTTY_ANSI = [
  "#1d1f21", "#cc6666", "#b5bd68", "#f0c674", "#81a2be", "#b294bb", "#8abeb7", "#c5c8c6",
  "#666666", "#d54e53", "#b9ca4a", "#e7c547", "#7aa6da", "#c397d8", "#70c0b1", "#eaeaea",
] as const;

/** The ANSI roles in palette order (themeRoles.ts keys them by name). */
const ANSI_ORDER: readonly (keyof typeof LIGHT_ANSI_ROLES)[] = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
];

/** The Ghostty theme for a row's terminal colours. */
export function resttyTheme(colors: TerminalColors): GhosttyTheme {
  const lines = [
    `background = ${colors.background}`,
    `foreground = ${colors.foreground}`,
    `cursor-color = ${colors.cursor}`,
    `selection-background = ${colors.selectionBackground}`,
    ...ANSI_ORDER.map((role, index) => `palette = ${index}=${colors[role] ?? GHOSTTY_ANSI[index]}`),
  ];
  return parseGhosttyTheme(lines.join("\n"));
}

/** The same RGBs the renderer draws, published to Herdr for application colour queries. */
export function terminalDisplayTheme(theme: GhosttyTheme): TerminalDisplayTheme | null {
  const { foreground, background, palette } = theme.colors;
  if (!foreground || !background) return null;
  const rgb = ({ r, g, b }: { r: number; g: number; b: number }) => ({ r, g, b });
  return {
    foreground: rgb(foreground), background: rgb(background),
    palette: GHOSTTY_ANSI.map((hex, index) => rgb(palette[index] ?? {
      r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16),
    })),
  };
}

/** Ghostty's own themes, by name (Settings → Appearance → Terminal theme). */
export function ghosttyThemeNames(): string[] {
  return listBuiltinThemeNames();
}

/** The terminal's colours: a Ghostty theme by name, or the app theme's row ("" or a name restty does not know). */
export function terminalColorsTheme(name: string, colors: TerminalColors): GhosttyTheme {
  return (name !== "" && isBuiltinThemeName(name) ? getBuiltinTheme(name) : null) ?? resttyTheme(colors);
}

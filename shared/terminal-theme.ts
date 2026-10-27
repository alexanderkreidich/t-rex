import type { TerminalDisplayTheme } from "./herdr-api.generated.ts";
export type { TerminalDisplayTheme };

/** Only a complete, byte-valued ANSI palette may become a pane's query responses. */
export function validTerminalTheme(value: unknown): value is TerminalDisplayTheme {
  if (typeof value !== "object" || value === null) return false;
  const color = (value: unknown): boolean => typeof value === "object" && value !== null
    && ["r", "g", "b"].every((key) => {
      const channel: unknown = Reflect.get(value, key);
      return typeof channel === "number" && Number.isInteger(channel) && channel >= 0 && channel <= 255;
    });
  const theme = value as TerminalDisplayTheme;
  return color(theme.foreground) && color(theme.background) && Array.isArray(theme.palette)
    && theme.palette.length === 16 && theme.palette.every(color);
}

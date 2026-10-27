/**
 * The UI strings the client asks for, as src/lib/i18n.test.ts checks the dictionaries against them,
 * and scripts/i18n-prune.ts drops the entries nothing asks for any more.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every string literal in the first argument of a `t(…)` / `tt(…)` call in the client, ternaries
 * included (`t(open ? "Hide" : "Show")`). A key built any other way is not allowed: label maps
 * are listed below instead.
 */
export function keysInCode(root: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: root })) {
    if (file.endsWith(".test.ts") || /i18n\.\w+\.ts$/.test(file)) continue;
    const text = readFileSync(join(root, file), "utf8");
    for (const match of text.matchAll(/(?<![\w.])(?:t|tt)\(/g)) {
      const firstArg = firstArgument(text, match.index + match[0].length);
      for (const literal of firstArg.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
        // a literal a condition compares against (`kind === "here" ? …`) is not shown to anyone
        if (/[=!]==?\s*$/.test(firstArg.slice(0, literal.index))) continue;
        const key = literal[1]!.replace(/\\"/g, '"').replace(/\\'/g, "'");
        found.set(key, [...(found.get(key) ?? []), file]);
      }
    }
  }
  return found;
}

/** The text of a call's first argument: up to the first comma or the closing paren at depth zero, strings and nesting respected. */
function firstArgument(text: string, from: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== null) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") { if (depth === 0) return text.slice(from, i); depth -= 1; }
    else if (ch === "," && depth === 0) return text.slice(from, i);
  }
  return text.slice(from);
}

/** Label maps the UI translates at the display site (`t(MAP[x])`): their values are keys too. */
export function labelMapKeys(root: string): string[] {
  const grab = (file: string, name: string, valuePattern: RegExp): string[] => {
    const text = readFileSync(join(root, file), "utf8");
    const start = text.indexOf(`const ${name}`);
    if (start < 0) throw new Error(`${name} not found in ${file}`);
    const end = text.indexOf("\n};", start) > 0 && (text.indexOf("\n];", start) < 0 || text.indexOf("\n};", start) < text.indexOf("\n];", start)) ? text.indexOf("\n};", start) : text.indexOf("\n];", start);
    return [...text.slice(start, end).matchAll(valuePattern)].flatMap((m) => m.slice(1).filter((v): v is string => v !== undefined));
  };
  const value = /^\s+\w+: "([^"]*)",?$/gm;
  return [
    ...grab("lib/status.ts", "STATUS_WORD", value),
    ...grab("components/MachineSidebar.tsx", "STATE_WORD", value),
    ...grab("components/DevicesPanel.tsx", "VIA", value),
    ...grab("components/SettingsDialog.tsx", "THEME_NAMES", /^\s+"?[\w-]+"?: "([^"]*)",?$/gm),
    ...grab("components/KeyBar.tsx", "ARROWS", /label: "([^"]+)"/g),
    ...grab("components/KeyBar.tsx", "KEY_SPOKEN_NAMES", /label: "([^"]+)"/g),
    ...grab("lib/shortcuts.ts", "SHORTCUTS", /label: "([^"]+)"/g),
    ...grab("lib/bridgeProgress.ts", "STAGES", /label: "([^"]+)"/g),
    ...grab("lib/updateProgress.ts", "STEPS", /label: "([^"]+)"/g),
  ];
}

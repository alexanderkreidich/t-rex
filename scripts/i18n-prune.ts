/**
 * Drops the dictionary entries no `t("…")` in src/ asks for any more, the ones
 * src/lib/i18n.test.ts reports as stale: run it after removing UI.
 *
 *   bun scripts/i18n-prune.ts           rewrite src/lib/i18n.{ja,ko,zh}.ts
 *   bun scripts/i18n-prune.ts --check   list what would go, change nothing
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keysInCode, labelMapKeys } from "./i18n-keys.ts";

const src = join(import.meta.dir, "..", "src");
const used = new Set([...keysInCode(src).keys(), ...labelMapKeys(src)]);
const check = process.argv.includes("--check");
const ENTRY = /^\s+("(?:[^"\\]|\\.)*"): "(?:[^"\\]|\\.)*",?$/;

let total = 0;
for (const language of ["ja", "ko", "zh"]) {
  const file = join(src, "lib", `i18n.${language}.ts`);
  const lines = readFileSync(file, "utf8").split("\n");
  const stale: string[] = [];
  const kept = lines.filter((line) => {
    const match = ENTRY.exec(line);
    if (!match) return true;
    const key = JSON.parse(match[1]!.replace(/\\'/g, "'")) as string;
    if (used.has(key)) return true;
    stale.push(key);
    return false;
  });
  total += stale.length;
  for (const key of stale) console.log(`${language}: ${key}`);
  if (!check && stale.length > 0) writeFileSync(file, kept.join("\n"));
}
console.log(`${total} stale entr${total === 1 ? "y" : "ies"}${check ? "" : " removed"}`);

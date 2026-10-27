import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import { chatFontStack, familyNames } from "./fontFamily.ts";

describe("terminal font families", () => {
  it("names each chosen family once, as Local Font Access looks it up: quotes off, generic families left out", () => {
    expect(familyNames('D2Coding, "Cascadia Mono", monospace')).toEqual(["D2Coding", "Cascadia Mono"]);
    expect(familyNames("")).toEqual([]);
    expect(familyNames("  , ")).toEqual([]);
  });

  it("never lets an unsanitized list through", () => {
    expect(familyNames("x; } body { color: red")).toEqual(["x body color: red"]);
  });

  it("keeps the app's bundled faces apart from the names a user types", () => {
    const sheets = ["../fonts/fonts.css", "../fonts/pretendard/pretendardvariable-dynamic-subset.css"].map((file) => readFileSync(new URL(file, import.meta.url), "utf8")).join("\n");
    const bundled = new Set([...sheets.matchAll(/font-family:\s*["']([^"']+)["']/g)].map((match) => match[1]!));
    expect([...bundled].sort()).toEqual(["JetBrains Mono Web", "Pretendard Variable"]);
    // the chat's and the chrome's code face takes it, after the icon font
    const mono = /--font-mono:\s*([^;]+);/.exec(readFileSync(new URL("../styles.css", import.meta.url), "utf8"))![1]!;
    expect(mono.startsWith('"Symbols Nerd Font Mono", "JetBrains Mono Web", ')).toBe(true);
    // and the interface is JetBrains Mono too, Pretendard behind it for Hangul and kana
    const ui = /--font-ui:\s*([^;]+);/.exec(readFileSync(new URL("../styles.css", import.meta.url), "utf8"))![1]!;
    expect(ui.startsWith('"JetBrains Mono Web", "Pretendard Variable", ')).toBe(true);
  });
});

describe("chat font stack", () => {
  it("keeps the UI font when nothing is typed", () => {
    expect(chatFontStack("")).toBeNull();
    expect(chatFontStack(" ")).toBeNull();
  });

  it("puts the typed list in front of the UI font", () => {
    expect(chatFontStack("Pretendard, Noto Sans KR")).toBe('Pretendard, "Noto Sans KR", var(--font-ui)');
  });
});

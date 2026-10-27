import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { keysInCode, labelMapKeys } from "../../scripts/i18n-keys.ts";
import { JA } from "./i18n.ja.ts";
import { KO } from "./i18n.ko.ts";
import { ZH } from "./i18n.zh.ts";
import { resolveLanguage, translate } from "./i18n.ts";

const DICTIONARIES = { Korean: KO, Japanese: JA, Chinese: ZH };

describe.each(Object.entries(DICTIONARIES))("%s dictionary", (_name, dictionary) => {
  const root = join(import.meta.dir, "..");
  const keys = new Set([...keysInCode(root).keys(), ...labelMapKeys(root)]);

  it("has every string the code asks for", () => {
    const missing = [...keys].filter((key) => !(key in dictionary)).sort();
    expect(missing).toEqual([]);
  });

  it("keeps no entry the code no longer uses", () => {
    const stale = Object.keys(dictionary).filter((key) => !keys.has(key)).sort();
    expect(stale).toEqual([]);
  });

  it("keeps every placeholder of the English in the translation", () => {
    const broken = Object.entries(dictionary).filter(([en, text]) => {
      const want = [...en.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      const have = [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      return want.join() !== have.join();
    }).map(([en]) => en);
    expect(broken).toEqual([]);
  });

  it("is not just the English repeated", () => {
    // names and key caps read the same in every language; Chinese UIs leave "Shell" and "Agent" in English;
    // theme brand names stay as their projects write them (the color words Amber and Charcoal are translated)
    const themeNames = ["Codex", "Catppuccin", "Catppuccin Latte", "Tokyo Night", "Tokyo Night Day", "Gruvbox", "Gruvbox Light", "One Dark", "One Light", "Solarized", "Solarized Light", "Kanagawa", "Kanagawa Lotus", "Rosé Pine", "Rosé Pine Dawn", "Dracula", "Nord", "Vesper"];
    const sameOnPurpose = new Set(["PC {name}", "Control C", "Control D", "Control Z", "Shift Tab", "Shell", "Agent", ...themeNames]);
    const same = Object.entries(dictionary).filter(([en, text]) => en === text && /[a-z]{3}/i.test(en) && !sameOnPurpose.has(en));
    expect(same.map(([en]) => en)).toEqual([]);
  });
});

describe("translate", () => {
  it("fills placeholders, falls back to English, and leaves unknown placeholders alone", () => {
    expect(translate("en", "Worked for {duration}", { duration: "7s" })).toBe("Worked for 7s");
    expect(translate("ko", "Worked for {duration}", { duration: "7초" })).toBe(KO["Worked for {duration}"]!.replace("{duration}", "7초"));
    expect(translate("ko", "not a key", { x: 1 })).toBe("not a key");
    expect(translate("ja", "Settings")).toBe(JA["Settings"]!);
    expect(translate("zh", "Settings")).toBe(ZH["Settings"]!);
    expect(translate("en", "{a} and {b}", { a: 1 })).toBe("1 and {b}");
  });

  it("follows the browser only when asked to", () => {
    expect(resolveLanguage("system", ["ko-KR", "en-US"])).toBe("ko");
    expect(resolveLanguage("system", ["en-US", "ko"])).toBe("en");
    expect(resolveLanguage("system", ["en-US"])).toBe("en");
    expect(resolveLanguage("system", [])).toBe("en");
    expect(resolveLanguage("en", ["ko-KR"])).toBe("en");
    expect(resolveLanguage("ko", ["en-US"])).toBe("ko");
    expect(resolveLanguage("system", ["ja-JP"])).toBe("ja");
    expect(resolveLanguage("system", ["en-US", "zh-CN", "ko"])).toBe("en");
    expect(resolveLanguage("system", ["zh-TW"])).toBe("zh");
    expect(resolveLanguage("ja", ["zh-CN"])).toBe("ja");
  });

  it("respects English priority regardless of region or later preferences", () => {
    expect(resolveLanguage("system", ["en-US", "ja-JP"])).toBe("en");
    expect(resolveLanguage("system", ["en-JP", "ja-JP"])).toBe("en");
    expect(resolveLanguage("system", ["EN", "ja-JP"])).toBe("en");
    expect(resolveLanguage("system", ["ja-JP", "en-US"])).toBe("ja");
    expect(resolveLanguage("system", ["zh-TW", "en-US"])).toBe("zh");
  });

  it("skips unsupported languages and falls back to English when none match", () => {
    expect(resolveLanguage("system", ["fr-FR", "en-US", "ja-JP"])).toBe("en");
    expect(resolveLanguage("system", ["fr-FR", "ja-JP", "en-US"])).toBe("ja");
    expect(resolveLanguage("system", ["fr-FR", "de-DE"])).toBe("en");
    expect(resolveLanguage("system", ["tr-TR", "en-US"])).toBe("en");
    expect(resolveLanguage("system", ["tr-TR"])).toBe("en");
  });
});

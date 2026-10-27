/**
 * The terminal's fonts for restty, all served by the bridge with the app (THIRD_PARTY_NOTICES.md),
 * never fetched from another host: JetBrains Mono in its four faces and the Nerd Font icons, then
 * the fallbacks for what those lack (symbols, arrows, emoji, CJK).
 *
 * restty measures the cell from the first face and loads the whole list before its first frame,
 * so the faces are fetched here at once and in parallel, and handed over as bytes: the session's
 * font store parses each buffer once and every later terminal finds it parsed. They are TrueType,
 * not WOFF2: a WOFF2 face is decompressed in JavaScript before it is parsed (60 ms for the
 * icons), while the bridge sends the TrueType files compressed anyway.
 *
 * The fallbacks are large (the CJK collection alone is 19 MB), so none delays a terminal: each is
 * fetched the first time a screen shows text it is for (`missingFallbacks`), and every terminal
 * then draws with it (`onFallbacks`).
 */
import type { ResttyFontInput, ResttyFontStyle } from "restty";
import { familyNames } from "../fontFamily.ts";
import regularUrl from "../../fonts/JetBrainsMono-Regular.ttf?url";
import boldUrl from "../../fonts/JetBrainsMono-Bold.ttf?url";
import italicUrl from "../../fonts/JetBrainsMono-Italic.ttf?url";
import boldItalicUrl from "../../fonts/JetBrainsMono-BoldItalic.ttf?url";
import symbolsUrl from "../../fonts/SymbolsNerdFont-Regular.ttf?url";
import symbols2Url from "../../fonts/NotoSansSymbols2-Regular.ttf?url";
import juliaUrl from "../../fonts/JuliaMono-Regular.ttf?url";
import openMojiUrl from "../../fonts/OpenMoji-black-glyf.ttf?url";
import cjkUrl from "../../fonts/NotoSansCJK-Regular.ttc?url";

interface Face {
  readonly url: string;
  /** restty tells faces apart by name: "Bold" and "Italic" pick the style, "Symbols Nerd Font"
   *  the icon handling, "OpenMoji" a colour emoji drawn with the system's emoji font, "CJK" two cells */
  readonly name: string;
  readonly weight?: number;
  readonly style?: ResttyFontStyle;
}

const BUNDLED: readonly Face[] = [
  { url: regularUrl, name: "JetBrains Mono Regular", weight: 400, style: "normal" },
  { url: boldUrl, name: "JetBrains Mono Bold", weight: 700, style: "normal" },
  { url: italicUrl, name: "JetBrains Mono Italic", weight: 400, style: "italic" },
  { url: boldItalicUrl, name: "JetBrains Mono Bold Italic", weight: 700, style: "italic" },
  // Ghostty's icon font: restty fits each icon to the cell by Nerd Fonts' own constraint table
  { url: symbolsUrl, name: "Symbols Nerd Font" },
];

/** The fallbacks, in restty's fallback order, with the text that asks for each. */
const FALLBACKS = {
  // arrows, technical and geometric shapes, dingbats: an agent's ⏺ ✻ ✳
  symbols: { face: { url: symbols2Url, name: "Noto Sans Symbols 2" }, needs: /[\u2190-\u2bff\u{1f000}-\u{1faff}]/u },
  // the arrows and technical symbols Symbols 2 lacks, monospaced and on the text's baseline: an agent's ⎿ ↳ ↵
  julia: { face: { url: juliaUrl, name: "JuliaMono" }, needs: /[\u2190-\u2bff]/u },
  emoji: { face: { url: openMojiUrl, name: "OpenMoji" }, needs: /\p{Extended_Pictographic}|[\u{1f1e6}-\u{1f1ff}]/u },
  cjk: {
    face: { url: cjkUrl, name: "Noto Sans CJK" },
    needs: /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}\u3000-\u303f\uff00-\uffef]/u,
  },
} as const satisfies Record<string, { face: Face; needs: RegExp }>;
export type FallbackName = keyof typeof FALLBACKS;
const ORDER = Object.keys(FALLBACKS) as FallbackName[];

/** The faces a chosen family is asked for: restty matches a local face by the style its name says. */
const STYLES: readonly { suffix: string; weight: number; style: ResttyFontStyle }[] = [
  { suffix: "Regular", weight: 400, style: "normal" },
  { suffix: "Bold", weight: 700, style: "normal" },
  { suffix: "Italic", weight: 400, style: "italic" },
  { suffix: "Bold Italic", weight: 700, style: "italic" },
];

/** A face as restty takes it, its bytes fetched; null when the bridge could not send it. */
async function fetchFace(face: Face): Promise<ResttyFontInput | null> {
  try {
    const response = await fetch(face.url);
    if (!response.ok) return null;
    const data = await response.arrayBuffer();
    return { data, name: face.name, ...(face.weight ? { weight: face.weight } : {}), ...(face.style ? { style: face.style } : {}) };
  } catch {
    return null;
  }
}

let bundled: Promise<ResttyFontInput[]> | null = null;

/** The bundled faces as bytes, fetched once per page; a face that fails to load is left out. */
export function bundledFonts(): Promise<ResttyFontInput[]> {
  bundled ??= Promise.all(BUNDLED.map(fetchFace)).then((faces) => faces.filter((face): face is ResttyFontInput => face !== null));
  return bundled;
}

/**
 * The terminal's own font list: the user's families first (installed fonts, through Local Font
 * Access; one the browser cannot reach is skipped), then the bundled faces, which also draw what a
 * chosen font lacks. The fallbacks loaded so far go after it (`fallbackFonts`).
 */
export async function terminalFonts(family: string): Promise<ResttyFontInput[]> {
  const chosen: ResttyFontInput[] = familyNames(family).flatMap((name) => STYLES.map(({ suffix, weight, style }) => ({
    family: name, local: "prefer" as const, name: `${name} ${suffix}`, weight, style,
  })));
  return [...chosen, ...await bundledFonts()];
}

const loaded = new Map<FallbackName, ResttyFontInput>();
/** asked for already: on its way, loaded, or failed (a failed one is not asked for again on this page) */
const asked = new Set<FallbackName>();
const listeners = new Set<() => void>();

/** The fallbacks loaded so far, in restty's fallback order. */
export function fallbackFonts(): ResttyFontInput[] {
  return ORDER.flatMap((name) => loaded.get(name) ?? []);
}

/** The fallbacks `text` (output for a screen) needs that nobody has asked for yet. */
export function missingFallbacks(text: string): FallbackName[] {
  if (asked.size === ORDER.length || !/[^\x00-\x7f]/.test(text)) return [];
  return ORDER.filter((name) => !asked.has(name) && FALLBACKS[name].needs.test(text));
}

/** Fetches fallbacks; once one is in, every terminal is told (onFallbacks) and draws with it. */
export function loadFallbacks(names: readonly FallbackName[]): void {
  for (const name of names) {
    if (asked.has(name)) continue;
    asked.add(name);
    void fetchFace(FALLBACKS[name].face).then((face) => {
      if (!face) return;
      loaded.set(name, face);
      for (const listener of [...listeners]) listener();
    });
  }
}

export function onFallbacks(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

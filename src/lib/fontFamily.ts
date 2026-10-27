/**
 * The terminal and chat font families the user types in Settings: a comma-separated list in
 * fallback order, like VS Code's `editor.fontFamily`. The list goes in front of the built-in
 * fonts, never in place of them, so a typo or a font missing on this device falls back as if
 * nothing had been typed: the chat's in CSS, the terminal's as installed faces restty loads
 * ahead of its bundled JetBrains Mono (lib/restty/fonts.ts).
 */

/** the chat's own stack: --font-ui in src/styles.css */
const CHAT_FONT_STACK = "var(--font-ui)";

export const FONT_FAMILY_MAX_CHARS = 200;

// what could close the declaration or the style element, escape, or hide in the value
const UNSAFE_CHARS = /[;{}<>\\\u0000-\u001f\u007f]/g;
const QUOTES = /["']/g;
// a name CSS reads unquoted: one identifier (non-ASCII letters included), no spaces
const IDENTIFIER = /^-?[A-Za-z_\u0080-￿][\w\u0080-￿-]*$/;
// unquoted, these are keywords rather than names and make the whole list invalid
const RESERVED = new Set(["inherit", "initial", "unset", "revert", "revert-layer", "default"]);
const GENERIC_FAMILIES = new Set(["monospace", "sans-serif", "serif", "system-ui", "ui-monospace", "ui-sans-serif", "ui-serif", "cursive", "fantasy", "emoji", "math"]);

function normalizeName(raw: string): string {
  const trimmed = raw.trim();
  const quoted = trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === "'") && trimmed.at(-1) === trimmed[0];
  // a stray quote inside a name would end the CSS string early: it cannot be part of a name
  const name = (quoted ? trimmed.slice(1, -1) : trimmed).replace(QUOTES, "").replace(/\s+/g, " ").trim();
  if (name === "") return "";
  // a name the user quoted stays quoted: "monospace" is a font called monospace, not the generic
  return quoted || !IDENTIFIER.test(name) || RESERVED.has(name.toLowerCase()) ? `"${name}"` : name;
}

/**
 * A typed family list as a CSS `font-family` value: composed (NFC), unsafe characters dropped,
 * each name trimmed, empty ones removed, names CSS cannot read bare quoted. Names past the length
 * limit are dropped whole, so a cut never leaves an open quote. Anything that is not a string is
 * no list at all.
 */
export function sanitizeFontFamily(value: unknown): string {
  if (typeof value !== "string") return "";
  // composed: a name copied from a macOS file name can arrive decomposed (NFD), and the browser
  // matches family names as written, so it would miss the installed font and fall back silently
  const names = value.normalize("NFC").replace(UNSAFE_CHARS, "").split(",").map(normalizeName).filter((name) => name !== "");
  let family = "";
  for (const name of names) {
    const next = family === "" ? name : `${family}, ${name}`;
    if (next.length > FONT_FAMILY_MAX_CHARS) break;
    family = next;
  }
  return family;
}

/** The names of a family list as sanitizeFontFamily writes it: quotes off, CSS generic families out (no font is called that). */
export function familyNames(family: string): string[] {
  return sanitizeFontFamily(family).split(",")
    .map((name) => name.trim().replace(/^"(.*)"$/, "$1"))
    .filter((name) => name !== "" && !GENERIC_FAMILIES.has(name.toLowerCase()));
}

/** The chat body's `font-family`, or null to keep the UI font. */
export function chatFontStack(family: string): string | null {
  const chosen = sanitizeFontFamily(family);
  return chosen === "" ? null : `${chosen}, ${CHAT_FONT_STACK}`;
}

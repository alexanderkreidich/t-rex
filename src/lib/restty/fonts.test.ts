import { afterAll, describe, expect, it } from "bun:test";
import { Font } from "text-shaper";
import { bundledFonts, fallbackFonts, loadFallbacks, missingFallbacks, onFallbacks } from "./fonts.ts";

// what agents print around their output: Claude Code's ⏺ ⎿ and spinner, Codex's and pi's ↳, key hints
const AGENT_GLYPHS = ["⎿", "↳", "↵", "⏺", "✳", "✻", "✽", "✢", "✶", "·", "⏵", "⏸", "✔", "✘", "❯", "⤷", "⟶", "⇡", "⇣"];

describe("terminal fonts", () => {
  const realFetch = globalThis.fetch;
  afterAll(() => { globalThis.fetch = realFetch; });

  it("draws every glyph an agent prints with the faces its output brings in", async () => {
    // the bridge serves the faces; under bun an asset URL is the file's path
    globalThis.fetch = (async (url: string) => new Response(Bun.file(url))) as unknown as typeof fetch;
    const text = AGENT_GLYPHS.join(" ");
    const names = missingFallbacks(text);
    const arrived = Promise.withResolvers<void>();
    const off = onFallbacks(() => { if (fallbackFonts().length === names.length) arrived.resolve(); });
    loadFallbacks(names);
    await arrived.promise;
    off();

    const faces = [...await bundledFonts(), ...fallbackFonts()].map((input) => Font.load((input as { data: ArrayBuffer }).data));
    const drawn = (glyph: string) => faces.some((face) => (face.glyphIdForChar(glyph) ?? 0) !== 0);
    expect(AGENT_GLYPHS.filter((glyph) => !drawn(glyph))).toEqual([]);
  });
});

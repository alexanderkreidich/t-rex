import { expect, it } from "bun:test";
import { paneCovered, PANE_COVER_SELECTOR } from "./panePresentation.ts";

/** Exercise the production selector with Bun's CSS selector engine, not a string assertion. */
async function covered(html: string): Promise<boolean> {
  let matched = false;
  await new HTMLRewriter().on(PANE_COVER_SELECTOR, { element() { matched = true; } })
    .transform(new Response(html)).text();
  return matched;
}

it("treats a dialog and a menu as covering the pane", async () => {
  expect(await covered('<div role="dialog"></div>')).toBe(true);
  expect(await covered('<div role="menu"><button role="menuitem">Item</button></div>')).toBe(true);
});

it("leaves a plain inline listbox uncovered", async () => {
  expect(await covered('<div role="listbox"></div>')).toBe(false);
});

it("ignores retained hidden covers without ignoring another presented dialog", () => {
  const before = Object.getOwnPropertyDescriptor(globalThis, "document");
  const beforeStyle = Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle");
  const nodes = [
    { closest: () => ({}), getClientRects: () => [{}], visibility: "visible" },
    { closest: () => null, getClientRects: () => [], visibility: "visible" },
    { closest: () => null, getClientRects: () => [{}], visibility: "hidden" },
  ];
  Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelectorAll: () => nodes } });
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: (node: { visibility: string }) => node });
  try {
    expect(paneCovered()).toBe(false);
    nodes.push({ closest: () => null, getClientRects: () => [{}], visibility: "visible" });
    expect(paneCovered()).toBe(true);
  } finally {
    if (before) Object.defineProperty(globalThis, "document", before);
    else Reflect.deleteProperty(globalThis, "document");
    if (beforeStyle) Object.defineProperty(globalThis, "getComputedStyle", beforeStyle);
    else Reflect.deleteProperty(globalThis, "getComputedStyle");
  }
});

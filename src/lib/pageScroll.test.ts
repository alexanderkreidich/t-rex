import { expect, it } from "bun:test";
import { pageScrollDistance } from "./pageScroll.ts";

it("retains overlap in native rows and computed chat pixels while always advancing", () => {
  expect(pageScrollDistance(24, 1, 1)).toBe(23);
  expect(pageScrollDistance(24, 1, 3)).toBe(21);
  expect(pageScrollDistance(24, 1, 0)).toBe(24);
  expect(pageScrollDistance(400, 24, 3)).toBe(328);
  expect(pageScrollDistance(400, 30, 3)).toBe(310);
  expect(pageScrollDistance(24, 1, 100)).toBe(1);
  expect(pageScrollDistance(10, 24, 1)).toBe(1);
});


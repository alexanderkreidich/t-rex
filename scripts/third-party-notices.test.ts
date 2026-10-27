import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";

it("keeps the original web client's MIT copyright and permission notice in the distributed notices", () => {
  const notices = readFileSync(new URL("../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8");
  expect(notices).toContain("Copyright (c) 2026 devswha");
  expect(notices).toContain("The above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.");
});

it("keeps Chromium's BSD notice for the icon drawn from Chrome's offline game", () => {
  const notices = readFileSync(new URL("../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8");
  expect(notices).toContain("Copyright 2015 The Chromium Authors");
  expect(notices).toContain("Neither the name of Google LLC nor the names of its\ncontributors may be used to endorse or promote products derived from\nthis software without specific prior written permission.");
});

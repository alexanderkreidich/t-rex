import { expect, it } from "bun:test";

import { branchWords, DETACHED } from "./paneBranch.ts";
import type { WorkspaceBranch } from "./worktreeBranches.ts";

const branch = (name: string | null, isDetached = false): WorkspaceBranch => ({ checkoutPath: "/repo", branch: name, isDetached });

it("says a checkout's branch, a detached head as such, and nothing where neither is known", () => {
  const words = branchWords(new Map([["w1", branch("fix/first-chat")], ["w2", branch(null, true)], ["w3", branch(null)], ["w4", branch("  ")]]));
  expect([...words]).toEqual([["w1", "fix/first-chat"], ["w2", DETACHED]]);
});

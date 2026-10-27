import { describe, expect, it } from "bun:test";

import { LaunchedAgents, STARTUP_MS } from "./launched-agents.ts";

describe("LaunchedAgents", () => {
  it("tells a pane it started an agent in, before its first turn, from any other", () => {
    const launched = new LaunchedAgents();
    launched.launched("w1:p1", "codex", 0);
    expect(launched.notBegun("w1:p1", undefined, 10)).toBe(true);
    expect(launched.notBegun("w1:p1", "done", 5_000)).toBe(true);
    expect(launched.notBegun("w1:p2", "idle", 10)).toBe(false);
  });

  it("takes the status of an agent not yet seen at rest for its startup's", () => {
    const launched = new LaunchedAgents();
    launched.launched("w1:p1", "codex", 0);
    expect(launched.notBegun("w1:p1", "working", 4_000)).toBe(true);
    launched.launched("w2:p1", "claude", 0);
    expect(launched.notBegun("w2:p1", "blocked", 4_000)).toBe(true);
  });

  it("ends with the first turn: at work or asking after it rested", () => {
    const launched = new LaunchedAgents();
    launched.launched("w1:p1", "codex", 0);
    expect(launched.notBegun("w1:p1", "idle", 5_000)).toBe(true);
    expect(launched.notBegun("w1:p1", "working", 6_000)).toBe(false);
    expect(launched.notBegun("w1:p1", "done", 60_000)).toBe(false);
  });

  it("takes an agent at work long after its launch for one on its first turn", () => {
    const launched = new LaunchedAgents();
    launched.launched("w1:p1", "opencode", 0);
    expect(launched.notBegun("w1:p1", "working", STARTUP_MS + 1)).toBe(false);
    expect(launched.notBegun("w1:p1", "idle", STARTUP_MS + 2)).toBe(false);
  });

  it("reads a start screen's working and done as rest, and the first turn's as they are", () => {
    const launched = new LaunchedAgents();
    launched.launched("w1:p1", "codex", 0);
    expect(launched.settle("w1:p1", "unknown", 500)).toBe("unknown");
    expect(launched.settle("w1:p1", "working", 4_000)).toBe("idle");
    expect(launched.settle("w1:p1", "done", 4_500)).toBe("idle");
    expect(launched.settle("w1:p1", "working", 9_000)).toBe("working");
    expect(launched.settle("w1:p1", "done", 12_000)).toBe("done");
  });

  it("keeps a question asked at the start, and every status of a pane it did not start", () => {
    const launched = new LaunchedAgents();
    launched.launched("w1:p1", "claude", 0);
    expect(launched.settle("w1:p1", "blocked", 4_000)).toBe("blocked");
    expect(launched.settle("w1:p1", "idle", 6_000)).toBe("idle");
    expect(launched.settle("w2:p1", "working", 4_000)).toBe("working");
    expect(launched.settle("w2:p1", "done", 4_500)).toBe("done");
  });

  it("takes no part in a kind whose start screen it does not know", () => {
    const launched = new LaunchedAgents();
    launched.launched("w1:p1", "muse", 0);
    expect(launched.notBegun("w1:p1", "idle", 10)).toBe(false);
    expect(launched.notBegun("w1:p1", "idle", 10)).toBe(false);
    launched.launched("w1:p2", "constructor", 0);
    expect(launched.notBegun("w1:p2", "idle", 10)).toBe(false);
  });

  it("forgets a pane that ended", () => {
    const launched = new LaunchedAgents();
    launched.launched("w1:p1", "claude", 0);
    launched.forget("w1:p1");
    expect(launched.notBegun("w1:p1", "idle", 40)).toBe(false);
  });
});

import { describe, expect, it } from "bun:test";

import { tabCloseAsks, tabPane } from "./tabs.ts";

const pane = (pane_id: string, focused = false) => ({ pane_id, focused });

describe("tabPane", () => {
  const own = [pane("p1"), pane("p2", true), pane("p3")];

  it("opens the pane last seen in the tab, then herdr's layout focus, then its focused mark, then the first", () => {
    expect(tabPane(own, "p3", "p1")?.pane_id).toBe("p3");
    expect(tabPane(own, null, "p1")?.pane_id).toBe("p1");
    expect(tabPane(own, undefined, undefined)?.pane_id).toBe("p2");
    expect(tabPane([pane("p1"), pane("p3")], null, null)?.pane_id).toBe("p1");
  });

  it("skips a remembered or focused pane the tab no longer holds", () => {
    expect(tabPane(own, "gone", "also-gone")?.pane_id).toBe("p2");
    expect(tabPane([], "p1", "p1")).toBeUndefined();
  });
});

describe("tabCloseAsks", () => {
  it("asks before the last tab takes its workspace with it", () => {
    expect(tabCloseAsks([{ agent_status: "idle" }], 1)).toBe(true);
  });

  it("asks while an agent in the tab works, waits on an answer or on its background work", () => {
    expect(tabCloseAsks([{ agent_status: "working" }], 2)).toBe(true);
    expect(tabCloseAsks([{ agent_status: "blocked" }], 2)).toBe(true);
    expect(tabCloseAsks([{ agent_status: "done", background_wait: true }], 2)).toBe(true);
  });

  it("closes a tab at rest at once", () => {
    expect(tabCloseAsks([{ agent_status: "idle" }, { agent_status: "done" }], 3)).toBe(false);
    expect(tabCloseAsks([{ agent_status: "unknown" }], 2)).toBe(false);
  });
});

import { describe, expect, it } from "bun:test";
import { loadSidebarPins, pinnedGroupIds, pinnedWorkspaceIds, reorderWorkspacePins, sidebarPinKey, splitPinnedGroups, toggleSidebarPin, workspacePinKey } from "./sidebarPins.ts";

describe("sidebar agent pins", () => {
  it("moves workspace pins in both directions without moving other pin slots", () => {
    const pins = ["pc:workspace:a", "pc:p1", "other:workspace:a", "pc:workspace:b", "pc:workspace:c"];
    expect(reorderWorkspacePins(pins, "pc", "a", "c")).toEqual(["pc:workspace:b", "pc:p1", "other:workspace:a", "pc:workspace:c", "pc:workspace:a"]);
    expect(reorderWorkspacePins(pins, "pc", "c", "a")).toEqual(["pc:workspace:c", "pc:p1", "other:workspace:a", "pc:workspace:a", "pc:workspace:b"]);
    expect(pins[0]).toBe("pc:workspace:a");
  });

  it("leaves pins alone for self drops and either unpinned endpoint", () => {
    const pins = ["pc:workspace:a", "pc:workspace:b"];
    for (const [source, target] of [["a", "a"], ["missing", "b"], ["a", "missing"]]) {
      expect(reorderWorkspacePins(pins, "pc", source!, target!)).toEqual(pins);
    }
  });

  it("keys a pin by PC and pane", () => {
    expect(sidebarPinKey("pc-a", "pane-1")).toBe("pc-a:pane-1");
    expect(sidebarPinKey("pc-b", "pane-1")).not.toBe(sidebarPinKey("pc-a", "pane-1"));
  });

  it("keys a workspace by PC", () => {
    expect(workspacePinKey("pc-a", "w1")).toBe("pc-a:workspace:w1");
    expect(pinnedWorkspaceIds(["pc-a:workspace:w2", "pc-a:w1:p1", "pc-b:workspace:w3", "pc-a:workspace:w1"], "pc-a")).toEqual(["w2", "w1"]);
  });

  it("toggles pins without changing the saved order of other pins", () => {
    expect(toggleSidebarPin(["a", "b"], "a")).toEqual(["b"]);
    expect(toggleSidebarPin(["a", "b"], "c")).toEqual(["a", "b", "c"]);
  });

  it("hoists only pinned rows and leaves a pinned head's worktrees in their group position", () => {
    const groups = [
      { workspace: "repo", children: ["wt1", "wt2"] },
      { workspace: "solo", children: [] },
      { workspace: "other", children: [] },
    ];
    const split = (ids: string[]) => splitPinnedGroups(groups, ids, (id) => id);
    expect(split([])).toEqual({ pinned: [], rest: groups });
    expect(split(["wt2", "other"])).toEqual({
      pinned: [{ workspace: "wt2", children: [] }, { workspace: "other", children: [] }],
      rest: [{ workspace: "repo", children: ["wt1"] }, { workspace: "solo", children: [] }],
    });
    expect(split(["repo", "wt1", "missing"])).toEqual({
      pinned: [{ workspace: "repo", children: [] }, { workspace: "wt1", children: [] }],
      rest: [{ workspace: "wt2", children: [] }, { workspace: "solo", children: [] }, { workspace: "other", children: [] }],
    });
  });

  it("keeps unpinned worktrees in order between the groups around their pinned head", () => {
    const groups = [
      { workspace: "before", children: [] },
      { workspace: "repo", children: ["wt1", "wt2"] },
      { workspace: "after", children: [] },
    ];
    expect(splitPinnedGroups(groups, ["repo"], (id) => id)).toEqual({
      pinned: [{ workspace: "repo", children: [] }],
      rest: [{ workspace: "before", children: [] }, { workspace: "wt1", children: [] }, { workspace: "wt2", children: [] }, { workspace: "after", children: [] }],
    });
    expect(splitPinnedGroups(groups, [], (id) => id)).toEqual({ pinned: [], rest: groups });
  });

  it("identifies a pinned repository's unpinned worktrees to keep fixed outside the card", () => {
    const groups = [
      { workspace: "repo", children: ["wt1", "wt2"] },
      { workspace: "solo", children: [] },
    ];
    expect([...pinnedGroupIds(groups, ["repo"], (id) => id)]).toEqual(["repo", "wt1", "wt2"]);
    expect([...pinnedGroupIds(groups, ["wt2"], (id) => id)]).toEqual(["wt2"]);
    expect(pinnedGroupIds(groups, [], (id) => id).size).toBe(0);
    expect(pinnedGroupIds([], ["missing"], (id: string) => id).size).toBe(0);
  });

  it("reorders pinned rows without moving their unpinned worktrees from the rest list", () => {
    const groups = [
      { workspace: "before", children: [] },
      { workspace: "repo", children: ["wt1", "wt2"] },
      { workspace: "after", children: [] },
    ];
    const pins = ["pc:workspace:repo", "pc:workspace:wt2", "pc:workspace:after"];
    const reordered = reorderWorkspacePins(pins, "pc", "repo", "after");
    const ids = pinnedWorkspaceIds(reordered, "pc");
    const shown = splitPinnedGroups(groups, ids, (id) => id);
    expect(shown.pinned).toEqual([
      { workspace: "wt2", children: [] },
      { workspace: "after", children: [] },
      { workspace: "repo", children: [] },
    ]);
    expect(shown.rest).toEqual([{ workspace: "before", children: [] }, { workspace: "wt1", children: [] }]);
    expect([...pinnedGroupIds(groups, ids, (id) => id)].filter((id) => !ids.includes(id))).toEqual(["wt1"]);
    expect(splitPinnedGroups(groups, ["wt2", "after"], (id) => id).rest).toEqual([
      { workspace: "before", children: [] },
      { workspace: "repo", children: ["wt1"] },
    ]);
  });

  it("starts with no pins when storage denies the read", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem() { throw new Error("denied"); } } });
    try { expect(loadSidebarPins()).toEqual([]); }
    finally {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});

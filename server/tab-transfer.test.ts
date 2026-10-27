import { describe, expect, it } from "bun:test";
import { paneTree, rebuildPlan } from "./tab-transfer.ts";

const pane = (pane_id: string, x: number, y: number, width: number, height: number) => ({ pane_id, focused: false, rect: { x, y, width, height } });
const split = (id: string, direction: string, ratio: number, x: number, y: number, width: number, height: number) => ({ id, direction, ratio, rect: { x, y, width, height } });

describe("a tab's split tree from herdr's layout snapshot", () => {
  it("reads a lone pane and a split inside a split", () => {
    expect(paneTree({ panes: [pane("a", 0, 0, 100, 40)], splits: [] })).toEqual({ pane: "a" });
    // a | (b over c)
    const tree = paneTree({
      panes: [pane("a", 0, 0, 30, 40), pane("b", 30, 0, 70, 20), pane("c", 30, 20, 70, 20)],
      splits: [split("split_0_root", "right", 0.3, 0, 0, 100, 40), split("split_1_1", "down", 0.5, 30, 0, 70, 40)],
    });
    expect(tree).toEqual({ direction: "right", ratio: 0.3, first: { pane: "a" }, second: { direction: "down", ratio: 0.5, first: { pane: "b" }, second: { pane: "c" } } });
    expect(rebuildPlan(tree!)).toEqual({ first: "a", splits: [
      { pane: "b", beside: "a", split: "right", ratio: 0.3 },
      { pane: "c", beside: "b", split: "down", ratio: 0.5 },
    ] });
  });

  it("tells a | (b | c) from (a | b) | c by the ratio of the split over them", () => {
    const panes = [pane("a", 0, 0, 33, 40), pane("b", 33, 0, 33, 40), pane("c", 66, 0, 34, 40)];
    const right = paneTree({ panes, splits: [split("split_0_root", "right", 0.33, 0, 0, 100, 40), split("split_1_1", "right", 0.5, 33, 0, 67, 40)] });
    expect(right).toEqual({ direction: "right", ratio: 0.33, first: { pane: "a" }, second: { direction: "right", ratio: 0.5, first: { pane: "b" }, second: { pane: "c" } } });
    const left = paneTree({ panes, splits: [split("split_0_root", "right", 0.66, 0, 0, 100, 40), split("split_1_0", "right", 0.5, 0, 0, 66, 40)] });
    expect(left).toEqual({ direction: "right", ratio: 0.66, first: { direction: "right", ratio: 0.5, first: { pane: "a" }, second: { pane: "b" } }, second: { pane: "c" } });
    // c first takes its third beside a, then b halves what a still holds
    expect(rebuildPlan(left!).splits).toEqual([
      { pane: "c", beside: "a", split: "right", ratio: 0.66 },
      { pane: "b", beside: "a", split: "right", ratio: 0.5 },
    ]);
  });

  it("cuts across a gap between the sides, and gives up on a layout it cannot place", () => {
    const panes = [pane("a", 0, 0, 49, 40), pane("b", 50, 0, 50, 40)];
    expect(paneTree({ panes, splits: [split("split_0_root", "right", 0.5, 0, 0, 100, 40)] })).toEqual({ direction: "right", ratio: 0.5, first: { pane: "a" }, second: { pane: "b" } });
    expect(paneTree({ panes, splits: [split("split-root", "right", 0.5, 0, 0, 100, 40)] })).toBeNull();
    expect(paneTree({ panes, splits: [split("split_0_root", "down", 0.5, 0, 0, 100, 40)] })).toBeNull();
    expect(paneTree({ panes, splits: [] })).toBeNull();
  });
});

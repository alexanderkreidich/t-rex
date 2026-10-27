import { describe, expect, it } from "bun:test";
import { adjacentTabBoundary, liftRow, liftShift, movedTabOrder, nearestSlot, tabDropBoundary, type RowSlot } from "./tabOrder.ts";

describe("native tab insertion boundaries", () => {
  const ids = ["a", "b", "c", "d"];
  it("moves in both directions, including the first and last gaps", () => {
    expect(movedTabOrder(ids, "a", 4)).toEqual(["b", "c", "d", "a"]);
    expect(movedTabOrder(ids, "d", 0)).toEqual(["d", "a", "b", "c"]);
    expect(movedTabOrder(ids, "b", 3)).toEqual(["a", "c", "b", "d"]);
    expect(movedTabOrder(ids, "c", 1)).toEqual(["a", "c", "b", "d"]);
    expect(ids).toEqual(["a", "b", "c", "d"]);
  });
  it("ignores both gaps beside the source and refuses stale sources/invalid boundaries", () => {
    for (const index of [1, 2, -1, 5, 1.5, NaN]) expect(movedTabOrder(ids, "b", index)).toBeNull();
    expect(movedTabOrder(ids, "closed", 0)).toBeNull();
    expect(movedTabOrder([], "a", 0)).toBeNull();
  });
  it("keyboard and touch moves share the native coordinates without wrapping", () => {
    expect(adjacentTabBoundary(ids, "b", -1)).toBe(0);
    expect(adjacentTabBoundary(ids, "b", 1)).toBe(3);
    expect(adjacentTabBoundary(ids, "a", -1)).toBeNull();
    expect(adjacentTabBoundary(ids, "d", 1)).toBeNull();
    expect(adjacentTabBoundary(ids, "closed", 1)).toBeNull();
  });
  it("uses each tab midpoint, including clipped tabs in a scrolled strip", () => {
    const rects = [{ left: -80, right: 20 }, { left: 24, right: 144 }, { left: 148, right: 208 }];
    expect(tabDropBoundary(rects, -90)).toBe(0);
    expect(tabDropBoundary(rects, 0)).toBe(1);
    expect(tabDropBoundary(rects, 85)).toBe(2);
    expect(tabDropBoundary(rects, 208)).toBe(3);
  });
});

describe("a tab row lifted out of the sidebar's column", () => {
  // api: rows from 0 (a2 has no row of its own, a3 is drawn third); web: a header further down; infra: one tab
  const columns = [
    { workspaceId: "api", top: 0, rows: [{ tabId: "a0", index: 0, top: 0, bottom: 30 }, { tabId: "a1", index: 1, top: 30, bottom: 60 }, { tabId: "a3", index: 3, top: 60, bottom: 90 }] },
    { workspaceId: "web", top: 128, rows: [{ tabId: "w0", index: 0, top: 128, bottom: 158 }, { tabId: "w1", index: 1, top: 158, bottom: 188 }] },
    { workspaceId: "infra", top: 226, rows: [{ tabId: "i0", index: 0, top: 226, bottom: 256 }] },
  ];
  const at = (slots: RowSlot[], workspaceId: string, boundary: number): RowSlot => slots.find((slot) => slot.workspaceId === workspaceId && slot.boundary === boundary)!;

  it("closes the rows up under it, and offers every place where they would stand with it gone", () => {
    const lift = liftRow(columns, "a0", false)!;
    expect(lift.slots.map(({ workspaceId, boundary, final, y, home }) => [workspaceId, boundary, final, y, home])).toEqual([
      ["api", 0, 0, 0, true], ["api", 2, 1, 30, false], ["api", 4, 3, 60, false],
      ["web", 0, 0, 98, false], ["web", 1, 1, 128, false], ["web", 2, 2, 158, false],
      ["infra", 0, 0, 196, false], ["infra", 1, 1, 226, false],
    ]);
    // its top just past a1's middle: below a1
    expect(nearestSlot(lift.slots, 16)).toBe(at(lift.slots, "api", 2));
    expect(nearestSlot(lift.slots, 120)).toBe(at(lift.slots, "web", 1));
    expect(nearestSlot([], 0)).toBeNull();
  });

  it("opens the slot it is over and moves the rest back where they were", () => {
    const lift = liftRow(columns, "a0", false)!;
    // over its own place: nothing moves
    for (const top of [30, 60, 94, 128, 226]) expect(liftShift(top, lift, at(lift.slots, "api", 0))).toBe(0);
    // below a1: a1 comes up, the rest stay
    expect(liftShift(30, lift, at(lift.slots, "api", 2))).toBe(-30);
    expect(liftShift(60, lift, at(lift.slots, "api", 2))).toBe(0);
    // into web, before w1: api's rows and web's name and w0 come up, w1 on stays
    expect([60, 94, 128, 158, 226].map((top) => liftShift(top, lift, at(lift.slots, "web", 1)))).toEqual([-30, -30, -30, 0, 0]);
    // dropped nowhere: the rows close up
    expect(liftShift(158, lift, null)).toBe(-30);
  });

  it("keeps a workspace's last tab's place open, and pushes the rows down where it goes", () => {
    const lift = liftRow(columns, "i0", true)!;
    expect(lift.slots.filter((slot) => slot.home).map((slot) => [slot.workspaceId, slot.boundary])).toEqual([["infra", 0], ["infra", 1]]);
    expect(at(lift.slots, "web", 0).y).toBe(128);
    expect(liftShift(256, lift, at(lift.slots, "infra", 1))).toBe(0);
    expect([0, 30, 60, 128].map((top) => liftShift(top, lift, at(lift.slots, "api", 1)))).toEqual([0, 30, 30, 30]);
    expect(liftRow(columns, "gone", false)).toBeNull();
  });
});

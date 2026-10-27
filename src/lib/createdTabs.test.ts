import { expect, it } from "bun:test";
import type { Machine } from "../../shared/machines.ts";
import type { SessionSnapshot, TabCreated } from "../../shared/protocol.ts";
import { CreatedTabs } from "./createdTabs.ts";

const roster = (): Machine[] => [{ id: "local", name: "Local", kind: "local", enabled: true, state: "connected", error: null,
  snapshot: { workspaces: [{ workspace_id: "w1", tab_count: 1 }], tabs: [{ tab_id: "t1" }], panes: [{ pane_id: "p1" }] } as unknown as SessionSnapshot,
}];
const created = (id = "2"): TabCreated => ({ workspace_id: "w1", pane_id: `p${id}`, agent_started: false,
  tab: { tab_id: `t${id}`, workspace_id: "w1" } as TabCreated["tab"],
  pane: { pane_id: `p${id}`, workspace_id: "w1", tab_id: `t${id}` } as TabCreated["pane"],
});

it("keeps an authoritative creation mounted across stale HTTP and SSE rosters", () => {
  const pending = new CreatedTabs();
  pending.add("local", created());
  for (let i = 0; i < 3; i++) {
    const applied = pending.apply(roster());
    expect(applied[0]!.snapshot!.panes.map((pane) => pane.pane_id)).toEqual(["p1", "p2"]);
    expect(applied[0]!.snapshot!.workspaces[0]!.tab_count).toBe(2);
  }
  const acknowledged = pending.apply(roster());
  expect(pending.apply(acknowledged)).toEqual(acknowledged);
  // Once acknowledged, a later roster can close the tab normally.
  const closed = roster();
  expect(pending.apply(closed)).toBe(closed);
});

it("keeps concurrent creations distinct and does not increment a known tab twice", () => {
  const pending = new CreatedTabs();
  pending.add("local", created());
  pending.add("local", created("3"));
  const applied = pending.apply(roster());
  expect(applied[0]!.snapshot!.workspaces[0]!.tab_count).toBe(3);
  expect(pending.apply(applied)[0]!.snapshot!.tabs).toHaveLength(3);
});

it("forgets exited panes, expires unacknowledged creations and tolerates old bridges", () => {
  let now = 0;
  const pending = new CreatedTabs(() => now);
  pending.add("local", { workspace_id: "w1", pane_id: "old-bridge", agent_started: false });
  expect(pending.apply(roster())[0]!.snapshot!.panes).toHaveLength(1);
  pending.add("local", created());
  pending.forget("local", "p2");
  expect(pending.apply(roster())[0]!.snapshot!.panes).toHaveLength(1);
  pending.add("local", created());
  now = 10_001;
  expect(pending.apply(roster())[0]!.snapshot!.panes).toHaveLength(1);
});

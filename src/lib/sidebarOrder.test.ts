import { describe, expect, it } from "bun:test";
import type { AgentStatus, HerdrPane } from "../../shared/protocol.ts";
import machines from "../../demo/fixtures/machines.json";
import { isSeenDone, markSeen, shownStatus } from "./sidebarOrder.ts";
import { DEFAULT_SETTINGS, sanitizeSettings } from "./settings.ts";

const template = machines.machines[0]!.snapshot!;
const pane = (id: string, agent_status: AgentStatus, finish_id?: number): HerdrPane =>
  ({ ...template.panes[0]!, pane_id: id, agent_status, finish_id });

describe("opened finish identity", () => {
  it("accepts stale lower finish ids within the epoch, never future or absent ids", () => {
    expect(isSeenDone(pane("a", "done", 2), { a: 2 })).toBe(true);
    expect(isSeenDone(pane("a", "done", 1), { a: 2 })).toBe(true);
    for (const id of [undefined, 0, 3]) expect(isSeenDone(pane("a", "done", id), { a: 2 })).toBe(false);
    expect(isSeenDone(pane("a", "done", 2), {})).toBe(false);
  });

  it("never draws working, blocked, or question as ready and keeps background-wait precedence", () => {
    for (const status of ["working", "blocked", "question"] as const) {
      expect(shownStatus(pane("a", status, 2), { a: 2 })).toBe(status);
    }
    expect(shownStatus({ ...pane("a", "done", 2), background_wait: true }, { a: 2 })).toBe("waiting");
    expect(shownStatus({ ...pane("a", "blocked", 2), background_wait: true }, { a: 2 })).toBe("blocked");
    expect(shownStatus(pane("a", "done", 2), { a: 2 })).toBe("idle");
  });

  it("keeps the maximum without changing a record that already has it", () => {
    const record = { a: 3 };
    expect(markSeen(record, "a", 2)).toBe(record);
    expect(markSeen(record, "a", 3)).toBe(record);
    expect(markSeen(record, "a", 4)).toEqual({ a: 4 });
  });
});

it("defaults to herdr's order and accepts only known settings", () => {
  expect(DEFAULT_SETTINGS.agentOrder).toBe("workspace");
  expect(sanitizeSettings({ agentOrder: "activity" })).toMatchObject({ agentOrder: "activity" });
  expect(sanitizeSettings({ agentOrder: "recent" })).toMatchObject({ agentOrder: "workspace" });
});

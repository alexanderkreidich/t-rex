import { describe, expect, it } from "bun:test";
import { seedStatuses } from "./statusBaseline.ts";
import { shouldNotifyStatus } from "../../shared/notify-policy.ts";
import type { AgentStatus } from "../../shared/protocol.ts";

describe("seedStatuses", () => {
  const roster = (...panes: Array<[string, AgentStatus]>) => [{ id: "local", snapshot: { panes: panes.map(([pane_id, agent_status]) => ({ pane_id, agent_status })) } }];

  it("leaves news to its status event: a roster that shows the wait or the finish first does not make the event old news", () => {
    const known = new Map<string, AgentStatus>();
    seedStatuses(known, roster(["p1", "idle"], ["p2", "idle"]));
    known.set("p1", "working");
    known.set("p2", "working");
    // the roster is read from herdr on its own and can show a change before its event arrives
    seedStatuses(known, roster(["p1", "blocked"], ["p2", "done"]));
    expect(shouldNotifyStatus(known.get("p1"), "blocked")).toBe(true);
    expect(shouldNotifyStatus(known.get("p2"), "done")).toBe(true);
  });

  it("catches up after lost events: a pane the roster shows back at work waits anew, which is news", () => {
    const known = new Map<string, AgentStatus>([["p1", "blocked"]]);
    // answered while no event arrived: the roster is all that says so
    seedStatuses(known, roster(["p1", "working"]));
    expect(shouldNotifyStatus(known.get("p1"), "blocked")).toBe(true);
    seedStatuses(known, roster(["p1", "idle"]));
    expect(known.get("p1")).toBe("idle");
  });

  it("takes a pane first seen as it is: no news", () => {
    const known = new Map<string, AgentStatus>();
    seedStatuses(known, roster(["p1", "blocked"]));
    expect(known.get("p1")).toBe("blocked");
    expect(shouldNotifyStatus(known.get("p1"), "blocked")).toBe(false);
  });

  it("forgets a pane no PC lists any more, on each PC by its own id", () => {
    const known = new Map<string, AgentStatus>();
    seedStatuses(known, [...roster(["p1", "blocked"]), { id: "pc-2", snapshot: { panes: [{ pane_id: "p1", agent_status: "working" as AgentStatus }] } }]);
    expect(known.size).toBe(2);
    // p1 closed on this PC; the other PC is offline and lists nothing
    seedStatuses(known, [{ id: "local", snapshot: { panes: [] } }, { id: "pc-2", snapshot: null }]);
    expect(known.size).toBe(0);
    seedStatuses(known, roster(["p1", "idle"]));
    expect(known.get("p1")).toBe("idle");
  });
});

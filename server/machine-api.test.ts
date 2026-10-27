import { describe, expect, it } from "bun:test";
import type { MachineEvent } from "../shared/protocol.ts";
import { handleMachineRequest } from "./machine-api.ts";
import type { MachineManager } from "./machines.ts";

describe("the machine event stream", () => {
  it("sends a page the roster only when it changed since the last one it got", async () => {
    let listener: ((event: MachineEvent) => void) | null = null;
    const manager = { subscribe: (next: (event: MachineEvent) => void) => { listener = next; return () => { listener = null; }; } } as unknown as MachineManager;
    const abort = new AbortController();
    const response = await handleMachineRequest(new Request("http://127.0.0.1/api/machines/events", { signal: abort.signal }), manager);
    const reader = response.body!.getReader();
    const roster = (state: string): MachineEvent => ({ type: "machines", machines: [{ id: "local", name: "pc", kind: "local", enabled: true, state, error: null, snapshot: null }] } as MachineEvent);
    listener!(roster("connected"));
    listener!(roster("connected"));
    listener!({ type: "machine-message", machine_id: "local", message: { type: "session-changed" } } as MachineEvent);
    listener!(roster("connected"));
    listener!(roster("error"));
    abort.abort();
    let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    const sent = text.split("\n\n").filter((frame) => frame.startsWith("data: ")).map((frame) => JSON.parse(frame.slice(6)) as MachineEvent);
    expect(sent.map((event) => event.type === "machines" ? event.machines[0]!.state : event.type)).toEqual(["connected", "machine-message", "error"]);
  });
});

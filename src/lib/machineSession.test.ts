import { describe, expect, it } from "bun:test";
import type { ServerMessage } from "../../shared/protocol.ts";
import { MachineSession, MachineSessionRegistry } from "./machineSession.ts";
import type { HerdrSocket } from "./ws.ts";
class FakeSocket {
  connected = false;
  connects = 0;
  closes = 0;
  private readonly handlers = new Set<(message: ServerMessage) => void>();
  private readonly disconnects = new Set<() => void>();
  on(handler: (message: ServerMessage) => void): () => void {
    this.handlers.add(handler); return () => { this.handlers.delete(handler); };
  }
  onDisconnect(handler: () => void): () => void {
    this.disconnects.add(handler); return () => { this.disconnects.delete(handler); };
  }
  connect(): void { this.connects++; this.connected = true; }
  close(): void { this.closes++; this.connected = false; this.handlers.clear(); this.disconnects.clear(); }
  receive(message: ServerMessage): void { for (const handler of this.handlers) handler(message); }
  disconnect(): void { this.connected = false; for (const handler of this.disconnects) handler(); }
}

const snapshot: ServerMessage = { type: "snapshot", features: ["submit"], snapshot: { version: "test", protocol: 22, workspaces: [], tabs: [], panes: [], agents: [], layouts: [] } };
function setup(machineId = "local") {
  const socket = new FakeSocket();
  const session = new MachineSession(machineId, { socket: socket as unknown as HerdrSocket });
  return { session, socket };
}
function start(session: MachineSession, socket: FakeSocket): void { session.connect(); socket.receive(snapshot); }

describe("PC connection ownership", () => {
  it("creates no network connection until explicitly connected and replays only the current role", () => {
    const { session, socket } = setup();
    expect(socket.connects).toBe(0);
    start(session, socket);
    socket.receive({ type: "role-ack", mode: "observe" });
    socket.receive({ type: "pty-data", pane_id: "w1:p1", data: "private output" });
    const events: ServerMessage[] = [];
    const off = session.on((frame) => events.push(frame));
    expect(events).toEqual([{ type: "role-ack", mode: "observe" }]);
    off();
    socket.disconnect();
    session.on((frame) => events.push(frame));
    expect(events).toHaveLength(1);
    session.close();
  });

  it("closes only the PC a registry no longer retains", () => {
    const sessions = new Map<string, ReturnType<typeof setup>>();
    const registry = new MachineSessionRegistry((machineId) => {
      const item = setup(machineId); sessions.set(machineId, item); return item.session;
    });
    const local = registry.get("local"), remote = registry.get("remote");
    expect(registry.get("local")).toBe(local);
    start(local, sessions.get("local")!.socket);
    start(remote, sessions.get("remote")!.socket);
    registry.retainMachines(new Set(["remote"]));
    expect(sessions.get("local")!.socket.closes).toBe(1);
    expect(sessions.get("remote")!.socket.closes).toBe(0);
    registry.closeAll();
  });

  it("closeAll is reusable after an effect restart", () => {
    const made: ReturnType<typeof setup>[] = [];
    const registry = new MachineSessionRegistry((machineId) => {
      const item = setup(machineId); made.push(item); return item.session;
    });
    const old = registry.get("local");
    start(old, made[0]!.socket);
    registry.closeAll();
    registry.closeAll();
    expect(made[0]!.socket.closes).toBe(1);
    const next = registry.get("local");
    expect(next).not.toBe(old);
    expect(made[1]!.socket.connects).toBe(0);
    start(next, made[1]!.socket);
    expect(made[1]!.socket.connects).toBe(1);
    registry.closeAll();
  });
});

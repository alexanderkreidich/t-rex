import type { ServerMessage } from "../../shared/protocol.ts";
import { watchPageInUse } from "./presence.ts";
import { HerdrSocket } from "./ws.ts";

type Handler = (message: ServerMessage) => void;
type RoleAck = Extract<ServerMessage, { type: "role-ack" }>;
export interface MachineSessionOptions {
  socket?: HerdrSocket;
}

/** A PC's connection outlives its pane views: detaching a view releases its input lease, and the
 * connection stays for the next view on that PC. */
export class MachineSession {
  readonly socket: HerdrSocket;
  private role: RoleAck | null = null;
  private readonly handlers = new Set<Handler>();
  private readonly offMessage: () => void;
  private readonly offDisconnect: () => void;
  private readonly offPresence: () => void;
  private closed = false;

  constructor(readonly machineId: string, options: MachineSessionOptions = {}) {
    this.socket = options.socket ?? new HerdrSocket(`${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws?machine_id=${encodeURIComponent(machineId)}`);
    // Installed before view subscribers, and kept even while this PC has no mounted pane.
    this.offMessage = this.socket.on((message) => {
      if (this.closed) return;
      if (message.type === "role-ack") this.role = message;
      for (const handler of this.handlers) handler(message);
    });
    this.offDisconnect = this.socket.onDisconnect(() => { this.role = null; });
    this.offPresence = watchPageInUse((active) => this.socket.setPresence(active));
  }

  on(handler: Handler): () => void {
    if (this.closed) return () => {};
    this.handlers.add(handler);
    // A pane mounted on an existing connection must honor an enforced observe role.
    // Snapshots and terminal bytes are never replayed from a browser-owned cache.
    if (this.role !== null) handler(this.role);
    return () => { this.handlers.delete(handler); };
  }

  onDisconnect(handler: () => void): () => void { return this.socket.onDisconnect(handler); }
  connect(): void { if (!this.closed) this.socket.connect(); }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.role = null;
    this.offMessage();
    this.offDisconnect();
    this.offPresence();
    this.handlers.clear();
    this.socket.close();
  }
}

/** Owned by the unlocked app, outside its PC-keyed canvas. Clearing it is reusable for
 * React's effect restart; selecting another PC does not close any existing connection. */
export class MachineSessionRegistry {
  private readonly sessions = new Map<string, MachineSession>();
  constructor(private readonly makeSession: (machineId: string) => MachineSession = (machineId) => new MachineSession(machineId)) {}

  get(machineId: string): MachineSession {
    let session = this.sessions.get(machineId);
    if (!session) { session = this.makeSession(machineId); this.sessions.set(machineId, session); }
    return session;
  }

  retainMachines(machineIds: ReadonlySet<string>): void {
    for (const [machineId, session] of this.sessions) {
      if (machineIds.has(machineId)) continue;
      this.sessions.delete(machineId);
      session.close();
    }
  }

  closeAll(): void {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) session.close();
  }
}

import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paneAgentOf, resolveAgent } from "./pane-context.ts";

// The real RPC client against a unix socket this test owns; only herdr's answers are synthetic.
let root: string;
let listener: ReturnType<typeof Bun.listen>;
let socketBefore: string | undefined;
let panes: Record<string, { agent?: string; process: { pid: number; argv: string[]; cwd: string }[] }>;

const paneInfo = (id: string) => ({
  pane_id: id, workspace_id: "w", tab_id: "w:t1", terminal_id: id, cwd: root, focused: false, revision: 0,
  ...(panes[id]?.agent ? { agent: panes[id]!.agent } : {}),
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t-rex-pane-routes-"));
  panes = {};
  socketBefore = process.env["HERDR_SOCKET"];
  const socket = join(root, "herdr.sock");
  process.env["HERDR_SOCKET"] = socket;
  listener = Bun.listen<{ buffer: string }>({
    unix: socket,
    socket: {
      open(socket) { socket.data = { buffer: "" }; },
      data(socket, chunk) {
        socket.data.buffer += chunk.toString();
        if (!socket.data.buffer.includes("\n")) return;
        const request = JSON.parse(socket.data.buffer) as { id: string; method: string; params?: { pane_id?: string } };
        const id = request.params?.pane_id ?? "";
        const result = request.method === "pane.get" ? { pane: paneInfo(id) }
          : request.method === "pane.process_info" ? { process_info: { foreground_processes: panes[id]?.process ?? [] } }
          : request.method === "session.snapshot" ? { snapshot: { panes: Object.keys(panes).map(paneInfo), agents: [] } }
          : null;
        if (result === null) throw new Error(`unexpected RPC ${request.method}`);
        socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
      },
    },
  });
});

afterEach(() => {
  listener.stop(true);
  if (socketBefore === undefined) delete process.env["HERDR_SOCKET"];
  else process.env["HERDR_SOCKET"] = socketBefore;
  rmSync(root, { recursive: true, force: true });
});

const OMO_PROCESS = { pid: 2147483647, argv: ["omo"], cwd: "" };

it("types into an omo pane that herdr labels pi as pi until omo holds a session", async () => {
  panes["w:p1"] = { agent: "pi", process: [{ ...OMO_PROCESS, cwd: root }] };
  panes["w:p2"] = { agent: "pi", process: [{ pid: 2147483646, argv: ["/usr/bin/pi"], cwd: root }] };
  // typing needs omo's own holder record: an argv alone keeps herdr's label
  expect(await paneAgentOf("w:p1")).toBe("pi");
  // an ordinary pi stays pi
  expect(await paneAgentOf("w:p2")).toBe("pi");
});

it("resolves a pane with no agent to null", async () => {
  panes["w:p3"] = { process: [] };
  expect(await paneAgentOf("w:p3")).toBeNull();
});

it("names an omo pane omo whatever herdr's label says, and a session report's agent where the label is absent", () => {
  const pane = (agent: string) => ({ agent }) as never;
  expect(resolveAgent(pane("claude"), null)).toEqual({ agent: "claude" });
  expect(resolveAgent(pane("claude"), { omo: { agentDir: null, pluginDir: null } })).toEqual({ agent: "omo" });
  expect(resolveAgent({ agent_session: { agent: "codex" } } as never, null).agent).toBe("codex");
  expect(resolveAgent({} as never, null)).toEqual({ agent: null });
});

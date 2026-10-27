import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { herdrRpc, paneSendText, paneSendKeys } from "./herdr/client.ts";
import { applyDiff, frameText, PLAIN_STYLE, type Frame, type FrameDiff, type Style } from "../shared/ssp.ts";
import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-output-contract-"));
const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: root });
const workspaces: string[] = [];
const sockets: WebSocket[] = [];
afterAll(async () => {
  for (const socket of sockets) socket.close();
  server.stop();
  for (const workspace of workspaces) await herdrRpc("workspace.close", { workspace_id: workspace });
  rmSync(root, { recursive: true, force: true });
});

async function until(check: () => boolean, label: string, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(10);
  }
}

async function pane(): Promise<string> {
  const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
    "workspace.create", { label: "t-rex-test-output", cwd: root, focus: false },
  );
  workspaces.push(created.workspace.workspace_id);
  return created.root_pane.pane_id;
}

async function connect(paneId: string, ack = true, observer = false, port = server.port, sync = true, resume?: { stream: string; num: number }) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  sockets.push(ws);
  const styles = new Map<number, Style>([[0, PLAIN_STYLE]]);
  const state = {
    frames: 0, ack, code: 0, exits: 0,
    errors: [] as string[],
    /** the raw stream's tail (an older page), or the synced screen's text */
    tail: "",
    screen: null as Frame | null,
    diffs: [] as FrameDiff[],
    /** the newest input of ours the program has had time to echo */
    echo: 0,
  };
  const send = (message: ClientMessage) => ws.send(JSON.stringify(message));
  const frames = new Map<number, Frame>();
  let stream: string | null = null;
  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as ServerMessage;
    if (frame.type === "error") state.errors.push(frame.code);
    if (frame.type === "pty-exit" && frame.pane_id === paneId) state.exits++;
    if (frame.type === "pty-data" && frame.pane_id === paneId) {
      state.frames++;
      state.tail = (state.tail + frame.data).slice(-8192);
    }
    if (frame.type !== "ssp" || frame.pane_id !== paneId) return;
    const { type: _type, pane_id: _pane, ...diff } = frame;
    state.diffs.push(diff);
    if (state.ack && ws.readyState === WebSocket.OPEN && diff.base !== 0 && !frames.has(diff.base) && diff.stream !== stream) send({ type: "ssp-ack", pane_id: paneId, stream: diff.stream, num: diff.base });
    if (diff.stream !== stream) {
      frames.clear();
      stream = diff.stream;
    }
    const base = diff.base === 0 ? null : frames.get(diff.base) ?? null;
    if (diff.base !== 0 && !base) return;
    const next = applyDiff(base, diff, styles);
    frames.set(next.num, next);
    state.frames++;
    state.screen = next;
    state.echo = Math.max(state.echo, diff.echo);
    state.tail = frameText(next).join("\n");
    if (state.ack && ws.readyState === WebSocket.OPEN) send({ type: "ssp-ack", pane_id: paneId, stream: diff.stream, num: next.num });
  });
  ws.addEventListener("close", (event) => { state.code = event.code; });
  await until(() => ws.readyState === WebSocket.OPEN, "socket open");
  if (observer) send({ type: "role", mode: "observe" });
  send({ type: "attach", pane_id: paneId, cols: 100, rows: 30, ...(sync ? { sync: "ssp" as const } : {}), ...(resume ? { resume } : {}) });
  // a resumed stream's first frame names a base this test client never kept: it is counted unapplied
  await until(() => state.frames > 0 || (resume !== undefined && state.diffs.length > 0), "initial terminal paint");
  return { ws, state, send };
}

/** Bun.spawn throws synchronously for the pty sidecar while `node` is not on PATH (herdr itself stays found). */
function breakPath(): () => void {
  const previous = process.env["PATH"];
  const previousHerdr = process.env["HERDR_WEB_HERDR_BIN"];
  process.env["HERDR_WEB_HERDR_BIN"] = Bun.which(previousHerdr || "herdr", { PATH: previous ?? "" }) ?? previousHerdr ?? "herdr";
  process.env["PATH"] = "/nonexistent";
  return () => {
    process.env["PATH"] = previous;
    if (previousHerdr === undefined) delete process.env["HERDR_WEB_HERDR_BIN"];
    else process.env["HERDR_WEB_HERDR_BIN"] = previousHerdr;
  };
}

const FLOOD = `python3 -u -c 'import sys,time; [(sys.stdout.write("\\033[H"+(str(i%10)*79+"\\n")*23),sys.stdout.flush(),time.sleep(.01)) for i in range(1500)]'`;

async function flood(paneId: string, command = FLOOD): Promise<void> {
  // Redraws reach the attach stream; raw shell byte rate alone is not its workload.
  await Bun.sleep(150); // herdr's attach consumes very early keystrokes
  await paneSendText(paneId, command);
  await paneSendKeys(paneId, ["Enter"]);
}

describe("the screen synced to every client (ssp)", () => {
  it("starts a new stream when a pane is reopened at once, and ignores the old stream's acknowledgements", async () => {
    const paneId = await pane();
    const client = await connect(paneId);
    try {
      const old = client.state.diffs.at(-1)!.stream;
      client.send({ type: "detach", pane_id: paneId });
      client.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30, sync: "ssp" });
      await until(() => client.state.diffs.at(-1)!.stream !== old, "a new stream after the retirement");
      expect(client.state.diffs.at(-1)!.base === 0 || client.state.diffs.some((diff) => diff.stream !== old && diff.base === 0)).toBe(true);
      client.send({ type: "ssp-ack", pane_id: paneId, stream: old, num: Number.MAX_SAFE_INTEGER });
      await Bun.sleep(100);
      expect(client.state.errors).toEqual([]);
      expect(client.state.exits).toBe(0);
      expect(client.state.code).toBe(0);
    } finally { client.ws.close(); }
  }, 20_000);

  it("keeps the operator in step while an observer never acknowledges, without pausing the pane or closing anyone", async () => {
    const paneId = await pane();
    const operator = await connect(paneId);
    const observer = await connect(paneId, false, true);
    try {
      await flood(paneId, `${FLOOD}; echo flood-$((1+1))-done`);
      // the operator's screen keeps up to the end, whatever the observer does
      await until(() => operator.state.tail.includes("flood-2-done"), "the operator sees the last screen", 30_000);
      // the observer is sent a few screens, then waits for its acknowledgement: nothing piles up
      expect(observer.state.frames).toBeLessThan(40);
      expect(observer.state.code).toBe(0);
      expect(operator.state.code).toBe(0);
      // and once it acknowledges, it skips straight to the current screen
      observer.state.ack = true;
      const last = observer.state.diffs.at(-1)!;
      observer.send({ type: "ssp-ack", pane_id: paneId, stream: last.stream, num: last.num });
      await until(() => observer.state.tail.includes("flood-2-done"), "the observer catches up in one step", 10_000);
      // the pane is alive and answers
      operator.send({ type: "input", pane_id: paneId, text: "echo alive-$((6*7))\r" });
      await until(() => operator.state.tail.includes("alive-42"), "the pane still runs");
      expect([...operator.state.errors, ...observer.state.errors]).toEqual([]);
    } finally { operator.ws.close(); observer.ws.close(); }
  }, 60_000);

  it("gives a client joining late the whole current screen, including what was drawn once", async () => {
    const paneId = await pane();
    const operator = await connect(paneId);
    try {
      await Bun.sleep(150); // herdr's attach consumes very early keystrokes
      operator.send({ type: "input", pane_id: paneId, text: "clear; printf 'drawn-once\\n'; " + FLOOD.replace("range(1500)", "range(200)") + "\r" });
      await until(() => operator.state.tail.includes("9".repeat(79)), "the flood ended", 30_000);
      const joiner = await connect(paneId);
      try {
        await until(() => joiner.state.tail === operator.state.tail, "the joiner has the operator's screen");
        expect(joiner.state.diffs[0]!.base).toBe(0);
      } finally { joiner.ws.close(); }
    } finally { operator.ws.close(); }
  }, 60_000);

  it("says which typed input the program has had time to echo", async () => {
    const paneId = await pane();
    const client = await connect(paneId);
    try {
      await Bun.sleep(300); // herdr's attach consumes very early keystrokes
      client.send({ type: "input", pane_id: paneId, text: "echo seq", seq: 7 });
      await until(() => client.state.echo >= 7, "the echo acknowledgement");
      expect(client.state.tail).toContain("echo seq");
      // keys through herdr are numbered the same way
      client.send({ type: "keys", pane_id: paneId, keys: ["Enter"], seq: 8 });
      await until(() => client.state.echo >= 8, "the key's echo acknowledgement");
    } finally { client.ws.close(); }
  }, 20_000);

  it("resumes a stream across a reconnect while the pane's attachment lives", async () => {
    const paneId = await pane();
    const stays = await connect(paneId);
    const leaves = await connect(paneId);
    try {
      const last = leaves.state.diffs.at(-1)!;
      leaves.ws.close();
      await until(() => leaves.state.code !== 0, "the first connection closed");
      const back = await connect(paneId, true, false, server.port, true, { stream: last.stream, num: last.num });
      try {
        expect(back.state.diffs[0]!.stream).toBe(last.stream);
        expect(back.state.diffs[0]!.base).toBe(last.num);
      } finally { back.ws.close(); }
      // an unknown stream starts a new one from a blank screen
      const stranger = await connect(paneId, true, false, server.port, true, { stream: "nope", num: 3 });
      try {
        expect(stranger.state.diffs[0]!.base).toBe(0);
        expect(stranger.state.diffs[0]!.stream).not.toBe("nope");
      } finally { stranger.ws.close(); }
    } finally { stays.ws.close(); }
  }, 20_000);

  it("refuses an acknowledgement of a screen never sent", async () => {
    const paneId = await pane();
    const client = await connect(paneId);
    try {
      const last = client.state.diffs.at(-1)!;
      client.send({ type: "ssp-ack", pane_id: paneId, stream: last.stream, num: last.num + 1_000_000 });
      await until(() => client.state.errors.includes("invalid_ack"), "invalid_ack");
    } finally { client.ws.close(); }
  }, 20_000);

  it("draws the screen whole for an older page on the raw stream, then streams its bytes", async () => {
    const paneId = await pane();
    const operator = await connect(paneId);
    try {
      await Bun.sleep(300); // herdr's attach consumes very early keystrokes
      operator.send({ type: "input", pane_id: paneId, text: "echo before-$((6*7))\r" });
      await until(() => operator.state.tail.includes("before-42"), "the operator's screen");
      const older = await connect(paneId, true, false, server.port, false);
      try {
        await until(() => older.state.tail.includes("before-42"), "the raw client's first paint has the screen");
        operator.send({ type: "input", pane_id: paneId, text: "echo after-$((6*7))\r" });
        await until(() => older.state.tail.includes("after-42"), "the raw stream goes on");
        expect(older.state.errors).toEqual([]);
      } finally { older.ws.close(); }
    } finally { operator.ws.close(); }
  }, 30_000);
});

describe("a terminal attach that cannot spawn (#154)", () => {
  it("reports the failure and leaves the pane attachable, never a record without a pty", async () => {
    const paneId = await pane();
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    sockets.push(ws);
    const errors: string[] = [];
    ws.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as ServerMessage;
      if (frame.type === "error") errors.push(frame.code);
    });
    await until(() => ws.readyState === WebSocket.OPEN, "socket open");
    const restore = breakPath();
    try {
      ws.send(JSON.stringify({ type: "attach", pane_id: paneId, cols: 100, rows: 30, sync: "ssp" } satisfies ClientMessage));
      await until(() => errors.includes("command_failed"), "the failed spawn is reported");
    } finally { restore(); }
    // the next attach spawns its own pty instead of joining a dead record
    const second = await connect(paneId);
    second.ws.close();
    await until(() => second.state.code !== 0, "second client closed");
    // closing it tore the attachment down cleanly: the server still attaches the pane
    const third = await connect(paneId);
    try {
      expect(third.state.errors).toEqual([]);
      expect(third.state.exits).toBe(0);
    } finally { third.ws.close(); ws.close(); }
  }, 30_000);
});

describe("a herdr the server cannot start (#925)", () => {
  it("tells the attaching client and logs it, instead of a terminal that waits in silence", async () => {
    const paneId = await pane();
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    sockets.push(ws);
    const errors: string[] = [];
    const errorPanes: (string | undefined)[] = [];
    ws.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as ServerMessage;
      if (frame.type === "error") { errors.push(frame.code); errorPanes.push(frame.pane_id); }
    });
    await until(() => ws.readyState === WebSocket.OPEN, "socket open");
    const missing = join(root, "missing-herdr");
    const logged: string[] = [];
    const log = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
    const previous = process.env["HERDR_WEB_HERDR_BIN"];
    process.env["HERDR_WEB_HERDR_BIN"] = missing;
    try {
      ws.send(JSON.stringify({ type: "attach", pane_id: paneId, cols: 100, rows: 30, sync: "ssp" } satisfies ClientMessage));
      await until(() => errors.includes("attach_failed"), "the missing herdr is reported", 3_000);
    } finally {
      console.error = log;
      if (previous === undefined) delete process.env["HERDR_WEB_HERDR_BIN"];
      else process.env["HERDR_WEB_HERDR_BIN"] = previous;
    }
    expect(errors).toEqual(["attach_failed"]);
    // the panes of a PC share one connection: the failure names its pane, so only that terminal ends
    expect(errorPanes).toEqual([paneId]);
    expect(logged.filter((line) => line.includes(paneId) && line.includes(missing))).toHaveLength(1);
    // nothing was left behind: with herdr back, the pane attaches for real
    const client = await connect(paneId);
    try {
      expect(client.state.errors).toEqual([]);
    } finally { client.ws.close(); ws.close(); }
  }, 30_000);
});

describe("an attach herdr refuses over a read in progress", () => {
  /**
   * A herdr that refuses the first `refusals` attaches as herdr 0.9 refuses one racing a
   * pane read of the same terminal, then attaches for real.
   */
  function refusingHerdr(refusals: number): { path: string; attempts: () => number } {
    const real = process.env["HERDR_WEB_HERDR_BIN"] || Bun.which("herdr") || "herdr";
    const dir = mkdtempSync(join(root, "refusing-herdr-"));
    const count = join(dir, "count");
    const path = join(dir, "herdr");
    writeFileSync(path, [
      "#!/bin/sh",
      `n=$(cat '${count}' 2>/dev/null || echo 0)`,
      `echo $((n + 1)) > '${count}'`,
      `if [ "$n" -lt ${refusals} ]; then printf 'herdr: server shut down: terminal attach failed: terminal term_0 has a read in progress; retry\\r\\n'; exit 1; fi`,
      `exec '${real}' "$@"`,
      "",
    ].join("\n"));
    chmodSync(path, 0o755);
    return { path, attempts: () => existsSync(count) ? Number(readFileSync(count, "utf8").trim() || 0) : 0 };
  }

  async function withHerdr<T>(path: string, run: () => Promise<T>): Promise<T> {
    const previous = process.env["HERDR_WEB_HERDR_BIN"];
    process.env["HERDR_WEB_HERDR_BIN"] = path;
    try { return await run(); } finally {
      if (previous === undefined) delete process.env["HERDR_WEB_HERDR_BIN"];
      else process.env["HERDR_WEB_HERDR_BIN"] = previous;
    }
  }

  it("attaches again for the same client instead of ending its terminal", async () => {
    const paneId = await pane();
    const herdr = refusingHerdr(2);
    await withHerdr(herdr.path, async () => {
      const client = await connect(paneId);
      try {
        // the refusals are retried; the third attach is real and paints the pane
        await until(() => herdr.attempts() === 3 && client.state.screen?.modes.altScreen === true, "the third attach paints");
        await Bun.sleep(300); // herdr's attach consumes very early keystrokes
        client.send({ type: "input", pane_id: paneId, text: "echo attach-$((6*7))\r" });
        await until(() => client.state.tail.includes("attach-42"), "the retried attach streams the pane");
        expect(herdr.attempts()).toBe(3);
        expect(client.state.exits).toBe(0);
        expect(client.state.errors).toEqual([]);
        // a refused attach's setup, teardown and message never reached the terminal
        expect(client.state.tail).not.toContain("read in progress");
      } finally { client.ws.close(); }
    });
  }, 30_000);

  it("ends the terminal, not the server, when a retried attach cannot spawn", async () => {
    const paneId = await pane();
    const herdr = refusingHerdr(1);
    await withHerdr(herdr.path, async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      sockets.push(ws);
      const errors: string[] = [];
      let exits = 0;
      ws.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data)) as ServerMessage;
        if (frame.type === "error") errors.push(frame.code);
        if (frame.type === "pty-exit" && frame.pane_id === paneId) exits++;
      });
      await until(() => ws.readyState === WebSocket.OPEN, "socket open");
      ws.send(JSON.stringify({ type: "attach", pane_id: paneId, cols: 100, rows: 30 } satisfies ClientMessage));
      // the refusal is running: the retry that follows its exit spawns without node
      await until(() => herdr.attempts() === 1, "the refused attach started");
      const restore = breakPath();
      try {
        await until(() => exits === 1, "pty-exit for the retry that failed to spawn");
      } finally { restore(); }
      expect(errors).toEqual(["command_failed"]);
      expect(herdr.attempts()).toBe(1);
      ws.close();
      // the server survived and the pane attaches again for real
      const client = await connect(paneId);
      try {
        expect(client.state.errors).toEqual([]);
        await until(() => herdr.attempts() === 2, "the pane attached again");
      } finally { client.ws.close(); }
    });
  }, 30_000);

  it("still ends the terminal when herdr keeps refusing past the longest such read", async () => {
    const paneId = await pane();
    const herdr = refusingHerdr(1000);
    const impatient = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: mkdtempSync(join(root, "impatient-")), attachRetryForMs: 800 });
    try {
      await withHerdr(herdr.path, async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${impatient.port}/ws`);
        sockets.push(ws);
        let exits = 0; let tail = "";
        ws.addEventListener("message", (event) => {
          const frame = JSON.parse(String(event.data)) as ServerMessage;
          if (frame.type === "pty-exit" && frame.pane_id === paneId) exits++;
          if (frame.type === "pty-data" && frame.pane_id === paneId) tail += frame.data;
          if (frame.type === "ssp" && frame.pane_id === paneId) tail += frame.lines.map(([, line]) => line.t).join("\n");
        });
        await until(() => ws.readyState === WebSocket.OPEN, "socket open");
        ws.send(JSON.stringify({ type: "attach", pane_id: paneId, cols: 100, rows: 30 } satisfies ClientMessage));
        await until(() => exits === 1, "pty-exit once the retries run out");
        expect(herdr.attempts()).toBeGreaterThan(2);
        // the last refusal is shown: it says why the terminal ended
        expect(tail).toContain("read in progress");
        ws.close();
      });
    } finally { impatient.stop(); }
  }, 30_000);
});

describe("herdr's attach-time terminal queries", () => {
  it("answers them in the bridge and keeps them out of every client's terminal", async () => {
    const real = process.env["HERDR_WEB_HERDR_BIN"] || Bun.which("herdr") || "herdr";
    const dir = mkdtempSync(join(root, "probing-herdr-"));
    const replies = join(dir, "replies");
    const path = join(dir, "herdr");
    // herdr 0.9.4+ asks its terminal these before it attaches; the herdr CI pins does not, so a shim asks
    writeFileSync(path, [
      "#!/bin/sh",
      "saved=$(stty -g)",
      "stty raw -echo",
      "printf '\\033[?1016$p\\033[c'",
      // --foreground: a background process group could not read the terminal
      `timeout --foreground 5 head -c 18 > '${replies}'`,
      'stty "$saved"',
      `exec '${real}' "$@"`,
      "",
    ].join("\n"));
    chmodSync(path, 0o755);
    const previous = process.env["HERDR_WEB_HERDR_BIN"];
    process.env["HERDR_WEB_HERDR_BIN"] = path;
    try {
      const paneId = await pane();
      const first = await connect(paneId);
      try {
        await until(() => first.state.screen?.modes.altScreen === true, "the attach behind the queries paints");
        await until(() => existsSync(replies) && readFileSync(replies, "utf8").length === 18, "the bridge answered");
        expect(readFileSync(replies, "utf8")).toBe("\x1b[?1016;4$y\x1b[?1;2c");
        // a browser joining later gets the screen: the queries are not in it to be answered again
        const second = await connect(paneId);
        try {
          for (const client of [first, second]) {
            expect(client.state.tail).not.toContain("1016$p");
            expect(client.state.tail).not.toContain("\x1b[c");
            expect(client.state.errors).toEqual([]);
          }
        } finally { second.ws.close(); }
      } finally { first.ws.close(); }
    } finally {
      if (previous === undefined) delete process.env["HERDR_WEB_HERDR_BIN"];
      else process.env["HERDR_WEB_HERDR_BIN"] = previous;
    }
  }, 30_000);
});

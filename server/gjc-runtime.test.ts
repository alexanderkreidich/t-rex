import { expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetGjcState, gjcPidUnderShell, gjcTranscriptForPane, isGjcProcess, validateGjcSdkTranscript } from "./gjc-runtime.ts";
import { GjcSdkLookupError } from "./gjc-sdk.ts";

// Session paths come back canonical and the store root is passed in canonical; macOS's tmpdir is a symlink into /private.
const tempDir = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

async function bounded<T>(event: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      event,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Missing SDK event: ${label}`)), 1000);
      }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

function sdkIndexRow(cwd: string, indexSeq: number, overrides: Record<string, unknown> = {}): string {
  const row = {
    version: 4, indexSeq, type: "host_heartbeat", sessionId: "unrelated-session",
    locator: { cwd, worktreeRoot: null, stateRoot: cwd },
    pid: 9999, processIncarnation: "other-host", hostIncarnation: "other-host",
    endpointGeneration: 1, activity: { state: "idle", at: 1000 }, ts: 1000,
    ...overrides,
  };
  return JSON.stringify({ ...row, checksum: createHash("sha256").update(JSON.stringify(row)).digest("hex") }) + "\n";
}

it("recognizes native and interpreter-launched gjc, not look-alikes", () => {
  expect(isGjcProcess(["/home/u/.local/bin/gjc", "--resume"])).toBe(true);
  expect(isGjcProcess(["gjc"])).toBe(true);
  expect(isGjcProcess(["/usr/bin/node", "/opt/gjc/dist/gjc.mjs"])).toBe(true);
  expect(isGjcProcess(["bun", "./gjc.js"])).toBe(true);
  expect(isGjcProcess(["/bin/zsh"])).toBe(false);
  expect(isGjcProcess(["gjc-helper"])).toBe(false);
  expect(isGjcProcess(["node", "/tmp/gjc/server.js"])).toBe(false);
  expect(isGjcProcess([])).toBe(false);
});

it("finds gjc under a Windows pane's shell, the only process herdr names there", async () => {
  const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const gjc = "C:\\Users\\u\\AppData\\Local\\gjc\\gjc.exe";
  const rows = [
    { pid: 100, parent: 4, path: powershell, commandLine: "powershell.exe" },
    { pid: 101, parent: 4, path: powershell, commandLine: "powershell.exe" },
    { pid: 150, parent: 100, path: "C:\\Windows\\System32\\conhost.exe", commandLine: "conhost.exe" },
    { pid: 300, parent: 200, path: gjc, commandLine: `${gjc} sdk broker-internal` },
    { pid: 200, parent: 100, path: gjc, commandLine: `"${gjc}" --resume` },
  ];
  const table = async () => rows;
  expect(await gjcPidUnderShell(100, "win32", table)).toEqual({ pid: 200, started: null });
  expect(await gjcPidUnderShell(101, "win32", table)).toBeNull();
  expect(await gjcPidUnderShell(undefined, "win32", table)).toBeNull();
  expect(await gjcPidUnderShell(100, "win32", async () => rows.map((row) => row.pid === 200 ? { ...row, started: 7 } : row))).toEqual({ pid: 200, started: 7 });
  expect(await gjcPidUnderShell(100, "win32", async () => [])).toBeUndefined();
  let asked = false;
  expect(await gjcPidUnderShell(100, "linux", async () => { asked = true; return rows; })).toBeNull();
  expect(asked).toBe(false);
});

it("validates an SDK-selected main transcript by canonical path and exact first-line identity", () => {
  const home = tempDir("gjc-sdk-file-");
  try {
    const cwd = join(home, "work"), otherCwd = join(home, "other");
    const agentDir = join(home, ".gjc", "agent"), project = join(agentDir, "sessions", "v2-project");
    mkdirSync(cwd); mkdirSync(otherCwd); mkdirSync(project, { recursive: true });
    const sessionId = "sdk-session-1";
    const header = (id: string, sessionCwd: string) => JSON.stringify({ type: "session", id, cwd: sessionCwd }) + "\n";
    const bind = (path: string, id = sessionId) => ({ sessionId: id, pid: 200, path, hostIncarnation: "host", endpointGeneration: 1, guardSessionIds: [id] });
    const good = join(project, "main.jsonl");
    writeFileSync(good, header(sessionId, cwd));
    expect(validateGjcSdkTranscript(bind(good), cwd, agentDir)).toBe(realpathSync(good));

    const wrongId = join(project, "wrong-id.jsonl");
    writeFileSync(wrongId, header("another-session", cwd));
    expect(validateGjcSdkTranscript(bind(wrongId), cwd, agentDir)).toBeNull();
    const wrongCwd = join(project, "wrong-cwd.jsonl");
    writeFileSync(wrongCwd, header(sessionId, otherCwd));
    expect(validateGjcSdkTranscript(bind(wrongCwd), cwd, agentDir)).toBeNull();

    const outside = join(home, "outside.jsonl");
    writeFileSync(outside, header(sessionId, cwd));
    expect(validateGjcSdkTranscript(bind(outside), cwd, agentDir)).toBeNull();
    const symlink = join(project, "outside-link.jsonl");
    symlinkSync(outside, symlink);
    expect(validateGjcSdkTranscript(bind(symlink), cwd, agentDir)).toBeNull();

    const subagent = join(project, sessionId, "worker.jsonl");
    mkdirSync(join(project, sessionId));
    writeFileSync(subagent, header(sessionId, cwd));
    expect(validateGjcSdkTranscript(bind(subagent), cwd, agentDir)).toBeNull();
    const malformed = join(project, "malformed.jsonl");
    writeFileSync(malformed, "{not-json}\n");
    expect(validateGjcSdkTranscript(bind(malformed), cwd, agentDir)).toBeNull();
    const longHeader = join(project, "long-header.jsonl");
    writeFileSync(longHeader, JSON.stringify({ type: "session", id: sessionId, cwd, padding: "x".repeat(64 * 1024) }) + "\n");
    expect(validateGjcSdkTranscript(bind(longHeader), cwd, agentDir)).toBeNull();
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it("re-reads pane process info and birth identity before accepting the SDK binding", async () => {
  const home = tempDir("gjc-sdk-race-");
  try {
    const cwd = join(home, "work"), agentDir = join(home, ".gjc", "agent");
    const project = join(agentDir, "sessions", "v2-project"), path = join(project, "main.jsonl");
    mkdirSync(cwd); mkdirSync(project, { recursive: true });
    const sessionId = "sdk-session-race";
    writeFileSync(path, JSON.stringify({ type: "session", id: sessionId, cwd }) + "\n");
    const binding = { sessionId, pid: 200, path, hostIncarnation: "host", endpointGeneration: 1, guardSessionIds: [sessionId] };
    const info = (pid: number) => ({ process_info: { foreground_processes: [{ pid, argv: ["/usr/bin/gjc"] }] } });
    let reads = 0, births = 0;
    const options = {
      platform: "linux",
      processInfo: async () => { reads += 1; return info(reads === 1 ? 200 : 200); },
      processBirth: () => { births += 1; return births === 1 ? 1000 : 1000; },
      sdkTranscript: async (pids: readonly number[]) => { expect(pids).toEqual([200]); return binding; },
    };
    expect(await gjcTranscriptForPane("pane", cwd, home, options)).toBe(realpathSync(path));
    expect(reads).toBe(2);
    expect(births).toBe(2);

    reads = 0; births = 0;
    expect(await gjcTranscriptForPane("pane", cwd, home, {
      ...options,
      processInfo: async () => { reads += 1; return info(reads === 1 ? 200 : 201); },
    })).toBeNull();
    reads = 0; births = 0;
    expect(await gjcTranscriptForPane("pane", cwd, home, {
      ...options,
      processInfo: async () => { reads += 1; return info(200); },
      processBirth: () => { births += 1; return births === 1 ? 1000 : 2000; },
    })).toBeNull();
    // macOS: one process read either side of a second boundary is still that process
    births = 0;
    expect(await gjcTranscriptForPane("pane", cwd, home, {
      ...options,
      platform: "darwin",
      processBirth: () => { births += 1; return births === 1 ? 1900 : 2100; },
    })).toBe(realpathSync(path));
    births = 0;
    expect(await gjcTranscriptForPane("pane", cwd, home, {
      ...options,
      platform: "darwin",
      processBirth: () => { births += 1; return births === 1 ? 1000 : 2500; },
    })).toBeNull();
    reads = 0;
    expect(await gjcTranscriptForPane("pane", cwd, home, {
      ...options,
      processInfo: async () => ++reads === 1 ? info(200) : null,
    })).toBeNull();
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it("shares one SDK lookup between overlapping reads of a pane", async () => {
  const home = tempDir("gjc-sdk-single-flight-");
  try {
    const cwd = join(home, "work"), agentDir = join(home, ".gjc", "agent");
    const project = join(agentDir, "sessions", "v2-project"), path = join(project, "main.jsonl");
    mkdirSync(cwd); mkdirSync(project, { recursive: true });
    const sessionId = "sdk-session-flight";
    writeFileSync(path, JSON.stringify({ type: "session", id: sessionId, cwd }) + "\n");
    const binding = { sessionId, pid: 200, path, hostIncarnation: "host", endpointGeneration: 1, guardSessionIds: [sessionId] };
    let lookups = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let gated = true;
    const options = {
      platform: "linux",
      processInfo: async () => ({ process_info: { foreground_processes: [{ pid: 200, argv: ["/usr/bin/gjc"] }] } }),
      processBirth: () => 1000,
      sdkTranscript: async () => { lookups += 1; if (gated) await gate; return lookups > 6 ? null : binding; },
    };
    // regression (fails on main: 5 lookups): five overlapping reads of one pane share one lookup
    const burst = Array.from({ length: 5 }, () => gjcTranscriptForPane("pane", cwd, home, options));
    release();
    expect(await Promise.all(burst)).toEqual(Array(5).fill(realpathSync(path)));
    expect(lookups).toBe(1);
    // control: once it settles, the next read looks up again (no session index to key a kept binding by)
    gated = false;
    expect(await gjcTranscriptForPane("pane", cwd, home, options)).toBe(realpathSync(path));
    expect(lookups).toBe(2);
    expect(await gjcTranscriptForPane("pane", cwd, home, options)).toBe(realpathSync(path));
    expect(lookups).toBe(3);
    // control: another pane is not joined
    gated = true;
    const [a, b] = [gjcTranscriptForPane("pane-a", cwd, home, options), gjcTranscriptForPane("pane-b", cwd, home, options)];
    release();
    await Promise.all([a, b]);
    expect(lookups).toBe(5);
    // control: a null answer is not kept, the next read asks again
    gated = false; lookups = 6;
    expect(await gjcTranscriptForPane("pane", cwd, home, options)).toBeNull();
    expect(lookups).toBe(7);
    lookups = 0;
    expect(await gjcTranscriptForPane("pane", cwd, home, options)).toBe(realpathSync(path));
    expect(lookups).toBe(1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it.each(["timeout", "unavailable"] as const)("propagates SDK %s without retaining an old transcript or a failed lookup", async (reason) => {
  const home = tempDir("gjc-sdk-failure-");
  try {
    const cwd = join(home, "work"), agentDir = join(home, ".gjc", "agent");
    const project = join(agentDir, "sessions", "project"), path = join(project, "main.jsonl");
    mkdirSync(cwd); mkdirSync(project, { recursive: true });
    const sessionId = "sdk-session-failure";
    writeFileSync(path, JSON.stringify({ type: "session", id: sessionId, cwd }) + "\n");
    const binding = { sessionId, pid: 200, path, hostIncarnation: "host", endpointGeneration: 1, guardSessionIds: [sessionId] };
    const failure = new GjcSdkLookupError(reason);
    let lookups = 0;
    const options = {
      platform: "linux",
      processInfo: async () => ({ process_info: { foreground_processes: [{ pid: 200, argv: ["gjc"] }] } }),
      processBirth: () => 1000,
      sdkTranscript: async () => {
        lookups += 1;
        if (lookups === 2) throw failure;
        return lookups === 3 ? null : binding;
      },
    };
    expect(await gjcTranscriptForPane("pane", cwd, home, options)).toBe(path);
    const failed = gjcTranscriptForPane("pane", cwd, home, options);
    const overlapping = gjcTranscriptForPane("pane", cwd, home, options);
    expect(overlapping).toBe(failed);
    await expect(failed).rejects.toBe(failure);
    await expect(overlapping).rejects.toBe(failure);
    expect(await gjcTranscriptForPane("pane", cwd, home, options)).toBeNull();
    expect(await gjcTranscriptForPane("pane", cwd, home, options)).toBe(path);
    expect(lookups).toBe(4);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it.each(["timeout", "unavailable"] as const)("caches status %s briefly while chat retries independently", async (reason) => {
  const home = tempDir("gjc-status-failure-");
  try {
    let clock = 0, lookups = 0;
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    const failure = new GjcSdkLookupError(reason);
    const options = {
      platform: "linux", now: () => clock,
      processInfo: async () => ({ process_info: { foreground_processes: [{ pid: 200, argv: ["gjc"] }] } }),
      processBirth: () => 1000,
      sdkTranscript: async () => { lookups += 1; entered.resolve(); await gate.promise; throw failure; },
    };
    const status = () => gjcTranscriptForPane("pane", home, home, { ...options, purpose: "status" });
    const first = status();
    await entered.promise;
    const chat = gjcTranscriptForPane("pane", home, home, options);
    expect(chat).not.toBe(first);
    const failed = first.catch((error: unknown) => error);
    const failedChat = chat.catch((error: unknown) => error);
    gate.resolve();
    expect(await failed).toBe(failure);
    expect(await failedChat).toBe(failure);
    clock = 29_999;
    await expect(status()).rejects.toBe(failure);
    expect(lookups).toBe(2);
    clock = 30_000;
    await expect(status()).rejects.toBe(failure);
    expect(lookups).toBe(3);
    await expect(gjcTranscriptForPane("pane", home, home, options)).rejects.toBe(failure);
    expect(lookups).toBe(4);
    await expect(status()).rejects.toBe(failure);
    expect(lookups).toBe(4);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it("keeps unresolved status lookups briefly but a successful chat retry clears them", async () => {
  const home = tempDir("gjc-status-null-");
  try {
    const store = join(home, ".gjc/agent/sessions/project"), path = join(store, "main.jsonl");
    mkdirSync(store, { recursive: true });
    writeFileSync(path, JSON.stringify({ type: "session", id: "retry", cwd: home }) + "\n");
    let lookups = 0;
    const options = {
      platform: "linux",
      processInfo: async () => ({ process_info: { foreground_processes: [{ pid: 200, argv: ["gjc"] }] } }),
      processBirth: () => 1000,
      sdkTranscript: async () => ++lookups === 1 ? null : ({
        sessionId: "retry", pid: 200, path, hostIncarnation: "host", endpointGeneration: 1, guardSessionIds: ["retry"],
      }),
    };
    const status = () => gjcTranscriptForPane("pane", home, home, { ...options, purpose: "status" });
    expect(await status()).toBeNull();
    expect(await status()).toBeNull();
    expect(lookups).toBe(1);
    expect(await gjcTranscriptForPane("pane", home, home, options)).toBe(path);
    expect(await status()).toBe(path);
    expect(lookups).toBe(3);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it.each(["RPC unavailable", "RPC exception", "no foreground"] as const)("does not cache a status miss before SDK execution: %s", async (missing) => {
  const home = tempDir("gjc-status-before-sdk-");
  try {
    const store = join(home, ".gjc/agent/sessions/project"), path = join(store, "main.jsonl");
    mkdirSync(store, { recursive: true });
    writeFileSync(path, JSON.stringify({ type: "session", id: "ready", cwd: home }) + "\n");
    let ready = false, lookups = 0, clock = 0;
    const options = {
      platform: "linux", now: () => clock, purpose: "status" as const,
      processInfo: async () => {
        if (!ready && missing === "RPC exception") throw new Error("fixture RPC failed");
        if (!ready && missing === "RPC unavailable") return null;
        return { process_info: { foreground_processes: ready ? [{ pid: 200, argv: ["gjc"] }] : [] } };
      },
      processBirth: () => 1000,
      sdkTranscript: async () => {
        lookups += 1;
        return { sessionId: "ready", pid: 200, path, hostIncarnation: "host", endpointGeneration: 1, guardSessionIds: ["ready"] };
      },
    };
    expect(await gjcTranscriptForPane("pane", home, home, options)).toBeNull();
    expect(lookups).toBe(0);
    ready = true; clock = 25_000;
    expect(await gjcTranscriptForPane("pane", home, home, options)).toBe(path);
    expect(lookups).toBe(1);
  } finally { forgetGjcState(); rmSync(home, { recursive: true, force: true }); }
});

it.each(["pid", "birth", "cwd", "pane", "index", "foreground gap", "RPC gap"] as const)("invalidates cached SDK failures after a change to %s", async (change) => {
  for (const result of ["null", "timeout"] as const) {
    const home = tempDir("gjc-status-identity-");
    try {
      const store = join(home, ".gjc/agent/sessions/project"), path = join(store, "main.jsonl");
      const indexDir = join(home, ".gjc/agent/sdk/sessions"), cwdB = join(home, "other");
      mkdirSync(store, { recursive: true }); mkdirSync(indexDir, { recursive: true }); mkdirSync(cwdB);
      const index = join(indexDir, "index.jsonl");
      writeFileSync(index, sdkIndexRow(home, 1, { type: "host_registered", pid: 200 }));
      let pid = 200, birth = 1000, cwd = home, pane = "pane", active = true, reachable = true, failing = true, lookups = 0;
      const failure = new GjcSdkLookupError("timeout");
      const options = {
        platform: "linux", purpose: "status" as const,
        processInfo: async () => reachable ? ({ process_info: { foreground_processes: active ? [{ pid, argv: ["gjc"] }] : [] } }) : null,
        processBirth: () => birth,
        sdkTranscript: async () => {
          lookups += 1;
          if (failing) { if (result === "timeout") throw failure; return null; }
          writeFileSync(path, JSON.stringify({ type: "session", id: "ready", cwd }) + "\n");
          return { sessionId: "ready", pid, path, hostIncarnation: "host", endpointGeneration: 1, guardSessionIds: ["ready"] };
        },
      };
      const read = () => gjcTranscriptForPane(pane, cwd, home, options).catch((error: unknown) => error);
      expect(await read()).toBe(result === "timeout" ? failure : null);
      expect(await read()).toBe(result === "timeout" ? failure : null);
      expect(lookups).toBe(1);
      switch (change) {
        case "pid": pid += 1; break;
        case "birth": birth += 1000; break;
        case "cwd": cwd = cwdB; break;
        case "pane": pane = "other-pane"; break;
        case "index": appendFileSync(index, sdkIndexRow(home, 2, { type: "host_registered", sessionId: "new", pid })); break;
        case "foreground gap": active = false; expect(await read()).toBeNull(); active = true; break;
        case "RPC gap": reachable = false; expect(await read()).toBeNull(); reachable = true; break;
      }
      failing = false;
      expect(await read()).toBe(path);
      expect(lookups).toBe(2);
    } finally { forgetGjcState(); rmSync(home, { recursive: true, force: true }); }
  }
});

it.each(["null", "timeout"] as const)("does not reinstate an older status %s after a newer chat succeeds", async (result) => {
  const home = tempDir("gjc-status-success-order-");
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
  try {
    const store = join(home, ".gjc/agent/sessions/project"), path = join(store, "main.jsonl");
    mkdirSync(store, { recursive: true });
    writeFileSync(path, JSON.stringify({ type: "session", id: "ready", cwd: home }) + "\n");
    const failure = new GjcSdkLookupError("timeout");
    let lookups = 0;
    const options = {
      platform: "linux",
      processInfo: async () => ({ process_info: { foreground_processes: [{ pid: 200, argv: ["gjc"] }] } }),
      processBirth: () => 1000,
      sdkTranscript: async (_pids: readonly number[], _cwd: string, _agentDir: string, purpose: "chat" | "status" = "chat") => {
        lookups += 1;
        if (purpose === "status" && lookups === 1) {
          entered.resolve(); await gate.promise;
          if (result === "timeout") throw failure;
          return null;
        }
        return { sessionId: "ready", pid: 200, path, hostIncarnation: "host", endpointGeneration: 1, guardSessionIds: ["ready"] };
      },
    };
    const status = () => gjcTranscriptForPane("pane", home, home, { ...options, purpose: "status" });
    const older = status().catch((error: unknown) => error);
    await bounded(entered.promise, "older status entered");
    expect(await gjcTranscriptForPane("pane", home, home, options)).toBe(path);
    gate.resolve();
    expect(await older).toBe(result === "timeout" ? failure : null);
    // No readable index: the success cannot be kept as a binding, but must still invalidate the older failure.
    expect(await status()).toBe(path);
    expect(lookups).toBe(3);
  } finally { gate.resolve(); forgetGjcState(); rmSync(home, { recursive: true, force: true }); }
});

it.each(["chat", "status"] as const)("does not inherit the %s deadline in an overlapping lookup of the other purpose", async (purpose) => {
  const home = tempDir("gjc-budget-flight-");
  const entered = Promise.withResolvers<void>(), both = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
  try {
    const purposes: string[] = [];
    const options = {
      platform: "linux",
      processInfo: async () => ({ process_info: { foreground_processes: [{ pid: 200, argv: ["gjc"] }] } }),
      processBirth: () => 1000,
      sdkTranscript: async (_pids: readonly number[], _cwd: string, _agentDir: string, budget: "chat" | "status" = "chat") => {
        purposes.push(budget);
        entered.resolve();
        if (purposes.length === 2) both.resolve();
        await gate.promise;
        return null;
      },
    };
    const first = gjcTranscriptForPane("pane", home, home, { ...options, purpose });
    await bounded(entered.promise, "first lookup entered");
    const other = gjcTranscriptForPane("pane", home, home, { ...options, purpose: purpose === "chat" ? "status" : "chat" });
    await bounded(both.promise, "both purpose-specific lookups entered");
    expect(other).not.toBe(first);
    gate.resolve();
    await Promise.all([first, other]);
    expect(purposes.sort()).toEqual(["chat", "status"]);
  } finally { gate.resolve(); rmSync(home, { recursive: true, force: true }); }
});

it.each(["cwd", "home", "SDK callback"])("keeps overlapping pane reads separate when %s differs", async (context) => {
  forgetGjcState();
  const home = tempDir("gjc-sdk-flight-context-");
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
  try {
    // Given two valid sessions for the same live pane/process.
    const cwdA = join(home, "a"), cwdB = context === "cwd" ? join(home, "b") : cwdA;
    const homeB = context === "home" ? join(home, "other-home") : home;
    const projectA = join(home, ".gjc/agent/sessions/project");
    const projectB = join(homeB, ".gjc/agent/sessions/project");
    mkdirSync(cwdA); mkdirSync(cwdB, { recursive: true });
    mkdirSync(projectA, { recursive: true }); mkdirSync(projectB, { recursive: true });
    const pathA = join(projectA, "a.jsonl"), pathB = join(projectB, "b.jsonl");
    writeFileSync(pathA, JSON.stringify({ type: "session", id: "A", cwd: cwdA }) + "\n");
    writeFileSync(pathB, JSON.stringify({ type: "session", id: "B", cwd: cwdB }) + "\n");
    const bindingA = { sessionId: "A", pid: 200, path: pathA, hostIncarnation: "host", endpointGeneration: 1, guardSessionIds: ["A"] };
    const bindingB = { ...bindingA, sessionId: "B", path: pathB, guardSessionIds: ["B"] };
    let lookups = 0;
    const options = {
      platform: "linux",
      processInfo: async () => ({ process_info: { foreground_processes: [{ pid: 200, argv: ["gjc"] }] } }),
      processBirth: () => 1000,
      sdkTranscript: async (_pids: readonly number[], cwd: string, agentDir: string) => {
        lookups += 1;
        if (cwd !== cwdA || agentDir !== join(home, ".gjc/agent")) return bindingB;
        entered.resolve();
        await gate.promise;
        return bindingA;
      },
    };
    // When a later snapshot arrives after the first SDK lookup has actually started.
    const first = gjcTranscriptForPane("pane", cwdA, home, options);
    await entered.promise;
    const equivalent = gjcTranscriptForPane("pane", cwdA, home, { ...options });
    const laterOptions = context === "SDK callback"
      ? { ...options, sdkTranscript: async () => { lookups += 1; return bindingB; } }
      : options;
    const later = gjcTranscriptForPane("pane", cwdB, homeB, laterOptions);
    gate.resolve();
    // Then only equivalent contexts join, and each directory/store receives its own session.
    expect(equivalent).toBe(first);
    expect(await Promise.all([first, equivalent, later])).toEqual([pathA, pathA, pathB]);
    expect(lookups).toBe(2);
  } finally {
    gate.resolve();
    forgetGjcState();
    rmSync(home, { recursive: true, force: true });
  }
}, 5000);

it("fails closed when the pane has no GJC process or its process info cannot be read", async () => {
  const home = tempDir("gjc-sdk-no-process-");
  try {
    const cwd = join(home, "work");
    mkdirSync(cwd);
    let sdkCalls = 0;
    const options = {
      platform: "linux",
      processInfo: async () => ({ process_info: { foreground_processes: [] } }),
      sdkTranscript: async () => { sdkCalls += 1; return null; },
    };
    expect(await gjcTranscriptForPane("pane", cwd, home, options)).toBeNull();
    expect(sdkCalls).toBe(0);
    expect(await gjcTranscriptForPane("pane", cwd, home, {
      ...options,
      processInfo: async () => null,
    })).toBeNull();
    expect(sdkCalls).toBe(0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

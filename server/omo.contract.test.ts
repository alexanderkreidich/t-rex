import { afterAll, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { herdrRpc, sessionSnapshot, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import type { HerdrPane } from "../shared/protocol.ts";
import { isOmoProcess, omoPanes, omoTranscriptsOfCwd, type ProcessInfo } from "./omo.ts";
import { labelOmoPanes } from "./pane-processes.ts";
import { startShellAgent } from "./shell-agent.ts";
import { processStartedAt } from "./process-start.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-omo-binding-"));
const workspaces: string[] = [];
const script = join(root, "omo");
writeFileSync(script, "setInterval(() => {}, 1000);\n");
const dir = join(root, ".omo", "agent", "sessions", `-${root.replaceAll("/", "-")}--`);
mkdirSync(dir, { recursive: true });
afterAll(async () => {
  for (const id of workspaces) await workspaceClose(id);
  rmSync(root, { recursive: true, force: true });
});

async function waitForProcess(paneId: string, marker: string) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const info = await herdrRpc<NonNullable<ProcessInfo>>("pane.process_info", { pane_id: paneId });
    const processes = info.process_info?.foreground_processes ?? [];
    // the stand-in itself, by its path: the shell's own startup processes come and go before it
    const process = processes.find((process) => process.argv?.includes(marker));
    if (process) return { process, processes };
    if (Date.now() >= deadline) {
      throw new Error(`test process ${marker} did not appear in pane ${paneId}; last process info: ${JSON.stringify(info)}`);
    }
    await Bun.sleep(50);
  }
}

async function launch(command: string, marker: string): Promise<string> {
  const created = await workspaceCreate({ cwd: root, label: "t-rex-test-omo-binding" });
  workspaces.push(created.workspace.workspace_id);
  const paneId = created.root_pane.pane_id;
  await herdrRpc("pane.send_text", { pane_id: paneId, text: `${command}\n` });
  await waitForProcess(paneId, marker);
  return paneId;
}
const pane = (id?: string) => launch(`${process.execPath} ${script}${id ? ` --session-id ${id}` : ""}`, script);
/** the session file status binds the pane to, as status reads it (omoPanes); null while there is none or it is not written yet */
const read = async (paneId: string, panes?: HerdrPane[], home = root) => (await omoPanes(panes ?? (await sessionSnapshot()).panes, home)).get(paneId)?.path ?? null;
const session = (id: string, timestamp = new Date().toISOString()) => {
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, JSON.stringify({ type: "session", id, cwd: root, timestamp }) + "\n");
  return path;
};

it("uses live process evidence and stops cwd inference as soon as a second omo shares it", async () => {
  const first = await pane();
  const fresh = session("fresh-session");
  expect(await read(first)).toBe(fresh);
  const resumed = session("resumed-session", "2020-01-01T00:00:00Z");
  const second = await pane("resumed-session");
  expect(await read(first)).toBeNull();
  expect(await read(second)).toBe(resumed);
  const duplicate = await pane("resumed-session");
  expect(await read(second)).toBeNull();
  expect(await read(duplicate)).toBeNull();
});

it("starts omo through the pane's shell and waits until omo is its foreground process", async () => {
  const shell = async () => {
    const created = await workspaceCreate({ cwd: root, label: "t-rex-test-omo-start" });
    workspaces.push(created.workspace.workspace_id);
    return created.root_pane.pane_id;
  };
  const started = await shell();
  await startShellAgent("omo", started, ["it's one arg"], { command: `${process.execPath} ${script}` });
  const info = await herdrRpc<{ process_info?: { foreground_processes?: { argv?: string[] }[] } }>("pane.process_info", { pane_id: started });
  expect(info.process_info?.foreground_processes?.find((process) => isOmoProcess(process.argv ?? []))?.argv?.slice(-1)).toEqual(["it's one arg"]);
  // a command that never becomes omo fails at the deadline instead of reporting a start
  await expect(startShellAgent("omo", await shell(), [], { command: "true", timeoutMs: 1500 })).rejects.toThrow("omo did not start");
});

// omo keeps no descriptor on its session file; it publishes a holder record instead
const hold = async (paneId: string, id: string, store = dir, marker = script) => {
  // A later process-info snapshot can omit the launcher even after launch() observed it.
  const { process: { pid } } = await waitForProcess(paneId, marker);
  const holders = join(store, "session-holders", encodeURIComponent(id));
  mkdirSync(holders, { recursive: true });
  writeFileSync(join(holders, `${pid}.json`), JSON.stringify({ pid, bootAtMs: 0, processStartedAtMs: Math.floor(processStartedAt(pid)! / 1000) * 1000, cwd: root }));
};

it("binds each omo pane in a shared cwd to the session its process holds", async () => {
  const first = await pane();
  const second = await pane();
  const afterNew = await pane("launch-session");
  const reportedBefore = await pane();
  const resumed = session("held-resumed", "2020-01-01T00:00:00Z");
  const fresh = session("held-fresh");
  session("launch-session");
  const replaced = session("held-after-new");
  const reported = session("herdr-reported");
  const heldSinceReport = session("held-since-report");
  await hold(first, "held-resumed");
  await hold(second, "held-fresh");
  await hold(afterNew, "held-after-new");
  await hold(reportedBefore, "held-since-report");
  expect(await read(first)).toBe(resumed);
  expect(await read(second)).toBe(fresh);
  expect(await read(afterNew)).toBe(replaced);
  // herdr still names the session this pane had before /new
  const panes = (await sessionSnapshot()).panes.map((entry) =>
    entry.pane_id === reportedBefore ? { ...entry, agent_session: { agent: "omo", kind: "path", source: "herdr:omo", value: reported } } : entry);
  expect(await read(reportedBefore, panes)).toBe(heldSinceReport);
});
it("tells a held session omo has not written yet from an older one", async () => {
  // omo writes the file with the first prompt; a launch id can name the session before /new
  const started = await pane();
  const afterNew = await pane("launched-before-new");
  session("launched-before-new");
  await hold(started, "unwritten-first");
  await hold(afterNew, "unwritten-after-new");
  // a file whose name only contains the held id is another session's
  writeFileSync(join(dir, "unwritten-first-copy.jsonl"), JSON.stringify({ type: "session", id: "copied", cwd: root, timestamp: new Date().toISOString() }) + "\n");
  const panes = (await sessionSnapshot()).panes;
  expect(await read(started, panes)).toBeNull();
  expect(await read(afterNew, panes)).toBeNull();
  const written = session("unwritten-first");
  expect(await read(started, panes)).toBe(realpathSync(written));
});

// open files are read from /proc, which macOS does not have
it.skipIf(process.platform !== "linux")("ignores the background task logs omo holds open outside its session store", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "herdr-omo-task-log-"));
  const store = join(cwd, ".omo", "agent", "sessions", `-${cwd.replaceAll("/", "-")}--`);
  const logs = join(cwd, ".omo", "senpi-task", "logs");
  mkdirSync(store, { recursive: true });
  mkdirSync(logs, { recursive: true });
  // a stand-in omo that holds a task log open, as omo does while a background task runs
  const holder = join(cwd, "omo");
  writeFileSync(holder, "require('node:fs').openSync(process.argv[2], 'a');\nsetInterval(() => {}, 1000);\n");
  const created = await workspaceCreate({ cwd, label: "t-rex-test-omo-task-log" });
  try {
    const paneId = created.root_pane.pane_id;
    await herdrRpc("pane.send_text", { pane_id: paneId, text: `${process.execPath} ${holder} ${join(logs, "st_task.jsonl")}\n` });
    let held = false;
    for (let attempt = 0; attempt < 100 && !held; attempt++) {
      const info = await herdrRpc<{ process_info?: { foreground_processes?: { pid: number; argv?: string[] }[] } }>("pane.process_info", { pane_id: paneId });
      const omo = info.process_info?.foreground_processes?.find((process) => isOmoProcess(process.argv ?? []));
      if (omo) held = readdirSync(`/proc/${omo.pid}/fd`).some((fd) => { try { return readlinkSync(`/proc/${omo.pid}/fd/${fd}`).endsWith("st_task.jsonl"); } catch { return false; } });
      if (!held) await Bun.sleep(50);
    }
    expect(held).toBe(true);
    const path = join(store, "task-session.jsonl");
    writeFileSync(path, JSON.stringify({ type: "session", id: "task-session", cwd, timestamp: new Date().toISOString() }) + "\n");
    expect(await read(paneId, undefined, cwd)).toBe(realpathSync(path));
  } finally {
    await workspaceClose(created.workspace.workspace_id);
    rmSync(cwd, { recursive: true, force: true });
  }
});

// a custom launcher's own name says nothing about omo, and a process's environment at
// exec is read from /proc/<pid>/environ: both halves of that contract are Linux-only
it.skipIf(process.platform !== "linux")("recognizes a custom launcher only by verified holders in an env-named store", async () => {
  const launcher = join(root, "team-ai");
  writeFileSync(launcher, "setInterval(() => {}, 1000);\n");
  const agentDir = join(root, "custom-agent");
  const store = join(agentDir, "sessions", `-${root.replaceAll("/", "-")}--`);
  const paneId = await launch(`OMO_CODING_AGENT_DIR=${agentDir} ${process.execPath} ${launcher}`, launcher);
  // the environment entry alone is no identity: nothing is held yet
  expect(await read(paneId)).toBeNull();
  expect((await labelOmoPanes(await sessionSnapshot())).panes.find((pane) => pane.pane_id === paneId)?.agent).toBeUndefined();
  // a held session omo has not written yet is pending, never another store's file
  await hold(paneId, "custom-pending", store, launcher);
  expect(await read(paneId)).toBeNull();
  expect((await labelOmoPanes(await sessionSnapshot())).panes.find((pane) => pane.pane_id === paneId)?.agent).toBe("omo");
  const written = join(store, "2026-10-03T00-00-00-000Z_custom-pending.jsonl");
  writeFileSync(written, JSON.stringify({ type: "session", id: "custom-pending", cwd: root, timestamp: new Date().toISOString() }) + "\n");
  expect(await read(paneId)).toBe(realpathSync(written));
  const snapshot = await sessionSnapshot();
  const { process: custom, processes } = await waitForProcess(paneId, launcher);
  expect(readlinkSync(`/proc/${custom.pid}/cwd`)).toBe(root);
  // Older process-info responses omit cwd; both pane directory fields can be stale.
  const withoutCwd = { process_info: { foreground_processes: processes.map(({ pid, argv }) => ({ pid, argv })) } };
  const stale = snapshot.panes.filter((entry) => entry.pane_id === paneId).map((entry) =>
    ({ ...entry, cwd: join(root, "stale-pane"), foreground_cwd: join(root, "stale-foreground") }));
  const resolved = omoTranscriptsOfCwd(root, stale, new Map([[paneId, withoutCwd]]), root).get(paneId);
  expect(resolved?.path).toBe(realpathSync(written));
  expect(resolved?.pending).toBeNull();
  for (const agent of ["codex", "devin", "gjc"]) {
    const relabelled = { ...snapshot, panes: snapshot.panes.map((entry) => entry.pane_id === paneId ? { ...entry, agent } : entry) };
    expect((await omoPanes(relabelled.panes)).get(paneId)?.path).toBe(realpathSync(written));
  }

});

it.skipIf(process.platform !== "linux")("recognizes a custom launcher in the default store and refuses a senpi-only one", async () => {
  const plain = join(root, "plain-runner");
  writeFileSync(plain, "setInterval(() => {}, 1000);\n");
  const paneId = await launch(`env -u OMO_CODING_AGENT_DIR -u SENPI_CODING_AGENT_DIR -u PI_CODING_AGENT_DIR ${process.execPath} ${plain}`, plain);
  await hold(paneId, "default-held", dir, plain);
  const path = session("default-held", "2020-01-01T00:00:00Z");
  expect(await read(paneId)).toBe(realpathSync(path));
  // the same launcher under a store moved only by SENPI's variable is not omo
  const senpi = join(root, "senpi-runner");
  writeFileSync(senpi, "setInterval(() => {}, 1000);\n");
  const otherDir = join(root, "senpi-state", "sessions", `-${root.replaceAll("/", "-")}--`);
  const paneId2 = await launch(`env -u OMO_CODING_AGENT_DIR -u PI_CODING_AGENT_DIR SENPI_CODING_AGENT_DIR=${join(root, "senpi-state")} ${process.execPath} ${senpi}`, senpi);
  await hold(paneId2, "senpi-held", otherDir, senpi);
  expect(await read(paneId2)).toBeNull();
});

import { afterAll, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { herdrRpc, herdrSocketPath, workspaceClose, workspaceCreate, paneRead } from "./herdr/client.ts";
import { isGjcProcess } from "./gjc-runtime.ts";
import { startShellAgent } from "./shell-agent.ts";

const home = realpathSync(mkdtempSync(join(tmpdir(), "herdr-gjc-binding-")));
const agentDir = join(home, ".gjc", "agent");
const dir = join(agentDir, "sessions", "v2-shared");
mkdirSync(dir, { recursive: true });
const workspaces: string[] = [];
const script = join(home, "gjc");
const bin = join(home, "bin");
const registry = join(home, "sdk-registry.json");
const sdkCli = join(home, "gjc-sdk-fixture.js");
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

// The stand-in is a Bun script named gjc; it holds only the requested store directory and prints the pane's fixed screen.
writeFileSync(script, "if (process.env.GJC_TEST_CWD) process.chdir(process.env.GJC_TEST_CWD);\nfor (const path of process.argv.slice(2)) require('node:fs').openSync(path, 'r');\nconsole.log('GJC fixture ready'); console.log(process.env.GJC_TEST_SCREEN || ''); setInterval(() => {}, 1000);\n");
mkdirSync(bin);
// The fixture accepts only the public raw global session.list operation. Its registry is test-owned JSON, never SDK state.
writeFileSync(sdkCli, `
const { appendFileSync, readFileSync } = require("node:fs");
if (process.env.GJC_TEST_CALLS) appendFileSync(process.env.GJC_TEST_CALLS, "sdk\\n");
const args = process.argv.slice(2);
const value = (flag) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
if (args[0] !== "sdk" || args[1] !== "session" || args[2] !== "raw" || args[3] !== "global"
  || args[4] !== "--op" || args[5] !== "session.list"
  || !args.includes("--attach-only") || !args.includes("--json")
  || value("--agent-dir") !== process.env.GJC_TEST_AGENT_DIR
  || !args.includes("--page") || value("--limit") !== "100") process.exit(64);
let state;
try { state = JSON.parse(readFileSync(process.env.GJC_TEST_REGISTRY, "utf8")); }
catch { process.exit(1); }
if (state.kind === "unavailable") {
  process.stdout.write(JSON.stringify({ type: "broker_response", ok: false, error: { code: "broker_unavailable" } }));
  process.exit(1);
}
if (state.kind === "malformed") { process.stdout.write("not-json"); process.exit(0); }
if (state.kind === "timeout") await new Promise(() => { setInterval(() => {}, 1000); });
let input;
try { if (value("--json-input") !== undefined) input = JSON.parse(value("--json-input")); }
catch { process.exit(64); }
let sessions = state.rows;
let savedSession;
let savedSessionOmission;
if (input && input.scope) {
  const scope = input.scope;
  if (scope.version !== 1 || scope.requested !== "pwd" || !scope.requestAnchor
    || typeof scope.requestAnchor.cwd !== "string" || scope.requestAnchor.worktreeRoot !== null) process.exit(64);
  sessions = sessions.filter((row) => row.locator.cwd === scope.requestAnchor.cwd);
}
if (input && typeof input.resolveSessionId === "string") {
  sessions = sessions.filter((row) => row.sessionId === input.resolveSessionId && row.locator.cwd === input.cwd);
  const path = state.paths && state.paths[input.resolveSessionId];
  if (typeof path === "string") savedSession = { id: input.resolveSessionId, path };
  else savedSessionOmission = { reason: "not_found", detailCode: "saved_session_omitted" };
}
const result = { indexSeq: 1, sessions, warnings: [] };
if (savedSession !== undefined) result.savedSession = savedSession;
if (savedSessionOmission !== undefined) result.savedSessionOmission = savedSessionOmission;
process.stdout.write(JSON.stringify({ type: "broker_response", ok: true, result }));
`);
// Non-SDK invocations are the executable-path contract's pane stand-in, not another SDK response path.
writeFileSync(join(bin, "gjc"), `#!/bin/sh\nif [ "$1" = "sdk" ]; then exec ${shellQuote(process.execPath)} ${shellQuote(sdkCli)} "$@"; fi\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`, { mode: 0o755 });

afterAll(async () => {
  const previousSocket = process.env["HERDR_SOCKET"];
  process.env["HERDR_SOCKET"] = herdrSocketPath();
  try {
    for (const workspace of workspaces) await workspaceClose(workspace);
  } finally {
    if (previousSocket === undefined) delete process.env["HERDR_SOCKET"]; else process.env["HERDR_SOCKET"] = previousSocket;
    rmSync(home, { recursive: true, force: true });
  }
});

async function withSdkFixture<T>(run: () => Promise<T>): Promise<T> {
  const keys = ["HOME", "HERDR_SOCKET", "PATH", "GJC_TEST_REGISTRY", "GJC_TEST_AGENT_DIR", "GJC_TEST_CALLS"] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env["HOME"] = home;
  process.env["HERDR_SOCKET"] = herdrSocketPath();
  process.env["PATH"] = `${bin}${process.env["PATH"] ? `:${process.env["PATH"]}` : ""}`;
  process.env["GJC_TEST_REGISTRY"] = registry;
  process.env["GJC_TEST_AGENT_DIR"] = agentDir;
  try {
    return await run();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

it("starts the gjc this server found on its PATH, by absolute path, and waits until it runs in the pane", async () => withSdkFixture(async () => {
  const shell = async () => {
    const created = await workspaceCreate({ cwd: home, label: "t-rex-test-gjc-start" });
    workspaces.push(created.workspace.workspace_id);
    return created.root_pane.pane_id;
  };
  // A `gjc` executable in a directory with a space is on this process's PATH only; the pane shell never sees that PATH.
  const spacedBin = join(home, "agent bin");
  mkdirSync(spacedBin);
  const exe = join(spacedBin, "gjc");
  writeFileSync(exe, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`, { mode: 0o755 });
  const previousPath = process.env["PATH"];
  try {
    process.env["PATH"] = `${spacedBin}:${previousPath ?? ""}`;
    const id = await shell();
    await startShellAgent("gjc", id, [dir]);
    const info = await herdrRpc<{ process_info?: { foreground_processes?: { argv?: string[] }[] } }>("pane.process_info", { pane_id: id });
    expect(info.process_info?.foreground_processes?.find((candidate) => isGjcProcess(candidate.argv ?? []))?.argv?.slice(-1)).toEqual([dir]);
    process.env["PATH"] = "/nonexistent";
    const bare = await shell();
    await expect(startShellAgent("gjc", bare, [], { timeoutMs: 1500 })).rejects.toThrow("not on this server's PATH");
    expect((await paneRead({ paneId: bare })).text.replaceAll(home, "")).not.toContain("gjc");
  } finally {
    if (previousPath === undefined) delete process.env["PATH"]; else process.env["PATH"] = previousPath;
  }
}));

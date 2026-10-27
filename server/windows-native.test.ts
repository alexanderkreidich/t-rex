/**
 * What only a real Windows PC can show: its process table as PowerShell answers it, and a
 * session store on its own file system with its own path rules. Everything else about the
 * Windows branches is tested with rows and paths handed in (gjc-runtime.test.ts); these run
 * on the Windows runners of reusable CI and the remote-bundle workflow (#271).
 */
import { expect, it } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claudeProcessSession, forgetClaudeSessions, processClaudeConfigDir } from "./claude-store.ts";

import { descendantArgv, windowsProcessTable } from "./windows-processes.ts";
import { windowsHost } from "./remote-host.ts";
import type { SshConnection } from "./ssh.ts";
import { psQuote } from "./powershell.ts";
import { REMOTE_BUNDLE_VERSION } from "../shared/machines.ts";

const onWindows = process.platform === "win32";

it.skipIf(!onWindows)("installs with native tar when PATH shadows tar, and preserves the runtime after bad extraction", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "herdr-bundle-native-")));
  const before = process.env["HERDR_WEB_BUNDLE_MANIFEST"];
  const runtime = join(home, "t-rex", `remote-v${REMOTE_BUNDLE_VERSION}`);
  const runPowerShell = async (script: string) => {
    const prefixed = `$env:LOCALAPPDATA=${psQuote(home)}; $env:PATH=${psQuote(join(home, "shadow"))}+';'+$env:PATH; ${script}`;
    // started from PowerShell 7 (the CI step), the child inherits its module path, and Windows
    // PowerShell then cannot load its own Get-FileHash; with none set it builds its own, as over SSH
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "psmodulepath"));
    const child = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(prefixed, "utf16le").toString("base64")], { stdout: "pipe", stderr: "pipe", env });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(stderr);
    return stdout.trim();
  };
  const ssh = { runPowerShell, upload: async (source: string, destination: string) => copyFileSync(source, destination) } as unknown as SshConnection;
  try {
    mkdirSync(join(home, "input", "bin"), { recursive: true });
    copyFileSync(process.execPath, join(home, "input", "bin", "bun.exe"));
    mkdirSync(join(home, "shadow"));
    // An invalid executable first on PATH must never handle this archive.
    writeFileSync(join(home, "shadow", "tar.exe"), "not a Windows executable");
    await runPowerShell(`& "$env:SystemRoot\\System32\\tar.exe" -czf ${psQuote(join(home, "bundle.tgz"))} -C ${psQuote(join(home, "input"))} .; if ($LASTEXITCODE -ne 0) { throw 'fixture archive failed' }`);
    const manifest = join(home, "manifest.json");
    const writeManifest = async () => writeFileSync(manifest, JSON.stringify({ version: REMOTE_BUNDLE_VERSION, assets: { "win32-x64": { url: "bundle.tgz", sha256: createHash("sha256").update(new Uint8Array(await Bun.file(join(home, "bundle.tgz")).arrayBuffer())).digest("hex") } } }));
    await writeManifest();
    process.env["HERDR_WEB_BUNDLE_MANIFEST"] = manifest;
    await windowsHost.installBundle(ssh, "win32-x64", AbortSignal.timeout(60_000));
    expect(existsSync(join(runtime, "bin", "bun.exe"))).toBe(true);
    const target = realpathSync(runtime);
    writeFileSync(join(home, "bundle.tgz"), "invalid archive with a valid manifest checksum");
    await writeManifest();
    await expect(windowsHost.installBundle(ssh, "win32-x64", AbortSignal.timeout(60_000))).rejects.toThrow();
    expect(realpathSync(runtime)).toBe(target);
    expect(existsSync(join(home, "t-rex", "install.lock"))).toBe(false);
    expect(existsSync(join(home, "t-rex", `install.${process.pid}`))).toBe(false);
  } finally {
    if (before === undefined) delete process.env["HERDR_WEB_BUNDLE_MANIFEST"]; else process.env["HERDR_WEB_BUNDLE_MANIFEST"] = before;
    // Remove the junction separately: the immutable release is cleaned with the fixture.
    if (existsSync(runtime)) await runPowerShell(`[IO.Directory]::Delete(${psQuote(runtime)})`);
    rmSync(home, { recursive: true, force: true });
  }
}, 120_000);

it.skipIf(!onWindows)("reads this PC's process table: this process, its parent, when it started and what it runs", async () => {
  const rows = await windowsProcessTable(30_000);
  const self = rows.find((row) => row.pid === process.pid);
  expect(self).toBeDefined();
  expect(self!.parent).toBe(process.ppid);
  // ms since 1970, as Date.now() counts: started before now, and not a day ago
  expect(typeof self!.started).toBe("number");
  expect(self!.started!).toBeLessThanOrEqual(Date.now() + 2000);
  expect(self!.started!).toBeGreaterThan(Date.now() - 24 * 60 * 60 * 1000);
  expect((self!.path ?? "").toLowerCase()).toContain("bun");
  // found from its parent the way a pane's program is found from the pane's shell
  expect(descendantArgv(rows, process.ppid).some((argv) => (argv[0] ?? "").toLowerCase() === (self!.path ?? "").toLowerCase())).toBe(true);
}, 40_000);

it.skipIf(!onWindows)("finds a Claude's own store from the start it records, which the process table repeats", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "herdr-claude-native-")));
  const serverConfigDir = process.env["CLAUDE_CONFIG_DIR"];
  delete process.env["CLAUDE_CONFIG_DIR"];
  try {
    const session = "0b8e6f0e-8d3f-4c1a-9a53-6c2b7a1d9e42";
    // Claude records its start as FILETIME ticks, as PowerShell gives them
    const probe = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${process.pid}).StartTime.ToFileTimeUtc()`], { stdin: "ignore", stderr: "ignore" });
    const procStart = probe.stdout.toString().trim();
    expect(procStart).toMatch(/^\d+$/);
    const user = join(home, "User With Spaces");
    const store = join(user, ".claude-second");
    mkdirSync(join(store, "sessions"), { recursive: true });
    mkdirSync(join(user, ".claude", "sessions"), { recursive: true });
    const record = (start: string) => writeFileSync(join(store, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: session, procStart: start, kind: "interactive" }));
    // a millisecond off is another process that had this PID
    record(String(BigInt(procStart) + 10_000n));
    expect(await claudeProcessSession(user, process.pid, store)).toBeNull();
    record(procStart);
    expect(await claudeProcessSession(user, process.pid, store)).toBe(session);
    expect(await processClaudeConfigDir(process.pid, [process.execPath], user)).toBe(store);
  } finally {
    forgetClaudeSessions();
    if (serverConfigDir !== undefined) process.env["CLAUDE_CONFIG_DIR"] = serverConfigDir;
    rmSync(home, { recursive: true, force: true });
  }
});

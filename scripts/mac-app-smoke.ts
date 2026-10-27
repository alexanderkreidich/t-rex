/**
 * Opens the built Mac app as a user would and checks what it did (docs/macos.md): it started herdr
 * and the bridge it carries, the bridge can attach terminals (the bundle's Node and node-pty run),
 * the window shows T-Rex from that bridge, and quitting stops the bridge while herdr keeps running.
 * Written for CI's disposable Mac: on a Mac of your own its window takes the keyboard, and it starts
 * your herdr when none runs and no bridge is registered for it.
 *
 *   bun scripts/mac-app-smoke.ts macos/build/T-Rex.app
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const app = resolve(process.argv[2] ?? "");
const executable = join(app, "Contents", "MacOS", "T-Rex");
if (!existsSync(executable)) throw new Error(`No app at ${app}; usage: bun scripts/mac-app-smoke.ts <path to T-Rex.app>`);
const socket = process.env["HERDR_SOCKET"] || join(process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config"), "herdr", "herdr.sock");

async function until<T>(what: string, check: () => Promise<T | null> | T | null, timeoutMs: number): Promise<T> {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline;) {
    const found = await check();
    if (found !== null) return found;
    await Bun.sleep(250);
  }
  throw new Error(`Timed out waiting until ${what}`);
}

async function json(url: string): Promise<any> {
  try {
    return await (await fetch(url, { signal: AbortSignal.timeout(2000) })).json();
  } catch {
    return null;
  }
}

/** The port of the bridge server/bridge.ts registered for herdr's socket, as the app reads it. */
function registered(): number | null {
  if (!existsSync(socket)) return null;
  // as server/bridge.ts: realpath of a socket can fail (EOPNOTSUPP under Bun), the path stands then
  let real = socket;
  try { real = realpathSync(socket); } catch { /* the path as it is */ }
  const name = createHash("sha256").update(real).digest("hex");
  try {
    return (JSON.parse(readFileSync(join(homedir(), ".config/t-rex/bridges", `${name}.json`), "utf8")) as { port: number }).port;
  } catch {
    return null;
  }
}

if (registered() !== null) throw new Error("A bridge is registered for this herdr: the smoke needs the app to start its own");
const output: string[] = [];
const child = spawn(executable, [], { stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", (data: Buffer) => { output.push(data.toString()); process.stdout.write(data); });
child.stderr.on("data", (data: Buffer) => process.stderr.write(data));
let port: number;
try {
  port = await until("the app's bridge registers for herdr", registered, 90_000);
  const health = await until("herdr and the bridge answer", async () => {
    const body = await json(`http://127.0.0.1:${port}/api/health`);
    return body?.ok && body.herdr?.version ? body : null;
  }, 60_000);
  console.log(`bridge on ${port}: herdr ${health.herdr.version}, terminal attach ${health.herdr.terminal_attach}`);
  if (health.herdr.terminal_attach !== true) throw new Error("The bridge cannot attach terminals: the bundle's Node or node-pty did not run");
  const shown = await until("the window shows T-Rex", () => output.join("").match(/T-Rex: the window shows (\S+)/)?.[1] ?? null, 60_000);
  if (new URL(shown).port !== String(port)) throw new Error(`The window shows ${shown}, not the bridge on ${port}`);
  // a picture of the window for the run (the app's --snapshot, on the bridge this one started)
  const snapshot = process.env["T_REX_SNAPSHOT"];
  if (snapshot) {
    const shot = spawnSync(executable, ["--snapshot", snapshot], { env: { ...process.env, T_REX_URL: shown }, encoding: "utf8", timeout: 90_000 });
    console.log(shot.stdout.trim());
  }
} finally {
  child.kill("SIGTERM");
}
await until("the bridge stops with the app", async () => (await json(`http://127.0.0.1:${port}/api/health?scope=bridge`)) ? null : true, 20_000);
console.log("the bridge stopped with the app");
const herdr = spawnSync("herdr", ["status", "server"], { encoding: "utf8" });
if (!/running/.test(herdr.stdout) || /not running/.test(herdr.stdout)) throw new Error(`herdr stopped with the app: it must keep the panes running\n${herdr.stdout}`);
console.log("herdr keeps running");

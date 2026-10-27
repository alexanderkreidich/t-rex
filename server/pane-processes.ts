/**
 * What runs in a pane, read from herdr's process info: whether omo is the agent there (whatever
 * herdr labels it), the roots and environment of the foreground agent, and a Claude pane's process
 * and session transcript (its subagents and background work are read from it: claude-subagents.ts).
 */
import { realpathSync, statSync } from "node:fs";
import nodePath from "node:path";

import type { HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import { AmbiguousClaudeStore, claudeProcessSession, claudeTranscriptFile, defaultClaudeConfigDir, isClaudeProcess, processClaudeConfigDir } from "./claude-store.ts";
import { herdrRpc } from "./herdr/client.ts";
import { omoProcessIdentity, processEnviron } from "./omo.ts";
import { processStartedAt } from "./process-start.ts";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A Claude pane whose session has no transcript yet, or none that can be told apart. */
class NoTranscript extends Error {}

/**
 * Is omo the agent in this pane, whatever herdr currently labels it? A probe
 * failure answers "no": the caller then reports why the labelled store failed,
 * which is the more useful error.
 */
export async function paneRunsOmo(paneId: string): Promise<boolean> {
  // pane.process_info wants `pane_id`; given `target` herdr answers for the
  // FOCUSED pane instead of erroring (live-verified 2026-09-21).
  const info = await herdrRpc<{ process_info?: { foreground_processes?: { pid?: unknown; argv?: unknown; cwd?: unknown }[] } }>(
    "pane.process_info",
    { pane_id: paneId },
  ).catch(() => null);
  const home = process.env["HOME"] ?? "";
  return (info?.process_info?.foreground_processes ?? []).some((process) =>
    // a pid herdr does not report keeps the argv-only proof and fails the custom one closed
    omoProcessIdentity({
      pid: typeof process.pid === "number" ? process.pid : -1,
      argv: Array.isArray(process.argv) ? process.argv.map(String) : undefined,
      cwd: typeof process.cwd === "string" && process.cwd ? process.cwd : undefined,
    }, "", home) !== null,
  );
}

/** Loaded roots and environment belong to the foreground agent, not the web server. */
export async function paneProcessRoots(paneId: string, agent: string | null | undefined): Promise<{
  /** `held`: the omo process holds a session there (its own holder record), not only an omo-ai path in its argv. */
  omo: { agentDir: string | null; pluginDir: string | null; held: boolean } | null;
  environ: string[] | null;
  pid: number | null;
  cwd: string | null;
}> {
  const info = await herdrRpc<{ process_info?: { foreground_processes?: { pid?: unknown; argv?: unknown; cwd?: unknown }[] } }>(
    "pane.process_info", { pane_id: paneId },
  ).catch(() => null);
  const home = process.env["HOME"] ?? "";
  const directory = (path: string | null): string | null => {
    try { return path && statSync(path).isDirectory() ? path : null; } catch { return null; }
  };
  let matched: { pid: number; cwd: string } | null = null;
  for (const candidate of info?.process_info?.foreground_processes ?? []) {
    const process = {
      pid: typeof candidate.pid === "number" ? candidate.pid : -1,
      argv: Array.isArray(candidate.argv) ? candidate.argv.map(String) : [],
      cwd: typeof candidate.cwd === "string" ? candidate.cwd : "",
    };
    const binary = (word: string): string => nodePath.posix.basename(word.replace(/\\/g, "/")).replace(/\.(?:exe|cmd|js|mjs|cjs)$/i, "");
    const executable = binary(process.argv[0] ?? "");
    const launched = ["node", "bun", "python", "python3"].includes(executable) ? binary(process.argv[1] ?? "") : executable;
    if (!matched && agent && ["claude", "codex", "omp", "gjc", "pi", "opencode", "devin", "grok", "hermes", "agy"].includes(agent) && launched === agent) {
      matched = process;
    }
    const identity = omoProcessIdentity(process, "", home);
    if (!identity) continue;
    const agentDir = directory(identity.agentDir);
    const argv = process.argv.map((word) => word.replace(/\\/g, "/"));
    const extension = argv.find((word, index) => argv[index - 1] === "--extension" && /\/omo-ai\/plugin\/?$/.test(word));
    let pluginDir = directory(extension ? nodePath.resolve(process.cwd, extension) : null);
    if (!pluginDir) {
      const word = argv.find((word) => word.includes("/omo-ai/"));
      if (word) {
        try {
          const canonical = realpathSync(nodePath.resolve(process.cwd, word));
          const paths = nodePath.win32.isAbsolute(canonical) && !nodePath.posix.isAbsolute(canonical) ? nodePath.win32 : nodePath.posix;
          for (let parent = paths.dirname(canonical); parent !== paths.dirname(parent); parent = paths.dirname(parent)) {
            if (paths.basename(parent) === "omo-ai") {
              pluginDir = directory(paths.join(parent, "plugin"));
              break;
            }
          }
        } catch { /* launcher may have gone away; try the installed executable */ }
      }
    }
    if (!pluginDir) {
      const executable = Bun.which("omo");
      if (executable) {
        try { pluginDir = directory(nodePath.join(nodePath.dirname(nodePath.dirname(realpathSync(executable))), "plugin")); }
        catch { /* no readable installed plugin */ }
      }
    }
    // a holder counts only while this pid's start is readable: without it (Windows) a crashed omo's
    // record could name a pid another process reuses
    const held = identity.heldIds.length > 0 && processStartedAt(process.pid) !== null;
    return { omo: { agentDir, pluginDir, held }, environ: processEnviron(process.pid), pid: process.pid, cwd: process.cwd || null };
  }
  return { omo: null, environ: matched ? processEnviron(matched.pid) : null, pid: matched?.pid ?? null, cwd: matched?.cwd || null };
}

/**
 * herdr labels an omo pane `pi` while it waits and `claude` while omo's claude-sdk child
 * runs, so the sidebar showed another agent's mark, and one that changed as omo worked.
 * The snapshots the browser gets name such a pane `omo`, decided by its process tree
 * (paneRunsOmo), including panes herdr has not recognized as an agent.
 */
export async function labelOmoPanes(snapshot: SessionSnapshot): Promise<SessionSnapshot> {
  const candidates = snapshot.panes;
  const omo = new Set<string>();
  await Promise.all(candidates.map(async (pane) => { if (await paneRunsOmo(pane.pane_id)) omo.add(pane.pane_id); }));
  if (omo.size === 0) return snapshot;
  return {
    ...snapshot,
    panes: snapshot.panes.map((pane) => omo.has(pane.pane_id) ? { ...pane, agent: "omo" } : pane),
    agents: snapshot.agents.map((agent) => omo.has(agent.pane_id) ? { ...agent, agent: "omo" } : agent),
  };
}

/** The Claude processes in a pane's foreground; none when herdr cannot say. */
async function claudeProcesses(paneId: string): Promise<{ pid: number; name?: string; argv0?: string; argv?: string[] }[]> {
  try {
    const processInfo = await herdrRpc<{ process_info?: { foreground_processes?: { pid: number; name?: string; argv0?: string; argv?: string[] }[] } }>(
      "pane.process_info", { pane_id: paneId },
    );
    return processInfo.process_info?.foreground_processes?.filter(isClaudeProcess) ?? [];
  } catch { return []; /* herdr busy: the default store */ }
}

/** The pid of the one Claude process in a pane's foreground, or null. */
export async function claudePanePid(pane: HerdrPane): Promise<number | null> {
  const processes = await claudeProcesses(pane.pane_id);
  return processes.length === 1 ? processes[0]!.pid : null;
}

/**
 * Claude's transcript: Herdr's hook, or a unique live Claude's native PID record, in the config dir
 * of the pane's Claude process (a launcher can give each environment its own CLAUDE_CONFIG_DIR).
 */
async function claudeTranscriptPath(paneId: string, cwds: readonly (string | null | undefined)[], onProcess?: (pid: number) => void): Promise<string> {
  const info = await herdrRpc<{ agent: { agent_session?: { value?: unknown } } }>("agent.get", { target: paneId });
  let session = info.agent.agent_session?.value;
  const home = process.env["HOME"] ?? "";
  const processes = await claudeProcesses(paneId);
  const only = processes.length === 1 ? processes[0] : undefined;
  if (only) onProcess?.(only.pid);
  let processDir: string | null = null;
  try {
    processDir = only ? await processClaudeConfigDir(only.pid, only.argv ?? [only.argv0 ?? only.name ?? ""], home) : null;
  } catch (error) {
    // two stores claim the process: ~/.claude would be a guess, maybe another account's session (#586)
    if (error instanceof AmbiguousClaudeStore) throw new NoTranscript();
    throw error;
  }
  const configDir = processDir || defaultClaudeConfigDir(home);
  if ((typeof session !== "string" || !SESSION_ID.test(session)) && only) session = await claudeProcessSession(home, only.pid, configDir);
  if (typeof session !== "string" || !SESSION_ID.test(session)) throw new NoTranscript();
  const path = await claudeTranscriptFile(home, session, cwds, configDir);
  // Claude writes the file with its first message: until then the session it reports holds nothing
  if (!path) throw new NoTranscript();
  return path;
}

/** A Claude pane's transcript and when its Claude process started (null when it cannot be told), or null while it has no transcript. */
export async function claudePaneSession(pane: HerdrPane): Promise<{ path: string; startedAt: number | null; pid: number | null } | null> {
  let pid: number | null = null;
  try {
    const path = await claudeTranscriptPath(pane.pane_id, [pane.cwd, pane.foreground_cwd], (found) => { pid = found; });
    return { path, startedAt: pid === null ? null : processStartedAt(pid), pid };
  } catch (error) {
    if (error instanceof NoTranscript) return null;
    throw error;
  }
}

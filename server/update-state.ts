/** Where app state and managed-update state live. Dependency-free on purpose: the launcher
 * (server/managed.ts) imports it and must stay small and stable across releases. */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * HERDR_WEB_STATE_DIR, else `t-rex` in the config dir. The dir the app used before it was named
 * T-Rex is kept while it exists: nothing moves it under a server that may still run from it.
 * Moving its files into `t-rex` with the app stopped retires it.
 */
export function stateDirFor(env: Record<string, string | undefined>): string {
  const override = env["HERDR_WEB_STATE_DIR"];
  if (override) return override;
  const config = env["XDG_CONFIG_HOME"] || join(homedir(), ".config");
  const before = join(config, "herdr-web-ui");
  return existsSync(before) ? before : join(config, "t-rex");
}

export function defaultStateDir(): string {
  return stateDirFor(process.env);
}

/** One update state per source checkout and port, so two checkouts or ports never share builds. */
export function updateStateDir(root: string, port: number, stateDir = defaultStateDir()): string {
  return join(resolve(stateDir), "updates",
    createHash("sha256").update(`${resolve(root)}:${port}`).digest("hex").slice(0, 16));
}

/** A supervisor exits with this after an install: "start the supervisor of the release now active"
 * (EX_TEMPFAIL, never a crash code). */
export const HANDOVER_EXIT = 75;

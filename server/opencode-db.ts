import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The database OpenCode writes to, by the rules it reads its own paths by; null for an in-memory one. */
export function opencodeDatabasePath(env: Record<string, string | undefined> = process.env, home = homedir()): string | null {
  const named = env["OPENCODE_DB"];
  if (named === ":memory:") return null;
  const data = join(env["XDG_DATA_HOME"] || join(home, ".local", "share"), "opencode");
  return named ? resolve(data, named) : join(data, "opencode.db");
}

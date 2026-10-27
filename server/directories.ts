import { mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { DirectoryListing } from "../shared/protocol.ts";

/** A folder with more subfolders than this lists the first ones and says it stopped. */
export const MAX_DIRECTORY_ENTRIES = 500;

/** A folder name past this many bytes is refused before the filesystem is asked (255 on every common filesystem). */
const MAX_NAME_BYTES = 255;

/** `path` in the dialog's syntax (absolute, `~`, `~/…`, empty for home), resolved against the server's own folder. */
function resolveFolder(path: string, home: string): string {
  const trimmed = path.trim();
  return trimmed === "" || trimmed === "~" ? home : trimmed.startsWith("~/") ? resolve(home, trimmed.slice(2)) : resolve(trimmed);
}

export type CreateDirectoryResult =
  | { path: string }
  | { error: "invalid_cwd" | "invalid_name" | "folder_exists" | "permission_denied" };

/**
 * Makes one folder named `name` directly inside `parent` (the folder the browser shows) and
 * answers its absolute path. `name` is one path segment: no separator, not `.` or `..`, so
 * nothing is made anywhere but inside `parent`; nothing is made recursively or overwritten.
 */
export function createDirectory(parent: string, name: string): CreateDirectoryResult {
  const target = resolveFolder(parent, homedir());
  try {
    if (!statSync(target).isDirectory()) return { error: "invalid_cwd" };
  } catch {
    return { error: "invalid_cwd" };
  }
  const folder = name.trim();
  if (folder === "" || folder === "." || folder === ".." || /[/\\\0]/.test(folder) || Buffer.byteLength(folder) > MAX_NAME_BYTES) return { error: "invalid_name" };
  const path = join(target, folder);
  try {
    mkdirSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return { error: "folder_exists" };
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") return { error: "permission_denied" };
    // the parent went away meanwhile; a name Windows will not take (`a:b`, `con`) is EINVAL or ENOENT there
    if (code === "ENOENT" || code === "ENOTDIR") return { error: process.platform === "win32" ? "invalid_name" : "invalid_cwd" };
    if (code === "EINVAL" || code === "ENAMETOOLONG") return { error: "invalid_name" };
    throw error;
  }
  return { path };
}

/**
 * The folders inside one directory, for the palette's folder browsing. One
 * directory at a time, names only, nothing kept between calls: the cost is one readdir.
 * `path` takes an absolute path, `~` or `~/…` (as the palette takes it); empty means home.
 * Hidden folders (a leading dot) are left out unless asked for. Null when `path` is not
 * a directory this user can read.
 */
export function listDirectories(path: string, hidden = false): DirectoryListing | null {
  const home = homedir();
  const target = resolveFolder(path, home);
  let entries;
  try {
    if (!statSync(target).isDirectory()) return null;
    entries = readdirSync(target, { withFileTypes: true });
  } catch {
    return null;
  }
  const directories: string[] = [];
  for (const entry of entries) {
    if (!hidden && entry.name.startsWith(".")) continue;
    let isDirectory = entry.isDirectory();
    // a link is what it points at (a dangling or looping one is neither)
    if (entry.isSymbolicLink()) {
      try { isDirectory = statSync(join(target, entry.name)).isDirectory(); } catch { isDirectory = false; }
    }
    if (isDirectory) directories.push(entry.name);
  }
  directories.sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base", numeric: true }));
  const parent = dirname(target);
  return {
    path: target,
    parent: parent === target ? null : parent,
    home,
    directories: directories.slice(0, MAX_DIRECTORY_ENTRIES),
    truncated: directories.length > MAX_DIRECTORY_ENTRIES,
  };
}

/** Windows paths in the one spelling the stores (Claude's, Codex's) and herdr can be compared in. */

/**
 * A Windows path without the `\\?\` prefix that Codex on Windows stores in `threads` (`cwd`,
 * `rollout_path`), as Rust's canonical paths carry it: `\\?\D:\x` is `D:\x` and
 * `\\?\UNC\host\share` is `\\host\share` (#518). Any other path, `\\?\Volume{…}\` included, is
 * returned as it is: without its prefix it would read as a relative path.
 */
export function withoutVerbatimPrefix(path: string): string {
  if (!path.startsWith("\\\\?\\")) return path;
  const rest = path.slice(4);
  if (/^UNC\\/i.test(rest)) return `\\\\${rest.slice(4)}`;
  return /^[A-Za-z]:\\/.test(rest) ? rest : path;
}

/**
 * A Windows cwd in one spelling for every way Codex and herdr may write it: without `\\?\` and
 * with an upper-case drive letter (`d:\work` and `\\?\D:\work` are `D:\work`). The rest is
 * compared as it is: a Windows directory can be case-sensitive, and nothing short of the file
 * system tells `app` from `App`, so a cwd stored in another letter case finds nothing (#587).
 */
export function directoryKey(cwd: string): string {
  const plain = withoutVerbatimPrefix(cwd);
  return /^[a-z]:\\/.test(plain) ? plain[0]!.toUpperCase() + plain.slice(1) : plain;
}

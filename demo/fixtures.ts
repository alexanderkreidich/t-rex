/**
 * The fictional session behind the demo fixtures (scripts/demo-stage.ts) and the browser
 * demo (demo/transport.ts): two repositories with two agent worktrees each and a shell tab.
 * Nothing here comes from a real machine. It imports no server code, so the browser bundle can take it.
 */

export interface DemoSpec {
  key: string;
  /** the workspace's label and the folder name: under the demo root, or under herdr's worktrees folder */
  label: string;
  /** the pane's title */
  title: string;
  agent: string | null;
  state?: "idle" | "working" | "blocked";
  /** a linked worktree of this repository spec's key, checked out on `branch` */
  worktreeOf?: string;
  branch?: string;
  /** a second tab, labelled `label`, in this spec's workspace instead of a workspace of its own */
  tabOf?: string;
}

// The sidebar reads as two repositories, each with its own agent and two agent worktrees under it.
export const SPECS: DemoSpec[] = [
  { key: "api", label: "checkout-api", title: "Idempotent payments", agent: "claude", state: "working" },
  { key: "web", label: "export-guard", title: "Guard the export button", agent: "codex", state: "blocked", worktreeOf: "api", branch: "feat/export-guard" },
  { key: "flaky", label: "flaky-retry-test", title: "Fix the flaky retry test", agent: "claude", state: "idle", worktreeOf: "api", branch: "fix/flaky-retry-test" },
  { key: "omp", label: "cli-tools", title: "Plan the config file", agent: "omp", state: "idle" },
  { key: "cli", label: "retry-flag", title: "Ship the retry flag", agent: "pi", state: "idle", worktreeOf: "omp", branch: "feat/retry-flag" },
  { key: "hermes", label: "changelog", title: "Draft the changelog", agent: "hermes", state: "idle", worktreeOf: "omp", branch: "docs/changelog" },
  { key: "shell", label: "release", title: "Tag v1.4.0", agent: null, tabOf: "api" },
];

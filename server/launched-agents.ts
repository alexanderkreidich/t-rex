import type { AgentStatus } from "../shared/protocol.ts";

/**
 * Panes this server started an agent in (New workspace, New tab, New worktree), until their
 * first turn: the launch itself is the evidence that the agent has done no work yet.
 *
 * It ends with the first turn (the agent at work or asking after it was seen at rest), or with
 * the pane. Until the agent was seen at rest its status is
 * its startup's: Codex reports `working` while it draws, Claude `blocked` at its folder question.
 */
/** the agents whose start screen is told from a first turn here */
const KINDS = new Set(["agy", "claude", "codex", "devin", "gjc", "grok", "hermes", "omo", "omp", "opencode", "pi"]);

/** A startup longer than this is taken for a first turn. */
export const STARTUP_MS = 30_000;

interface Launch { at: number; rested: boolean }

export class LaunchedAgents {
  private readonly panes = new Map<string, Launch>();

  launched(paneId: string, kind: string, now = Date.now()): void {
    if (!KINDS.has(kind)) { this.panes.delete(paneId); return; }
    this.panes.set(paneId, { at: now, rested: false });
  }

  /** Whether the pane's agent has not begun its first turn yet. */
  notBegun(paneId: string, status: AgentStatus | undefined, now = Date.now()): boolean {
    const launch = this.panes.get(paneId);
    if (launch === undefined) return false;
    const busy = status === "working" || status === "blocked";
    if (!busy && (status === "idle" || status === "done")) launch.rested = true;
    if (busy && (launch.rested || now - launch.at > STARTUP_MS)) { this.panes.delete(paneId); return false; }
    return true;
  }

  /**
   * The status to take for one herdr read off the pane. Before the first turn there is no work and
   * no finish: an agent drawing its start screen reads `working` and then `done` (Codex, live
   * 2026-10-14), which showed DONE on a pane nobody had asked anything of. A question it asks
   * (Claude's folder question) is a question all the same.
   */
  settle(paneId: string, status: AgentStatus, now = Date.now()): AgentStatus {
    const unbegun = this.notBegun(paneId, status, now);
    return unbegun && (status === "working" || status === "done") ? "idle" : status;
  }

  forget(paneId: string): void { this.panes.delete(paneId); }
  clear(): void { this.panes.clear(); }
}

export const launchedAgents = new LaunchedAgents();

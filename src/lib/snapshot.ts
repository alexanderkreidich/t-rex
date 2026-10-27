import type { AgentStatus, HerdrPane, SessionSnapshot } from "../../shared/protocol.ts";

/**
 * Merges a pushed `pane-status` into the last snapshot so the sidebar badge updates
 * instantly; the debounced /api/session refetch that follows brings the derived
 * workspace/tab rollups back in line. Pure: returns the same object when nothing changed.
 */
export function applyPaneStatus(snapshot: SessionSnapshot, paneId: string, status: AgentStatus, background?: number, waiting = false, finishId?: number, finishEpoch?: string): SessionSnapshot {
  const epochChanged = snapshot.finish_epoch !== finishEpoch;
  let paneChanged = epochChanged;
  const panes = snapshot.panes.map((pane: HerdrPane) => {
    if (pane.pane_id !== paneId) {
      if (!epochChanged) return pane;
      const { finish_id: _finish, ...rest } = pane;
      return rest;
    }
    // a frame that says nothing of background tasks leaves them as they were; every frame says whether the pane waits
    const tasks = background === undefined ? pane.background_tasks : background > 0 ? background : undefined;
    if (pane.agent_status === status && pane.finish_id === finishId && pane.background_tasks === tasks && (pane.background_wait === true) === waiting) return pane;
    paneChanged = true;
    const { background_tasks: _before, background_wait: _waited, finish_id: _finish, ...rest } = pane;
    return { ...rest, agent_status: status, ...(finishId === undefined ? {} : { finish_id: finishId }), ...(tasks === undefined ? {} : { background_tasks: tasks }), ...(waiting ? { background_wait: true as const } : {}) };
  });
  if (!paneChanged) return snapshot;
  const agents = snapshot.agents.map((agent) =>
    agent.pane_id === paneId && agent.agent_status !== status ? { ...agent, agent_status: status } : agent,
  );
  return { ...snapshot, finish_epoch: finishEpoch, panes, agents };
}

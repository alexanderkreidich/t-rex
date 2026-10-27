import type { AgentStatus } from "../../shared/protocol.ts";
import { shouldNotifyStatus } from "../../shared/notify-policy.ts";
import { paneStorageId } from "../../shared/machines.ts";

/**
 * The last status each pane was seen in, by `paneStorageId`: the baseline that decides whether a
 * status event is news worth an alert. A roster takes what is no news and forgets panes no PC
 * lists any more; news stays for its status event, which the roster can show first (herdr is read
 * on its own), so the event still alerts.
 */
export function seedStatuses(
  known: Map<string, AgentStatus>,
  machines: readonly { id: string; snapshot?: { panes: readonly { pane_id: string; agent_status: AgentStatus }[] } | null }[],
): void {
  const listed = new Set<string>();
  for (const machine of machines) for (const pane of machine.snapshot?.panes ?? []) {
    const key = paneStorageId(machine.id, pane.pane_id);
    listed.add(key);
    const previous = known.get(key);
    if (previous === pane.agent_status || shouldNotifyStatus(previous, pane.agent_status)) continue;
    known.set(key, pane.agent_status);
  }
  for (const key of [...known.keys()]) if (!listed.has(key)) known.delete(key);
}

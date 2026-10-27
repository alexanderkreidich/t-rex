import type { Machine } from "../../shared/machines.ts";
import type { TabCreated } from "../../shared/protocol.ts";

/** Creation replies are newer than the roster cache and SSE messages already in flight.
 * Keep their panes mounted until a roster acknowledges them (or the pane exits). */
export class CreatedTabs {
  private readonly pending = new Map<string, { machineId: string; created: TabCreated; at: number }>();
  constructor(private readonly now = Date.now) {}

  add(machineId: string, created: TabCreated): void {
    if (created.tab && created.pane) this.pending.set(`${machineId}/${created.pane_id}`, { machineId, created, at: this.now() });
  }

  forget(machineId: string, paneId: string): void { this.pending.delete(`${machineId}/${paneId}`); }

  apply(machines: Machine[]): Machine[] {
    if (this.pending.size === 0) return machines;
    return machines.map((machine) => {
      let snapshot = machine.snapshot;
      if (!snapshot) return machine;
      for (const [key, item] of this.pending) {
        if (item.machineId !== machine.id) continue;
        const { tab, pane } = item.created;
        if (!tab || !pane) continue;
        const hasTab = snapshot.tabs.some((entry) => entry.tab_id === tab.tab_id);
        const hasPane = snapshot.panes.some((entry) => entry.pane_id === pane.pane_id);
        // Do not retain a phantom pane forever if creation raced an external close or disconnect.
        if ((hasTab && hasPane) || this.now() - item.at > 10_000) {
          this.pending.delete(key);
          continue;
        }
        if (!snapshot.workspaces.some((entry) => entry.workspace_id === tab.workspace_id)) continue;
        snapshot = { ...snapshot,
          tabs: hasTab ? snapshot.tabs : [...snapshot.tabs, tab],
          panes: hasPane ? snapshot.panes : [...snapshot.panes, pane],
          workspaces: hasTab ? snapshot.workspaces : snapshot.workspaces.map((workspace) => workspace.workspace_id === tab.workspace_id
            ? { ...workspace, tab_count: workspace.tab_count + 1 } : workspace),
        };
      }
      return snapshot === machine.snapshot ? machine : { ...machine, snapshot };
    });
  }
}

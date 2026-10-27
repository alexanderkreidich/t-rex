import type { HerdrPane, PaneInfo } from "../../shared/protocol.ts";
import { paneStatus } from "./status.ts";

/**
 * The pane a tab opens, among its own: the one last seen there in this browser (lib/lastViewedPane.ts),
 * else the one herdr keeps focused in the tab's layout, else the one it marks focused, else the first.
 * The tab strip and focus mode's tab rows (Sidebar) open the same pane.
 */
export function tabPane<P extends Pick<PaneInfo, "pane_id" | "focused">>(own: readonly P[], lastViewedId: string | null | undefined, layoutFocusedId: string | null | undefined): P | undefined {
  const pick = (id: string | null | undefined) => (id ? own.find((pane) => pane.pane_id === id) : undefined);
  return pick(lastViewedId) ?? pick(layoutFocusedId) ?? own.find((pane) => pane.focused) ?? own[0];
}

/**
 * Whether closing a tab asks first: it is its workspace's last (the workspace closes with it), or an
 * agent in it is at work, waits on an answer, or waits on its turn's background work, which would
 * stop with it.
 */
export function tabCloseAsks(own: readonly Pick<HerdrPane, "agent_status" | "background_wait">[], tabCount: number): boolean {
  if (tabCount <= 1) return true;
  return own.some((pane) => {
    const status = paneStatus(pane);
    return status === "working" || status === "blocked" || status === "waiting";
  });
}

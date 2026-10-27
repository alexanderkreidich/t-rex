/**
 * What the shell lets its surfaces do. App builds one AppActions object and hands it
 * to the header, the sidebar, the command palette and the settings dialog, so a
 * keyboard shortcut, a palette row and a sidebar button all run the same code.
 */

import type { SplitPaneDirection } from "../../shared/protocol.ts";
import type { ZoomMode } from "./layoutMap.ts";

/** The selected pane’s mounted input and history, bound to its PC. */
export interface PaneControls {
  focusInput: () => void;
  scrollPage: (direction: -1 | 1) => void;
}

export interface AppActions {
  selectPane: (paneId: string) => void;
  /** the previous/next pane in sidebar order; wraps around */
  selectAdjacentPane: (direction: -1 | 1) => void;
  /** Focus the selected pane's mounted input without sending any text or keys. */
  focusInput: () => void;
  scrollPage: (direction: -1 | 1) => void;
  /**
   * A workspace on that PC (the selected one by default) with a shell in its home, at once and
   * with no dialog; it opens unless another pane was opened meanwhile. A refusal is said over the pane.
   */
  openNewSession: (machineId?: string) => void;
  /** openTerminalTab for the selected pane's workspace, from a key or the palette: a refusal is said over the pane */
  openNewTab: () => void;
  /**
   * A shell tab in the same workspace, at once and with no dialog, as herdr's own new tab: the
   * new pane opens unless another one was opened meanwhile. Rejects with herdr's refusal.
   */
  openTerminalTab: (target?: { machineId: string; workspaceId: string }) => Promise<void>;
  /** the palette, blank or opened on `query` (a `>` prefix keeps the actions alone) */
  openPalette: (query?: string) => void;
  openFind: () => void;
  openSettings: () => void;
  /** the Add PC dialog, from Settings → Remote PCs and the palette; Settings closes first */
  openAddPc: () => void;
  toggleSidebar: () => void;
  /** Focus mode on or off (Settings.focusMode): the tabs under their workspaces, no bar over the pane */
  toggleFocusMode: () => void;
  /** flips dark/light (a `system` setting becomes the opposite of the resolved theme) */
  toggleTheme: () => void;
  /** Sign out of token/device authentication; null for automatic local/Tailscale access. */
  lock: (() => Promise<void>) | null;
  /** null once alerts are on (or unsupported); otherwise asks for permission */
  enableNotifications: (() => void) | null;
  refresh: () => void;
  /**
   * herdr's split beside the selected pane (its prefix+v and prefix+-), null without a pane. The
   * selection stays on this pane, as herdr's --no-focus keeps its focus, unless `focus` asks for
   * the new pane: then herdr focuses it and the app opens it.
   */
  splitPane: ((direction: SplitPaneDirection, focus?: boolean) => void) | null;
  /**
   * herdr's prefix+z on the selected pane, with the mode the caller's item names (`zoomMode`,
   * lib/layoutMap.ts): its tab shows it alone, or every pane again; null without a pane
   */
  zoomPane: ((mode: ZoomMode) => void) | null;
}

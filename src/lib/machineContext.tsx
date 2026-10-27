import { createContext, useContext, useMemo } from "react";
import * as api from "./api.ts";
import type { CreateWorktreeRequest, OpenWorktreeRequest, PaneDirection, PluginActionRequest, RemoveWorktreeRequest, SplitPaneDirection } from "../../shared/protocol.ts";
import type { ZoomMode } from "./layoutMap.ts";
export const MachineContext = createContext("local");
export const useMachineId = () => useContext(MachineContext);
/** Bound functions retain their owner across an async upload or a fast PC switch. */
export function useMachineApi() {
  const id = useMachineId();
  return useMemo(() => ({
    uploadPaneImage: (pane: string, image: Blob) => api.uploadPaneImage(pane, image, id),
    findPane: (request: Parameters<typeof api.findPane>[0]) => api.findPane(request, id),
    fetchPaneScroll: (pane: string) => api.fetchPaneScroll(pane, id),
    scrollPane: (pane: string, offset: number) => api.scrollPane(pane, offset, id),
    closePane: (pane: string) => api.closePane(pane, id),
    focusPane: (pane: string) => api.focusPane(pane, id),
    closeWorkspace: (workspace: string, closeGroup = false) => api.closeWorkspace(workspace, id, closeGroup),
    createWorktree: (request: CreateWorktreeRequest) => api.createWorktree(request, id),
    listWorktrees: (workspace: string) => api.listWorktrees(workspace, id),
    openWorktree: (request: OpenWorktreeRequest) => api.openWorktree(request, id),
    removeWorktree: (request: RemoveWorktreeRequest) => api.removeWorktree(request, id),
    renamePane: (pane: string, label: string) => api.renamePane(pane, label, id),
    renameAgent: (pane: string, name: string | null) => api.renameAgent(pane, name, id),
    splitPane: (pane: string, direction: SplitPaneDirection, focus = false) => api.splitPane(pane, direction, focus, id),
    zoomPane: (pane: string, mode: ZoomMode) => api.zoomPane(pane, mode, id),
    swapPane: (pane: string, direction: PaneDirection) => api.swapPane(pane, direction, id),
    swapPaneWith: (pane: string, target: string) => api.swapPaneWith(pane, target, id),
    setSplitRatio: (tab: string, path: boolean[], ratio: number) => api.setSplitRatio(tab, path, ratio, id),
    resizePane: (pane: string, direction: PaneDirection) => api.resizePane(pane, direction, id),
    clearPane: (pane: string) => api.clearPane(pane, id),
    renameWorkspace: (workspace: string, label: string) => api.renameWorkspace(workspace, label, id),
    moveWorkspace: (workspace: string, index: number) => api.moveWorkspace(workspace, index, id),
    fetchAgentKinds: () => api.fetchAgentKinds(id),
    fetchIntegrations: () => api.fetchIntegrations(id),
    fetchDirectories: (path: string, hidden: boolean) => api.fetchDirectories(path, hidden, id),
    createWorkspace: (request: api.CreateWorkspaceRequest) => api.createWorkspace(request, id),
    createTab: (request: api.CreateTabRequest) => api.createTab(request, id),
    renameTab: (tab: string, label: string) => api.renameTab(tab, label, id),
    closeTab: (tab: string) => api.closeTab(tab, id),
    moveTab: (tab: string, index: number) => api.moveTab(tab, index, id),
    transferTab: (tab: string, workspace: string, index: number) => api.transferTab(tab, workspace, index, id),
    fetchPluginActions: () => api.fetchPluginActions(id),
    runPluginAction: (request: PluginActionRequest) => api.runPluginAction(request, id),
    fetchPluginActionStatus: (pluginId: string, logId: string) => api.fetchPluginActionStatus(pluginId, logId, id),
  }), [id]);
}

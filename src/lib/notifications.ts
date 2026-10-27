import type { AgentStatus, PaneInfo } from "../../shared/protocol.ts";
import type { Machine } from "../../shared/machines.ts";
import { ENDED_NOTIFICATION_BODY, paneNotificationTag, statusNotificationBody } from "../../shared/notify-policy.ts";
import { nativeNotifications } from "./nativeNotifications.ts";
import { customTabLabel } from "./tabName.ts";

/**
 * Tab alerts: Web Notifications for pane status transitions while this page is open
 * but hidden. A device with a push subscription (lib/push.ts) gets the same alerts from
 * the server instead, and App skips these. Notification exists only in secure contexts
 * (https or localhost) - a plain-http LAN deployment reports "unsupported", and the bell
 * there switches only the in-app alerts.
 *
 * The transition policy is shared with the server (shared/notify-policy.ts).
 */

export { alertStatus, alertsAllow, shouldNotifyStatus } from "../../shared/notify-policy.ts";

export type NotificationState = "unsupported" | "default" | "granted" | "denied";
type NotificationHeading = string | { title: string; subtitle: string };

/** Name the same tab as the sidebar, with its workspace and PC on a separate native line. */
export function paneNotificationHeading(machine: Pick<Machine, "name" | "snapshot">, pane: Pick<PaneInfo, "workspace_id" | "tab_id">, paneTitle: string): NotificationHeading {
  const workspace = machine.snapshot?.workspaces.find((entry) => entry.workspace_id === pane.workspace_id);
  const tabs = machine.snapshot?.tabs.filter((entry) => entry.workspace_id === pane.workspace_id) ?? [];
  const place = tabs.findIndex((entry) => entry.tab_id === pane.tab_id);
  const tab = tabs[place];
  return { title: (tab && customTabLabel(tab, place + 1)) || paneTitle, subtitle: `${workspace?.label.trim() || pane.workspace_id} · ${machine.name}` };
}

export function notificationState(): NotificationState {
  const native = nativeNotifications();
  if (native) return native.permission;
  if (typeof globalThis.Notification === "undefined") return "unsupported";
  return globalThis.Notification.permission;
}

export async function requestNotificationPermission(): Promise<NotificationState> {
  const native = nativeNotifications();
  if (native) return native.requestPermission();
  if (typeof globalThis.Notification === "undefined") return "unsupported";
  const permission = await globalThis.Notification.requestPermission();
  return permission === "granted" ? "granted" : permission === "denied" ? "denied" : "default";
}

/**
 * Shown through the service worker when there is one: Android Chrome has no
 * `new Notification()`, and the worker's notificationclick (public/sw.js) selects the
 * pane. The constructor is the fallback for a page without a worker.
 */
async function show(paneId: string, heading: NotificationHeading, body: string, onClick?: () => void, machineId = "local", workspaceId?: string): Promise<void> {
  const title = typeof heading === "string" ? heading : heading.title;
  const subtitle = typeof heading === "string" ? undefined : heading.subtitle;
  const native = nativeNotifications();
  if (native) {
    if (native.permission !== "granted") return;
    try {
      // WebKit's page can remain visible behind another app; the native window checks activity.
      await native.show({ title, subtitle, body, tag: paneNotificationTag(paneId, machineId), data: { pane_id: paneId, machine_id: machineId, ...(workspaceId ? { workspace_id: workspaceId } : {}) } });
    } catch (error) {
      console.warn("could not show the Mac notification", error);
    }
    return;
  }
  if (typeof globalThis.Notification === "undefined") return;
  if (globalThis.Notification.permission !== "granted") return;
  if (typeof document !== "undefined" && !document.hidden) return; // visible tab: the UI already shows it
  const options: NotificationOptions = { body, tag: paneNotificationTag(paneId, machineId), data: { pane_id: paneId, machine_id: machineId, ...(workspaceId ? { workspace_id: workspaceId } : {}) }, icon: "/icons/icon-192.png?v=rex2" };
  try {
    const registration = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
    if (registration?.active) {
      await registration.showNotification(subtitle ? `${subtitle} · ${title}` : title, options);
      return;
    }
    const notification = new globalThis.Notification(subtitle ? `${subtitle} · ${title}` : title, options);
    notification.addEventListener("click", () => {
      window.focus();
      onClick?.();
    });
  } catch {
    /* no way to show it here: the sidebar badge still carries the change */
  }
}

/** `workspaceId`: the pane's workspace, as the server's push names it (server/push.ts), so a tap after the pane ends opens it. */
export function showPaneStatusNotification(paneId: string, title: NotificationHeading, status: AgentStatus, onClick?: () => void, machineId = "local", workspaceId?: string): void {
  void show(paneId, title, statusNotificationBody(status), onClick, machineId, workspaceId);
}

export function showPaneEndedNotification(paneId: string, title: NotificationHeading, onClick?: () => void, machineId = "local", workspaceId?: string): void {
  void show(paneId, title, ENDED_NOTIFICATION_BODY, onClick, machineId, workspaceId);
}

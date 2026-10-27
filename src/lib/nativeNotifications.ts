import type { NotificationTarget } from "./notificationTarget.ts";

/** The Mac window supplies this before the client loads; browsers keep their own notification path. */
export interface NativeNotifications {
  permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  show(notification: { title: string; subtitle?: string; body: string; tag: string; data?: NotificationTarget; test?: boolean }): Promise<void>;
  targets: { addEventListener(type: "message", listener: (event: MessageEvent) => void): void };
}

declare global {
  interface Window {
    __trexMac?: { notifications?: NativeNotifications };
  }
}

export function nativeNotifications(): NativeNotifications | undefined {
  return typeof window === "undefined" ? undefined : window.__trexMac?.notifications;
}

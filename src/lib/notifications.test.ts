import { afterEach, describe, expect, it } from "bun:test";
import type { AgentStatus, SessionSnapshot } from "../../shared/protocol.ts";
import { alertStatus, alertsAllow, shouldNotifyStatus, showPaneEndedNotification, showPaneStatusNotification, notificationState, requestNotificationPermission, paneNotificationHeading } from "./notifications.ts";
import type { NativeNotifications } from "./nativeNotifications.ts";
import { notificationTargets } from "./notificationTarget.ts";
import { pushSupported } from "./push.ts";

describe("alertStatus", () => {
  it("takes a pane at rest that waits on its turn's background work for working, and leaves the rest as they are", () => {
    expect(["done", "idle", "unknown"].map((status) => alertStatus(status, true))).toEqual(["working", "working", "working"]);
    expect(alertStatus("blocked", true)).toBe("blocked");
    expect(alertStatus("done", false)).toBe("done");
    expect(alertStatus("done", undefined)).toBe("done");
    // a wait that ends with no new turn is a finish
    expect(shouldNotifyStatus(alertStatus("done", true), alertStatus("done", false))).toBe(true);
  });
});

describe("shouldNotifyStatus", () => {
  it("notifies when a known pane becomes blocked", () => {
    expect(shouldNotifyStatus("working", "blocked")).toBe(true);
  });

  it("notifies when a known pane becomes done", () => {
    expect(shouldNotifyStatus("blocked", "done")).toBe(true);
  });

  it("does not notify for the busy baseline states", () => {
    expect(shouldNotifyStatus("idle", "working")).toBe(false);
    expect(shouldNotifyStatus("working", "idle")).toBe(false);
  });

  it("does not notify when the status does not change", () => {
    expect(shouldNotifyStatus("blocked", "blocked")).toBe(false);
  });

  it("does not notify on first sight of a pane", () => {
    // the app just opened or the pane is new: not news
    expect(shouldNotifyStatus(undefined, "blocked")).toBe(false);
  });

  it("carries unknown future statuses through without notifying", () => {
    expect(shouldNotifyStatus("working", "teleporting" as AgentStatus)).toBe(false);
  });
});

describe("alertsAllow", () => {
  it("lets through what the device chose, and nothing that is not an alert", () => {
    expect(alertsAllow({ input: true, done: "off" }, "blocked")).toBe(true);
    expect(alertsAllow({ input: false, done: "always" }, "blocked")).toBe(false);
    expect(alertsAllow({ input: false, done: "long" }, "done")).toBe(true);
    expect(alertsAllow({ input: true, done: "off" }, "done")).toBe(false);
    expect(alertsAllow({ input: true, done: "always" }, "working")).toBe(false);
  });
});

describe("Mac notifications", () => {
  const saved = Object.fromEntries(["window", "Notification", "document", "navigator", "PushManager"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  afterEach(() => {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  });

  function mac(permission: NotificationPermission = "granted") {
    const shown: Parameters<NativeNotifications["show"]>[0][] = [];
    const targets = new EventTarget();
    const native: NativeNotifications = {
      permission,
      requestPermission: async () => { native.permission = "granted"; return "granted"; },
      show: async (notification) => { shown.push(notification); },
      targets: { addEventListener: (type, listener) => targets.addEventListener(type, (event) => listener(event as MessageEvent)) },
    };
    Object.defineProperty(globalThis, "window", { configurable: true, value: { __trexMac: { notifications: native } } });
    // WebKit refuses browser permission and can stay visible behind another app.
    Object.defineProperty(globalThis, "Notification", { configurable: true, value: { permission: "denied" } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { hidden: false } });
    return { native, shown, targets };
  }

  it("uses macOS permission instead of WebKit's refusal, and requests native permission", async () => {
    const { native } = mac("default");
    expect(notificationState()).toBe("default");
    expect(await requestNotificationPermission()).toBe("granted");
    expect(notificationState()).toBe("granted");
    native.permission = "denied";
    expect(notificationState()).toBe("denied");
  });

  it("delivers finishes, input requests and ended panes even when WebKit stays visible", () => {
    const { shown } = mac();
    showPaneStatusNotification("w2:p1", "Mac codex", "done", undefined, "pc-2", "w2");
    showPaneStatusNotification("w2:p1", "Mac codex", "blocked", undefined, "pc-2", "w2");
    showPaneEndedNotification("w1:p9", "Mac claude", undefined, "local", "w1");
    expect(shown.map(({ body, data }) => ({ body, data }))).toEqual([
      { body: "work finished", data: { pane_id: "w2:p1", machine_id: "pc-2", workspace_id: "w2" } },
      { body: "waiting for your input", data: { pane_id: "w2:p1", machine_id: "pc-2", workspace_id: "w2" } },
      { body: "terminal ended", data: { pane_id: "w1:p9", machine_id: "local", workspace_id: "w1" } },
    ]);
    expect(shown[0]!.tag).toBe(shown[1]!.tag);
    expect(shown[0]!.tag).not.toBe(shown[2]!.tag);
  });

  it("shows the named tab with its session and PC, falling back to the pane title for numbered tabs", () => {
    const { shown } = mac();
    const pane = { workspace_id: "w2", tab_id: "w2:t1" };
    const snapshot = { workspaces: [{ workspace_id: "w2", label: "T-REX" }], tabs: [{ workspace_id: "w2", tab_id: "w2:t1", label: "Fix notifications", number: 1 }] } as SessionSnapshot;
    const machine = { name: "Work Mac", snapshot };
    const heading = paneNotificationHeading(machine, pane, "Codex pane");
    expect(heading).toEqual({ title: "Fix notifications", subtitle: "T-REX · Work Mac" });
    showPaneStatusNotification("w2:p1", heading, "done", undefined, "local", "w2");
    expect(shown[0]).toMatchObject({ title: "Fix notifications", subtitle: "T-REX · Work Mac", body: "work finished" });
    snapshot.tabs[0]!.label = "1";
    expect(paneNotificationHeading(machine, pane, "Codex pane")).toEqual({ title: "Codex pane", subtitle: "T-REX · Work Mac" });
    expect(paneNotificationHeading({ name: "Remote PC", snapshot: null }, pane, "Agent tab")).toEqual({ title: "Agent tab", subtitle: "w2 · Remote PC" });
  });

  it("does not deliver alerts until macOS grants permission", () => {
    const { shown, native } = mac("default");
    showPaneStatusNotification("w1:p1", "Mac codex", "done");
    native.permission = "denied";
    showPaneStatusNotification("w1:p1", "Mac codex", "done");
    expect(shown).toEqual([]);
  });

  it("does not also subscribe to web push in the Mac window", () => {
    mac();
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { serviceWorker: {} } });
    Object.defineProperty(globalThis, "PushManager", { configurable: true, value: class {} });
    expect(pushSupported()).toBe(false);
  });

  it("retains a native click until the app can select its PC, pane and workspace", () => {
    const { native, targets } = mac();
    const subscribe = notificationTargets(native.targets);
    const target = { machine_id: "pc-2", pane_id: "w2:p1", workspace_id: "w2" };
    targets.dispatchEvent(new MessageEvent("message", { data: { type: "select-pane", ...target } }));
    const selected: unknown[] = [];
    const unsubscribe = subscribe((value) => selected.push(value));
    expect(selected).toEqual([target]);
    unsubscribe();
  });
});

describe("tab alerts shown through the worker", () => {
  const saved = { Notification: globalThis.Notification, navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"), document: Object.getOwnPropertyDescriptor(globalThis, "document") };
  afterEach(() => {
    (globalThis as { Notification?: unknown }).Notification = saved.Notification;
    for (const key of ["navigator", "document"] as const) {
      const descriptor = saved[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  });
  /** A hidden tab with a worker: what each alert asked the worker to show. */
  function hiddenTabWithWorker(): Array<{ data: unknown }> {
    const shown: Array<{ data: unknown }> = [];
    (globalThis as { Notification?: unknown }).Notification = { permission: "granted" };
    Object.defineProperty(globalThis, "document", { configurable: true, value: { hidden: true } });
    const registration = { active: {}, showNotification: async (_title: string, options: { data: unknown }) => { shown.push({ data: options.data }); } };
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { serviceWorker: { getRegistration: async () => registration } } });
    return shown;
  }

  it("names the pane's workspace, as the server's push does, so a tap after the pane ends opens it (public/sw.js)", async () => {
    const shown = hiddenTabWithWorker();
    showPaneEndedNotification("w1:p9", "Mac · claude", undefined, "local", "w1");
    showPaneStatusNotification("w2:p1", "Mac · codex", "blocked", undefined, "pc-2", "w2");
    showPaneStatusNotification("w3:p1", "Mac · codex", "done", undefined, "local");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shown.map((entry) => entry.data)).toEqual([
      { pane_id: "w1:p9", machine_id: "local", workspace_id: "w1" },
      { pane_id: "w2:p1", machine_id: "pc-2", workspace_id: "w2" },
      { pane_id: "w3:p1", machine_id: "local" },
    ]);
  });
});

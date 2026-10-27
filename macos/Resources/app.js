// T-Rex for the Mac (macos/): the page's side of the window, run before the page's own scripts. It
// tells the app where the top bar is, what in it takes a click, and the page's colour; the app
// centres the window's buttons on the bar, says how far they reach (app.css keeps that clear), and
// moves the window from the rest of the bar (TRexWindowController).
(() => {
  const app = window.webkit?.messageHandlers?.trex;
  if (!app) return;
  const root = document.documentElement;
  root.dataset.trexMac = "";
  window.__trexMac = { reserve: (px) => root.style.setProperty("--trex-mac-reserve", `${px}px`) };
  const notificationHandler = window.webkit.messageHandlers.trexNotifications;
  if (notificationHandler) {
    const targets = new EventTarget();
    const notifications = {
      permission: "default",
      targets,
      requestPermission: async () => updatePermission(await notificationHandler.postMessage({ kind: "requestPermission" })),
      show: (notification) => notificationHandler.postMessage({ kind: "show", ...notification }),
      clicked: (target) => targets.dispatchEvent(new MessageEvent("message", { data: { type: "select-pane", ...target } })),
    };
    const updatePermission = (permission) => {
      notifications.permission = permission;
      window.dispatchEvent(new Event("trex-notification-permission"));
      return permission;
    };
    const refreshPermission = () => notificationHandler.postMessage({ kind: "permission" }).then(updatePermission).catch(() => {});
    window.__trexMac.notifications = notifications;
    addEventListener("focus", refreshPermission);
    refreshPermission();
  }
  // what takes a click in the bar: styles.css's list for Chrome's window controls overlay, and tabs
  const CONTROLS = "button, a, input, select, textarea, [tabindex], [draggable='true'], [role='tab']";
  const box = (rect) => [rect.left, rect.top, rect.width, rect.height];
  const sent = {};
  const send = (message) => {
    const key = JSON.stringify(message);
    if (sent[message.kind] === key) return;
    sent[message.kind] = key;
    app.postMessage(message);
  };
  let frame = 0;
  const measure = () => {
    frame = 0;
    const header = document.querySelector(".app-header");
    const bar = header?.getBoundingClientRect();
    if (header && bar && bar.height > 0) {
      // an open dialog covers the bar: a press there is the dialog's
      const covered = document.querySelector("[aria-modal='true'], dialog[open]") !== null;
      const holes = [...header.querySelectorAll(CONTROLS)].map((element) => element.getBoundingClientRect()).filter((rect) => rect.width > 0 && rect.height > 0).map(box);
      send({ kind: "bar", middle: bar.top + bar.height / 2, bar: covered ? null : box(bar), holes });
    }
    if (document.body) send({ kind: "theme", color: getComputedStyle(document.body).backgroundColor, dark: root.dataset.theme !== "light" });
    if (!sent.ready && document.querySelector(".app-header.is-zoned")) {
      sent.ready = "yes";
      app.postMessage({ kind: "ready" });
    }
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(measure);
  };
  new MutationObserver(schedule).observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "hidden", "open", "aria-modal", "data-theme", "data-palette"] });
  new ResizeObserver(schedule).observe(root);
  // the tab strip scrolls under the bar, and the sidebar's top row slides with the sidebar
  addEventListener("scroll", schedule, true);
  addEventListener("transitionend", schedule, true);
  addEventListener("DOMContentLoaded", schedule);
  schedule();
})();

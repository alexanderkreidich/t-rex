import AppKit
import UserNotifications
import WebKit

/** Local Mac alerts while the app runs; WKWebView cannot grant Web Notification permission. */
final class DesktopNotifications: NSObject, WKScriptMessageHandlerWithReply, UNUserNotificationCenterDelegate {
  private weak var webView: WKWebView?
  private let center: UNUserNotificationCenter?
  var origin: URL?
  var activate: (() -> Void)?
  private var ready = false
  private var pendingTarget: [String: String]?

  init(webView: WKWebView, enabled: Bool) {
    self.webView = webView
    center = enabled ? UNUserNotificationCenter.current() : nil
    super.init()
    center?.delegate = self
  }

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
    guard message.frameInfo.isMainFrame, let url = message.frameInfo.request.url, let origin,
      url.scheme == origin.scheme, url.host == origin.host, url.port == origin.port,
      let body = message.body as? [String: Any], let kind = body["kind"] as? String,
      let center else {
      replyHandler(nil, "Notifications are available only to the T-Rex page")
      return
    }
    Task {
      do {
        switch kind {
        case "permission":
          replyHandler(Self.permission(await center.notificationSettings().authorizationStatus), nil)
        case "requestPermission":
          _ = try await center.requestAuthorization(options: [.alert, .sound])
          replyHandler(Self.permission(await center.notificationSettings().authorizationStatus), nil)
        case "show":
          guard let request = Self.request(body) else {
            replyHandler(nil, "Invalid notification")
            return
          }
          // A visible WebKit page does not mean its app is frontmost. Match the browser's policy
          // using the actual window, and still alert when it is minimized or closed to the Dock.
          let window = webView?.window
          if body["test"] as? Bool != true && NSApp.isActive && window?.isVisible == true && window?.isMiniaturized == false {
            replyHandler(false, nil)
            return
          }
          try await center.add(request)
          replyHandler(true, nil)
        default:
          replyHandler(nil, "Unknown notification operation")
        }
      } catch {
        replyHandler(nil, error.localizedDescription)
      }
    }
  }

  static func permission(_ status: UNAuthorizationStatus) -> String {
    switch status {
    case .notDetermined: "default"
    case .authorized, .provisional, .ephemeral: "granted"
    case .denied: "denied"
    @unknown default: "denied"
    }
  }

  static func request(_ body: [String: Any]) -> UNNotificationRequest? {
    guard let title = body["title"] as? String, !title.isEmpty,
      let text = body["body"] as? String, let tag = body["tag"] as? String, !tag.isEmpty else { return nil }
    let content = UNMutableNotificationContent()
    if body["test"] as? Bool != true {
      guard let data = body["data"] as? [String: String],
        let pane = data["pane_id"], !pane.isEmpty, let machine = data["machine_id"], !machine.isEmpty else { return nil }
      content.userInfo = data
    }
    content.title = title
    content.subtitle = body["subtitle"] as? String ?? ""
    content.body = text
    content.sound = .default
    return UNNotificationRequest(identifier: tag, content: content, trigger: nil)
  }

  func pageLoading() { ready = false }

  func pageReady() {
    ready = true
    deliverTarget()
  }

  private func select(_ target: [String: String]) {
    pendingTarget = target
    activate?()
    deliverTarget()
  }

  private func deliverTarget() {
    guard ready, let target = pendingTarget,
      let data = try? JSONEncoder().encode(target), let json = String(data: data, encoding: .utf8) else { return }
    pendingTarget = nil
    webView?.evaluateJavaScript("window.__trexMac?.notifications?.clicked(\(json)); void 0", completionHandler: nil)
  }

  nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
    [.banner, .sound, .list]
  }

  nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
    guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
      let target = response.notification.request.content.userInfo as? [String: String], target["pane_id"] != nil else { return }
    await select(target)
  }
}

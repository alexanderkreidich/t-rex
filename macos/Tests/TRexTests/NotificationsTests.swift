import AppKit
import Testing
import UserNotifications
import WebKit
@testable import TRex

@Test func macAppCanNotifyWithoutBrowserNotifications() async throws {
  _ = NSApplication.shared
  let controller = TRexWindowController(snapshot: URL(fileURLWithPath: "/tmp/t-rex-notification-test.png"))
  let window = try #require(controller.window)
  let webView = try #require(window.contentView?.subviews.compactMap { $0 as? WKWebView }.first)
  let script = try String(contentsOf: URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("Resources/app.js"), encoding: .utf8)
  let handler = NotificationHandler()
  let scripts = webView.configuration.userContentController
  scripts.removeScriptMessageHandler(forName: "trexNotifications", contentWorld: .page)
  scripts.addScriptMessageHandler(handler, contentWorld: .page, name: "trexNotifications")
  scripts.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
  webView.navigationDelegate = nil
  webView.loadHTMLString("<!doctype html><body>Notification test</body>", baseURL: URL(string: "http://127.0.0.1:7417"))
  let deadline = ContinuousClock.now + .seconds(5)
  while (try? await webView.evaluateJavaScript("document.body?.textContent === 'Notification test'") as? Bool) != true {
    try #require(ContinuousClock.now < deadline, "The notification test page did not finish navigating")
    try await Task.sleep(for: .milliseconds(10))
  }
  let browser = try await webView.evaluateJavaScript("typeof Notification") as? String
  let native = try await webView.evaluateJavaScript("typeof window.__trexMac?.notifications?.requestPermission") as? String
  let permission = try await webView.callAsyncJavaScript("return typeof Notification === 'undefined' ? 'unsupported' : await Notification.requestPermission()", arguments: [:], in: nil, contentWorld: .page) as? String
  print("T-Rex notifications: browser=\(browser ?? "nil"), permission=\(permission ?? "nil"), native=\(native ?? "nil")")
  #expect(native == "function", "WebKit refuses notifications and the Mac window needs a native permission path")
  let granted = try await webView.callAsyncJavaScript("return await window.__trexMac.notifications.requestPermission()", arguments: [:], in: nil, contentWorld: .page) as? String
  #expect(granted == "granted")
  #expect(try await webView.evaluateJavaScript("window.__trexMac.notifications.permission") as? String == "granted")
  _ = try await webView.callAsyncJavaScript("return await window.__trexMac.notifications.show({title:'Mac codex',body:'work finished',tag:'pane-1',data:{machine_id:'pc-2',pane_id:'w2:p1',workspace_id:'w2'}})", arguments: [:], in: nil, contentWorld: .page)
  let message = try #require(handler.shown.first)
  #expect(message["body"] as? String == "work finished")
  #expect(message["data"] as? [String: String] == ["machine_id": "pc-2", "pane_id": "w2:p1", "workspace_id": "w2"])
  try await webView.evaluateJavaScript("window.__trexMac.notifications.targets.addEventListener('message', event => window.clickedTarget = event.data); window.__trexMac.notifications.clicked({machine_id:'pc-2',pane_id:'w2:p1',workspace_id:'w2'}); void 0")
  let clicked = try await webView.evaluateJavaScript("window.clickedTarget") as? [String: String]
  #expect(clicked == ["type": "select-pane", "machine_id": "pc-2", "pane_id": "w2:p1", "workspace_id": "w2"])
}

@Test func nativeNotificationPermissionMapsToTheClient() {
  #expect(DesktopNotifications.permission(.notDetermined) == "default")
  #expect(DesktopNotifications.permission(.denied) == "denied")
  #expect(DesktopNotifications.permission(.authorized) == "granted")
  #expect(DesktopNotifications.permission(.provisional) == "granted")
}

@Test func nativeNotificationsKeepThePaneSlotAndClickTarget() throws {
  let target = ["machine_id": "pc-2", "pane_id": "w2:p1", "workspace_id": "w2"]
  let request = try #require(DesktopNotifications.request(["title": "Agent tab", "subtitle": "T-REX / Work Mac", "body": "work finished", "tag": "pane-1", "data": target]))
  #expect(request.identifier == "pane-1")
  #expect(request.content.title == "Agent tab")
  #expect(request.content.subtitle == "T-REX / Work Mac")
  #expect(request.content.body == "work finished")
  #expect(request.content.userInfo as? [String: String] == target)
  #expect(request.content.sound != nil)
  #expect(request.trigger == nil)
  #expect(DesktopNotifications.request(["title": "Mac codex", "body": "work finished", "tag": "pane-1"]) == nil)
  #expect(DesktopNotifications.request(["title": "Mac codex", "body": "work finished", "tag": "pane-1", "data": ["pane_id": "", "machine_id": "local"]]) == nil)
  let test = try #require(DesktopNotifications.request(["title": "T-Rex", "body": "Test notification", "tag": "t-rex:test", "test": true]))
  #expect(test.content.userInfo.isEmpty)
}

private final class NotificationHandler: NSObject, WKScriptMessageHandlerWithReply {
  var shown: [[String: Any]] = []
  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
    guard let body = message.body as? [String: Any] else { replyHandler(nil, "Invalid message"); return }
    switch body["kind"] as? String {
    case "permission": replyHandler("default", nil)
    case "requestPermission": replyHandler("granted", nil)
    case "show": shown.append(body); replyHandler(true, nil)
    default: replyHandler(nil, "Unknown message")
    }
  }
}

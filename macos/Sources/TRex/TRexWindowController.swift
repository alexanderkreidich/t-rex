import AppKit
import WebKit

/**
 * One window on the bridge, drawn as the installed app is in Chrome: no title bar, T-Rex's top bar
 * under the window's buttons, which sit centred on that bar. The page says where the bar is and what
 * in it takes a click (Resources/app.js); this side places the buttons, tells the page the room they
 * take (Resources/app.css keeps it clear), lets the rest of the bar move the window as a title bar
 * would (WindowContent), and follows the page's colour.
 */
final class TRexWindowController: NSWindowController, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
  private let webView: WKWebView
  private let content: WindowContent
  private let notifications: DesktopNotifications
  private let snapshot: URL?
  private var origin: URL?
  /** the middle of the page's top bar, in points from the window's top; nil until the page says */
  private var barMiddle: CGFloat?
  private var reserved: Int?
  private static let zoomKey = "PageZoom"

  init(snapshot: URL?) {
    self.snapshot = snapshot
    let configuration = WKWebViewConfiguration()
    configuration.applicationNameForUserAgent = "T-Rex"
    configuration.preferences.isElementFullscreenEnabled = true
    let scripts = WKUserContentController()
    if let css = Bundled.text("app.css") {
      scripts.addUserScript(WKUserScript(source: Self.styleScript(css), injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }
    if let js = Bundled.text("app.js") {
      scripts.addUserScript(WKUserScript(source: js, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }
    configuration.userContentController = scripts
    webView = WKWebView(frame: .zero, configuration: configuration)
    webView.isInspectable = true
    webView.allowsMagnification = false
    webView.allowsBackForwardNavigationGestures = false
    webView.underPageBackgroundColor = Theme.fallback
    webView.pageZoom = UserDefaults.standard.object(forKey: Self.zoomKey) as? CGFloat ?? 1
    content = WindowContent(webView: webView)
    notifications = DesktopNotifications(webView: webView, enabled: snapshot == nil)

    let window = TRexWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
      styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
      backing: .buffered, defer: false)
    window.title = "T-Rex"
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.minSize = NSSize(width: 480, height: 360)
    window.backgroundColor = Theme.fallback
    window.tabbingMode = .disallowed
    // the controller keeps the window: closing it only hides it, and the Dock icon brings it back
    window.isReleasedWhenClosed = false
    window.contentView = content
    super.init(window: window)
    window.delegate = self
    webView.navigationDelegate = self
    webView.uiDelegate = self
    scripts.add(WeakHandler(self), name: "trex")
    scripts.addScriptMessageHandler(notifications, contentWorld: .page, name: "trexNotifications")
    notifications.activate = { [weak self] in self?.present() }
    if snapshot == nil {
      if !window.setFrameUsingName("T-Rex") { window.center() }
      window.setFrameAutosaveName("T-Rex")
    }
    webView.loadHTMLString(Self.startingPage, baseURL: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("not built from a nib") }

  /** What the window shows while the bridge starts: the page's colour and one dim line. */
  private static let startingPage = """
    <!doctype html><meta name="color-scheme" content="dark"><body style="margin:0;height:100vh;display:grid;place-items:center;\
    background:#12100e;color:#9b9183;font:13px -apple-system,system-ui;-webkit-user-select:none">Starting T-Rex…</body>
    """

  /** CSS as a script that adds it before the page's first paint. */
  private static func styleScript(_ css: String) -> String {
    let literal = String(decoding: try! JSONEncoder().encode(css), as: UTF8.self)
    return "(() => { const s = document.createElement('style'); s.id = 'trex-mac'; s.textContent = \(literal); document.documentElement.append(s); })();"
  }

  func present() {
    guard let window else { return }
    if let snapshot {
      Snapshot.present(window, writing: snapshot, webView: webView)
      return
    }
    window.makeKeyAndOrderFront(nil)
    NSApp.activate()
  }

  func load(_ origin: URL) {
    self.origin = origin
    notifications.origin = origin
    webView.load(URLRequest(url: origin))
  }

  // MARK: the page's top bar

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let body = message.body as? [String: Any], let kind = body["kind"] as? String else { return }
    switch kind {
    case "bar":
      let zoom = webView.pageZoom
      let rect = { (value: Any?) -> CGRect? in
        guard let box = value as? [Double], box.count == 4 else { return nil }
        return CGRect(x: box[0] * zoom, y: box[1] * zoom, width: box[2] * zoom, height: box[3] * zoom)
      }
      content.bar = rect(body["bar"])
      content.holes = (body["holes"] as? [Any] ?? []).compactMap(rect)
      if let middle = body["middle"] as? Double, middle > 0 {
        barMiddle = middle * zoom
        placeButtons()
      }
    case "theme":
      guard let css = body["color"] as? String, let color = Theme.color(css) else { return }
      window?.backgroundColor = color
      webView.underPageBackgroundColor = color
      // Keep WebKit on the system appearance; overriding the window pins prefers-color-scheme.
      window?.standardWindowButton(.closeButton)?.superview?.appearance = NSAppearance(named: (body["dark"] as? Bool ?? true) ? .darkAqua : .aqua)
    case "ready":
      notifications.pageReady()
      // what scripts/mac-app-smoke.ts waits for: the window shows T-Rex from this bridge
      print("T-Rex: the window shows \(webView.url?.absoluteString ?? "")")
      fflush(stdout)
      if snapshot != nil { Snapshot.pageReady() }
    default:
      break
    }
  }

  /**
   * The window's buttons centred on the page's bar, as far in from the window's left edge as their
   * middle is down from its top; the page learns how far they reach, and keeps that clear.
   */
  private func placeButtons() {
    guard let window else { return }
    let buttons = [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton].compactMap { window.standardWindowButton($0) }
    guard buttons.count == 3, let titlebar = buttons[0].superview, let container = titlebar.superview else { return }
    var reserve = 0
    if let middle = barMiddle, !window.styleMask.contains(.fullScreen) {
      let size = buttons[0].frame.height
      let spacing = buttons[1].frame.minX - buttons[0].frame.minX
      let margin = (middle - size / 2).rounded()
      var frame = container.frame
      frame.size.height = margin * 2 + size
      frame.origin.y = window.frame.height - frame.size.height
      container.frame = frame
      titlebar.frame = container.bounds
      for (index, button) in buttons.enumerated() {
        button.setFrameOrigin(NSPoint(x: margin + CGFloat(index) * spacing, y: margin))
      }
      reserve = Int((buttons[2].frame.maxX / webView.pageZoom).rounded(.up))
    }
    guard reserve != reserved else { return }
    reserved = reserve
    webView.evaluateJavaScript("window.__trexMac?.reserve(\(reserve))", completionHandler: nil)
  }

  func windowDidResize(_ notification: Notification) { placeButtons() }
  func windowDidEnterFullScreen(_ notification: Notification) { placeButtons() }
  func windowDidExitFullScreen(_ notification: Notification) { placeButtons() }

  // MARK: zoom, as ⌘+ and ⌘− do in a browser

  @objc func actualSize(_ sender: Any?) { setZoom(1) }
  @objc func zoomIn(_ sender: Any?) { setZoom(webView.pageZoom * 1.1) }
  @objc func zoomOut(_ sender: Any?) { setZoom(webView.pageZoom / 1.1) }

  private func setZoom(_ zoom: CGFloat) {
    let clamped = min(max(zoom, 0.5), 3)
    webView.pageZoom = abs(clamped - 1) < 0.01 ? 1 : clamped
    UserDefaults.standard.set(webView.pageZoom, forKey: Self.zoomKey)
    reserved = nil
  }

  // MARK: navigation

  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
    guard let url = action.request.url else { return .cancel }
    if ["about", "blob", "data"].contains(url.scheme ?? "") { return .allow }
    if let origin, url.host == origin.host, url.port == origin.port { return .allow }
    // links leave for the browser; the window stays on the bridge
    if ["http", "https", "mailto"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
    return .cancel
  }

  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = action.request.url, ["http", "https", "mailto"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
    return nil
  }

  func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
    notifications.pageLoading()
    // a new page has none of the last one's state: it learns the room again
    reserved = nil
    content.bar = nil
    content.holes = []
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    // the bridge restarting (an update, a crash): try again until it answers
    guard let origin else { return }
    Task {
      try? await Task.sleep(for: .seconds(2))
      if self.webView.url == nil || self.webView.url?.host == origin.host { self.webView.load(URLRequest(url: origin)) }
    }
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    webView.reload()
  }

  // Pages ask for these; WKWebView shows nothing unless the app does.
  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async {
    let alert = NSAlert()
    alert.messageText = message
    alert.runModal()
  }

  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async -> Bool {
    let alert = NSAlert()
    alert.messageText = message
    alert.addButton(withTitle: "OK")
    alert.addButton(withTitle: "Cancel")
    return alert.runModal() == .alertFirstButtonReturn
  }

  func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo) async -> [URL]? {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection
    panel.canChooseDirectories = parameters.allowsDirectories
    return panel.runModal() == .OK ? panel.urls : nil
  }
}

/**
 * The window's content: the page, and over its top bar's empty space a title bar's behaviour. A press
 * there moves the window and a double click zooms it (or what System Settings says); a press on a
 * control in the bar, and anything below it, is the page's.
 */
final class WindowContent: NSView {
  private let webView: WKWebView
  /** the page's top bar and the controls in it, in points from the top left; nil while a dialog covers it */
  var bar: CGRect?
  var holes: [CGRect] = []
  /** what moves the window before the page reports its bar (the starting page): a title bar's height */
  private static let fallbackStrip: CGFloat = 32

  init(webView: WKWebView) {
    self.webView = webView
    super.init(frame: .zero)
    webView.translatesAutoresizingMaskIntoConstraints = false
    addSubview(webView)
    NSLayoutConstraint.activate([
      webView.leadingAnchor.constraint(equalTo: leadingAnchor),
      webView.trailingAnchor.constraint(equalTo: trailingAnchor),
      webView.topAnchor.constraint(equalTo: topAnchor),
      webView.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("not built from a nib") }

  override var isFlipped: Bool { true }

  // mouseDown below moves the window; AppKit must not start a move of its own under the page
  override var mouseDownCanMoveWindow: Bool { false }

  private func movesWindow(_ point: NSPoint) -> Bool {
    guard let window, !window.styleMask.contains(.fullScreen) else { return false }
    guard let bar else { return webView.url?.scheme == "about" && point.y < Self.fallbackStrip }
    return bar.contains(point) && !holes.contains { $0.contains(point) }
  }

  override func hitTest(_ point: NSPoint) -> NSView? {
    guard let superview else { return super.hitTest(point) }
    return movesWindow(convert(point, from: superview)) ? self : super.hitTest(point)
  }

  override func mouseDown(with event: NSEvent) {
    if event.clickCount == 2 {
      (window as? TRexWindow)?.titleBarDoubleClick()
    } else {
      window?.performDrag(with: event)
    }
  }

  // the tab strip under the bar still scrolls with the wheel
  override func scrollWheel(with event: NSEvent) {
    webView.scrollWheel(with: event)
  }
}

/** A double click on the top bar does what one on a title bar does: what System Settings says, zoom by default. */
final class TRexWindow: NSWindow {
  func titleBarDoubleClick() {
    switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") {
    case "Minimize": miniaturize(nil)
    case "None": break
    default: zoom(nil)
    }
  }
}

/** WKUserContentController keeps its handlers strongly: this leaves the window controller free to go. */
private final class WeakHandler: NSObject, WKScriptMessageHandler {
  weak var target: WKScriptMessageHandler?
  init(_ target: WKScriptMessageHandler) { self.target = target }
  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    target?.userContentController(controller, didReceive: message)
  }
}

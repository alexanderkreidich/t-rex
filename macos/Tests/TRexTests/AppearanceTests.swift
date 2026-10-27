import AppKit
import Testing
import WebKit
@testable import TRex

@Test func pageThemeDoesNotPinSystemAppearance() async throws {
  let app = NSApplication.shared
  let previous = app.appearance
  app.appearance = NSAppearance(named: .aqua)
  defer { app.appearance = previous }

  let controller = TRexWindowController(snapshot: URL(fileURLWithPath: "/tmp/t-rex-appearance-test.png"))
  let window = try #require(controller.window)
  let webView = try #require(window.contentView?.subviews.compactMap { $0 as? WKWebView }.first)
  window.alphaValue = 0.01
  window.ignoresMouseEvents = true
  window.orderFrontRegardless()
  defer { window.close() }
  webView.loadHTMLString("<!doctype html><meta name='color-scheme' content='light dark'><body>Theme test</body>", baseURL: nil)
  try await waitUntil { !webView.isLoading }

  // Follow the system in both directions, then choose a page theme opposite to the system.
  for (systemDark, pageDark) in [(false, false), (true, true), (false, false), (false, true), (true, false)] {
    app.appearance = NSAppearance(named: systemDark ? .darkAqua : .aqua)
    try await waitUntil {
      try await webView.evaluateJavaScript("matchMedia('(prefers-color-scheme: dark)').matches") as? Bool == systemDark
    }
    let red = pageDark ? 18 : 250
    // Exercise the actual page -> native callback, not a separate appearance resolver.
    try await webView.evaluateJavaScript("window.webkit.messageHandlers.trex.postMessage({kind:'theme',color:'rgb(\(red),16,14)',dark:\(pageDark)}); void 0")
    try await waitUntil { window.backgroundColor.usingColorSpace(.sRGB)?.redComponent == Double(red) / 255.0 }
    try await waitUntil {
      try await webView.evaluateJavaScript("matchMedia('(prefers-color-scheme: dark)').matches") as? Bool == systemDark
    }
    #expect(window.standardWindowButton(.closeButton)?.superview?.appearance?.name == (pageDark ? .darkAqua : .aqua))
  }
}

private func waitUntil(_ condition: () async throws -> Bool) async throws {
  let deadline = ContinuousClock.now + .seconds(3)
  while try await !condition() {
    try #require(ContinuousClock.now < deadline, "WebKit did not follow the application's appearance")
    try await Task.sleep(for: .milliseconds(10))
  }
}

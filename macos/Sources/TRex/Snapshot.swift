import AppKit
import WebKit

/**
 * `--snapshot <png> [--size 1280x820]`: a check run. The window is drawn all but transparent, under
 * no mouse, and never takes the keyboard; once the page shows T-Rex, the page with the window's
 * buttons where they sit is written to the PNG and the app quits.
 */
enum Snapshot {
  private static var capture: (() -> Void)?

  static func target(in arguments: [String]) -> URL? {
    guard let at = arguments.firstIndex(of: "--snapshot"), at + 1 < arguments.count else { return nil }
    return URL(fileURLWithPath: arguments[at + 1])
  }

  private static func size(in arguments: [String]) -> NSSize {
    guard let at = arguments.firstIndex(of: "--size"), at + 1 < arguments.count else { return NSSize(width: 1280, height: 820) }
    let parts = arguments[at + 1].split(separator: "x").compactMap { Double($0) }
    return parts.count == 2 ? NSSize(width: parts[0], height: parts[1]) : NSSize(width: 1280, height: 820)
  }

  static func present(_ window: NSWindow, writing url: URL, webView: WKWebView) {
    // a window the system counts as hidden stops drawing its page: nearly transparent, not invisible
    window.alphaValue = 0.01
    window.ignoresMouseEvents = true
    window.setContentSize(size(in: CommandLine.arguments))
    window.setFrameOrigin(.zero)
    window.orderFrontRegardless()
    capture = { write(window, webView, url) }
    // the page never shows T-Rex: write what there is
    Task {
      try? await Task.sleep(for: .seconds(60))
      print("snapshot: T-Rex did not show within 60 s")
      take()
    }
  }

  static func pageReady() {
    guard capture != nil else { return }
    // the terminal draws its first frames after the bar is there
    Task {
      try? await Task.sleep(for: .seconds(2))
      take()
    }
  }

  private static func take() {
    let run = capture
    capture = nil
    run?()
  }

  private static func write(_ window: NSWindow, _ webView: WKWebView, _ url: URL) {
    webView.takeSnapshot(with: nil) { image, error in
      guard let image else {
        print("snapshot failed: \(error?.localizedDescription ?? "no image")")
        NSApp.terminate(nil)
        return
      }
      let size = webView.bounds.size
      let scale = window.backingScaleFactor
      guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width * scale), pixelsHigh: Int(size.height * scale),
                                       bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                       colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return }
      rep.size = size
      NSGraphicsContext.saveGraphicsState()
      NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
      image.draw(in: NSRect(origin: .zero, size: size))
      // the window's buttons cannot draw themselves into a bitmap off the keyboard (they come out
      // blank): their colours, where AppKit placed them
      let colors = [NSColor.systemRed, .systemYellow, .systemGreen]
      for (type, color) in zip([NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton], colors) {
        guard let button = window.standardWindowButton(type) else { continue }
        let frame = button.convert(button.bounds, to: nil)
        color.setFill()
        NSBezierPath(ovalIn: NSRect(x: frame.midX - 6, y: frame.midY - 6, width: 12, height: 12)).fill()
      }
      NSGraphicsContext.restoreGraphicsState()
      do {
        try rep.representation(using: .png, properties: [:])?.write(to: url)
        print("snapshot: \(url.path)")
      } catch {
        print("snapshot failed: \(error.localizedDescription)")
      }
      NSApp.terminate(nil)
    }
  }
}

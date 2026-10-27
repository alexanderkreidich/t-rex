import AppKit

/**
 * The app: one window, which opens at once and shows T-Rex as soon as a bridge answers (Bridge).
 * Closing the window keeps the app in the Dock, whose icon brings it back; quitting stops the bridge
 * this app started. herdr keeps running, as it owns every pane.
 */
final class AppDelegate: NSObject, NSApplicationDelegate {
  private let snapshot: URL?
  private var started: Bridge.Started?
  private var window: TRexWindowController?
  private var termination: DispatchSourceSignal?

  init(snapshot: URL?) {
    self.snapshot = snapshot
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    // a snapshot run draws its window off screen and never takes the keyboard (Snapshot)
    NSApp.setActivationPolicy(snapshot == nil ? .regular : .accessory)
    NSApp.mainMenu = MainMenu.build()
    // SIGTERM (kill, a CI run) would end the app without applicationWillTerminate, leaving its
    // bridge behind: it quits as ⌘Q does instead
    signal(SIGTERM, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    source.setEventHandler { MainActor.assumeIsolated { NSApp.terminate(nil) } }
    source.resume()
    termination = source
    let controller = TRexWindowController(snapshot: snapshot)
    window = controller
    controller.present()
    Task { await start(controller) }
  }

  private func start(_ controller: TRexWindowController) async {
    do {
      let found = try await Bridge.connect()
      started = found.started
      controller.load(found.origin)
    } catch {
      let alert = NSAlert()
      alert.messageText = "T-Rex could not start"
      alert.informativeText = "\(error.localizedDescription)\n\nLogs are in \(Bridge.logs.path)."
      alert.addButton(withTitle: "Quit")
      if snapshot == nil { alert.runModal() } else { print("T-Rex could not start: \(error.localizedDescription)") }
      NSApp.terminate(nil)
    }
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    if !flag { window?.present() }
    return true
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    false
  }

  func applicationWillTerminate(_ notification: Notification) {
    started?.stop()
  }
}

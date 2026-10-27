import AppKit

let app = NSApplication.shared
let delegate = AppDelegate(snapshot: Snapshot.target(in: CommandLine.arguments))
app.delegate = delegate
app.run()

import Foundation
import Synchronization

/**
 * The environment a terminal would give: the login shell's. An app opened from the Dock gets a bare
 * PATH, and herdr's panes inherit the environment herdr is started with. An rc file that waits for
 * input or execs another program prints nothing in time: then this process's environment, with the
 * usual tool folders.
 */
nonisolated enum LoginEnvironment {
  private static let mark = "__T_REX_ENV__"
  private static let timeout: Duration = .seconds(10)

  @concurrent static func read() async -> [String: String] {
    // a run from inside a herdr pane carries that pane's variables (HERDR_PANE_ID, HERDR_SOCKET_PATH…),
    // which herdr's panes must not inherit; HERDR_SOCKET and the bridge's own HERDR_WEB_* stay
    let base = ProcessInfo.processInfo.environment.filter { !$0.key.hasPrefix("HERDR_") || $0.key == "HERDR_SOCKET" || $0.key.hasPrefix("HERDR_WEB_") }
    let shell = base["SHELL"].flatMap { $0.isEmpty ? nil : $0 } ?? "/bin/zsh"
    let process = Process()
    process.executableURL = URL(fileURLWithPath: shell)
    process.arguments = ["-ilc", "printf '\(mark)'; command env -0"]
    process.environment = base
    process.currentDirectoryURL = URL(fileURLWithPath: Paths.home)
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    process.standardInput = FileHandle.nullDevice
    let output = Mutex(Data())
    let ended = Mutex(false)
    pipe.fileHandleForReading.readabilityHandler = { handle in
      let chunk = handle.availableData
      if chunk.isEmpty { ended.withLock { $0 = true } } else { output.withLock { $0.append(chunk) } }
    }
    do { try process.run() } catch { return withLocale(fallback(base)) }
    let clock = ContinuousClock()
    let deadline = clock.now + timeout
    while process.isRunning, clock.now < deadline { try? await Task.sleep(for: .milliseconds(20)) }
    if process.isRunning { process.terminate() }
    // what the shell wrote before it exited is in the pipe; a program it left behind may hold the pipe open
    let drained = clock.now + .milliseconds(500)
    while !ended.withLock({ $0 }), clock.now < drained { try? await Task.sleep(for: .milliseconds(10)) }
    pipe.fileHandleForReading.readabilityHandler = nil
    let text = String(decoding: output.withLock { $0 }, as: UTF8.self)
    return withLocale(parse(text) ?? fallback(base))
  }

  /** The environment printed after the mark (`env -0`); nil when there is none or it has no PATH. */
  static func parse(_ output: String) -> [String: String]? {
    guard let at = output.range(of: mark) else { return nil }
    var env: [String: String] = [:]
    for entry in output[at.upperBound...].split(separator: "\0") {
      guard let eq = entry.firstIndex(of: "="), eq != entry.startIndex else { continue }
      env[String(entry[..<eq])] = String(entry[entry.index(after: eq)...])
    }
    return env["PATH"] == nil ? nil : env
  }

  static func fallback(_ base: [String: String]) -> [String: String] {
    let home = base["HOME"] ?? Paths.home
    var env = base
    env["PATH"] = [base["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin", "/opt/homebrew/bin", "/usr/local/bin", "\(home)/.local/bin", "\(home)/.cargo/bin"].joined(separator: ":")
    return env
  }

  /** A UTF-8 locale when none is set, as a terminal gives its shells: herdr's panes inherit it. */
  static func withLocale(_ env: [String: String]) -> [String: String] {
    if env["LANG"] != nil || env["LC_ALL"] != nil || env["LC_CTYPE"] != nil { return env }
    var withLocale = env
    withLocale["LANG"] = "en_US.UTF-8"
    return withLocale
  }
}

import Foundation

/**
 * Where the window's T-Rex comes from, in this order (docs/macos.md):
 *
 * 1. T_REX_URL, for a development run against another bridge (the sandbox's).
 * 2. The bridge already registered for this herdr (~/.config/t-rex/bridges, server/bridge.ts): the
 *    herdr plugin's, `bun run start`'s. herdr gives each pane to one attached client, so a second
 *    bridge on the same herdr would take panes from the first; the window joins that one instead.
 * 3. The bridge inside the app (Contents/Resources/bridge), started on a free loopback port with its
 *    own state dir, after herdr's server when nothing answers on herdr's socket. It stops with the
 *    app; herdr does not.
 */
nonisolated enum Bridge {
  struct Started {
    let process: Process
    func stop() {
      guard process.isRunning else { return }
      process.terminate()
      // the bridge gives its attach sidecars two seconds to hand herdr's client slots back (server/index.ts)
      let deadline = Date().addingTimeInterval(3)
      while process.isRunning, Date() < deadline { usleep(50_000) }
    }
  }

  struct Found {
    let origin: URL
    let started: Started?
  }

  enum Failure: LocalizedError {
    case noHerdr
    case herdrSocketStuck(String)
    case herdrDidNotStart(String)
    case bridgeDidNotStart(String)

    var errorDescription: String? {
      switch self {
      case .noHerdr: "herdr is not installed. Install it (herdr.dev), then open T-Rex again."
      case .herdrSocketStuck(let path): "herdr's socket \(path) is there but does not answer. Restart herdr, then open T-Rex again."
      case .herdrDidNotStart(let why): "herdr did not start: \(why)"
      case .bridgeDidNotStart(let why): "The bridge did not start.\n\n\(why)"
      }
    }
  }

  static let support = URL(fileURLWithPath: Paths.home).appending(path: "Library/Application Support/T-Rex")
  static let logs = URL(fileURLWithPath: Paths.home).appending(path: "Library/Logs/T-Rex")

  static func connect() async throws -> Found {
    if let override = ProcessInfo.processInfo.environment["T_REX_URL"], let url = URL(string: override) {
      return Found(origin: url, started: nil)
    }
    let env = await LoginEnvironment.read()
    let socket = herdrSocket(env)
    if let port = registeredPort(socket: socket), await answers(port: port) {
      return Found(origin: origin(port), started: nil)
    }
    guard let herdr = which("herdr", path: env["PATH"]) else { throw Failure.noHerdr }
    try await ensureHerdr(herdr, socket: socket, env: env)
    // herdr may have brought up its plugin's bridge as it started: join it rather than race it
    if let port = registeredPort(socket: socket), await answers(port: port) {
      return Found(origin: origin(port), started: nil)
    }
    return try await startBundled(herdr: herdr, socket: socket, env: env)
  }

  private static func origin(_ port: Int) -> URL { URL(string: "http://127.0.0.1:\(port)/")! }

  /** Where herdr listens: HERDR_SOCKET, else under XDG_CONFIG_HOME or ~/.config (server/herdr/client.ts). */
  static func herdrSocket(_ env: [String: String]) -> String {
    if let socket = env["HERDR_SOCKET"], !socket.isEmpty { return socket }
    let home = env["HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? Paths.home
    let config = env["XDG_CONFIG_HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? (home + "/.config")
    return config + "/herdr/herdr.sock"
  }

  /** The port of the live bridge server/bridge.ts registered for this socket. */
  static func registeredPort(socket: String) -> Int? {
    let name = Paths.sha256(Paths.real(socket)) + ".json"
    // server/bridge.ts: homedir(), which is HOME
    let file = URL(fileURLWithPath: Paths.home).appending(path: ".config/t-rex/bridges/\(name)")
    guard let data = try? Data(contentsOf: file),
          let descriptor = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let port = descriptor["port"] as? Int, let pid = descriptor["pid"] as? Int32,
          descriptor["managed_remote"] as? Bool != true,
          kill(pid, 0) == 0 else { return nil }
    return port
  }

  /** Whether a T-Rex bridge answers on the port: its health says so without asking herdr. */
  static func answers(port: Int) async -> Bool {
    var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/api/health?scope=bridge")!)
    request.timeoutInterval = 1.5
    guard let (data, _) = try? await URLSession.shared.data(for: request),
          let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
    return body["bridge_protocol"] is NSNumber
  }

  static func which(_ name: String, path: String?) -> String? {
    for dir in (path ?? "").split(separator: ":") where !dir.isEmpty {
      let file = "\(dir)/\(name)"
      if FileManager.default.isExecutableFile(atPath: file) { return file }
    }
    return nil
  }

  /**
   * herdr's server when nothing listens on its socket, detached: it owns every pane, so it outlives
   * the app. A socket that is there but does not answer is the user's to look at, not a reason to
   * start a second daemon over it.
   */
  static func ensureHerdr(_ herdr: String, socket: String, env: [String: String]) async throws {
    switch UnixSocket.state(socket) {
    case .answers: return
    case .unknown: throw Failure.herdrSocketStuck(socket)
    case .absent, .refused: break
    }
    try FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
    let log = logs.appending(path: "herdr.log")
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/sh")
    // nohup and a shell of its own: herdr's server must not be this app's child when the app quits
    process.arguments = ["-c", "exec nohup \"$0\" server >>\"$1\" 2>&1 </dev/null &", herdr, log.path]
    process.environment = env
    process.currentDirectoryURL = URL(fileURLWithPath: env["HOME"] ?? Paths.home)
    try process.run()
    process.waitUntilExit()
    let deadline = Date().addingTimeInterval(30)
    while Date() < deadline {
      if UnixSocket.state(socket) == .answers { return }
      try await Task.sleep(for: .milliseconds(100))
    }
    throw Failure.herdrDidNotStart("no answer on \(socket) within 30 s; see \(log.path)")
  }

  /**
   * The bridge in Contents/Resources/bridge (the remote PC bundle for this Mac: Bun, Node, node-pty,
   * server/, shared/, dist/) on a free loopback port, its bin/ first on PATH so the PTY sidecar finds
   * its Node. Its state dir is the app's own: the plugin's bridge keeps its settings, paired devices
   * and remote PCs, and the two never reach the same PC at once.
   */
  static func startBundled(herdr: String, socket: String, env: [String: String]) async throws -> Found {
    guard let bundle = Bundle.main.resourceURL?.appending(path: "bridge"),
          FileManager.default.isExecutableFile(atPath: bundle.appending(path: "bin/bun").path) else {
      throw Failure.bridgeDidNotStart("This copy of T-Rex carries no bridge (Contents/Resources/bridge). Build it with `bun run build:mac`.")
    }
    let port = try freePort()
    try FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
    let state = support.appending(path: "state")
    try FileManager.default.createDirectory(at: state, withIntermediateDirectories: true)
    let logURL = logs.appending(path: "bridge.log")
    if !FileManager.default.fileExists(atPath: logURL.path) { FileManager.default.createFile(atPath: logURL.path, contents: nil) }
    let log = try FileHandle(forWritingTo: logURL)
    log.seekToEndOfFile()

    var childEnv = env
    childEnv["PATH"] = bundle.appending(path: "bin").path + ":" + (env["PATH"] ?? "/usr/bin:/bin")
    childEnv["HOST"] = "127.0.0.1"
    childEnv["PORT"] = String(port)
    childEnv["HERDR_SOCKET"] = socket
    childEnv["HERDR_WEB_HERDR_BIN"] = herdr
    childEnv["HERDR_WEB_STATE_DIR"] = env["HERDR_WEB_STATE_DIR"] ?? state.path
    childEnv["HERDR_WEB_AUTO_UPDATE"] = "0"
    childEnv["HERDR_WEB_APP_NAME"] = "T-Rex"

    let process = Process()
    process.executableURL = bundle.appending(path: "bin/bun")
    process.arguments = [bundle.appending(path: "server/index.ts").path]
    process.currentDirectoryURL = bundle
    process.environment = childEnv
    process.standardOutput = log
    process.standardError = log
    process.standardInput = FileHandle.nullDevice
    try process.run()

    let deadline = Date().addingTimeInterval(30)
    while Date() < deadline {
      if await answers(port: port) { return Found(origin: origin(port), started: Started(process: process)) }
      if !process.isRunning { throw Failure.bridgeDidNotStart(tail(of: logURL)) }
      try await Task.sleep(for: .milliseconds(150))
    }
    process.terminate()
    throw Failure.bridgeDidNotStart("No answer on 127.0.0.1:\(port) within 30 s.\n\n" + tail(of: logURL))
  }

  /** A loopback port nothing listens on: the kernel picks one, and it is given back at once. */
  static func freePort() throws -> Int {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { throw Failure.bridgeDidNotStart("no socket for a free port") }
    defer { close(fd) }
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_addr.s_addr = inet_addr("127.0.0.1")
    address.sin_port = 0
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    let bound = withUnsafeMutablePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, length) == 0 && getsockname(fd, $0, &length) == 0 }
    }
    guard bound else { throw Failure.bridgeDidNotStart("no free loopback port") }
    return Int(UInt16(bigEndian: address.sin_port))
  }

  private static func tail(of file: URL) -> String {
    guard let data = try? Data(contentsOf: file) else { return "" }
    return String(decoding: data.suffix(2000), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
  }
}

import AppKit
import CryptoKit

/** Whether something listens on a unix socket: `absent` (no file) and `refused` (left by a dead daemon) are free to take. */
nonisolated enum UnixSocket {
  enum State { case answers, absent, refused, unknown }

  static func state(_ path: String) -> State {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { return .unknown }
    defer { close(fd) }
    var address = sockaddr_un()
    let bytes = Array(path.utf8)
    guard bytes.count < MemoryLayout.size(ofValue: address.sun_path) else { return .unknown }
    address.sun_family = sa_family_t(AF_UNIX)
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    withUnsafeMutableBytes(of: &address.sun_path) { raw in
      raw.copyBytes(from: bytes)
      raw[bytes.count] = 0
    }
    let result = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    if result == 0 { return .answers }
    switch errno {
    case ENOENT: return .absent
    case ECONNREFUSED: return .refused
    default: return .unknown
    }
  }
}

nonisolated enum Paths {
  /**
   * HOME as the environment says, as the bridge and herdr read it (Bun's and Rust's home lookups
   * both start there); NSHomeDirectory() ignores it and asks the system for the account's.
   */
  static var home: String {
    let env = ProcessInfo.processInfo.environment["HOME"] ?? ""
    return env.isEmpty ? NSHomeDirectory() : env
  }

  /** realpath(3), as Node's realpathSync: Foundation's symlink resolution drops /private, which the bridge keeps. */
  static func real(_ path: String) -> String {
    guard let resolved = realpath(path, nil) else { return path }
    defer { free(resolved) }
    return String(cString: resolved)
  }

  static func sha256(_ text: String) -> String {
    SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
  }
}

/** The window's colour before the page says its own (styles.css, the dark theme's --bg). */
enum Theme {
  static let fallback = NSColor(srgbRed: 0x12 / 255, green: 0x10 / 255, blue: 0x0e / 255, alpha: 1)

  /** A CSS colour as getComputedStyle gives it, `rgb(r, g, b)` or `rgba(r, g, b, a)`, or `#rrggbb`. */
  static func color(_ css: String) -> NSColor? {
    let text = css.trimmingCharacters(in: .whitespaces)
    if text.hasPrefix("#"), text.count == 7, let value = UInt32(text.dropFirst(), radix: 16) {
      return NSColor(srgbRed: CGFloat((value >> 16) & 0xff) / 255, green: CGFloat((value >> 8) & 0xff) / 255, blue: CGFloat(value & 0xff) / 255, alpha: 1)
    }
    guard let open = text.firstIndex(of: "("), let close = text.lastIndex(of: ")") else { return nil }
    let parts = text[text.index(after: open)..<close].split(whereSeparator: { $0 == "," || $0 == " " || $0 == "/" }).compactMap { Double($0) }
    guard parts.count >= 3 else { return nil }
    return NSColor(srgbRed: parts[0] / 255, green: parts[1] / 255, blue: parts[2] / 255, alpha: 1)
  }
}

/** Files the app carries in Contents/Resources (scripts/build-mac-app.ts copies them from macos/Resources). */
enum Bundled {
  static func text(_ name: String) -> String? {
    guard let url = Bundle.main.url(forResource: name, withExtension: nil) else { return nil }
    return try? String(contentsOf: url, encoding: .utf8)
  }
}

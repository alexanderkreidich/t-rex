// swift-tools-version: 6.2
// T-Rex for the Mac: a native window on the bridge (docs/macos.md). `bun run build:mac` at the root
// builds it into macos/build/T-Rex.app with the bridge inside.
import PackageDescription

let package = Package(
  name: "TRex",
  platforms: [.macOS(.v15)],
  targets: [
    .executableTarget(
      name: "TRex",
      path: "Sources/TRex",
      swiftSettings: [
        .defaultIsolation(MainActor.self),
        .enableUpcomingFeature("NonisolatedNonsendingByDefault"),
        .enableUpcomingFeature("InferIsolatedConformances"),
      ]
    ),
    .testTarget(
      name: "TRexTests",
      dependencies: ["TRex"],
      swiftSettings: [.defaultIsolation(MainActor.self)]
    ),
  ]
)

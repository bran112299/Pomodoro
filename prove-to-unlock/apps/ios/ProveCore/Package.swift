// swift-tools-version:5.9
// Platform-independent logic shared by the iOS app and its Screen Time extension. A faithful
// port of packages/core (TypeScript); both are tested against spec/vectors so they agree exactly.
import PackageDescription

let package = Package(
    name: "ProveCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "ProveCore", targets: ["ProveCore"]),
    ],
    targets: [
        .target(name: "ProveCore", path: "Sources/ProveCore"),
        .testTarget(name: "ProveCoreTests", dependencies: ["ProveCore"], path: "Tests/ProveCoreTests"),
    ]
)

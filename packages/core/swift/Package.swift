// swift-tools-version: 5.9
import PackageDescription

// ByosCore: the Swift side of @byos/core for iOS and macOS apps. Same credential-mode API and the
// same conformance vectors (../conformance) as the TypeScript package.
let package = Package(
    name: "ByosCore",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "ByosCore", targets: ["ByosCore"]),
    ],
    targets: [
        .target(name: "ByosCore"),
        .testTarget(name: "ByosCoreTests", dependencies: ["ByosCore"]),
    ]
)

// swift-tools-version: 6.0
import PackageDescription

// The MLX engine and the `byos-mlx` helper that @byos/mlx-local drives over
// stdin/stdout. Versions match Skim's SkimMLXEngine, which ships this stack on
// iOS and macOS today; bump them together.
let package = Package(
    name: "ByosMLX",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [
        .library(name: "ByosMLX", targets: ["ByosMLX"]),
        .executable(name: "byos-mlx", targets: ["byos-mlx"]),
    ],
    dependencies: [
        .package(url: "https://github.com/ml-explore/mlx-swift", .upToNextMinor(from: "0.32.3")),
        .package(url: "https://github.com/ml-explore/mlx-swift-lm", exact: "3.32.3"),
        .package(url: "https://github.com/huggingface/swift-transformers", .upToNextMinor(from: "1.3.4")),
    ],
    targets: [
        .target(
            name: "ByosMLX",
            dependencies: [
                .product(name: "MLX", package: "mlx-swift"),
                .product(name: "MLXLMCommon", package: "mlx-swift-lm"),
                .product(name: "MLXLLM", package: "mlx-swift-lm"),
                .product(name: "Hub", package: "swift-transformers"),
                .product(name: "Tokenizers", package: "swift-transformers"),
            ]
        ),
        .executableTarget(name: "byos-mlx", dependencies: ["ByosMLX"]),
    ],
    swiftLanguageModes: [.v5]
)

#!/bin/sh
# Builds the byos-mlx helper for Apple silicon macOS into packages/mlx-local/bin:
#   bin/byos-mlx                         the helper (ad-hoc signed)
#   bin/mlx.metallib                     MLX's GPU kernels (SwiftPM cannot build Metal)
#   bin/swift-transformers_Hub.bundle    tokenizer fallback resources
# Needs Xcode (for the Metal compiler). Output directory: $BYOS_MLX_OUT or bin/.
set -eu
PKG_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OUT_DIR="${BYOS_MLX_OUT:-$PKG_DIR/bin}"
SCRATCH_DIR="${TMPDIR:-/tmp}/byos-mlx-build"
export MACOSX_DEPLOYMENT_TARGET=14.0

set -- --package-path "$PKG_DIR/swift" --product byos-mlx -c release --scratch-path "$SCRATCH_DIR"
swift build "$@"
BIN_DIR=$(swift build "$@" --show-bin-path)
RESOURCE_PATH="$BIN_DIR/swift-transformers_Hub.bundle"
if [ ! -f "$BIN_DIR/byos-mlx" ] || [ ! -d "$RESOURCE_PATH" ]; then
  echo "SwiftPM output is missing byos-mlx or its resource bundle: $BIN_DIR" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
cp -f "$BIN_DIR/byos-mlx" "$OUT_DIR/byos-mlx"
rm -rf "$OUT_DIR/swift-transformers_Hub.bundle"
cp -Rf "$RESOURCE_PATH" "$OUT_DIR/swift-transformers_Hub.bundle"
chmod -R u+w "$OUT_DIR/swift-transformers_Hub.bundle"

MLX_METAL_DIR=$(find "$SCRATCH_DIR/checkouts/mlx-swift" -path '*/mlx-generated/metal' -type d | head -1)
test -n "$MLX_METAL_DIR"
AIR_DIR="$SCRATCH_DIR/byos-mlx-air"
rm -rf "$AIR_DIR"
mkdir -p "$AIR_DIR"
find "$MLX_METAL_DIR" -name '*.metal' -type f | while read -r SOURCE; do
  xcrun -sdk macosx metal -Wall -Wextra -fno-fast-math -Wno-c++17-extensions \
    -mmacosx-version-min=14.0 -c "$SOURCE" -I"$MLX_METAL_DIR" \
    -o "$AIR_DIR/$(basename "${SOURCE%.metal}").air"
done
xcrun -sdk macosx metallib "$AIR_DIR"/*.air -o "$OUT_DIR/mlx.metallib"
codesign --force --sign - "$OUT_DIR/byos-mlx"
echo "Built $OUT_DIR/byos-mlx"

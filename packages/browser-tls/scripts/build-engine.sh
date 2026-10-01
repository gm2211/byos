#!/usr/bin/env bash
set -euo pipefail

PACKAGE_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
RUST_DIR="$PACKAGE_ROOT/rust"

if [[ $# -gt 1 ]]; then
  echo "Usage: $0 [OUTPUT_DIR]" >&2
  exit 2
fi
OUTPUT_INPUT="${1:-$PACKAGE_ROOT/engine}"
if [[ "$OUTPUT_INPUT" != /* ]]; then OUTPUT_INPUT="$PWD/$OUTPUT_INPUT"; fi
mkdir -p "$OUTPUT_INPUT"
OUTPUT_DIR="$(cd "$OUTPUT_INPUT" && pwd -P)"

TOOLCHAIN="${BYOS_TLS_TOOLCHAIN:-1.94.1}"
WASM_BINDGEN="${BYOS_WASM_BINDGEN:-wasm-bindgen}"
CARGO_HOME_FOR_REMAP="${CARGO_HOME:-$HOME/.cargo}"
export RUSTC="$(rustup which --toolchain "$TOOLCHAIN" rustc)"
export RUSTDOC="$(rustup which --toolchain "$TOOLCHAIN" rustdoc)"
[[ "$("$RUSTC" --version)" == 'rustc 1.94.1 '* ]] || { echo 'Use Rust 1.94.1 to reproduce this artifact.' >&2; exit 1; }

if [[ "$(uname -s)" == Darwin ]]; then
  # Apple's ar creates empty archives from ring's WASM objects; use LLVM's archiver.
  LLVM_PREFIX="${BYOS_LLVM_PREFIX:-$(brew --prefix llvm)}"
  export CC_wasm32_unknown_unknown="$LLVM_PREFIX/bin/clang"
  export AR_wasm32_unknown_unknown="$LLVM_PREFIX/bin/llvm-ar"
else
  export CC_wasm32_unknown_unknown="${CC_wasm32_unknown_unknown:-clang}"
  export AR_wasm32_unknown_unknown="${AR_wasm32_unknown_unknown:-llvm-ar}"
fi
[[ "$("$CC_wasm32_unknown_unknown" --version | head -1)" == *'clang version 23.1.0'* ]] || { echo 'Use LLVM clang 23.1.0 to reproduce this artifact.' >&2; exit 1; }
[[ "$("$WASM_BINDGEN" --version)" == 'wasm-bindgen 0.2.128' ]] || { echo 'Use wasm-bindgen-cli 0.2.128.' >&2; exit 1; }

# Encoded flags preserve clone/cache paths containing spaces. Virtual path retains reviewed bytes.
unset RUSTFLAGS
export CARGO_ENCODED_RUSTFLAGS="--remap-path-prefix=$RUST_DIR=/motive/browser-tls"$'\x1f'"--remap-path-prefix=$CARGO_HOME_FOR_REMAP=/cargo"
TARGET_DIR="${BYOS_TLS_TARGET_DIR:-$PACKAGE_ROOT/target}"
export CARGO_TARGET_DIR="$TARGET_DIR"
rustup run "$TOOLCHAIN" cargo build --manifest-path "$RUST_DIR/Cargo.toml" --target wasm32-unknown-unknown --release --locked
"$WASM_BINDGEN" "$TARGET_DIR/wasm32-unknown-unknown/release/motive_browser_tls.wasm" --target web --out-dir "$OUTPUT_DIR"
node "$PACKAGE_ROOT/scripts/verify-engine.mjs" --write --engine-dir "$OUTPUT_DIR"

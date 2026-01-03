#!/bin/bash
# Build floatty-server and copy to binaries/ for Tauri sidecar bundling
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BINARIES_DIR="$PROJECT_ROOT/src-tauri/binaries"

# Get target triple
TARGET_TRIPLE=$(rustc -vV | grep host | cut -d' ' -f2)

echo "Building floatty-server for $TARGET_TRIPLE..."

# Build in release mode
cargo build --manifest-path "$PROJECT_ROOT/src-tauri/Cargo.toml" -p floatty-server --release

# Copy with target triple suffix (required by Tauri sidecar)
mkdir -p "$BINARIES_DIR"
cp "$PROJECT_ROOT/src-tauri/target/release/floatty-server" "$BINARIES_DIR/floatty-server-$TARGET_TRIPLE"

echo "Copied to $BINARIES_DIR/floatty-server-$TARGET_TRIPLE"

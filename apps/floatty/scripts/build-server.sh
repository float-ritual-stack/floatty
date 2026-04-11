#!/bin/bash
# Build floatty-server and copy to binaries/ for Tauri sidecar bundling
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BINARIES_DIR="$PROJECT_ROOT/src-tauri/binaries"

# Kill servers on known ports (prevents stale server after rebuild)
# Ports: 8765 (release), 8766 (dev alt), 33333 (debug)
# This is important because Tauri sidecars persist across builds - the app must
# be restarted to pick up a new server binary, but killing the server first
# ensures the app will spawn a fresh one.
kill_existing_servers() {
  local pids=$(lsof -ti :8765 :8766 :33333 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "Killing servers on ports 8765/8766/33333: $pids"
    echo "$pids" | xargs kill 2>/dev/null || true
    sleep 1
  fi
}

kill_existing_servers

# Get target triple
TARGET_TRIPLE=$(rustc -vV | grep host | cut -d' ' -f2)

echo "Building floatty-server for $TARGET_TRIPLE..."

# Build in release mode
cargo build --manifest-path "$PROJECT_ROOT/src-tauri/Cargo.toml" -p floatty-server --release

# Copy with target triple suffix (required by Tauri sidecar)
mkdir -p "$BINARIES_DIR"
cp "$PROJECT_ROOT/src-tauri/target/release/floatty-server" "$BINARIES_DIR/floatty-server-$TARGET_TRIPLE"

echo "Copied to $BINARIES_DIR/floatty-server-$TARGET_TRIPLE"

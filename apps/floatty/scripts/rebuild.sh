#!/bin/bash
# Nuclear rebuild: kill → build → kill again → install → launch → verify
# The double-kill is intentional: macOS/Tauri can respawn sidecars during build.
# Usage: ./scripts/rebuild.sh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
APP_SRC="$PROJECT_ROOT/src-tauri/target/release/bundle/macos/float-pty.app"
APP_DEST="/Applications/float-pty.app"
BINARIES_DIR="$PROJECT_ROOT/src-tauri/binaries"
TARGET_TRIPLE=$(rustc -vV | grep host | cut -d' ' -f2)

PORT=$(grep '^server_port' ~/.floatty/config.toml 2>/dev/null | cut -d= -f2 | tr -d ' ')
PORT=${PORT:-8765}

nuke_floatty() {
  # 1. Kill the Tauri app first (it's the parent that spawns the server)
  osascript -e 'quit app "float-pty"' 2>/dev/null || true
  sleep 1

  # 2. Kill by process name
  pkill -9 -f "floatty-server" 2>/dev/null || true
  pkill -9 -f "float-pty" 2>/dev/null || true

  # 3. Kill anything on known ports
  for p in 8765 8766 33333; do
    PIDS=$(lsof -ti :$p 2>/dev/null || true)
    if [ -n "$PIDS" ]; then
      echo "    Killing PIDs on port $p: $PIDS"
      echo "$PIDS" | xargs kill -9 2>/dev/null || true
    fi
  done

  sleep 1

  # 4. Fix window-state: pkill -9 can catch the app mid-hide, persisting visible:false.
  #    Force visible:true so the next launch actually shows a window.
  WINDOW_STATE="$HOME/Library/Application Support/dev.float.floatty/.window-state.json"
  if [ -f "$WINDOW_STATE" ]; then
    sed -i '' 's/"visible": false/"visible": true/' "$WINDOW_STATE"
  fi
}

wait_port_free() {
  for i in $(seq 1 10); do
    if ! lsof -ti :$PORT >/dev/null 2>&1; then
      return 0
    fi
    echo "    Port $PORT still in use, waiting... (attempt $i)"
    # Escalate: kill whatever is there
    lsof -ti :$PORT 2>/dev/null | xargs kill -9 2>/dev/null || true
    sleep 1
  done
  echo "ERROR: Port $PORT stuck. Giving up."
  lsof -i :$PORT
  exit 1
}

# ── Step 1: Kill before build ────────────────────────────────────────
echo "==> Killing floatty..."
nuke_floatty
echo "    Done."

# ── Step 2: Build server binary ──────────────────────────────────────
echo "==> Building floatty-server (release)..."
cargo build --manifest-path "$PROJECT_ROOT/src-tauri/Cargo.toml" -p floatty-server --release

mkdir -p "$BINARIES_DIR"
cp "$PROJECT_ROOT/src-tauri/target/release/floatty-server" "$BINARIES_DIR/floatty-server-$TARGET_TRIPLE"
echo "    Sidecar copied to binaries/"

# ── Step 3: Build Tauri app ──────────────────────────────────────────
echo "==> Building Tauri app..."
cd "$PROJECT_ROOT"
bun run tauri build

# ── Step 4: Kill AGAIN (something may have respawned during build) ───
echo "==> Pre-install kill..."
nuke_floatty
wait_port_free
echo "    Port $PORT is free."

# ── Step 5: Install ──────────────────────────────────────────────────
if [ ! -d "$APP_SRC" ]; then
  echo "ERROR: No .app bundle at $APP_SRC"
  exit 1
fi

BUILD_VERSION=$(defaults read "$APP_SRC/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo "unknown")
echo "==> Installing floatty v$BUILD_VERSION..."

rm -rf "$APP_DEST"
cp -R "$APP_SRC" "$APP_DEST"
xattr -cr "$APP_DEST" 2>/dev/null || true

# ── Step 6: Launch ───────────────────────────────────────────────────
# Unset dev env vars so the release app uses its own defaults (~/.floatty)
# FLOATTY_DATA_DIR leaks from tauri:dev:fresh into the shell session
unset FLOATTY_DATA_DIR
echo "==> Launching..."
open "$APP_DEST"

# ── Step 7: Wait for health ──────────────────────────────────────────
echo -n "==> Waiting for server on port $PORT"
for i in $(seq 1 20); do
  sleep 1
  echo -n "."
  HEALTH=$(curl -sf --max-time 1 "http://127.0.0.1:$PORT/api/v1/health" 2>/dev/null || true)
  if [ -n "$HEALTH" ]; then
    echo ""
    GIT_SHA=$(echo "$HEALTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('gitSha','?'))" 2>/dev/null || echo "?")
    VERSION=$(echo "$HEALTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('version','?'))" 2>/dev/null || echo "?")
    DIRTY=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(' (dirty)' if d.get('gitDirty') else '')" 2>/dev/null || echo "")
    echo ""
    echo "    floatty v$VERSION (${GIT_SHA}${DIRTY}) on port $PORT"
    echo ""
    # Quick sanity: block count
    BLOCKS=$(curl -sf --max-time 5 "http://127.0.0.1:$PORT/api/v1/blocks" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('blocks',[])))" 2>/dev/null || echo "?")
    echo "    $BLOCKS blocks loaded"
    exit 0
  fi
done

echo ""
echo "ERROR: Server didn't respond on port $PORT within 20s."
echo "Check: ps aux | grep floatty"
exit 1

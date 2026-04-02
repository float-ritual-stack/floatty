#!/bin/bash
# Install floatty release build — kills stale server, copies .app, relaunches
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
APP_SRC="$PROJECT_ROOT/src-tauri/target/release/bundle/macos/float-pty.app"
APP_DEST="/Applications/float-pty.app"

# Verify the build exists
if [ ! -d "$APP_SRC" ]; then
  echo "No build found at $APP_SRC"
  echo "Run: ./scripts/build-server.sh && npm run tauri build"
  exit 1
fi

# Get version from the build
BUILD_VERSION=$(defaults read "$APP_SRC/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo "unknown")
echo "Installing floatty v$BUILD_VERSION"

# 1. Quit the running app (graceful, then force)
if pgrep -x "float-pty" >/dev/null 2>&1; then
  echo "Quitting floatty..."
  osascript -e 'quit app "float-pty"' 2>/dev/null || true
  sleep 2
  # Force kill if still alive
  pkill -x "float-pty" 2>/dev/null || true
  sleep 1
fi

# 2. Kill any orphaned server processes on known ports
PIDS=$(lsof -ti :8765 :33333 2>/dev/null || true)
if [ -n "$PIDS" ]; then
  echo "Killing stale server(s): $PIDS"
  echo "$PIDS" | xargs kill 2>/dev/null || true
  sleep 1
fi

# 3. Copy .app to /Applications
echo "Copying to $APP_DEST..."
rm -rf "$APP_DEST"
cp -R "$APP_SRC" "$APP_DEST"

# 4. Clear quarantine (local build, not from internet)
xattr -cr "$APP_DEST" 2>/dev/null || true

# 5. Relaunch
echo "Launching floatty v$BUILD_VERSION..."
open "$APP_DEST"

# 6. Wait for server to come up
echo -n "Waiting for server"
KEY=$(grep '^api_key' ~/.floatty/config.toml 2>/dev/null | cut -d'"' -f2)
PORT=$(grep server_port ~/.floatty/config.toml 2>/dev/null | cut -d= -f2 | tr -d ' ')
for i in $(seq 1 15); do
  sleep 1
  echo -n "."
  HEALTH=$(curl -sf --max-time 1 "http://127.0.0.1:$PORT/api/v1/health" 2>/dev/null || true)
  if [ -n "$HEALTH" ]; then
    echo ""
    echo "$HEALTH" | python3 -m json.tool 2>/dev/null || echo "$HEALTH"
    echo ""
    echo "floatty v$BUILD_VERSION installed and running."
    exit 0
  fi
done

echo ""
echo "Server didn't respond on port $PORT within 15s."
echo "App is open — server may still be starting. Check manually:"
echo "  curl http://127.0.0.1:$PORT/api/v1/health"

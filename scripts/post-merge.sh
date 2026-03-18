#!/bin/bash
set -e

echo "=== Post-merge setup ==="

# Install JS dependencies
npm install --no-fund --no-audit

# Restore server config (merge may overwrite it)
mkdir -p "$HOME/.floatty-replit"
cat > "$HOME/.floatty-replit/config.toml" << 'CONF'
server_port = 8080

[server]
enabled = true
port = 8080
bind = "0.0.0.0"
auth_enabled = false

[backup]
enabled = false
CONF

# Rebuild the Rust backend if binary is missing or stale
SERVER_BIN="src-tauri/target-server/debug/floatty-server"
if [ ! -f "$SERVER_BIN" ]; then
  echo "Server binary missing, rebuilding..."
  cd src-tauri
  CARGO_TARGET_DIR=target-server FLOATTY_DATA_DIR="$HOME/.floatty-replit" cargo build -p floatty-server -j 2
  cd ..
else
  echo "Server binary exists, skipping rebuild"
fi

echo "=== Post-merge setup complete ==="

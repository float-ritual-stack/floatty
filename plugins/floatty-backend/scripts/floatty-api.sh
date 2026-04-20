#!/usr/bin/env bash
# floatty-api.sh - Core API wrapper for floatty-server
# Source this for common API setup

# ─── jq availability ────────────────────────────────────────────────
# In claude.ai sandboxes, floatctl bootstrap installs jq to /tmp/jq.
# Ensure it's on PATH so all downstream helpers can use it.
if ! command -v jq &>/dev/null; then
  if [[ -x /tmp/jq ]]; then
    export PATH="/tmp:$PATH"
  else
    # Attempt install as last resort (works in claude.ai containers)
    if command -v apt-get &>/dev/null; then
      apt-get update -qq && apt-get install -y -qq jq 2>/dev/null
    fi
  fi
fi

# Server URL resolution (in priority order):
# 1. Probe localhost:8765 (release server) — if it responds, use it
# 2. Probe localhost:33333 (dev server) — if it responds, use it
# 3. FLOATTY_URL env var (may be stale from a tauri dev session)
# 4. ngrok tunnel (Desktop Claude / sandbox fallback)
#
# Why not just trust FLOATTY_URL? Because tauri dev injects
# FLOATTY_URL=http://127.0.0.1:33333 into the shell env, and Claude Code
# inherits it even when the dev server is long dead and the release server
# is alive on 8765. Probing is cheap (1 curl), silent failure is not.
_floatty_probe_url() {
  local url="$1"
  curl -sf -o /dev/null --max-time 1 "$url/api/v1/health" 2>/dev/null
}

if _floatty_probe_url "http://localhost:8765"; then
  FLOATTY_URL="http://localhost:8765"
elif _floatty_probe_url "http://localhost:33333"; then
  FLOATTY_URL="http://localhost:33333"
elif [[ -n "$FLOATTY_URL" ]] && _floatty_probe_url "$FLOATTY_URL"; then
  : # env var is valid, keep it
else
  FLOATTY_URL="${FLOATTY_URL:-http://127.0.0.1:8765}"
fi

# API key: config.toml > env var > hardcoded default
# config.toml is the source of truth — env var may be stale (same tauri dev problem)
if [[ -f ~/.floatty/config.toml ]]; then
  _FLOATTY_CONFIG_KEY=$(grep -E '^\s*api_key\s*=' ~/.floatty/config.toml | grep -v anthropic | head -1 | cut -d'"' -f2)
fi
FLOATTY_API_KEY="${_FLOATTY_CONFIG_KEY:-${FLOATTY_API_KEY:-floatty-1890872e6255d2d0}}"
unset _FLOATTY_CONFIG_KEY

# Check if auth is disabled (no auth header needed)
if [[ -f ~/.floatty/config.toml ]]; then
  AUTH_DISABLED=$(grep -E '^\s*auth_enabled\s*=\s*false' ~/.floatty/config.toml)
fi

# Core curl wrapper with auth headers (or without if auth disabled)
floatty_curl() {
  if [[ -n "$AUTH_DISABLED" ]]; then
    curl -s -H "Content-Type: application/json" "$@"
  else
    curl -s -H "Authorization: Bearer $FLOATTY_API_KEY" \
         -H "Content-Type: application/json" \
         "$@"
  fi
}

# Health check
floatty_health() {
  floatty_curl "$FLOATTY_URL/api/v1/health"
}

# Export for subshells
export FLOATTY_URL FLOATTY_API_KEY

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
# 1. FLOATTY_URL env var — if set, always wins (explicit > auto)
# 2. Probe localhost:8765 (release server) — if it responds, use it
# 3. Probe localhost:33333 (dev server) — if it responds, use it
# 4. Fall back to release default (http://127.0.0.1:8765)
#
# PR #250 feedback: previously probes won over explicit FLOATTY_URL, which
# broke the documented Desktop Daddy / ngrok remote-agent flow — callers
# passing `FLOATTY_URL=https://floatty.ngrok.app` got silently redirected to
# localhost. Explicit user intent should win, full stop. If the user sets
# FLOATTY_URL to a stale dev port, that's a user problem (and a clear one:
# curl will fail with connection refused, not silently hit a different outline).
_floatty_probe_url() {
  local url="$1"
  curl -sf -o /dev/null --max-time 1 "$url/api/v1/health" 2>/dev/null
}

if [[ -n "$FLOATTY_URL" ]]; then
  : # explicit env var wins — do nothing
elif _floatty_probe_url "http://localhost:8765"; then
  FLOATTY_URL="http://localhost:8765"
elif _floatty_probe_url "http://localhost:33333"; then
  FLOATTY_URL="http://localhost:33333"
else
  FLOATTY_URL="http://127.0.0.1:8765"
fi

# API key resolution (priority order):
#   1. $FLOATTY_API_KEY env var (always wins — the right lever for Desktop
#      Daddy / remote MCP setups that have no config.toml access)
#   2. api_key= line in ~/.floatty-dev/config.toml (dev build)
#   3. api_key= line in ~/.floatty/config.toml (release build)
#   4. bootstrap default (well-known, ships with floatty's default config)
#
# Threat model for #4 (Greptile P2 on PR #250): the bootstrap key is the
# literal default that every fresh `floatty` dev install writes into its
# config.toml on first run. It's a convention, not a secret. The real
# authority is the server's bind address + any tunnel in front of it (ngrok,
# Caddy, etc.) — NOT the key value.
#
# Consequences if you tunnel floatty publicly with the default key:
#   * Anyone who reads this file (public repo) can hit your tunneled server.
#   * Rotate: change api_key= in your config.toml + restart floatty + update
#     FLOATTY_API_KEY in whatever env consumes this (Desktop Daddy MCP, ngrok
#     consumer, etc.).
#
# Why not gate on localhost: Desktop Daddy / other remote agents access
# floatty over ngrok by design. Blocking the default for non-local URLs
# would break those flows for the common case (same user on both ends). The
# ergonomic default wins; rotate the key if you're exposing publicly.
_floatty_read_api_key_from() {
  local path="$1"
  [[ -f "$path" ]] || return 1
  grep -E '^\s*api_key\s*=' "$path" | grep -v anthropic | head -1 | cut -d'"' -f2
}

if [[ -z "$FLOATTY_API_KEY" ]]; then
  FLOATTY_API_KEY=$(_floatty_read_api_key_from ~/.floatty-dev/config.toml)
  [[ -z "$FLOATTY_API_KEY" ]] && FLOATTY_API_KEY=$(_floatty_read_api_key_from ~/.floatty/config.toml)
fi
FLOATTY_API_KEY="${FLOATTY_API_KEY:-floatty-1890872e6255d2d0}"

# Check if auth is disabled (no auth header needed) — same dual-path probe.
if [[ -z "$AUTH_DISABLED" ]]; then
  if [[ -f ~/.floatty-dev/config.toml ]]; then
    AUTH_DISABLED=$(grep -E '^\s*auth_enabled\s*=\s*false' ~/.floatty-dev/config.toml)
  fi
  if [[ -z "$AUTH_DISABLED" && -f ~/.floatty/config.toml ]]; then
    AUTH_DISABLED=$(grep -E '^\s*auth_enabled\s*=\s*false' ~/.floatty/config.toml)
  fi
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

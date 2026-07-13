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
# 1. FLOATTY_URL env var — if set, always wins (explicit > auto). Inside
#    floatty terminals FLOATTY_URL is pre-injected and is correct in BOTH
#    local and remote mode, so it's also the cleanest in-terminal path.
# 2. remote_server_url from config.toml (FLO-762) — if set, the app runs NO
#    local server; talk to the remote authority instead of probing localhost.
# 3. Probe localhost:8765 (release server) — if it responds, use it
# 4. Probe localhost:33333 (dev server) — if it responds, use it
# 5. Fall back to release default (http://127.0.0.1:8765)
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

# FLO-762: read a live top-level `remote_server_url = "..."` from a config.toml.
# A commented example (`# remote_server_url = ...`) starts with `#`, so the
# `^\s*remote_server_url` anchor never matches it — only an active setting.
_floatty_read_remote_url_from() {
  local path="$1" line
  [[ -f "$path" ]] || return 1
  # NOTE: parse via grep + shell parameter expansion, NOT `grep | head | cut`.
  # When this script is sourced under zsh (the case for many agents), the
  # head/cut pipe stage intermittently fails with "command not found"; grep
  # and builtin expansion are reliable across bash + zsh.
  line=$(grep -E '^[[:space:]]*remote_server_url[[:space:]]*=' "$path")
  line="${line%%$'\n'*}"          # first matching line only (replaces head -1)
  line="${line#*\"}"; line="${line%%\"*}"   # value between quotes (replaces cut)
  [[ -n "$line" && "$line" != *remote_server_url* ]] && printf '%s\n' "$line"
}

# _floatty_cfg records which config.toml supplied a remote_server_url, so the
# api_key below is read from the SAME file. A release-config remote pointer
# paired with a dev-config key is a guaranteed 401 (FLO-762).
#
# Scan dev BEFORE release — consistent with the api_key fallback order and the
# config precedence documented in README ("dev, then release"). A dev session
# pointed at a remote dev authority should win over the release daily-driver;
# either way the matching key is read from the same file via _floatty_cfg.
_floatty_cfg=""
if [[ -n "$FLOATTY_URL" ]]; then
  : # explicit env var wins — do nothing
else
  for _cfg in ~/.floatty-dev/config.toml ~/.floatty/config.toml; do
    _floatty_remote=$(_floatty_read_remote_url_from "$_cfg")
    if [[ -n "$_floatty_remote" ]]; then
      FLOATTY_URL="${_floatty_remote%/}"   # remote authority — skip localhost probe
      _floatty_cfg="$_cfg"
      break
    fi
  done
  if [[ -z "$FLOATTY_URL" ]]; then
    if _floatty_probe_url "http://localhost:8765"; then
      FLOATTY_URL="http://localhost:8765"
    elif _floatty_probe_url "http://localhost:33333"; then
      FLOATTY_URL="http://localhost:33333"
    else
      FLOATTY_URL="http://127.0.0.1:8765"
    fi
  fi
fi

# API key resolution (priority order):
#   1. $FLOATTY_API_KEY env var (always wins — the right lever for Desktop
#      Daddy / remote MCP setups that have no config.toml access)
#   2. FLO-762: the key from the config.toml that supplied remote_server_url.
#      URL and key MUST come from the same file — a release-config remote
#      pointer with a dev-config key 401s against the remote authority.
#   3. api_key= line in ~/.floatty-dev/config.toml (dev build)
#   4. api_key= line in ~/.floatty/config.toml (release build)
#   5. bootstrap default (well-known, ships with floatty's default config)
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
  local path="$1" line
  [[ -f "$path" ]] || return 1
  # grep + parameter expansion (no head/cut) — robust when sourced under zsh.
  # The `^[[:space:]]*api_key` anchor already excludes `anthropic_api_key`
  # (starts with "anthropic", not "api_key"), so no value-based filtering —
  # filtering on "anthropic" would wrongly drop a server key whose value
  # happened to contain that substring.
  line=$(grep -E '^[[:space:]]*api_key[[:space:]]*=' "$path")
  line="${line%%$'\n'*}"          # first match (replaces head -1)
  line="${line#*\"}"; line="${line%%\"*}"   # value between quotes (replaces cut)
  [[ -n "$line" && "$line" != *api_key* ]] && printf '%s\n' "$line"
}

if [[ -z "$FLOATTY_API_KEY" ]]; then
  # FLO-762: if a config supplied the remote URL, its key must win — that
  # server only accepts that key. Otherwise fall back to dev-then-release.
  [[ -n "$_floatty_cfg" ]] && FLOATTY_API_KEY=$(_floatty_read_api_key_from "$_floatty_cfg")
  [[ -z "$FLOATTY_API_KEY" ]] && FLOATTY_API_KEY=$(_floatty_read_api_key_from ~/.floatty-dev/config.toml)
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

# Core curl wrapper with auth + ngrok-aware retry.
#
# Two ngrok gotchas protect against here (both discovered 2026-04-20 against
# https://floatty.ngrok.app):
#
# 1. Consistent interstitial (3.37.6+): free-tier tunnels serve a 503 with
#    body literal "DNS cache overflow" unless `ngrok-skip-browser-warning: 1`
#    is set. Harmless on localhost — always send it.
#
# 2. Intermittent interstitials: even WITH the header, ngrok edge fires the
#    interstitial inconsistently under sequential POST traffic. Daddy's
#    sandbox saw 7/16 POSTs bounce with 503 "DNS cache overflow" in a single
#    tree-creation run; retry with 0.5s backoff cleared all transient failures
#    within 2-3 attempts. A retry wrapper has to live in this helper so every
#    caller is protected without reinventing `mk()` per script.
#
# Only 5xx (and curl connection errors) retry — 4xx is the caller's fault,
# retrying won't help and would hide the real error. POST retries are safe
# here because ngrok's 503 interstitial is an EDGE response (the tunnel
# rejected the request; the backend never saw it). A real 5xx from the
# backend is rare and worth surfacing via the exhausted-retries return code.
#
# Tuning:
#   FLOATTY_CURL_RETRIES   (default: 5)     max attempts including the first
#   FLOATTY_CURL_BACKOFF   (default: 0.5)   initial delay in seconds; ×1.5 per retry
#
# Exit codes:
#   0  success (2xx/3xx/4xx — body written to stdout)
#   1  exhausted retries (final body written to stdout for debugging)
# zsh-compat notes (0.7.1):
# - $status is read-only in zsh (alias for $?). Use $http_code instead.
# - trap ... RETURN is bash-only. Use an explicit rm after each exit path,
#   OR keep the trap but scope it with EXIT inside a subshell. We use
#   explicit cleanup because it's portable and unambiguous.
floatty_curl() {
  local max_attempts="${FLOATTY_CURL_RETRIES:-5}"
  local delay="${FLOATTY_CURL_BACKOFF:-0.5}"
  local tmpbody
  tmpbody=$(mktemp -t floatty-curl.XXXXXX)

  local auth_args=()
  if [[ -z "$AUTH_DISABLED" ]]; then
    auth_args=(-H "Authorization: Bearer $FLOATTY_API_KEY")
  fi

  local attempt=1 http_code curl_rc
  while (( attempt <= max_attempts )); do
    curl_rc=0
    # The helper's -w MUST come after "$@": curl is last-wins on -w, and a
    # caller passing its own -w (e.g. -w "http_code=%{http_code}\n") used to
    # clobber ours — $http_code became "http_code=200", the 2xx case didn't
    # match, and a SUCCESSFUL request burned all retries before "failing".
    http_code=$(curl -sS -o "$tmpbody" \
      "${auth_args[@]}" \
      -H "Content-Type: application/json" \
      -H "ngrok-skip-browser-warning: 1" \
      "$@" -w "%{http_code}" 2>/dev/null) || curl_rc=$?

    # Success path: 2xx/3xx/4xx return the body and exit. 4xx is a client
    # error (bad request, 404, etc.) — retrying won't fix it, surface it.
    case "$http_code" in
      2*|3*|4*)
        cat "$tmpbody"
        rm -f "$tmpbody"
        return 0
        ;;
    esac

    # Transient: 5xx (includes ngrok 503 interstitial) OR curl network error.
    # Retry with exponential-ish backoff, log to stderr on attempts >1 so a
    # caller watching the stream sees the flake without parsing curl output.
    if (( attempt < max_attempts )); then
      [[ $attempt -ge 2 ]] && echo "floatty_curl: retry $attempt/$max_attempts after ${delay}s (http=$http_code, curl_rc=$curl_rc)" >&2
      sleep "$delay"
      delay=$(awk "BEGIN{printf \"%.2f\", $delay * 1.5}")
    fi
    attempt=$((attempt + 1))
  done

  # Exhausted — emit the last body (likely ngrok's 503 page or server error)
  # so the caller can inspect, and return nonzero to signal failure.
  cat "$tmpbody"
  rm -f "$tmpbody"
  echo "floatty_curl: exhausted $max_attempts attempts (last http=$http_code, curl_rc=$curl_rc)" >&2
  return 1
}

# Health check
floatty_health() {
  floatty_curl "$FLOATTY_URL/api/v1/health"
}

# Export for subshells
export FLOATTY_URL FLOATTY_API_KEY

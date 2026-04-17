#!/usr/bin/env bash
# build-door.sh — compile + deploy a floatty door correctly, or complain loudly
#
# Usage: build-door.sh <door-name>
#   e.g. build-door.sh input
#
# Does:
#   1. Validates apps/floatty/doors/<name>/door.json (structure + required fields)
#   2. Compiles <name>.tsx via scripts/compile-door-bundle.mjs
#   3. Deploys BOTH door.json AND index.js to:
#        ~/.floatty-dev/doors/<name>/   (dev profile)
#        ~/.floatty/doors/<name>/        (release profile)
#   4. Verifies both files exist after copy
#   5. Pings backend list_door_files (if reachable) to confirm registration
#
# Fails on:
#   - source dir missing
#   - door.json missing or invalid JSON
#   - required manifest fields missing (id, name, prefixes, version)
#   - prefixes not a non-empty array
#   - .tsx source missing
#   - compile-door-bundle.mjs fails
#   - target file missing after copy
#
# Warns on:
#   - manifest id != directory name (floatty resolves by directory)
#
# Failure mode this script prevents (from skill failure-modes.md FM-9):
#   Deploying only the bundle (cp index.js) without the manifest (door.json)
#   leads to "Unknown door: <id>" in the frontend even though the backend
#   scans the dir — the scanner needs door.json to register the door.

set -euo pipefail

# ─── argparse ────────────────────────────────────────────────────────
DOOR_NAME="${1:-}"
if [[ -z "$DOOR_NAME" ]]; then
  cat >&2 <<EOF
Usage: $0 <door-name>
Examples:
  $0 input      compiles apps/floatty/doors/input/
  $0 render     recompiles the render door

Deploys both door.json and index.js to dev + release profiles.
EOF
  exit 1
fi

# ─── locate project root ─────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Walk up to find the floatty repo root (the one containing apps/floatty)
PROJECT_ROOT="$SCRIPT_DIR"
while [[ "$PROJECT_ROOT" != "/" ]]; do
  if [[ -d "$PROJECT_ROOT/apps/floatty/doors" ]]; then break; fi
  PROJECT_ROOT="$(dirname "$PROJECT_ROOT")"
done
if [[ ! -d "$PROJECT_ROOT/apps/floatty/doors" ]]; then
  echo "ERROR: couldn't locate floatty repo root from $SCRIPT_DIR" >&2
  echo "       (walked up looking for apps/floatty/doors/)" >&2
  exit 1
fi

APP_DIR="$PROJECT_ROOT/apps/floatty"
SOURCE_DIR="$APP_DIR/doors/$DOOR_NAME"
MANIFEST="$SOURCE_DIR/door.json"

# ─── guard: source dir ───────────────────────────────────────────────
if [[ ! -d "$SOURCE_DIR" ]]; then
  echo "ERROR: source dir not found: $SOURCE_DIR" >&2
  echo "" >&2
  echo "Available doors:" >&2
  ls -1 "$APP_DIR/doors" | sed 's/^/  /' >&2
  exit 1
fi

# ─── guard: manifest exists ──────────────────────────────────────────
if [[ ! -f "$MANIFEST" ]]; then
  echo "ERROR: no door.json at $MANIFEST" >&2
  echo "" >&2
  echo "Every door needs a manifest. Minimum:" >&2
  cat >&2 <<'JSON'
  {
    "id": "<name>",
    "name": "<label>",
    "prefixes": ["<name>::"],
    "version": "0.1.0",
    "selfRender": true
  }
JSON
  exit 1
fi

# ─── validate manifest structure ─────────────────────────────────────
MANIFEST_ID=$(python3 <<PYEOF
import json, sys
try:
    m = json.load(open('$MANIFEST'))
except Exception as e:
    print(f"INVALID_JSON: {e}", file=sys.stderr)
    sys.exit(1)

required = ['id', 'name', 'prefixes', 'version']
missing = [f for f in required if f not in m]
if missing:
    print(f"MISSING_FIELDS: {', '.join(missing)}", file=sys.stderr)
    sys.exit(1)

if not isinstance(m.get('prefixes'), list) or not m['prefixes']:
    print("INVALID_PREFIXES: must be non-empty array", file=sys.stderr)
    sys.exit(1)

for p in m['prefixes']:
    if not isinstance(p, str) or not p.endswith('::'):
        print(f"INVALID_PREFIX: '{p}' — must end with '::'", file=sys.stderr)
        sys.exit(1)

print(m['id'])
PYEOF
) || {
  echo "ERROR: manifest validation failed (see above)" >&2
  exit 1
}

# ─── warn on id/dir mismatch ─────────────────────────────────────────
if [[ "$MANIFEST_ID" != "$DOOR_NAME" ]]; then
  echo "WARN: manifest id '$MANIFEST_ID' != directory '$DOOR_NAME'" >&2
  echo "      floatty resolves doors by directory; expect folder-level id match" >&2
fi

# ─── locate source .tsx ──────────────────────────────────────────────
TSX_SOURCE="$SOURCE_DIR/$DOOR_NAME.tsx"
if [[ ! -f "$TSX_SOURCE" ]]; then
  TSX_SOURCE=$(ls "$SOURCE_DIR"/*.tsx 2>/dev/null | head -1 || true)
  if [[ -z "$TSX_SOURCE" ]]; then
    echo "ERROR: no .tsx source in $SOURCE_DIR" >&2
    exit 1
  fi
  echo "NOTE: using $(basename "$TSX_SOURCE") (no $DOOR_NAME.tsx found)" >&2
fi

# ─── make target dirs ────────────────────────────────────────────────
DEV_DIR="$HOME/.floatty-dev/doors/$DOOR_NAME"
RELEASE_DIR="$HOME/.floatty/doors/$DOOR_NAME"
mkdir -p "$DEV_DIR" "$RELEASE_DIR"

# ─── compile ─────────────────────────────────────────────────────────
echo "→ compile: $TSX_SOURCE"
cd "$APP_DIR"
RELATIVE_TSX="doors/$DOOR_NAME/$(basename "$TSX_SOURCE")"
if ! node scripts/compile-door-bundle.mjs "$RELATIVE_TSX" "$DEV_DIR/index.js"; then
  echo "ERROR: bundle compilation failed" >&2
  exit 1
fi

# ─── deploy BOTH files to BOTH profiles ──────────────────────────────
echo "→ deploy manifest + bundle"
cp "$MANIFEST"           "$DEV_DIR/door.json"
cp "$DEV_DIR/index.js"   "$RELEASE_DIR/index.js"
cp "$MANIFEST"           "$RELEASE_DIR/door.json"

# ─── verify ──────────────────────────────────────────────────────────
verify() {
  local d="$1"
  local label="$2"
  local ok=1
  if [[ ! -f "$d/door.json" ]]; then
    echo "  FAIL: $label missing door.json at $d" >&2
    ok=0
  fi
  if [[ ! -f "$d/index.js" ]]; then
    echo "  FAIL: $label missing index.js at $d" >&2
    ok=0
  fi
  if [[ $ok -eq 1 ]]; then
    local bytes
    bytes=$(stat -f%z "$d/index.js" 2>/dev/null || stat -c%s "$d/index.js" 2>/dev/null || echo "?")
    echo "  OK: $label ($bytes bytes)"
  else
    return 1
  fi
}

echo "→ verify deploy"
verify "$DEV_DIR"     "dev    "
verify "$RELEASE_DIR" "release"

# ─── ping backend to confirm registration (best-effort) ──────────────
check_backend() {
  local profile="$1"
  local config="$2"
  if [[ ! -f "$config" ]]; then return 0; fi
  local key port
  key=$(grep '^api_key' "$config" 2>/dev/null | cut -d'"' -f2)
  port=$(grep '^server_port' "$config" 2>/dev/null | cut -d= -f2 | tr -d ' ')
  if [[ -z "$key" || -z "$port" ]]; then return 0; fi
  # Backend has no list-doors REST endpoint; Tauri-only. Skip health ping.
  if ! curl -s -m 2 -H "Authorization: Bearer $key" "http://127.0.0.1:$port/api/v1/health" >/dev/null 2>&1; then
    echo "  NOTE: $profile server not reachable on :$port (not running?)"
  else
    echo "  NOTE: $profile server reachable on :$port"
  fi
}

echo "→ backend probe"
check_backend "dev    " "$HOME/.floatty-dev/config.toml"
check_backend "release" "$HOME/.floatty/config.toml"

# ─── summary ─────────────────────────────────────────────────────────
cat <<EOF

✓ door '$DOOR_NAME' deployed
  source:   $SOURCE_DIR
  dev:      $DEV_DIR
  release:  $RELEASE_DIR

  Existing doors: watcher picks up file change → frontend hot-reloads.
  NEW doors:      backend scanner needs the directory to exist at
                  startup OR the watcher to fire 'door-changed'. If
                  the app shows "Unknown door: $DOOR_NAME", Cmd+R
                  the window to force a registry rescan.
EOF

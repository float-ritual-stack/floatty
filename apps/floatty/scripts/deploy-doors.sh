#!/usr/bin/env bash
# deploy-doors.sh — compile + deploy all floatty doors to a target doors dir.
#
# Closes the release gap where `tauri build` / rebuild.sh ships the app binary
# but leaves the door bundles under {target}/doors/ stale. Door code is loaded
# at RUNTIME from {target}/doors/{id}/index.js — it is NOT bundled into the app.
# v0.22.0 shipped FLO-815's read:: ToC/collapse, but the release door bundle was
# a week stale, so the feature silently did nothing until the door was redeployed.
#
# Door build is heterogeneous, handled per-door:
#   - .tsx source (read, input, timestamp, ...) -> compile via compile-door-bundle.mjs
#   - pre-compiled index.js only (digest, floatctl, linear, portless) -> copy
#   - render (extracted to packages/render-door) -> package build + copy
# External/runtime-only doors (flue, stub) have no source here and are left untouched.
#
# Usage: deploy-doors.sh [target_root]   (default: ~/.floatty ; dev: ~/.floatty-dev)
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"            # apps/floatty
REPO_DIR="$(cd "$APP_DIR/../.." && pwd)"           # repo root
TARGET_ROOT="${1:-$HOME/.floatty}"
DOORS_SRC="$APP_DIR/doors"
DOORS_OUT="$TARGET_ROOT/doors"

SKIP=()   # test-only doors, never deployed

# Retired doors: source is gone, but an older install may still have a deployed
# copy whose door.json keeps getting discovered (and its prefix registered) at
# runtime. Deploy removes them so upgrades converge on the current door set.
# External/runtime-only doors (flue, stub) are NOT listed here — never touched.
RETIRED=("session-garden")   # removed 2026-08-18: garden:: reserved for gardener role

echo "==> Deploying doors -> $DOORS_OUT"
mkdir -p "$DOORS_OUT"
cd "$APP_DIR"

ok=0; fail=0; skipped=0
for src in "$DOORS_SRC"/*/; do
  name=$(basename "$src")
  if printf '%s\n' "${SKIP[@]:-}" | grep -qx "$name"; then
    echo "  - skip $name (test-only)"; skipped=$((skipped + 1)); continue
  fi
  out="$DOORS_OUT/$name"; mkdir -p "$out"
  entry=""
  for cand in "$name.tsx" "index.tsx"; do
    [ -f "$src$cand" ] && { entry="$cand"; break; }
  done
  if [ -n "$entry" ]; then
    if node "$SCRIPT_DIR/compile-door-bundle.mjs" "doors/$name/$entry" "$out/index.js" >/dev/null 2>&1; then
      echo "  + compiled $name ($entry)"; ok=$((ok + 1))
    else
      echo "  ! FAIL compile $name"; fail=$((fail + 1))
    fi
  elif [ -f "${src}index.js" ]; then
    cp "${src}index.js" "$out/index.js"; echo "  + copied $name (pre-compiled)"; ok=$((ok + 1))
  else
    echo "  ? skip $name (no .tsx entry, no index.js)"; skipped=$((skipped + 1)); continue
  fi
  [ -f "${src}door.json" ] && cp "${src}door.json" "$out/door.json"
done

# render door: extracted to packages/render-door, has its own build
echo "  ... render (packages/render-door)"
if (cd "$REPO_DIR" && pnpm --filter @floatty/render-door run build) >/dev/null 2>&1; then
  mkdir -p "$DOORS_OUT/render"
  if cp "$REPO_DIR/packages/render-door/dist/index.js" "$DOORS_OUT/render/index.js" 2>/dev/null \
    && cp "$REPO_DIR/packages/render-door/dist/door.json" "$DOORS_OUT/render/door.json" 2>/dev/null; then
    echo "  + deployed render"; ok=$((ok + 1))
  else
    echo "  ! FAIL render copy"; fail=$((fail + 1))
  fi
else
  echo "  ! FAIL render build"; fail=$((fail + 1))
fi

# Retire doors whose source no longer exists in this repo.
retired=0
for name in "${RETIRED[@]}"; do
  if [ -d "$DOORS_SRC/$name" ]; then
    echo "  ! WARN $name listed as retired but source still exists — not removing"
    continue
  fi
  if [ -d "$DOORS_OUT/$name" ]; then
    if rm -rf "$DOORS_OUT/$name"; then
      echo "  - retired $name (removed $DOORS_OUT/$name)"; retired=$((retired + 1))
    else
      echo "  ! FAIL retire $name"; fail=$((fail + 1))
    fi
  fi
done

echo "==> doors: $ok deployed, $skipped skipped, $retired retired, $fail failed"
[ "$fail" -eq 0 ]

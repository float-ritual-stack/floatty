#!/bin/bash
# Verify dev/release build isolation
# Run after starting both builds

set -e

echo "═══════════════════════════════════════════════════════"
echo "  floatty Build Isolation Verification"
echo "═══════════════════════════════════════════════════════"
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

check() {
  if [ "$1" = "pass" ]; then
    echo -e "${GREEN}✓${NC} $2"
  elif [ "$1" = "fail" ]; then
    echo -e "${RED}✗${NC} $2"
  else
    echo -e "${YELLOW}?${NC} $2"
  fi
}

echo "1. Bundle Identifiers (from config)"
echo "   ─────────────────────────────────"
DEV_ID=$(grep '"identifier"' src-tauri/tauri.dev.conf.json 2>/dev/null | cut -d'"' -f4)
REL_ID=$(grep '"identifier"' src-tauri/tauri.conf.json 2>/dev/null | cut -d'"' -f4)
echo "   Dev:     $DEV_ID"
echo "   Release: $REL_ID"
if [ "$DEV_ID" != "$REL_ID" ] && [ -n "$DEV_ID" ] && [ -n "$REL_ID" ]; then
  check pass "Bundle identifiers are different"
else
  check fail "Bundle identifiers should differ"
fi
echo ""

echo "2. Server Ports (from config)"
echo "   ──────────────────────────"
DEV_PORT=$(grep server_port ~/.floatty-dev/config.toml 2>/dev/null | cut -d= -f2 | tr -d ' ')
REL_PORT=$(grep server_port ~/.floatty/config.toml 2>/dev/null | cut -d= -f2 | tr -d ' ')
DEV_PORT=${DEV_PORT:-33333}  # default
REL_PORT=${REL_PORT:-8765}   # default
echo "   Dev:     $DEV_PORT"
echo "   Release: $REL_PORT"
if [ "$DEV_PORT" != "$REL_PORT" ]; then
  check pass "Server ports are different"
else
  check fail "Server ports should differ"
fi
echo ""

echo "3. Data Directories"
echo "   ─────────────────"
echo "   Dev:     ~/.floatty-dev/"
echo "   Release: ~/.floatty/"
if [ -d ~/.floatty-dev ] && [ -d ~/.floatty ]; then
  check pass "Both data directories exist"
elif [ -d ~/.floatty-dev ]; then
  check warn "Only dev directory exists (run release build)"
elif [ -d ~/.floatty ]; then
  check warn "Only release directory exists (run dev build)"
else
  check fail "Neither directory exists"
fi
echo ""

echo "4. WebKit Storage (macOS)"
echo "   ──────────────────────"
DEV_WEBKIT=~/Library/WebKit/$DEV_ID
REL_WEBKIT=~/Library/WebKit/$REL_ID
if [ -d "$DEV_WEBKIT" ]; then
  check pass "Dev WebKit storage: $DEV_WEBKIT"
else
  check warn "Dev WebKit storage not found (start dev build first)"
fi
if [ -d "$REL_WEBKIT" ]; then
  check pass "Release WebKit storage: $REL_WEBKIT"
else
  check warn "Release WebKit storage not found (start release build first)"
fi
echo ""

echo "5. Running Processes"
echo "   ─────────────────"
DEV_PROCS=$(pgrep -f "floatty-server.*33333" 2>/dev/null | wc -l | tr -d ' ')
REL_PROCS=$(pgrep -f "floatty-server.*8765" 2>/dev/null | wc -l | tr -d ' ')
if [ "$DEV_PROCS" -gt 0 ]; then
  check pass "Dev server running on port 33333"
else
  check warn "Dev server not detected"
fi
if [ "$REL_PROCS" -gt 0 ]; then
  check pass "Release server running on port 8765"
else
  check warn "Release server not detected"
fi
echo ""

echo "6. Server Health Check"
echo "   ────────────────────"
DEV_KEY=$(grep api_key ~/.floatty-dev/config.toml 2>/dev/null | cut -d'"' -f2)
REL_KEY=$(grep api_key ~/.floatty/config.toml 2>/dev/null | cut -d'"' -f2)

if [ -n "$DEV_KEY" ]; then
  DEV_HEALTH=$(curl -s -H "Authorization: Bearer $DEV_KEY" "http://127.0.0.1:$DEV_PORT/api/v1/health" 2>/dev/null | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
  if [ "$DEV_HEALTH" = "ok" ]; then
    check pass "Dev server healthy (port $DEV_PORT)"
  else
    check warn "Dev server not responding"
  fi
fi

if [ -n "$REL_KEY" ]; then
  REL_HEALTH=$(curl -s -H "Authorization: Bearer $REL_KEY" "http://127.0.0.1:$REL_PORT/api/v1/health" 2>/dev/null | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
  if [ "$REL_HEALTH" = "ok" ]; then
    check pass "Release server healthy (port $REL_PORT)"
  else
    check warn "Release server not responding"
  fi
fi
echo ""

echo "═══════════════════════════════════════════════════════"
echo "  Verification complete"
echo "═══════════════════════════════════════════════════════"

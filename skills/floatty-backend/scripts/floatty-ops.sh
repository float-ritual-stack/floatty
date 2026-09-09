#!/usr/bin/env bash
# floatty-ops.sh — Operational wrappers around endpoints that weren't
# covered by the block/daily/search/garden scripts: topology graph,
# page-content-by-name, export, backup, search maintenance.
#
# All helpers assume FLOATTY_URL + floatty_curl are available (sourced
# from floatty-api.sh).

if [[ -z "$FLOATTY_SKILL_DIR" ]]; then
  FLOATTY_SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
if ! declare -F floatty_curl >/dev/null 2>&1; then
  source "$FLOATTY_SKILL_DIR/scripts/floatty-api.sh"
fi

# ─── Topology ──────────────────────────────────────────────────────
# GET /api/v1/topology → { n: nodes, e: edges, c: counts, daily: ..., meta: ... }
# Graph-shaped view of the whole outline. Use for cross-page analysis
# (backlinks-of-backlinks, orphan pages, stub pages referenced N times).
#
# Usage: floatty_topology
floatty_topology() {
  floatty_curl "$FLOATTY_URL/api/v1/topology"
}

# GET /api/v1/topology/content/:pageName — fetch a page's rendered content
# by NAME (no UUID lookup needed). Response shape (snake_case, not
# camelCase like most endpoints):
#   { name, lines: [[depth, content], ...], block_count }
# Each line is `(indent_depth, text)`. Case-insensitive match.
#
# Usage: floatty_page_content "2026-04-20"
floatty_page_content() {
  local name="$1"
  [[ -z "$name" ]] && { echo "Usage: floatty_page_content <page-name>" >&2; return 1; }

  local encoded
  encoded=$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$name")
  floatty_curl "$FLOATTY_URL/api/v1/topology/content/$encoded"
}

# Pretty-print page content as indented outline.
# Usage: floatty_page_content_pretty "2026-04-20"
floatty_page_content_pretty() {
  local name="$1"
  [[ -z "$name" ]] && { echo "Usage: floatty_page_content_pretty <page-name>" >&2; return 1; }

  floatty_page_content "$name" | \
    jq -r '"# " + .name,
           "",
           (.lines[] | ("  " * .[0]) + "- " + .[1]),
           "",
           "(" + (.block_count | tostring) + " blocks)"'
}

# ─── Export ────────────────────────────────────────────────────────
# These stream binary/JSON dumps of the full Y.Doc state. Intended for
# one-shot backup or migration work; don't call routinely.

# Download the full Y.Doc as a binary .ydoc file (base64 on wire).
# Usage: floatty_export_binary > outline.ydoc.b64
floatty_export_binary() {
  floatty_curl "$FLOATTY_URL/api/v1/export/binary"
}

# Download the full outline as JSON (all blocks + state hash).
# Usage: floatty_export_json > outline.json
floatty_export_json() {
  floatty_curl "$FLOATTY_URL/api/v1/export/json"
}

# ─── State introspection ───────────────────────────────────────────

# Server state hash + block count (cheap health-of-sync probe).
# Usage: floatty_state_hash
floatty_state_hash() {
  floatty_curl "$FLOATTY_URL/api/v1/state/hash"
}

# ─── Search index maintenance ──────────────────────────────────────
# The Tantivy index is ephemeral — rebuilt from Y.Doc on every app
# start. These helpers are for manual rebuild/clear when you suspect
# search is stale or want to reclaim disk.

# Force a full rebuild of the search index from Y.Doc.
# Usage: floatty_search_reindex  → { rehydrated: N }
floatty_search_reindex() {
  floatty_curl -X POST "$FLOATTY_URL/api/v1/search/reindex"
}

# Clear the search index (returns 204). Usually followed by reindex.
# Usage: floatty_search_clear
floatty_search_clear() {
  floatty_curl -X POST "$FLOATTY_URL/api/v1/search/clear"
}

# ─── Backup operations ─────────────────────────────────────────────
# Backup daemon writes hourly snapshots. These expose its status and
# let you trigger/restore manually.

floatty_backup_status() {
  floatty_curl "$FLOATTY_URL/api/v1/backup/status"
}

floatty_backup_list() {
  floatty_curl "$FLOATTY_URL/api/v1/backup/list"
}

floatty_backup_config() {
  floatty_curl "$FLOATTY_URL/api/v1/backup/config"
}

# Trigger an immediate backup (outside the hourly schedule).
# Usage: floatty_backup_trigger
floatty_backup_trigger() {
  floatty_curl -X POST "$FLOATTY_URL/api/v1/backup/trigger"
}

# Restore from a backup by path.
# Usage: floatty_backup_restore "/path/to/backup.ydoc"
# DESTRUCTIVE — replaces the current Y.Doc.
floatty_backup_restore() {
  local path="$1"
  [[ -z "$path" ]] && { echo "Usage: floatty_backup_restore <backup-path>" >&2; return 1; }

  local payload
  payload=$(jq -n --arg p "$path" '{path: $p}')
  floatty_curl -X POST "$FLOATTY_URL/api/v1/backup/restore" -d "$payload"
}

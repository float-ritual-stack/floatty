#!/usr/bin/env bash
# floatty-search.sh - Search helpers for floatty-server (Tantivy backend)
# Source floatty-api.sh first, or this will source it

# Self-locate via BASH_SOURCE so scripts work regardless of install path:
#   Plugin marketplace: ~/.claude/plugins/cache/<market>/<plugin>/<ver>/skills/floatty-backend/
#   --plugin-dir:       <plugin>/skills/floatty-backend/
#   Legacy:             ~/.claude/skills/floatty-backend/
#   claude.ai upload:   /mnt/skills/user/floatty-backend/
#
# Scripts live at <skill-root>/scripts/, so BASH_SOURCE/.. is the skill root.
if [[ -z "$FLOATTY_SKILL_DIR" ]]; then
  FLOATTY_SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
type floatty_curl &>/dev/null || source "$FLOATTY_SKILL_DIR/scripts/floatty-api.sh"

# ═══════════════════════════════════════════════════════════════
# SEARCH API — Query Parameters Reference (v0.9.6)
# ═══════════════════════════════════════════════════════════════
#
# GET /api/v1/search?q=...
#
# Text query:
#   q                   Search text (optional — omit or empty for filter-only)
#
# Type filters:
#   types               Comma-separated block types to include (OR logic)
#   exclude_types       Comma-separated block types to exclude (MustNot)
#
# Marker filters:
#   has_markers         Filter by marker presence (true/false)
#   marker_type         Filter by marker prefix ("project", "ctx", "mode", etc.)
#   marker_val          Filter by marker value. Joins with marker_type → "type::value"
#   inherited           When false, use own-only marker fields (default: true)
#
# Link/tree filters:
#   parent_id           Search within subtree only
#   outlink             Filter blocks containing [[outlink]] target
#
# Temporal filters (epoch SECONDS):
#   created_after       Blocks created after
#   created_before      Blocks created before
#   ctx_after           Blocks with ctx:: datetime after
#   ctx_before          Blocks with ctx:: datetime before
#
# Display:
#   limit               Max results (default: 20)
#   include_breadcrumb  Add parent chain per hit
#   include_metadata    Add block metadata per hit (markers, outlinks)
#
# Response shape per hit:
#   .blockId            Block UUID
#   .score              Relevance score (higher = more relevant)
#   .content            Block content (truncated ~200 chars)
#   .snippet            HTML with <b> tags around matched terms (null for filter-only)
#   .breadcrumb[]       Parent chain (if requested)
#   .metadata           { markers, outlinks } (if requested)
#
# Content preprocessing (v0.9.6):
#   prefix::value → prefix stripped from content (lives in markers field only)
#   [[wikilinks]] → inner text (brackets stripped)
#   Field boost: content 2.0x, markers 1.0x → prose outranks markers
#
# Vocabulary discovery:
#   GET /api/v1/markers              Distinct marker types + counts
#   GET /api/v1/markers/:type/values Values for a marker type
#   GET /api/v1/stats                Block count, type distribution
#
# ═══════════════════════════════════════════════════════════════

# URL-encode a query string for search API.
# Pass the value via sys.argv so a query containing ''' (Greptile/CodeRabbit
# on PR #250) cannot terminate the Python string literal and inject code.
_floatty_urlencode() {
  python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$1"
}

# Full-text search — ALWAYS includes breadcrumbs + metadata by default.
# Blocks are 1-2 lines. 20 results is ~800 chars. Don't minimize.
# Usage: floatty_search "query" [limit]
floatty_search() {
  local query="$1"
  local limit="${2:-20}"

  [[ -z "$query" ]] && { echo "Usage: floatty_search <query> [limit]" >&2; return 1; }

  local encoded
  encoded=$(_floatty_urlencode "$query")

  floatty_curl "$FLOATTY_URL/api/v1/search?q=$encoded&limit=$limit&include_breadcrumb=true&include_metadata=true"
}

# Lean search — ONLY use when piping IDs to another command.
# You lose breadcrumbs, markers, outlinks. Know what you're dropping.
# Usage: floatty_search_lean "query" [limit]
floatty_search_lean() {
  local query="$1"
  local limit="${2:-20}"

  [[ -z "$query" ]] && { echo "Usage: floatty_search_lean <query> [limit]" >&2; return 1; }

  local encoded
  encoded=$(_floatty_urlencode "$query")

  floatty_curl "$FLOATTY_URL/api/v1/search?q=$encoded&limit=$limit"
}

# Alias — floatty_search is now rich by default
# Kept for backward compatibility with existing scripts
floatty_search_rich() {
  floatty_search "$@"
}

# Search with pretty-printed output (ID, score, content snippet)
floatty_search_pretty() {
  local query="$1"
  [[ -z "$query" ]] && { echo "Usage: floatty_search_pretty <query>" >&2; return 1; }

  printf '%s' "$(floatty_search "$query")" | jq -r '.hits[] | "[\(.blockId | .[0:8])] score:\(.score | . * 100 | round / 100) \(.content[0:80] | gsub("\n"; " "))"'
}

# Search for markers (ctx::, project::, etc) — returns rich results with metadata
# Usage: floatty_search_markers "project::floatty"
floatty_search_markers() {
  local marker="$1"
  local value="${2:-}"

  [[ -z "$marker" ]] && { echo "Usage: floatty_search_markers <marker> [value]" >&2; return 1; }

  if [[ -n "$value" ]]; then
    floatty_search "$marker$value"
  else
    floatty_search "$marker"
  fi
}

# Search and return just IDs (uses lean search — IDs only)
floatty_search_ids() {
  local query="$1"
  [[ -z "$query" ]] && { echo "Usage: floatty_search_ids <query>" >&2; return 1; }

  printf '%s' "$(floatty_search_lean "$query")" | jq -r '.hits[].blockId'
}

# Search for blocks that link TO a page (backlinks via outlinks metadata)
# Searches for the wikilink text, then filters to blocks whose
# .metadata.outlinks actually contain the target. This separates
# real backlinks from BM25 text-match noise.
# Usage: floatty_search_backlinks "Page Title"
floatty_search_backlinks() {
  local page="$1"
  [[ -z "$page" ]] && { echo "Usage: floatty_search_backlinks <page>" >&2; return 1; }

  printf '%s' "$(floatty_search "[[$page]]" 30)" | jq --arg t "$page" '
    .hits | map(select(.metadata.outlinks // [] | any(contains($t)))) |
    {hits: ., total: length}'
}

# Search with breadcrumb context (server-side, single request)
# DEPRECATED: use floatty_search_rich instead (same behavior)
floatty_search_with_breadcrumb() {
  floatty_search_rich "$@"
}

# Search with formatted context — breadcrumbs + metadata + AncestorContext surfaced
# Usage: floatty_search_context "query" [limit]
#
# FLO-679 PR 2: now surfaces .ancestorContext.nearestPageName (page identity)
# and inboundCount / subtreeSize compact badges when present.
floatty_search_context() {
  local query="$1"
  local limit="${2:-5}"

  [[ -z "$query" ]] && { echo "Usage: floatty_search_context <query> [limit]" >&2; return 1; }

  local result
  result=$(floatty_search_rich "$query" "$limit")

  local total hit_count
  total=$(printf '%s' "$result" | jq -r '.total')
  hit_count=$(printf '%s' "$result" | jq -r '.hits | length')

  echo "Search: \"$query\" → $total hits (showing $hit_count)"
  echo ""

  printf '%s' "$result" | jq -r '.hits[] |
    "━━━ [\(.blockId[0:8])] score:\(.score | . * 10 | round / 10) ━━━" +
    "\n  \(.content[0:300])" +
    "\n  breadcrumb: \(.breadcrumb // ["(root)"] | join(" → "))" +
    (if .ancestorContext.nearestPageName then
      "\n  page: [[\(.ancestorContext.nearestPageName)]]" +
      (if (.ancestorContext.subtreeSize // 0) > 0 or (.ancestorContext.inboundCount // 0) > 0 then
        "  (subtree:\(.ancestorContext.subtreeSize // 0) inbound:\(.ancestorContext.inboundCount // 0))"
      else "" end)
    else "" end) +
    (if .metadata.markers and (.metadata.markers | length > 0) then
      "\n  markers: \([.metadata.markers[] | if .value then "\(.markerType)::\(.value)" else "\(.markerType)::" end] | join(", "))"
    else "" end) +
    (if .metadata.outlinks and (.metadata.outlinks | length > 0) then
      "\n  outlinks: \(.metadata.outlinks | join(", "))"
    else "" end) +
    "\n"'
}

# Search filtered by inherited project marker — FLO-679 PR 2 helper.
#
# Wraps the existing marker_type+marker_val+inherited filter into one
# ergonomic call. The new ancestorContext.effectiveMarkers field lets
# agents see which project a hit belongs to (own or inherited) — this
# helper just gives a one-liner for the common "search inside one
# project" use case.
#
# Usage: floatty_search_in_project "query" "floatty" [limit]
floatty_search_in_project() {
  local query="$1"
  local project="$2"
  local limit="${3:-15}"

  [[ -z "$project" ]] && { echo "Usage: floatty_search_in_project <query> <project> [limit]" >&2; return 1; }

  local q_encoded=""
  [[ -n "$query" ]] && q_encoded=$(_floatty_urlencode "$query")
  local proj_encoded
  proj_encoded=$(_floatty_urlencode "$project")

  # `inherited=true` is the default but we name it explicitly so future
  # readers understand the intent: "blocks where project::X is in own
  # OR ancestor markers."
  floatty_curl "$FLOATTY_URL/api/v1/search?q=$q_encoded&marker_type=project&marker_val=$proj_encoded&inherited=true&limit=$limit&include_breadcrumb=true&include_metadata=true&include=effective_markers"
}

# ═══════════════════════════════════════════════════════════════
# FILTER SEARCH — v0.9.2 Tantivy field filters
# ═══════════════════════════════════════════════════════════════

# Search by marker type (e.g., all blocks with project:: markers)
# Usage: floatty_search_by_marker "project" [text_query] [limit]
floatty_search_by_marker() {
  local marker_type="$1"
  local query="${2:-}"
  local limit="${3:-20}"

  [[ -z "$marker_type" ]] && { echo "Usage: floatty_search_by_marker <marker_type> [query] [limit]" >&2; return 1; }

  local encoded=""
  [[ -n "$query" ]] && encoded=$(_floatty_urlencode "$query")

  floatty_curl "$FLOATTY_URL/api/v1/search?q=$encoded&marker_type=$marker_type&limit=$limit&include_breadcrumb=true&include_metadata=true"
}

# Search by outlink — find blocks that link to a specific target
# Usage: floatty_search_by_outlink "FLO-483" [text_query] [limit]
floatty_search_by_outlink() {
  local outlink="$1"
  local query="${2:-}"
  local limit="${3:-20}"

  [[ -z "$outlink" ]] && { echo "Usage: floatty_search_by_outlink <outlink> [query] [limit]" >&2; return 1; }

  local encoded_outlink encoded_query=""
  encoded_outlink=$(_floatty_urlencode "$outlink")
  [[ -n "$query" ]] && encoded_query=$(_floatty_urlencode "$query")

  floatty_curl "$FLOATTY_URL/api/v1/search?q=$encoded_query&outlink=$encoded_outlink&limit=$limit&include_breadcrumb=true&include_metadata=true"
}

# Search by ctx:: datetime range (timestamps in SECONDS)
# Usage: floatty_search_ctx_range <after_epoch_seconds> [before_epoch_seconds] [query] [limit]
floatty_search_ctx_range() {
  local after="$1"
  local before="${2:-}"
  local query="${3:-ctx}"
  local limit="${4:-20}"

  [[ -z "$after" ]] && { echo "Usage: floatty_search_ctx_range <after_seconds> [before_seconds] [query] [limit]" >&2; return 1; }

  local encoded
  encoded=$(_floatty_urlencode "$query")

  local params="q=$encoded&ctx_after=$after&limit=$limit&include_breadcrumb=true&include_metadata=true"
  [[ -n "$before" ]] && params="$params&ctx_before=$before"

  floatty_curl "$FLOATTY_URL/api/v1/search?$params"
}

# Search by creation date range (timestamps in SECONDS)
# Usage: floatty_search_created_range <after_epoch_seconds> [before_epoch_seconds] [query] [limit]
floatty_search_created_range() {
  local after="$1"
  local before="${2:-}"
  local query="${3:-}"
  local limit="${4:-20}"

  [[ -z "$after" ]] && { echo "Usage: floatty_search_created_range <after_seconds> [before_seconds] [query] [limit]" >&2; return 1; }

  local encoded=""
  [[ -n "$query" ]] && encoded=$(_floatty_urlencode "$query")

  local params="q=$encoded&created_after=$after&limit=$limit&include_breadcrumb=true&include_metadata=true"
  [[ -n "$before" ]] && params="$params&created_before=$before"

  floatty_curl "$FLOATTY_URL/api/v1/search?$params"
}

# Filter-only search (no text, just filters)
# Usage: floatty_search_filter "marker_type=project&has_markers=true" [limit]
floatty_search_filter() {
  local filters="$1"
  local limit="${2:-20}"

  [[ -z "$filters" ]] && { echo "Usage: floatty_search_filter <filter_params> [limit]" >&2; return 1; }

  floatty_curl "$FLOATTY_URL/api/v1/search?q=&$filters&limit=$limit&include_breadcrumb=true&include_metadata=true"
}

# ═══════════════════════════════════════════════════════════════
# PAGE SEARCH — Page Name Index (nucleo fuzzy + prefix matching)
# ═══════════════════════════════════════════════════════════════
#
# GET /api/v1/pages/search?prefix=...&fuzzy=true&limit=10
#
# Response shape:
#   .pages[]            Array of page matches
#   .pages[].name       Page name (heading text, first line, stripped)
#   .pages[].isStub     true = referenced by [[wikilink]] but no page block exists
#
# Fuzzy uses nucleo (same as Helix/fzf). Prefix is case-insensitive start-of-name.
# ═══════════════════════════════════════════════════════════════

# Search pages by prefix — case-insensitive start-of-name matching.
# Usage: floatty_search_pages "2026-03" [limit]
floatty_search_pages() {
  local prefix="$1"
  local limit="${2:-10}"

  local encoded
  encoded=$(_floatty_urlencode "$prefix")

  floatty_curl "$FLOATTY_URL/api/v1/pages/search?prefix=$encoded&limit=$limit"
}

# Fuzzy search pages — typo-tolerant, nucleo subsequence scoring.
# Usage: floatty_search_pages_fuzzy "mnday-hedlines" [limit]
floatty_search_pages_fuzzy() {
  local query="$1"
  local limit="${2:-10}"

  [[ -z "$query" ]] && { echo "Usage: floatty_search_pages_fuzzy <query> [limit]" >&2; return 1; }

  local encoded
  encoded=$(_floatty_urlencode "$query")

  floatty_curl "$FLOATTY_URL/api/v1/pages/search?prefix=$encoded&fuzzy=true&limit=$limit"
}

# List all pages (empty prefix returns all)
# Usage: floatty_pages_list [limit]
floatty_pages_list() {
  local limit="${1:-50}"
  floatty_curl "$FLOATTY_URL/api/v1/pages/search?limit=$limit"
}

# Search excluding specific block types
# Usage: floatty_search_exclude "query" "eval,sh" [limit]
floatty_search_exclude() {
  local query="$1"
  local exclude="$2"
  local limit="${3:-20}"

  [[ -z "$query" || -z "$exclude" ]] && { echo "Usage: floatty_search_exclude <query> <exclude_types> [limit]" >&2; return 1; }

  local encoded
  encoded=$(_floatty_urlencode "$query")

  floatty_curl "$FLOATTY_URL/api/v1/search?q=$encoded&exclude_types=$exclude&limit=$limit&include_breadcrumb=true&include_metadata=true"
}

# ═══════════════════════════════════════════════════════════════
# VOCABULARY DISCOVERY — Marker types, values, stats (v0.9.3)
# ═══════════════════════════════════════════════════════════════

# List all marker types with counts
# Usage: floatty_markers
floatty_markers() {
  floatty_curl "$FLOATTY_URL/api/v1/markers"
}

# List values for a specific marker type
# Usage: floatty_marker_values "project"
floatty_marker_values() {
  local marker_type="$1"
  [[ -z "$marker_type" ]] && { echo "Usage: floatty_marker_values <marker_type>" >&2; return 1; }
  floatty_curl "$FLOATTY_URL/api/v1/markers/$marker_type/values"
}

# Get index stats (block count, type distribution, etc.)
# Usage: floatty_stats
floatty_stats() {
  floatty_curl "$FLOATTY_URL/api/v1/stats"
}

# Pretty-print page search results
# Usage: floatty_search_pages_pretty "query" [limit]
floatty_search_pages_pretty() {
  local query="$1"
  local limit="${2:-10}"

  local result
  result=$(floatty_search_pages_fuzzy "$query" "$limit")

  printf '%s' "$result" | jq -r '.pages[] | (if .isStub then "  [stub] " else "  " end) + .name'
}

# ═══════════════════════════════════════════════════════════════
# PRESENCE — Where is the human in the outline?
# ═══════════════════════════════════════════════════════════════
#
# GET /api/v1/presence → { blockId, paneId } or 204
#
# Use to orient: what block is the user looking at right now?
# Combine with floatty_block_get to get context around their focus.
# ═══════════════════════════════════════════════════════════════

# Get current user presence (focused block + pane + AncestorContext)
# Returns JSON { blockId, paneId, ancestorContext? } or empty string if no presence.
#
# FLO-679 PR 2 / [[FLO-680]]: presence now returns ancestorContext inline.
# `effective_markers` opt-in surfaces project/mode markers (own + inherited)
# so one call answers "what is the user focused on AND in what project."
#
# Usage: floatty_presence [include_directives]
#   include_directives: comma-separated list (effective_markers, inbound_samples).
#                       Default: effective_markers
floatty_presence() {
  local includes="${1:-effective_markers}"
  local url="$FLOATTY_URL/api/v1/presence"
  [[ -n "$includes" ]] && url="$url?include=$(_floatty_urlencode "$includes")"

  local response http_code
  # FLOATTY_CURL_CODE_MARKER (not -w) — the wrapper owns -w for its retry
  # logic; the marker is the supported status channel. See floatty-api.sh.
  response=$(FLOATTY_CURL_CODE_MARKER=1 floatty_curl "$url")
  http_code=$(printf '%s' "$response" | sed -n 's/.*__FLOATTY_CODE__//p' | tail -1)
  response=$(printf '%s' "$response" | sed 's/__FLOATTY_CODE__[0-9]*$//' | sed '$ { /^$/d; }')

  if [[ "$http_code" == "204" ]]; then
    echo ""
    return 1
  fi

  printf '%s' "$response"
}

# Get the block the user is currently focused on, with full context.
#
# FLO-679 PR 2 NOTE: floatty_presence now returns ancestorContext directly,
# so for "where am I" queries you can use floatty_presence alone — this
# helper is for "where am I AND show me the surrounding tree."
#
# Usage: floatty_presence_context [sibling_radius]
floatty_presence_context() {
  local radius="${1:-3}"
  local presence
  presence=$(floatty_presence)

  [[ -z "$presence" ]] && { echo "No active presence" >&2; return 1; }

  local block_id
  block_id=$(printf '%s' "$presence" | jq -r '.blockId')

  floatty_curl "$FLOATTY_URL/api/v1/blocks/$block_id?include=ancestors,siblings,children&sibling_radius=$radius"
}

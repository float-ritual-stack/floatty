#!/usr/bin/env bash
# floatty-context.sh - Focused context retrieval for agent consumption
# Instead of exporting giant outlines, query what you need

# Self-locate via BASH_SOURCE so the probe works from ANY install path:
# legacy ~/.claude/skills/, Claude Code plugin cache, `--plugin-dir`, or
# claude.ai /mnt/skills. Each script lives in <plugin-root>/scripts/, so the
# parent of the script directory is the plugin/skill root.
if [[ -z "$FLOATTY_SKILL_DIR" ]]; then
  FLOATTY_SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
source "$FLOATTY_SKILL_DIR/scripts/floatty-search.sh"
source "$FLOATTY_SKILL_DIR/scripts/floatty-blocks.sh"

# Usage info
usage() {
  cat <<EOF
floatty-context - Focused context retrieval from floatty outline

USAGE:
  floatty-context <command> [args]

COMMANDS:
  today                    Today's ctx:: markers
  yesterday                Yesterday's ctx:: markers
  sysop-notes [limit]      All sysop::note captures (default: 20)
  todos [limit]            All todo:: items (default: 30)
  project <name> [limit]   Blocks mentioning project::<name>
  meeting <type> [limit]   Meeting blocks (e.g., "pharmacy", "scott")
  search <query> [limit]   Raw search query
  search-ctx <query> [lim] Search with breadcrumb context per hit
  block <id>               Get full block content by ID
  context <id> [radius]    Block with ancestors + siblings + children
  tree <id> [depth]        Block subtree with token estimate

OPTIONS:
  --json                   Output raw JSON instead of formatted
  --ids-only               Output only block IDs

EXAMPLES:
  floatty-context today
  floatty-context sysop-notes 10
  floatty-context project floatty 15
  floatty-context meeting pharmacy
  floatty-context search "FLO-187"
EOF
}

# Format output for human consumption (lean — ID + content snippet)
format_hits() {
  local json="$1"
  printf '%s' "$json" | jq -r '.hits[] | "[\(.blockId[0:8])] \(.content | gsub("\n"; " ") | .[0:100])"'
}

# Format with full content + metadata when available
format_hits_full() {
  local json="$1"
  printf '%s' "$json" | jq -r '.hits[] |
    "─── [\(.blockId[0:8])] score:\(.score | . * 10 | round / 10) ───" +
    "\n\(.content)" +
    (if .metadata.markers and (.metadata.markers | length > 0) then
      "\n  markers: \([.metadata.markers[] | if .value then "\(.markerType)::\(.value)" else "\(.markerType)::" end] | join(", "))"
    else "" end) +
    (if .metadata.outlinks and (.metadata.outlinks | length > 0) then
      "\n  outlinks: \(.metadata.outlinks | join(", "))"
    else "" end) +
    "\n"'
}

# Get date string for queries
get_date() {
  local offset="${1:-0}"
  date -v"-${offset}d" "+%Y-%m-%d" 2>/dev/null || date -d "-$offset days" "+%Y-%m-%d"
}

# Commands
cmd_today() {
  local today=$(get_date 0)
  local limit="${1:-15}"
  local result=$(floatty_search_rich "ctx::$today" "$limit")

  echo "## Today's Context ($today)"
  echo ""
  format_hits_full "$result"
  echo ""
  echo "Total: $(printf '%s' "$result" | jq '.total') hits"
}

cmd_yesterday() {
  local yesterday=$(get_date 1)
  local limit="${1:-15}"
  local result=$(floatty_search_rich "ctx::$yesterday" "$limit")

  echo "## Yesterday's Context ($yesterday)"
  echo ""
  format_hits_full "$result"
  echo ""
  echo "Total: $(printf '%s' "$result" | jq '.total') hits"
}

cmd_sysop_notes() {
  local limit="${1:-20}"
  local result=$(floatty_search_rich "sysop::note" "$limit")

  echo "## Sysop Notes (observations, ideas, friction)"
  echo ""
  format_hits_full "$result"
  echo ""
  echo "Total: $(printf '%s' "$result" | jq '.total') hits"
}

cmd_todos() {
  local limit="${1:-30}"
  local result=$(floatty_search_rich "todo::" "$limit")

  echo "## Todo Items"
  echo ""
  format_hits_full "$result"
  echo ""
  echo "Total: $(printf '%s' "$result" | jq '.total') hits"
}

cmd_project() {
  local name="$1"
  local limit="${2:-20}"

  [[ -z "$name" ]] && { echo "Usage: floatty-context project <name> [limit]" >&2; exit 1; }

  local result=$(floatty_search_rich "project::$name" "$limit")

  echo "## Project: $name"
  echo ""
  format_hits_full "$result"
  echo ""
  echo "Total: $(printf '%s' "$result" | jq '.total') hits"
}

cmd_meeting() {
  local type="$1"
  local limit="${2:-10}"

  [[ -z "$type" ]] && { echo "Usage: floatty-context meeting <type> [limit]" >&2; exit 1; }

  local result=$(floatty_search_rich "meeting::$type" "$limit")

  echo "## Meeting: $type"
  echo ""
  format_hits_full "$result"
  echo ""
  echo "Total: $(printf '%s' "$result" | jq '.total') hits"
}

cmd_search() {
  local query="$1"
  local limit="${2:-20}"

  [[ -z "$query" ]] && { echo "Usage: floatty-context search <query> [limit]" >&2; exit 1; }

  local result=$(floatty_search "$query" "$limit")

  echo "## Search: $query"
  echo ""
  format_hits_full "$result"
  echo ""
  echo "Total: $(echo "$result" | jq '.total') hits"
}

cmd_block() {
  local id="$1"

  [[ -z "$id" ]] && { echo "Usage: floatty-context block <id>" >&2; exit 1; }

  floatty_block_get "$id" | jq -r '.content // "Block not found"'
}

cmd_context() {
  local id="$1"
  local radius="${2:-2}"

  [[ -z "$id" ]] && { echo "Usage: floatty-context context <id> [sibling_radius]" >&2; exit 1; }

  local result
  result=$(floatty_block_context "$id" "$radius")

  echo "## Block Context"
  echo ""
  echo "**Content**: $(echo "$result" | jq -r '.content // "?"' | head -3)"
  echo ""

  # Ancestors (breadcrumb)
  local ancestor_count
  ancestor_count=$(echo "$result" | jq '.ancestors // [] | length')
  if [[ "$ancestor_count" -gt 0 ]]; then
    echo "**Breadcrumb** (nearest first):"
    echo "$result" | jq -r '.ancestors[] | "  → \(.content[0:80])"'
    echo ""
  fi

  # Siblings
  echo "**Siblings**:"
  echo "$result" | jq -r '
    (.siblings.before // [] | .[] | "  ↑ \(.content[0:80])"),
    "  ● \(.content[0:80])",
    (.siblings.after // [] | .[] | "  ↓ \(.content[0:80])")
  '
  echo ""

  # Children
  local child_count
  child_count=$(echo "$result" | jq '.children // [] | length')
  if [[ "$child_count" -gt 0 ]]; then
    echo "**Children** ($child_count):"
    echo "$result" | jq -r '.children[:5][] | "  • \(.content[0:80])"'
    [[ "$child_count" -gt 5 ]] && echo "  ... and $((child_count - 5)) more"
  fi
}

cmd_tree() {
  local id="$1"
  local depth="${2:-50}"

  [[ -z "$id" ]] && { echo "Usage: floatty-context tree <id> [max_depth]" >&2; exit 1; }

  local result
  result=$(floatty_block_tree "$id" "$depth")

  echo "## Subtree"
  echo ""
  echo "**Root**: $(echo "$result" | jq -r '.content // "?"' | head -1)"
  echo "$result" | jq -r '.tokenEstimate | "**Size**: \(.totalChars) chars, \(.blockCount) blocks, max depth \(.maxDepth)"'
  echo ""
  echo "$result" | jq -r '.tree[:20][] | ("  " * .depth) + "• \(.content[0:80])"'

  local tree_count
  tree_count=$(echo "$result" | jq '.tree | length')
  [[ "$tree_count" -gt 20 ]] && echo "... and $((tree_count - 20)) more blocks"
}

cmd_search_ctx() {
  local query="$1"
  local limit="${2:-10}"

  [[ -z "$query" ]] && { echo "Usage: floatty-context search-ctx <query> [limit]" >&2; exit 1; }

  local result
  result=$(floatty_search_with_breadcrumb "$query" "$limit")

  echo "## Search: $query (with context)"
  echo ""
  echo "$result" | jq -r '.hits[] | "─── [\(.blockId[0:8])] score:\(.score | . * 10 | round / 10) ───\n\(.content)\n  breadcrumb: \(.breadcrumb // ["(root)"] | join(" → "))\n"'
  echo "Total: $(echo "$result" | jq '.total') hits"
}

# Main dispatch
main() {
  local cmd="${1:-}"
  shift 2>/dev/null || true

  case "$cmd" in
    today)       cmd_today "$@" ;;
    yesterday)   cmd_yesterday "$@" ;;
    sysop-notes) cmd_sysop_notes "$@" ;;
    todos)       cmd_todos "$@" ;;
    project)     cmd_project "$@" ;;
    meeting)     cmd_meeting "$@" ;;
    search)      cmd_search "$@" ;;
    search-ctx)  cmd_search_ctx "$@" ;;
    block)       cmd_block "$@" ;;
    context)     cmd_context "$@" ;;
    tree)        cmd_tree "$@" ;;
    -h|--help|help|"") usage ;;
    *)           echo "Unknown command: $cmd" >&2; usage; exit 1 ;;
  esac
}

main "$@"

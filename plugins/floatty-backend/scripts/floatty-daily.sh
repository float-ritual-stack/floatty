#!/usr/bin/env bash
# floatty-daily.sh - Daily note workflows for floatty-server
# Source floatty-api.sh and floatty-blocks.sh first, or this will source them

# Self-locate via BASH_SOURCE so the probe works from ANY install path:
# legacy ~/.claude/skills/, Claude Code plugin cache, `--plugin-dir`, or
# claude.ai /mnt/skills. Each script lives in <plugin-root>/scripts/, so the
# parent of the script directory is the plugin/skill root.
if [[ -z "$FLOATTY_SKILL_DIR" ]]; then
  FLOATTY_SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
[[ -z "$FLOATTY_URL" ]] && source "$FLOATTY_SKILL_DIR/scripts/floatty-api.sh"
source "$FLOATTY_SKILL_DIR/scripts/floatty-blocks.sh"
source "$FLOATTY_SKILL_DIR/scripts/floatty-search.sh"

# Get daily note via dedicated endpoint (uses PageNameIndex, not search)
# Usage: floatty_daily_get [YYYY-MM-DD] [include]
# Returns: block JSON with children (default) or specified includes
floatty_daily_get() {
  local date="${1:-$(TZ="${FLOATTY_TZ:-America/Toronto}" date +%Y-%m-%d)}"
  local include="${2:-children}"
  floatty_curl "$FLOATTY_URL/api/v1/daily/$date?include=$include"
}

# DEPRECATED (FLO-636): this function creates a "## $date" ROOT block, which
# is the wrong shape AND wrong location. The canonical daily note is
# `# YYYY-MM-DD` under the `pages::` container, created by the frontend when
# you click a `[[YYYY-MM-DD]]` wikilink. Kept for backward compatibility but
# do NOT use in new code. Use `floatty_daily_find_or_create` which now uses
# the `GET /api/v1/daily/:date` endpoint and returns an explicit error if the
# daily note is missing. Once FLO-652 lands + release rebuilds, switch to
# `floatty_daily_append_via_api` which uses `POST /api/v1/daily/:date/append`.
floatty_daily_create() {
  local date="${1:-$(TZ="${FLOATTY_TZ:-America/Toronto}" date +%Y-%m-%d)}"
  echo "DEPRECATED (FLO-636): floatty_daily_create creates root blocks — open floatty and click [[${date}]] to create the daily note under pages:: instead." >&2
  floatty_block_create "## $date"
}

# Resolve today's daily note block id via the canonical GET endpoint.
# Returns empty string when the daily note doesn't exist — caller decides
# whether to create it in floatty (the UI) or to auto-create via the new
# `POST /api/v1/pages/:name` semantic endpoint once FLO-652 is live.
#
# Replaces the previous heading-search + root-block-fallback that silently
# created orphaned `## $date` root blocks (the FLO-636 bug in shell form).
floatty_daily_find_or_create() {
  local date="${1:-$(TZ="${FLOATTY_TZ:-America/Toronto}" date +%Y-%m-%d)}"

  # Canonical lookup via PageNameIndex. Returns the page block under pages::
  # regardless of stub/real/case.
  local daily_id
  daily_id=$(floatty_daily_get "$date" 2>/dev/null | jq -r '.id // empty')

  if [[ -z "$daily_id" ]]; then
    echo "No daily note for $date — open floatty and click [[${date}]] to create it under pages::, or (once FLO-652 ships) call POST /api/v1/pages/${date} first." >&2
    return 1
  fi

  echo "$daily_id"
}

# Add timestamped entry to today's daily
# Usage: floatty_daily_add "content" [project] [mode]
floatty_daily_add() {
  local content="$1"
  local project="${2:-}"
  local mode="${3:-}"
  [[ -z "$content" ]] && { echo "Usage: floatty_daily_add <content> [project] [mode]" >&2; return 1; }

  local timestamp
  timestamp=$(TZ="${FLOATTY_TZ:-America/Toronto}" date "+%I:%M %p")
  local markers=""
  [[ -n "$project" ]] && markers="[project::$project] "
  [[ -n "$mode" ]] && markers="${markers}[mode::$mode] "

  local daily_id
  daily_id=$(floatty_daily_find_or_create)

  if [[ -z "$daily_id" || "$daily_id" == "null" ]]; then
    echo "Failed to find or create daily note" >&2
    return 1
  fi

  floatty_block_create "[$timestamp] ${markers}$content" "$daily_id"
}

# Create TLDR block tree
# Usage: floatty_tldr "summary" ["did"] ["learned"] ["next"] ["project"]
floatty_tldr() {
  local summary="$1"
  local did="${2:-}"
  local learned="${3:-}"
  local next="${4:-}"
  local project="${5:-}"

  [[ -z "$summary" ]] && { echo "Usage: floatty_tldr <summary> [did] [learned] [next] [project]" >&2; return 1; }

  local time
  time=$(TZ="${FLOATTY_TZ:-America/Toronto}" date "+%I:%M %p")
  local proj_marker=""
  [[ -n "$project" ]] && proj_marker="[project::$project] "

  # Create TLDR header
  local parent_id
  parent_id=$(floatty_block_create "## $time - ${proj_marker}$summary" | jq -r '.id')

  if [[ "$parent_id" == "null" || -z "$parent_id" ]]; then
    echo "Failed to create TLDR header" >&2
    return 1
  fi

  # Add sections if provided
  [[ -n "$did" ]] && floatty_block_create "**Did**: $did" "$parent_id" > /dev/null
  [[ -n "$learned" ]] && floatty_block_create "**Learned**: $learned" "$parent_id" > /dev/null
  [[ -n "$next" ]] && floatty_block_create "**Next**: $next" "$parent_id" > /dev/null

  echo "$parent_id"
}

# Quick context capture (like ctx:: but to floatty)
# Usage: floatty_ctx "message" [project] [mode]
floatty_ctx() {
  local message="$1"
  local project="${2:-}"
  local mode="${3:-}"

  [[ -z "$message" ]] && { echo "Usage: floatty_ctx <message> [project] [mode]" >&2; return 1; }

  local timestamp
  timestamp=$(TZ="${FLOATTY_TZ:-America/Toronto}" date "+%Y-%m-%d @ %I:%M %p")

  local content="ctx::$timestamp"
  [[ -n "$project" ]] && content="$content [project::$project]"
  [[ -n "$mode" ]] && content="$content [mode::$mode]"
  content="$content $message"

  floatty_daily_add "$content"
}

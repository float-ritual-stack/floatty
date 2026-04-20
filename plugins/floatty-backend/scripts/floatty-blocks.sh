#!/usr/bin/env bash
# floatty-blocks.sh - Block CRUD helpers for floatty-server
# Source floatty-api.sh first, or this will source it
#
# IMPORTANT: When capturing output in a variable and re-piping to jq,
# use `printf '%s' "$VAR" | jq ...` NOT `echo "$VAR" | jq ...`
# zsh echo interprets \n in JSON strings → parse errors on multiline content.
# Or just pipe directly: `floatty_block_get "$ID" | jq '.content'`

# Auto-detect skill directory (Claude Code: ~/.claude/skills/, claude.ai: /mnt/skills/user/)
if [[ -z "$FLOATTY_SKILL_DIR" ]]; then
  for _d in "$HOME/.claude/skills/floatty-backend" /mnt/skills/user/floatty-backend /mnt/skills/private/floatty-backend; do
    [[ -d "$_d/scripts" ]] && FLOATTY_SKILL_DIR="$_d" && break
  done
  FLOATTY_SKILL_DIR="${FLOATTY_SKILL_DIR:-$HOME/.claude/skills/floatty-backend}"
fi
[[ -z "$FLOATTY_URL" ]] && source "$FLOATTY_SKILL_DIR/scripts/floatty-api.sh"

# List all blocks (optionally filter by content regex)
floatty_blocks_list() {
  local filter="${1:-}"
  if [[ -n "$filter" ]]; then
    floatty_curl "$FLOATTY_URL/api/v1/blocks" | jq ".blocks[] | select(.content | test(\"$filter\"; \"i\"))"
  else
    floatty_curl "$FLOATTY_URL/api/v1/blocks" | jq '.blocks'
  fi
}

# Get single block with context (ancestors + children by default)
# Blocks are 1-2 lines. ancestors + children is cheap. Always include them.
floatty_block_get() {
  local id="$1"
  [[ -z "$id" ]] && { echo "Usage: floatty_block_get <id>" >&2; return 1; }
  floatty_curl "$FLOATTY_URL/api/v1/blocks/$id?include=ancestors,children"
}

# Lean block get — just the block, no context. Use for CRUD piping only.
floatty_block_get_lean() {
  local id="$1"
  [[ -z "$id" ]] && { echo "Usage: floatty_block_get_lean <id>" >&2; return 1; }
  floatty_curl "$FLOATTY_URL/api/v1/blocks/$id"
}

# Create a new block
# Usage: floatty_block_create "content" [parent_id]
floatty_block_create() {
  local content="$1"
  local parent_id="${2:-}"

  [[ -z "$content" ]] && { echo "Usage: floatty_block_create <content> [parent_id]" >&2; return 1; }

  local payload
  if [[ -n "$parent_id" ]]; then
    payload=$(jq -n --arg c "$content" --arg p "$parent_id" '{content: $c, parentId: $p}')
  else
    payload=$(jq -n --arg c "$content" '{content: $c}')
  fi

  floatty_curl -X POST "$FLOATTY_URL/api/v1/blocks" -d "$payload"
}

# Update block content
floatty_block_update() {
  local id="$1"
  local content="$2"

  [[ -z "$id" || -z "$content" ]] && { echo "Usage: floatty_block_update <id> <content>" >&2; return 1; }

  local payload=$(jq -n --arg c "$content" '{content: $c}')
  floatty_curl -X PATCH "$FLOATTY_URL/api/v1/blocks/$id" -d "$payload"
}

# Delete block
floatty_block_delete() {
  local id="$1"
  [[ -z "$id" ]] && { echo "Usage: floatty_block_delete <id>" >&2; return 1; }
  floatty_curl -X DELETE "$FLOATTY_URL/api/v1/blocks/$id"
}

# Get block with context (ancestors, siblings, children)
# Usage: floatty_block_context <id> [sibling_radius]
floatty_block_context() {
  local id="$1"
  local radius="${2:-2}"
  [[ -z "$id" ]] && { echo "Usage: floatty_block_context <id> [sibling_radius]" >&2; return 1; }
  floatty_curl "$FLOATTY_URL/api/v1/blocks/$id?include=ancestors,siblings,children&sibling_radius=$radius"
}

# Get block subtree with token estimate
# Usage: floatty_block_tree <id> [max_depth]
floatty_block_tree() {
  local id="$1"
  local depth="${2:-50}"
  [[ -z "$id" ]] && { echo "Usage: floatty_block_tree <id> [max_depth]" >&2; return 1; }
  floatty_curl "$FLOATTY_URL/api/v1/blocks/$id?include=tree,token_estimate&max_depth=$depth"
}

# Resolve short-hash prefix to full block UUID + data
# Usage: floatty_resolve <prefix>  (6+ hex chars)
floatty_resolve() {
  local prefix="$1"
  [[ -z "$prefix" ]] && { echo "Usage: floatty_resolve <prefix>" >&2; return 1; }
  floatty_curl "$FLOATTY_URL/api/v1/blocks/resolve/$prefix"
}

# Resolve (if needed) + get full subtree as raw JSON
# Usage: floatty_page <id_or_prefix> [max_depth]
# Returns full tree JSON — pipe to jq for formatting.
# Blocks are lines. A 400-block daily note is ~15K chars. Read it.
floatty_page() {
  local input="$1"
  local depth="${2:-50}"
  [[ -z "$input" ]] && { echo "Usage: floatty_page <id_or_prefix> [max_depth]" >&2; return 1; }

  local full_id="$input"

  # Resolve short-hash if not a full UUID
  if [[ ${#input} -lt 36 ]]; then
    local resolved
    resolved=$(floatty_resolve "$input")
    full_id=$(printf '%s' "$resolved" | jq -r '.id // empty')
    if [[ -z "$full_id" ]]; then
      echo "Failed to resolve prefix: $input" >&2
      echo "$resolved" >&2
      return 1
    fi
  fi

  floatty_curl "$FLOATTY_URL/api/v1/blocks/$full_id?include=tree,token_estimate&max_depth=$depth"
}

# Formatted page summary — truncated tree for quick scan
# Usage: floatty_page_pretty <id_or_prefix> [max_blocks] [max_depth]
floatty_page_pretty() {
  local input="$1"
  local max_blocks="${2:-50}"
  local depth="${3:-50}"
  [[ -z "$input" ]] && { echo "Usage: floatty_page_pretty <id_or_prefix> [max_blocks] [max_depth]" >&2; return 1; }

  local result
  result=$(floatty_page "$input" "$depth")

  local content block_count total_chars max_depth_val
  content=$(printf '%s' "$result" | jq -r '.content // "?" | .[0:120]')
  block_count=$(printf '%s' "$result" | jq -r '.tokenEstimate.blockCount // "?"')
  total_chars=$(printf '%s' "$result" | jq -r '.tokenEstimate.totalChars // "?"')
  max_depth_val=$(printf '%s' "$result" | jq -r '.tokenEstimate.maxDepth // "?"')

  echo "## $content"
  echo "ID: $(printf '%s' "$result" | jq -r '.id')"
  echo "Size: $total_chars chars, $block_count blocks, depth $max_depth_val"
  echo ""
  printf '%s' "$result" | jq -r ".tree[:$max_blocks][] | (\"  \" * .depth) + \"• [\\(.id[0:8])] \\(.content[0:80])\""

  local tree_count
  tree_count=$(printf '%s' "$result" | jq '.tree | length')
  [[ "$tree_count" -gt "$max_blocks" ]] && echo "... and $((tree_count - max_blocks)) more blocks (use floatty_page for full JSON)"
}

# Create block with children (returns parent ID)
# Usage: floatty_block_create_tree "header" "child1" "child2" ...
floatty_block_create_tree() {
  local header="$1"
  shift
  local children=("$@")

  [[ -z "$header" ]] && { echo "Usage: floatty_block_create_tree <header> [children...]" >&2; return 1; }

  # Create parent
  local parent_id
  parent_id=$(floatty_block_create "$header" | jq -r '.id')

  if [[ "$parent_id" == "null" || -z "$parent_id" ]]; then
    echo "Failed to create parent block" >&2
    return 1
  fi

  # Create children
  for child in "${children[@]}"; do
    floatty_block_create "$child" "$parent_id" > /dev/null
  done

  echo "$parent_id"
}

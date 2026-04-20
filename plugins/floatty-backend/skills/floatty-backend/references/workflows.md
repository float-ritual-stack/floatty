# floatty-backend Workflow Patterns

Common workflows for kitty and other Claude instances.

## Morning Brain Boot

Check what's in floatty from recent sessions:

```bash
source "$FLOATTY_SKILL_DIR/scripts/floatty-daily.sh"  # see SKILL.md setup for $FLOATTY_SKILL_DIR

# Yesterday's notes
floatty_search "$(date -v-1d +%Y-%m-%d)"  # macOS
floatty_search "$(date -d yesterday +%Y-%m-%d)"  # Linux

# Recent project work
floatty_search_markers "project::" "floatty"

# Recent ctx:: entries
floatty_search "ctx::"
```

## Session Capture

### Quick Note

**Precondition**: today's daily note must already exist under `pages::` — `floatty_daily_add` uses `GET /api/v1/daily/:date` and errors if the note is missing (FLO-636). Open floatty and click `[[YYYY-MM-DD]]` to create it first.

```bash
floatty_daily_add "Fixed scroll yanking bug - overflow:hidden pattern"
```

Creates: `[10:30 AM] Fixed scroll yanking bug - overflow:hidden pattern`

### Full TLDR

```bash
floatty_tldr "scroll fix + intent primitives" \
  "FLO-147 scroll fix, designed float.view.navigate" \
  "preventScroll unreliable on contentEditable" \
  "implement useNavigate hook"
```

Creates:
```
## 10:30 AM - scroll fix + intent primitives
  **Did**: FLO-147 scroll fix, designed float.view.navigate
  **Learned**: preventScroll unreliable on contentEditable
  **Next**: implement useNavigate hook
```

### Context Capture

```bash
floatty_ctx "completed Unit 3.6 marker search" "floatty" "build"
```

Creates: `ctx::2026-01-12 @ 10:30 AM [project::floatty] [mode::build] completed Unit 3.6 marker search`

## Search Patterns

### Find by Content

```bash
# Simple search
floatty_search "intent primitives"

# Pretty output (truncated)
floatty_search_pretty "intent primitives"
# Output: [abc12345] Intent primitives define the API surface for...

# Just IDs for piping
floatty_search_ids "intent primitives" | head -3
```

### Find by Markers

```bash
# All ctx:: markers
floatty_search_markers "ctx::"

# Project-specific
floatty_search_markers "project::" "floatty"

# Mode-specific
floatty_search_markers "mode::" "review"
```

### Find Backlinks

```bash
# What links to this page?
floatty_search_backlinks "Intent Primitives"
```

## Page Operations (short-hash → tree → operate)

The most common agent workflow: "give me this page, let me work on it."

```bash
source "$FLOATTY_SKILL_DIR/scripts/floatty-blocks.sh"  # see SKILL.md setup for $FLOATTY_SKILL_DIR

# One command: resolve short-hash + fetch full tree
floatty_page 5696d8b9
# Output: heading, ID, size stats, indented tree with short-hash per block

# With full UUID (skips resolve step)
floatty_page "5696d8b9-e563-4868-..."

# Deeper tree (default max_depth=50)
floatty_page 5696d8b9 10
```

### Resolve Only (when you just need the UUID)

```bash
floatty_resolve 5696d8b9
# Returns: { "id": "5696d8b9-e563-4868-...", "block": {...} }
```

### Pattern: Enrich Page Children

```bash
# 1. Get page tree
floatty_page 5696d8b9

# 2. Identify blocks needing metadata (from tree output)
# 3. Update each block
floatty_block_update "full-uuid" "updated content with [[backlinks]] and metadata"
```

## Block Tree Operations

### Create Nested Structure

```bash
# Create parent with children
parent_id=$(floatty_block_create_tree \
  "## Architecture Notes" \
  "Event → Handler → Transform → Project" \
  "Store-and-forward pattern" \
  "BBS message handlers, same shape")

echo "Created tree: $parent_id"
```

### Read and Navigate

```bash
# Get specific block
floatty_block_get "abc123"

# List all, filter locally
floatty_blocks_list | jq '.[] | select(.content | contains("ctx::"))'
```

## Block Repositioning (v0.7.29+, FLO-283)

### Reorder siblings within a parent

```bash
# Move block to first position in its current parent
curl -s -X PATCH "http://localhost:8765/api/v1/blocks/$BLOCK_ID" \
  -H "Content-Type: application/json" \
  -d '{"atIndex": 0}'
```

### Reparent + position

```bash
# Move block to new parent, insert after a specific sibling
curl -s -X PATCH "http://localhost:8765/api/v1/blocks/$BLOCK_ID" \
  -H "Content-Type: application/json" \
  -d "{\"parentId\": \"$NEW_PARENT\", \"afterId\": \"$SIBLING_ID\"}"
```

### Gardening loop (batch reparent + sort)

```bash
# 1. Create new day node (use floatty_block_create — handles auth + FLOATTY_URL)
DAY_NODE=$(floatty_block_create "## scratch for [[2026-02-13]] -" "$WEEK_NODE" \
  | jq -r '.id')

# 2. Reparent blocks (full UUIDs required)
for block in "${BLOCK_IDS[@]}"; do
  floatty_curl -X PATCH "$FLOATTY_URL/api/v1/blocks/${block}" \
    -d "{\"parentId\": \"${DAY_NODE}\"}"
done

# 3. Sort day nodes (reverse-chron: newest first)
floatty_curl -X PATCH "$FLOATTY_URL/api/v1/blocks/$NEWEST_DAY" \
  -d '{"atIndex": 0}'
```

**Short-hash resolution**: Block IDs can be resolved from 6+ hex-char prefixes via `GET /api/v1/blocks/resolve/818b2ef9` → returns full UUID + block data. For content-based discovery, use search: `GET /api/v1/search?q=content+snippet` → `.hits[0].blockId`.

## Integration with evna

Capture to both floatty AND evna:

```bash
# Capture context
MSG="completed skill creation for floatty-backend"
floatty_ctx "$MSG" "floatty" "build"

# Also capture to evna
# (done via mcp__evna-remote__active_context in Claude session)
```

## Debugging

### Check Server Health

```bash
source "$FLOATTY_SKILL_DIR/scripts/floatty-api.sh"  # see SKILL.md setup for $FLOATTY_SKILL_DIR
floatty_health
# {"status":"ok","version":"0.8.4","gitSha":"...","gitDirty":false}
```

### Verify API Key

```bash
# Should see your key
echo $FLOATTY_API_KEY

# If empty, check config
grep '^api_key' ~/.floatty/config.toml
```

### Test Connection

```bash
floatty_blocks_list | head -20
```

## Pipeline Examples

### Export Daily to Markdown

Daily notes are resolved via `GET /api/v1/daily/:date` (PageNameIndex),
not by text-searching for `## $TODAY` — that misses the canonical page and
only returns content snippets that happen to contain the heading.

```bash
TODAY=$(date +%Y-%m-%d)
# Get the daily note's full subtree
floatty_daily_get "$TODAY" tree \
  | jq -r '.tree[] | ("  " * .depth) + "- " + .content' \
  > "daily-$TODAY.md"
```

### Find and Update

```bash
# Find block, update it
ID=$(floatty_search "WIP: intent primitives" | jq -r '.hits[0].blockId')
floatty_block_update "$ID" "DONE: intent primitives architecture"
```

### Bulk Context Dump

```bash
# All context from today
floatty_search "ctx::$(date +%Y-%m-%d)" 100 | \
  jq -r '.hits[].content' | \
  sort
```

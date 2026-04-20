# Anti-Patterns: floatty-backend

## The Graph Filter Anti-Pattern ("cutting off your own arm")

Every search hit returns a graph-aware response. This is free data. The anti-pattern is filtering it out and then trying to reconstruct it.

### What the search API returns on every hit

```json
{
  "blockId": "bd4f5c17-...",
  "score": 8.42,
  "content": "...",
  "breadcrumb": ["Daily Notes", "2026-03-09"],    ← WHERE it lives (free)
  "metadata": {
    "markers": [{ "markerType": "project", "value": "floatty" }],  ← INDEX KEYS (free)
    "outlinks": ["Issue #1540", "2026-03-06"]                       ← EDGES (free)
  }
}
```

### Wrong pattern

```bash
# ❌ WRONG — threw away location, edges, tags
floatty_search_rich "issue::1526" | jq '.hits[] | .content'

# Now you have text. You lost:
# - WHERE it lives (breadcrumb)
# - WHAT it references (outlinks: ["PR #1682", "#1526"])
# - HOW it's tagged (markers: [project::rangle/pharmacy, mode::build])
# Then you write Python to re-derive what you just threw away.
```

### Correct pattern

```bash
# ✅ CORRECT — read what the API already gave you
floatty_search_rich "issue::1526" | jq '.hits[] | {
  id: .blockId,
  content: .content,
  location: .breadcrumb,
  references: .metadata.outlinks,
  tags: [.metadata.markers[] | "\(.markerType)::\(.value // "")"]
}'
```

### Distinguishing true backlinks from text noise

`metadata.outlinks` tells you instantly whether a result **links to** your target vs. just mentions it as a word:

```bash
# Find blocks that actually LINK to "Search Race" (not just mention "race")
floatty_search_rich "Search Race" | jq '.hits[] | select(
  .metadata.outlinks | map(test("Search Race"; "i")) | any
) | {id: .blockId, content, breadcrumb}'
```

### Why this matters

- The outline API is a graph engine, not a text search engine
- `breadcrumb` = location in tree (already parsed ancestry)
- `metadata.outlinks` = forward edges (already parsed wikilinks)
- `metadata.markers` = index keys (already parsed `::` annotations)
- Every `| jq '.hits[] | .content'` throws away the graph and gives you flat text

## The `echo` JSON Corruption Anti-Pattern

```bash
# ❌ BROKEN — zsh echo expands \n in JSON strings → parse error
RESULT=$(floatty_block_get "$ID")
echo "$RESULT" | jq '.content'

# ✅ CORRECT — printf preserves JSON exactly
RESULT=$(floatty_block_get "$ID")
printf '%s' "$RESULT" | jq '.content'

# ✅ ALSO CORRECT — pipe directly without capturing
floatty_block_get "$ID" | jq '.content'
```

## The `blockId` vs `id` Confusion

| Context | Field | Use case |
|---------|-------|----------|
| Block CRUD response | `.id` | Primary key — this IS the block |
| Search hit | `.blockId` | Foreign key — REFERENCES a block |

When piping search results to CRUD, map `.blockId` → the ID param. `.id` from a block list is NOT the same field.

# Querying the floatty API

Practical examples for querying block data via the REST API.

## Setup

```bash
# Extract auth from config (dev or release)
KEY=$(grep '^api_key' ~/.floatty/config.toml | cut -d'"' -f2)
PORT=$(grep '^server_port' ~/.floatty/config.toml | cut -d= -f2 | tr -d ' ')

# For dev builds, use ~/.floatty-dev/config.toml instead
```

## Basic Queries

### All blocks
```bash
curl -s -H "Authorization: Bearer $KEY" "http://127.0.0.1:$PORT/api/v1/blocks" | jq '.blocks | length'
```

### Single block by ID
```bash
curl -s -H "Authorization: Bearer $KEY" "http://127.0.0.1:$PORT/api/v1/blocks/{id}" | jq
```

### Block response shape
```json
{
  "id": "69d27e30-c792-4a57-89a5-ea4adfa7a436",
  "content": "some text here",
  "parentId": "08668763-0b4d-45e2-8329-2d1a9e8cad0d",
  "childIds": [],
  "collapsed": false,
  "blockType": "text",
  "createdAt": 1769436112959,
  "updatedAt": 1769441745004,
  "metadata": {
    "extractedAt": 1769435432.0,
    "isStub": false,
    "markers": [{ "markerType": "project", "value": "floatty" }],
    "outlinks": ["FLO-185"]
  }
}
```

## Context Retrieval (FLO-338)

### Block with ancestors and siblings
```bash
curl -s -H "Authorization: Bearer $KEY" \
  "http://127.0.0.1:$PORT/api/v1/blocks/{id}?include=ancestors,siblings&sibling_radius=3"
```

### Subtree with token estimate
```bash
curl -s -H "Authorization: Bearer $KEY" \
  "http://127.0.0.1:$PORT/api/v1/blocks/{id}?include=tree,token_estimate&max_depth=3"
```

| Include | What it adds |
|---------|-------------|
| `ancestors` | Parent chain up to root (max 10) |
| `siblings` | N blocks before/after within parent (default radius: 2) |
| `children` | Direct children (id + content) |
| `tree` | Full subtree DFS (max 1000 nodes) |
| `token_estimate` | totalChars, blockCount, maxDepth |

### Search with breadcrumbs
```bash
curl -s -H "Authorization: Bearer $KEY" \
  "http://127.0.0.1:$PORT/api/v1/search?q=my+query&include_breadcrumb=true&include_metadata=true"
```

## Time-Based Queries

Timestamps are milliseconds since epoch.

### Blocks updated in last N minutes
```bash
# Last 5 minutes (300000ms)
CUTOFF=$(( $(date +%s) * 1000 - 300000 ))

curl -s -H "Authorization: Bearer $KEY" "http://127.0.0.1:$PORT/api/v1/blocks" | \
  jq --argjson cutoff $CUTOFF \
  '[.blocks | to_entries[].value | select(.updatedAt > $cutoff)] | .[] | {id: .id[0:8], content: .content[0:60], updatedAt}'
```

### Blocks from a specific day
```bash
# Example: Wednesday Jan 22, 2026
START=$(date -j -f "%Y-%m-%d %H:%M:%S" "2026-01-22 00:00:00" "+%s")000
END=$(date -j -f "%Y-%m-%d %H:%M:%S" "2026-01-23 00:00:00" "+%s")000

curl -s -H "Authorization: Bearer $KEY" "http://127.0.0.1:$PORT/api/v1/blocks" | \
  jq --argjson start $START --argjson end $END \
  '[.blocks | to_entries[].value | select(.updatedAt >= $start and .updatedAt < $end and .content != "")] |
   "Found: \(length) blocks",
   (.[0:20] | .[] | .content[0:80])'
```

### Blocks created vs updated
```bash
# Created on a day (new blocks)
jq 'select(.createdAt >= $start and .createdAt < $end)'

# Updated on a day (any activity)
jq 'select(.updatedAt >= $start and .updatedAt < $end)'
```

## Filtering by Content

### Blocks containing a marker type
```bash
curl -s -H "Authorization: Bearer $KEY" "http://127.0.0.1:$PORT/api/v1/blocks" | \
  jq '[.blocks | to_entries[].value | select(.metadata.markers[]?.markerType == "project")] | length'
```

### Blocks with specific marker value
```bash
curl -s -H "Authorization: Bearer $KEY" "http://127.0.0.1:$PORT/api/v1/blocks" | \
  jq '[.blocks | to_entries[].value | select(.metadata.markers[]? | .markerType == "project" and .value == "floatty")] | .[] | .content[0:60]'
```

### Blocks with outlinks
```bash
curl -s -H "Authorization: Bearer $KEY" "http://127.0.0.1:$PORT/api/v1/blocks" | \
  jq '[.blocks | to_entries[].value | select(.metadata.outlinks | length > 0)] | .[] | {content: .content[0:40], outlinks: .metadata.outlinks}'
```

## Statistics

### Count blocks with/without timestamps
```bash
curl -s -H "Authorization: Bearer $KEY" "http://127.0.0.1:$PORT/api/v1/blocks" | \
  jq '[.blocks | to_entries[].value | {has_ts: (.createdAt > 0)}] | group_by(.has_ts) | map({has_timestamp: .[0].has_ts, count: length})'
```

### Activity by day (last 7 days)
```bash
curl -s -H "Authorization: Bearer $KEY" "http://127.0.0.1:$PORT/api/v1/blocks" | \
  jq '[.blocks | to_entries[].value | select(.updatedAt > 0)] |
      group_by(.updatedAt / 86400000 | floor) |
      .[-7:] |
      map({day: (.[0].updatedAt / 1000 | strftime("%Y-%m-%d")), count: length})'
```

## Tips

- **Timestamps**: `createdAt`/`updatedAt` are ms since epoch. Divide by 1000 for Unix seconds.
- **Empty blocks**: Filter with `select(.content != "")` to skip empty nodes.
- **Large outlines**: Add `| head -N` to limit output while exploring.
- **macOS date**: Use `-j -f` for parsing. Linux uses `-d` instead.

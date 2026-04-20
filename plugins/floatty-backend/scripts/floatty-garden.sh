#!/usr/bin/env bash
# floatty-garden.sh - Outline gardening helpers (sort, dedup, resolve, sweep)
# Source floatty-api.sh first, or this will source it

# Self-locate via BASH_SOURCE so the probe works from ANY install path:
# legacy ~/.claude/skills/, Claude Code plugin cache, `--plugin-dir`, or
# claude.ai /mnt/skills. Each script lives in <plugin-root>/scripts/, so the
# parent of the script directory is the plugin/skill root.
if [[ -z "$FLOATTY_SKILL_DIR" ]]; then
  FLOATTY_SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
# Guard on floatty_curl presence (not $FLOATTY_URL) — see blocks.sh for why.
if ! declare -F floatty_curl >/dev/null 2>&1; then
  source "$FLOATTY_SKILL_DIR/scripts/floatty-api.sh"
fi

# ─── Page Resolution ───────────────────────────────────────────────
# Resolve a page title to its block UUID via the PageNameIndex endpoint.
#
# Previously this downloaded every block in the outline and ran a Python
# filter to find pages by exact name — O(n) per call, with no fuzzy support.
# GET /api/v1/pages/search?prefix=<name> uses the server-side PageNameIndex
# (indexed, bounded, returns only matching pages + isStub flag). This helper
# is a thin filter on that endpoint: exact case-insensitive match.
#
# For fuzzy / prefix / list-all, use the richer wrappers in floatty-search.sh:
#   floatty_search_pages       (prefix match)
#   floatty_search_pages_fuzzy (nucleo fuzzy)
#   floatty_pages_list         (list all)
#
# Usage: floatty_find_page "Issue #1211"
# Returns: one-line JSON object {id, name, isStub} or empty on no match
floatty_find_page() {
  local title="$1"
  [[ -z "$title" ]] && { echo "Usage: floatty_find_page <title>" >&2; return 1; }

  # Defer to the search endpoint — encode title as prefix (won't include
  # longer titles that happen to start with the same text, since we filter
  # by exact equality below). Limit 10 in case of near-duplicates.
  local encoded
  encoded=$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$title")

  floatty_curl "$FLOATTY_URL/api/v1/pages/search?prefix=$encoded&limit=10" | \
    jq -c --arg t "$title" '
      .pages[]
      | select((.name | ascii_downcase) == ($t | ascii_downcase))
      | {id: .blockId, name, isStub}
    '
}

# Find page by content substring (broader than find_page)
# Usage: floatty_find_blocks "search term"
floatty_find_blocks() {
  local term="$1"
  [[ -z "$term" ]] && { echo "Usage: floatty_find_blocks <term>" >&2; return 1; }

  # ascii()|test() would treat $t as regex; use ascii_downcase | contains()
  # for literal substring match (CodeRabbit 🟡 on PR #250).
  floatty_curl "$FLOATTY_URL/api/v1/blocks" | \
    jq --arg t "$term" '[.blocks[] | select(.content | ascii_downcase | contains($t | ascii_downcase)) | {id, content: .content[0:120], children: (.childIds | length), parent: .parentId}]'
}

# ─── Sort Children ─────────────────────────────────────────────────
# Sort children of a block alphabetically by content
# Usage: floatty_sort_children <parent_id> [--dry-run]
floatty_sort_children() {
  local parent_id="$1"
  local dry_run="${2:-}"
  [[ -z "$parent_id" ]] && { echo "Usage: floatty_sort_children <parent_id> [--dry-run]" >&2; return 1; }

  # Pass parent_id + dry_run flag as Python argv so the quoted heredoc
  # (safe: prevents $VAR injection) can still receive the shell variables.
  # Fix for PR #250: previously the heredoc received no args, so sort_children
  # silently exited with "Parent block  not found" on every call.
  python3 - "$parent_id" "$dry_run" << 'PYEOF'
import json, sys, urllib.request, os

parent_id = sys.argv[1] if len(sys.argv) > 1 else ""
dry_run = "--dry-run" in sys.argv

url = os.environ.get("FLOATTY_URL", "http://localhost:8765")
key = os.environ.get("FLOATTY_API_KEY", "")

def api(method, path, data=None):
    req = urllib.request.Request(f"{url}{path}", method=method)
    req.add_header("Content-Type", "application/json")
    if key:
        req.add_header("Authorization", f"Bearer {key}")
    body = json.dumps(data).encode() if data else None
    try:
        with urllib.request.urlopen(req, body) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return {"error": e.code, "body": e.read().decode()}

# Fetch all blocks
resp = api("GET", "/api/v1/blocks")
blocks = resp.get("blocks", [])
block_map = {b["id"]: b for b in blocks}

# Get parent's children
parent = block_map.get(parent_id)
if not parent:
    print(f"Parent block {parent_id} not found", file=sys.stderr)
    sys.exit(1)

child_ids = parent.get("childIds", [])
if not child_ids:
    print("No children to sort")
    sys.exit(0)

# Build sortable list (skip orphans)
children = []
orphans = []
for cid in child_ids:
    if cid in block_map:
        children.append((cid, block_map[cid].get("content", "").lstrip("# ").strip().lower()))
    else:
        orphans.append(cid)

# Sort alphabetically
sorted_children = sorted(children, key=lambda x: x[1])
sorted_ids = [c[0] for c in sorted_children]

if sorted_ids == [c[0] for c in children]:
    print("Already sorted")
    sys.exit(0)

print(f"Sorting {len(sorted_ids)} children ({len(orphans)} orphans skipped)")

if dry_run:
    for i, (cid, title) in enumerate(sorted_children[:10]):
        print(f"  {i+1}. {title[:60]}")
    if len(sorted_children) > 10:
        print(f"  ... and {len(sorted_children) - 10} more")
    sys.exit(0)

# Execute sort: first to atIndex 0, rest via afterId chaining
ok = 0
errors = 0
for i, cid in enumerate(sorted_ids):
    if i == 0:
        result = api("PATCH", f"/api/v1/blocks/{cid}", {"parentId": parent_id, "atIndex": 0})
    else:
        result = api("PATCH", f"/api/v1/blocks/{cid}", {"parentId": parent_id, "afterId": sorted_ids[i-1]})
    if "error" in result:
        errors += 1
    else:
        ok += 1

print(f"Sorted: {ok} moved, {errors} errors")
PYEOF
}

# ─── Duplicate Page Detection ──────────────────────────────────────
# Find duplicate pages (exact and near-match titles)
# Usage: floatty_dedup_pages [--dry-run]
floatty_dedup_pages() {
  local dry_run="${1:-}"

  # NOTE on endpoint choice (PR #250 audit): GET /api/v1/pages/search uses
  # PageNameIndex, which only knows about pages *registered under the
  # `pages::` container*. But the real dedup use case is to find `# Title`
  # blocks that have ended up under other parents too (e.g. archived dupes
  # of a hub page) — those aren't in PageNameIndex. Full /api/v1/blocks
  # scan is unavoidable here until a richer "all blocks with heading
  # content" endpoint exists. For indexed-only enumeration use
  # `floatty_search_pages` / `floatty_pages_list` in floatty-search.sh.
  python3 - "$dry_run" << 'PYEOF'
import json, sys, re, urllib.request, os
from collections import defaultdict

dry_run = len(sys.argv) > 1 and sys.argv[1] == "--dry-run"

url = os.environ.get("FLOATTY_URL", "http://localhost:8765")
key = os.environ.get("FLOATTY_API_KEY", "")

def api(method, path, data=None):
    req = urllib.request.Request(f"{url}{path}", method=method)
    req.add_header("Content-Type", "application/json")
    if key:
        req.add_header("Authorization", f"Bearer {key}")
    body = json.dumps(data).encode() if data else None
    try:
        with urllib.request.urlopen(req, body) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return {"error": e.code}

resp = api("GET", "/api/v1/blocks")
blocks = resp.get("blocks", [])

# Find pages (blocks starting with #). Scans all blocks — no endpoint
# returns "all heading blocks" today. /api/v1/pages/search would miss
# headings parented outside the `pages::` container (which is exactly
# the merge target we care about).
pages = []
for b in blocks:
    content = b.get("content", "")
    if content.startswith("# "):
        title = content[2:].strip()
        pages.append({
            "id": b["id"],
            "title": title,
            "children": len(b.get("childIds", [])),
            "content": content,
        })

# Normalize for comparison: lowercase, strip ::, strip #/issue/Issue prefix variations
def normalize(title):
    t = title.lower().strip()
    t = re.sub(r'^(issue\s*::\s*|issue\s+#?\s*|#\s*)', '', t)
    t = re.sub(r'\s+', ' ', t)
    return t

# Group by normalized title
groups = defaultdict(list)
for p in pages:
    key_norm = normalize(p["title"])
    groups[key_norm].append(p)

# Report duplicates
dupes = {k: v for k, v in groups.items() if len(v) > 1}

if not dupes:
    print("No duplicate pages found")
    sys.exit(0)

print(f"Found {len(dupes)} duplicate groups:\n")
for norm_title, group in sorted(dupes.items()):
    print(f"  [{norm_title}]")
    for p in sorted(group, key=lambda x: -x["children"]):
        print(f"    {p['id'][:12]}  children:{p['children']:3d}  \"{p['title']}\"")

    # Recommend canonical (most children)
    canonical = max(group, key=lambda x: x["children"])
    others = [p for p in group if p["id"] != canonical["id"]]
    print(f"    → canonical: \"{canonical['title']}\" ({canonical['children']} children)")
    print()

if dry_run:
    sys.exit(0)

# Merge path. Use /api/v1/search?outlink=<name> to find blocks containing
# [[dupe_title]] (server-side indexed — much faster than scanning `blocks`
# in-memory for substring). The `blocks` dict we already have is fine for
# childIds lookups during reparenting.
for norm_title, group in dupes.items():
    canonical = max(group, key=lambda x: x["children"])
    others = [p for p in group if p["id"] != canonical["id"]]

    block_by_id = {b["id"]: b for b in blocks}

    for dupe in others:
        # Refs via outlink filter — index-backed, no content substring walk.
        from urllib.parse import quote
        outlink_encoded = quote(dupe["title"])
        refs_resp = api("GET", f"/api/v1/search?q=&outlink={outlink_encoded}&limit=1000")
        refs = refs_resp.get("hits", []) if "error" not in refs_resp else []

        print(f"Merging \"{dupe['title']}\" → \"{canonical['title']}\"")

        # Rewrite wikilink references. Search hits omit full content by
        # default; fetch each block fresh to avoid clobbering co-edits.
        for hit in refs:
            block_id = hit.get("blockId")
            if not block_id:
                continue
            block = api("GET", f"/api/v1/blocks/{block_id}")
            if "error" in block:
                continue
            current = block.get("content", "")
            new_content = current.replace(f"[[{dupe['title']}]]", f"[[{canonical['title']}]]")
            if new_content != current:
                result = api("PATCH", f"/api/v1/blocks/{block_id}", {"content": new_content})
                status = "ok" if "error" not in result else f"err:{result['error']}"
                print(f"  ref rewrite: {block_id[:12]} ({status})")

        # Reparent dupe's children to canonical (use cached childIds map).
        dupe_block = block_by_id.get(dupe["id"])
        if dupe_block:
            for child_id in dupe_block.get("childIds", []):
                result = api("PATCH", f"/api/v1/blocks/{child_id}", {"parentId": canonical["id"]})
                status = "ok" if "error" not in result else f"err:{result['error']}"
                print(f"  reparent child: {child_id[:12]} ({status})")

        # Delete the duplicate page
        result = api("DELETE", f"/api/v1/blocks/{dupe['id']}")
        status = "ok" if "error" not in result else f"err:{result['error']}"
        print(f"  delete dupe: {dupe['id'][:12]} ({status})")
    print()

PYEOF
}

# ─── Orphan Sweep ──────────────────────────────────────────────────
# Find blocks referenced in childIds that no longer exist
# Usage: floatty_orphan_sweep [--fix]
floatty_orphan_sweep() {
  local fix="${1:-}"

  # Pass fix flag via argv (quoted heredoc blocks $VAR interpolation).
  # Fix for PR #250: previously heredoc received no args, so --fix was silently ignored.
  python3 - "$fix" << 'PYEOF'
import json, sys, urllib.request, os

fix = "--fix" in sys.argv

url = os.environ.get("FLOATTY_URL", "http://localhost:8765")
key = os.environ.get("FLOATTY_API_KEY", "")

def api(method, path, data=None):
    req = urllib.request.Request(f"{url}{path}", method=method)
    req.add_header("Content-Type", "application/json")
    if key:
        req.add_header("Authorization", f"Bearer {key}")
    body = json.dumps(data).encode() if data else None
    try:
        with urllib.request.urlopen(req, body) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return None

resp = api("GET", "/api/v1/blocks")
blocks = resp.get("blocks", [])
block_ids = {b["id"] for b in blocks}

orphan_refs = []
for b in blocks:
    for child_id in b.get("childIds", []):
        if child_id not in block_ids:
            orphan_refs.append({"parent": b["id"], "parent_title": b.get("content", "")[:60], "orphan": child_id})

if not orphan_refs:
    print("No orphan references found")
    sys.exit(0)

print(f"Found {len(orphan_refs)} orphan childId references:\n")
for o in orphan_refs:
    print(f"  parent: {o['parent'][:12]} \"{o['parent_title']}\"")
    print(f"  orphan: {o['orphan']}")
    print()

if not fix:
    print("Run with --fix to clean up (note: requires server-side childIds cleanup)")
PYEOF
}

# ─── Duplicate sh:: Block Detection ────────────────────────────────
# Find duplicate sh:: blocks and optionally replace with wikilinks
# Usage: floatty_dedup_sh [--dry-run]
floatty_dedup_sh() {
  local dry_run="${1:---dry-run}"

  # Pass dry_run flag via argv.
  # Fix for PR #250: previously heredoc received no args, so --dry-run check was always False.
  python3 - "$dry_run" << 'PYEOF'
import json, sys, re, urllib.request, os
from collections import defaultdict

dry_run = "--dry-run" in sys.argv

url = os.environ.get("FLOATTY_URL", "http://localhost:8765")
key = os.environ.get("FLOATTY_API_KEY", "")

def api(method, path, data=None):
    req = urllib.request.Request(f"{url}{path}", method=method)
    req.add_header("Content-Type", "application/json")
    if key:
        req.add_header("Authorization", f"Bearer {key}")
    body = json.dumps(data).encode() if data else None
    try:
        with urllib.request.urlopen(req, body) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return {"error": e.code}

resp = api("GET", "/api/v1/blocks")
blocks = resp.get("blocks", [])

# Find sh:: blocks
sh_blocks = []
for b in blocks:
    content = b.get("content", "")
    # Match sh:: prefix (with optional x/% guard prefix)
    if re.match(r'^[x%]?\s*sh::', content):
        cmd = re.sub(r'^[x%]?\s*sh::\s*', '', content).strip()
        sh_blocks.append({
            "id": b["id"],
            "content": content,
            "command": cmd,
            "children": b.get("childIds", []),
            "parentId": b.get("parentId"),
        })

# Group by normalized command
def normalize_cmd(cmd):
    return re.sub(r'\s+', ' ', cmd.strip().lower())

groups = defaultdict(list)
for sb in sh_blocks:
    groups[normalize_cmd(sb["command"])].append(sb)

dupes = {k: v for k, v in groups.items() if len(v) > 1}

if not dupes:
    print("No duplicate sh:: blocks found")
    sys.exit(0)

# Categorize duplicates
categories = {
    "linear": [],    # floatctl script run linear FLO-XXX
    "cat": [],       # cat file paths
    "other": [],
}

for cmd, group in dupes.items():
    if "linear" in cmd or "flo-" in cmd:
        categories["linear"].append((cmd, group))
    elif cmd.startswith("cat "):
        categories["cat"].append((cmd, group))
    else:
        categories["other"].append((cmd, group))

total = sum(len(g) for g in dupes.values())
print(f"Found {len(dupes)} duplicate commands ({total} total blocks):\n")

for cat_name, cat_groups in categories.items():
    if not cat_groups:
        continue
    print(f"  [{cat_name}] ({len(cat_groups)} commands)")
    for cmd, group in cat_groups:
        print(f"    \"{cmd[:70]}\" × {len(group)}")
        for sb in group:
            kids = len(sb["children"])
            print(f"      {sb['id'][:12]} ({kids} children)")
    print()

if dry_run:
    print("Run without --dry-run to apply wikilink replacements")

PYEOF
}

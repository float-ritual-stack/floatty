#!/usr/bin/env bash
# search-test.sh - Helper for testing floatty search API
#
# Usage:
#   ./scripts/search-test.sh search "project::floatty"
#   ./scripts/search-test.sh populate
#   ./scripts/search-test.sh clear-index
#
# Requires: floatty-server running on port 8765, jq for formatting

set -euo pipefail

FLOATTY_PORT="${FLOATTY_PORT:-8765}"
BASE_URL="http://127.0.0.1:${FLOATTY_PORT}/api/v1"

# Get API key from config
get_api_key() {
    local config_file="$HOME/.floatty/config.toml"
    if [[ -f "$config_file" ]]; then
        grep -E '^api_key' "$config_file" | cut -d'"' -f2
    else
        echo "floatty-dev-key"  # Default for dev
    fi
}

API_KEY=$(get_api_key)
AUTH_HEADER="Authorization: Bearer $API_KEY"

# Helper to make API calls
api() {
    local method=$1
    local endpoint=$2
    shift 2
    curl -s -X "$method" \
        -H "$AUTH_HEADER" \
        -H "Content-Type: application/json" \
        "${BASE_URL}${endpoint}" \
        "$@"
}

# Search for blocks (IDs only)
cmd_search() {
    local query="${1:-}"
    if [[ -z "$query" ]]; then
        echo "Usage: $0 search <query>"
        echo "Examples:"
        echo "  $0 search floatty"
        echo "  $0 search 'project::floatty'"
        echo "  $0 search 'mode::dev'"
        exit 1
    fi

    echo "Searching for: $query"
    echo "─────────────────────────────────────"
    api GET "/search?q=$(urlencode "$query")&limit=20" | jq .
}

# Search and return full blocks with content
cmd_find() {
    local query="${1:-}"
    local limit="${2:-10}"

    if [[ -z "$query" ]]; then
        echo "Usage: $0 find <query> [limit]"
        echo "Examples:"
        echo "  $0 find 'project::floatty'"
        echo "  $0 find 'mode::dev' 5"
        exit 1
    fi

    echo "Finding: $query (limit: $limit)"
    echo "═══════════════════════════════════════════════════════════════════"

    # Get search hits
    local hits=$(api GET "/search?q=$(urlencode "$query")&limit=$limit")
    local count=$(echo "$hits" | jq '.hits | length')

    if [[ "$count" == "0" ]]; then
        echo "No results found."
        return
    fi

    echo "Found $count hits:"
    echo ""

    # Hydrate each block
    echo "$hits" | jq -r '.hits[].blockId' | while read -r block_id; do
        local block=$(api GET "/blocks/$block_id" 2>/dev/null)
        if [[ -n "$block" && "$block" != "null" ]]; then
            local content=$(echo "$block" | jq -r '.content // "(no content)"')
            local block_type=$(echo "$block" | jq -r '.blockType // "text"')
            local score=$(echo "$hits" | jq -r ".hits[] | select(.blockId == \"$block_id\") | .score")

            echo "┌─ [$block_type] score: $score"
            echo "│  $block_id"
            echo "├──────────────────────────────────────────────────────────────"
            echo "$content" | head -5 | sed 's/^/│  /'
            local lines=$(echo "$content" | wc -l)
            if [[ $lines -gt 5 ]]; then
                echo "│  ... ($lines lines total)"
            fi
            echo "└──────────────────────────────────────────────────────────────"
            echo ""
        fi
    done
}

# Populate test data
cmd_populate() {
    echo "Populating test data..."
    echo "─────────────────────────────────────"

    # Create blocks with various markers
    local blocks=(
        '{"content": "ctx::2026-01-11 @ 06:00 AM Working on [project::floatty] [mode::dev] search architecture", "parent_id": null}'
        '{"content": "ctx::2026-01-11 @ 06:30 AM [project::floatty] [issue::264] Unit 3.6 marker indexing", "parent_id": null}'
        '{"content": "sh:: cargo test -p floatty-core search", "parent_id": null}'
        '{"content": "project::pharmacy mode::review PR #1031 code review", "parent_id": null}'
        '{"content": "Just some plain text without markers", "parent_id": null}'
        '{"content": "[[Page Reference]] with wikilink", "parent_id": null}'
        '{"content": "ctx::2026-01-10 @ 11:00 PM [project::float-archaeology] [mode::synthesis]", "parent_id": null}'
    )

    for block in "${blocks[@]}"; do
        local id=$(api POST "/blocks" -d "$block" | jq -r '.id // "error"')
        local content=$(echo "$block" | jq -r '.content | .[0:50]')
        echo "Created: $id - ${content}..."
    done

    echo ""
    echo "Done! Try:"
    echo "  $0 search 'project::floatty'"
    echo "  $0 search 'mode::dev'"
    echo "  $0 search 'issue::264'"
}

# Clear the search index (requires restart to rebuild)
cmd_clear_index() {
    echo "Clearing search index..."
    local index_path="$HOME/.floatty/search_index"
    if [[ -d "$index_path" ]]; then
        rm -rf "$index_path"
        echo "Deleted: $index_path"
        echo ""
        echo "Restart floatty-server to rebuild index from Y.Doc"
    else
        echo "Index directory not found: $index_path"
    fi
}

# List all blocks (for debugging)
cmd_list() {
    echo "Listing all blocks..."
    echo "─────────────────────────────────────"
    api GET "/blocks" | jq '.[] | {id, content: .content[0:60], has_metadata: (.metadata != null)}'
}

# Check server health
cmd_health() {
    echo "Checking floatty-server health..."
    echo "─────────────────────────────────────"
    local status
    if curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/blocks" -H "$AUTH_HEADER" | grep -q "200"; then
        echo "✓ Server responding on port $FLOATTY_PORT"
        local block_count=$(api GET "/blocks" | jq 'length')
        echo "  Blocks: $block_count"
    else
        echo "✗ Server not responding on port $FLOATTY_PORT"
        echo "  Start with: cd src-tauri && cargo run -p floatty-server"
        exit 1
    fi
}

# URL encode helper
urlencode() {
    python3 -c "import urllib.parse; print(urllib.parse.quote('$1', safe=''))"
}

# Main dispatch
case "${1:-help}" in
    search)
        shift
        cmd_search "$@"
        ;;
    find)
        shift
        cmd_find "$@"
        ;;
    populate)
        cmd_populate
        ;;
    clear-index)
        cmd_clear_index
        ;;
    list)
        cmd_list
        ;;
    health)
        cmd_health
        ;;
    *)
        echo "search-test.sh - Floatty search testing helper"
        echo ""
        echo "Usage: $0 <command> [args]"
        echo ""
        echo "Commands:"
        echo "  search <query>   Search for blocks (IDs + scores only)"
        echo "  find <query>     Search and show full block content"
        echo "  populate         Create test blocks with various markers"
        echo "  list             List all blocks"
        echo "  health           Check server health"
        echo "  clear-index      Delete search index (requires server restart)"
        echo ""
        echo "Environment:"
        echo "  FLOATTY_PORT     Server port (default: 8765)"
        echo ""
        echo "Examples:"
        echo "  $0 health"
        echo "  $0 populate"
        echo "  $0 search 'project::floatty'"
        echo "  $0 search 'mode::synthesis'"
        ;;
esac

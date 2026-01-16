# filter:: Dynamic Query Blocks

> Query blocks that match by markers (`project::`, `status::`, `type::`, etc.)

---

## Quick Start

Type `filter::` on a block, add child blocks with rules:

```
filter:: floatty tasks
  - include(project::floatty)
  - include(type::task)
  - exclude(status::archived)
```

Press **Enter** on the parent to execute and see matching blocks.

---

## Rule Syntax

### Include / Exclude

```
include(markerType::pattern)   // Block MUST have this marker
exclude(markerType::pattern)   // Block MUST NOT have this marker
```

**Examples:**
```
include(project::floatty)      // Exact match
include(project::float*)       // Prefix wildcard
include(project::*ty)          // Suffix wildcard
include(project::*)            // Any project marker
include(project::)             // Same as * (empty = wildcard)
exclude(status::archived)      // Hide archived blocks
```

### Options

```
limit(20)                      // Max results (default: 50)
sort(updatedAt, desc)          // Sort by field (asc|desc)
sort(createdAt)                // Direction defaults to desc
any()                          // Use OR instead of AND
```

### Comments

Lines starting with `#`, `//`, `%%`, or `--` are ignored:

```
filter:: my tasks
  - include(project::floatty)
  - // TODO: add more filters
  - # this line is ignored
  - exclude(status::archived) <-- trailing notes work too
```

---

## Evaluation Logic

1. **Excludes first** - if any exclude rule matches, block is rejected (short-circuit)
2. **No includes = pass** - if only exclude rules, all non-excluded blocks match
3. **Combinator applies** to include rules:
   - `all` (default): ALL include rules must match
   - `any()`: ANY include rule must match

### Example: OR Logic

```
filter:: float projects
  - include(project::floatty)
  - include(project::float-hub)
  - any()
```

Matches blocks with `project::floatty` OR `project::float-hub`.

---

## Pattern Matching

| Pattern | Matches |
|---------|---------|
| `*` | Any value (including blocks without the marker) |
| `floatty` | Exact match only |
| `float*` | Values starting with "float" |
| `*ty` | Values ending with "ty" |

---

## Supported Marker Types

Any marker from your blocks' metadata:

| Type | Description |
|------|-------------|
| `project` | Project identifier |
| `type` | Block type (task, bug, note, etc.) |
| `status` | Status (active, done, archived) |
| `mode` | Execution mode |
| `issue` | Issue reference |
| `ctx` | Context marker |

Markers are extracted from block content by the MetadataExtractionHook:
```
ctx::2026-01-15 project::floatty status::active - Working on filters
```

---

## Sort Fields

| Field | Description |
|-------|-------------|
| `updatedAt` | Last modification time |
| `createdAt` | Block creation time |
| `content` | Alphabetical by content |

---

## Visual Styling

### Inline Syntax Highlighting

Filter rules get syntax highlighting in the outliner:

- `include(...)` / `exclude(...)` - cyan function style
- `filter::` prefix - cyan (matches ctx:: styling)
- Comments (`//`, `--`, `%%`, `#`) - muted gray

### Results Panel

Matching blocks appear in a results panel below the filter:
- Project badges with colored backgrounds
- Click to navigate to the block
- Badges show marker types (project, status, type)

---

## Examples

### All floatty tasks

```
filter:: floatty tasks
  - include(project::floatty)
  - include(type::task)
```

### Recent activity (any project)

```
filter:: recent
  - include(project::*)
  - sort(updatedAt, desc)
  - limit(10)
```

### Non-archived from float projects

```
filter:: float ecosystem
  - include(project::float*)
  - exclude(status::archived)
  - exclude(status::done)
```

### Multi-project OR query

```
filter:: work stuff
  - include(project::rangle)
  - include(project::pharmacy)
  - any()
  - exclude(status::archived)
```

---

## Architecture

### Files

| File | Purpose |
|------|---------|
| `src/lib/filterParser.ts` | Rule parsing, pattern matching, filter evaluation |
| `src/lib/filterParser.test.ts` | 30+ tests for parsing and matching |
| `src/lib/inlineParser.ts` | Syntax highlighting tokens |
| `src/components/FilterResults.tsx` | Results panel component |
| `src/index.css` | Filter styling (search for `.filter-`) |

### Data Flow

```
filter:: block
    │
    ├─ parseFilterFromChildren() → ParsedFilter
    │     (rules, combinator, limit, sort)
    │
    ├─ executeFilter(filter, allBlocks) → Block[]
    │     (applies rules, sorts, limits)
    │
    └─ FilterResults component
          (displays matches with badges)
```

### Marker Source

Filters match against `block.metadata.markers`, populated by MetadataExtractionHook from block content patterns like `[project::floatty]` or `status::active`.

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Execute filter (refresh results) |
| `⌘.` | Collapse/expand filter rules |
| `Tab` | Indent rule (at line start) |

---

## Troubleshooting

### No results showing

1. Check markers exist on target blocks (look for `[project::X]` in content)
2. MetadataExtractionHook must have run on those blocks
3. Check for typos in marker type names

### Error: "Unrecognized filter syntax"

Rule format must be: `include(type::pattern)` or `exclude(type::pattern)`

Valid: `include(project::floatty) <-- my notes`
Invalid: `project::floatty` (missing include/exclude wrapper)

### Results panel text unreadable

Check theme variables are defined. Filter results use:
- `--color-fg` for text
- `--color-bg-secondary` for card backgrounds

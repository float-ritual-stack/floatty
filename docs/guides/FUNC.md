# func:: — Blocks as Config

Define new prefixes from blocks — no .js files needed. A `func::` block with `input::` and `body::` children teaches floatty a new command at runtime.

## Quick Start

```
func:: greet
  input:: name
  body:: return "Hello, " + name + "!"
```

Now type anywhere in the outline:
```
greet:: World
→ "Hello, World!"
```

## How It Works

1. **Define**: Create a block starting with `func:: name`
2. **Children**: Add `input::` (comma-separated parameter names) and `body::` (JS expression)
3. **Use**: Type `name:: args` anywhere — floatty recognizes the new prefix
4. **Execute**: Press Enter — func reads the definition, binds args, evaluates the body

## Anatomy

```
func:: weather                    ← defines "weather::" prefix
  input:: city, units             ← parameters (optional)
  body:: return $ref("api") + "?q=" + city + "&units=" + units
```

- `func::` + name → registers the prefix
- `input::` → comma-separated parameter names, bound to args in order
- `body::` → JS expression (same scope as eval::, plus input variables)

## Calling

Arguments are comma-separated after the prefix:

```
weather:: london, metric
```

This binds `city = "london"` and `units = "metric"` in the body expression.

No arguments:
```
weather::
```

Single argument:
```
weather:: london
```

## The Body Expression

The body has the same scope as `eval::` (see `help:: eval`):

- `$ref("name")` — read sibling blocks by prefix
- `$siblings()`, `$children(id)`, `$parent()`, `$block(id)` — outline traversal
- `$after(content)`, `$inside(content)`, `$update(id, content)`, `$delete(id)` — write operations
- Plus all `input::` variables bound by name

## Result Types

Same as eval:: — the engine auto-detects what you return:

| Return | Viewer |
|---|---|
| String URL | Embedded iframe |
| Object | JSON tree |
| Array of objects | Table |
| Primitive | Inline value |

## Examples

### URL viewer (iframe)
```
func:: site
  body:: return "https://example.com"

site:: anything
→ [embedded iframe showing example.com]
```

### Calculator with inputs
```
func:: calc
  input:: a, b, op
  body:: return op === "+" ? a + b : op === "*" ? a * b : "unknown op"

calc:: 10, 3, +
→ 13
```

### Template generator
```
func:: todo
  input:: task
  body:: return $after("- [ ] " + task)

todo:: Buy groceries
→ [creates sibling block: "- [ ] Buy groceries"]
```

### Using sibling data
```
api:: https://api.weather.example.com
func:: wx
  input:: city
  body:: return $ref("api") + "/current?city=" + city

wx:: london
→ [iframe loading weather API]
```

## Live Index

func:: definitions are indexed automatically. When you create, edit, or delete a `func::` block, the prefix registry updates immediately. No restart needed.

## Tips

- func:: blocks can live anywhere in the outline — they're found by scanning all blocks
- The definition block itself doesn't execute — only `name:: args` trigger blocks do
- Body expressions are re-read on every invocation (edit the body, next call uses the new version)
- Combine with `⌘⇧F` (full-width) for iframe results that need more room

# eval:: — Inline JS Expressions

Evaluate JavaScript expressions with full read/write access to the outline.

## Quick Start

```
eval:: 2 + 2
→ 4

eval:: "hello".toUpperCase()
→ "HELLO"

eval:: new Date().toLocaleDateString()
→ "3/3/2026"
```

Type `eval::` followed by any JS expression, then press Enter to execute.

## Result Types

The engine auto-detects what you returned and picks the right viewer:

| Return value | Type | Viewer |
|---|---|---|
| Number, string, boolean | `value` | Inline text |
| `http://` or `https://` URL | `url` | Embedded iframe |
| Object `{}` | `json` | Collapsible JSON tree |
| Array of objects `[{...}]` | `table` | Table view |
| Array of primitives | `json` | Pretty-printed JSON |
| Error thrown | `error` | Red error message |

## Outline API ($-functions)

Every eval:: expression has access to these scope functions:

### Reading

```
eval:: $ref("name")
```
Look up a sibling block by prefix name. If a sibling has content `name:: value`, returns the parsed value (or its output if it was executed).

Also accepts UUIDs for direct block lookup:
```
eval:: $ref("a1b2c3d4-...")
```

```
eval:: $siblings()
```
Returns array of sibling blocks (same parent, excluding self).

```
eval:: $children("block-id")
```
Returns array of child blocks.

```
eval:: $parent()
```
Returns the parent block.

```
eval:: $block("block-id")
```
Returns a block by UUID.

### Writing

```
eval:: $after("new sibling content")
```
Creates a new block after this eval block. Returns the new block's ID.

```
eval:: $inside("child content")
```
Creates a child block inside this eval block. Returns the new block's ID.

```
eval:: $inside("child content", "other-block-id")
```
Creates a child inside a specific block.

```
eval:: $update("block-id", "new content")
```
Updates an existing block's content.

```
eval:: $delete("block-id")
```
Deletes a block.

## Combining With Sibling Data

The `$ref` function makes sibling blocks into live variables:

```
price:: 42.50
quantity:: 3
eval:: $ref("price") * $ref("quantity")
→ 127.50
```

Values after `::` are parsed as JSON when possible (numbers, booleans, arrays), or kept as strings.

## Examples

### Quick calculation
```
eval:: Math.round(Math.PI * 100) / 100
→ 3.14
```

### Embed a URL
```
eval:: "https://example.com"
→ [embedded iframe]
```

### Generate a table
```
eval:: [{name: "Alice", age: 30}, {name: "Bob", age: 25}]
→ [table view]
```

### Read sibling data
```
data:: [1, 2, 3, 4, 5]
eval:: $ref("data").reduce((a, b) => a + b, 0)
→ 15
```

### Create blocks programmatically
```
eval:: ["apple", "banana", "cherry"].map(f => $after(f))
→ [creates 3 sibling blocks below]
```

## Collapse & Full-Width

- **Collapse** (`⌘.`): hides the eval output. Bullet shows ▸.
- **Full-width** (`⌘⇧F`): stretches output to full pane width. See `help:: full-width`.
- **Full-pane** (`⌘Enter`): for URL results, fills entire pane with iframe.

# Authored props — `POST /api/v1/blocks/:id/props`

A *prop* is the authored form of a property in a block's own text: a `[key::value]` pill, or for `status` a `[[glyph]]` link (`[[⬜]]` todo · `[[🟨]]` doing · `[[✅]]` done · `[[👀]]` waiting). **Props are written; metadata is read.** `metadata.markers` is a derived cache that hooks rebuild from the text on every content change — writing it directly is overwritten within seconds. The endpoint writes the text for you, in the form the outline already uses, and everything downstream (extraction, inheritance, search, sync) follows.

## Request

```
POST /api/v1/blocks/:id/props        (:id accepts 6+ hex short hashes)
{
  "set":    { "status": "doing", "project": "demo/qv" },
  "unset":  [ "owner" ],
  "expect": { "status": "todo", "owner": null },
  "ifUpdatedAt": 1788924353476
}
```

All fields optional. Unknown fields are rejected. Sets apply in key order, then unsets.

- `expect` is the optimistic-concurrency guard: each key must currently have exactly that value; `null` means **absent** (a present-but-valueless pill does not count). `expect: {status: null}` is how you *claim* an unowned task atomically.
- `ifUpdatedAt` guards the whole block against any edit since you read it.
- Guards and the write share one lock — a check-then-write can't race another client.

## Responses

- **200** — the updated block (same shape as `GET /blocks/:id`, `ancestorContext` included). Idempotent: an unchanged write returns 200 with the same `updatedAt`. Returned `metadata` may lag one hook batch behind the new content — trust the content and the status code.
- **409** — a guard failed: `{"current": {"status": "doing", "owner": null}, "updatedAt": …}` — re-read and retry from `current`.
- **400** — the write can't be represented, nothing was written: `{"error", "key", "value", "reason"}` with `reason` one of `unrepresentableValue` (empty, or contains `]`/newline), `unknownGlyphValue` (not in the key's table), `multipleExistingPills`, `unsupportedExistingSurface`.

## Where the text lands

| Key kind | Set | Unset |
|---|---|---|
| glyph-backed (`status`) | replaces the mapped `[[glyph]]` in the first line, else inserts one at the head after any `## ` / `- ` / `① ` prefix | removes it |
| pill (everything else) | replaces `[key::old]` in place, else appends to the end of the first line (or to line 2 if it's already a pill envelope) | removes every `[key::…]` |

Surface table: `status` is glyph-backed by default; override or add keys per server with `[props.<key>]` in `config.toml` (`surface = "glyph"` + `glyphs = { … }`, or `surface = "pill"`). Malformed entries fail at startup.

## Examples

```bash
# claim a todo (fails with 409 if someone else already moved it)
curl -s -X POST -H "Authorization: Bearer $FLOATTY_API_KEY" -H 'Content-Type: application/json' \
  -d '{"set":{"status":"doing"},"expect":{"status":"todo"}}' \
  "$FLOATTY_URL/api/v1/blocks/99b7feba/props" | jq -c '{content, updatedAt}'

# tag and hand off
curl -s -X POST … -d '{"set":{"project":"demo/project","owner":"demo-alice"}}' "$FLOATTY_URL/api/v1/blocks/99b7feba/props"

# done, and drop the owner pill
curl -s -X POST … -d '{"set":{"status":"done"},"unset":["owner"]}' "$FLOATTY_URL/api/v1/blocks/99b7feba/props"
```

Inside a floatty terminal `$FLOATTY_URL` / `$FLOATTY_API_KEY` are injected and correct for that instance (dev or release).

## Related

`help:: query` for standing queries that consume these props; `.claude/rules/api-reference.md` §Authored props for the wire contract; write-through on move/create is `PropStampHook` (ADR-009 D4).

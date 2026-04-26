# Projections Layer (FLO-368 intermediary surface)

> Created during FLO-679 PR 2 (2026-04-25). Reads from the consolidated
> `walk_ancestors` foundation that landed in [[PR #281]].

## What this layer is

`projections/` is the **intermediary surface** in the FLO-368 three-layer
architecture (human → intermediary → query). It sits between the raw Y.Doc
read primitives (`get_block`, `get_array`, `Map::iter`) and the API-facing
shaping helpers in `block_service`, providing **pure, read-time, side-effect-
free** functions that other layers compose.

```text
            ┌─────────────────────────────────────────┐
            │  Handlers (api/blocks.rs, search.rs,    │
            │  discovery.rs, outlines.rs)             │
            └────────────────────┬────────────────────┘
                                 │
            ┌────────────────────▼────────────────────┐
            │  Shaping helpers (block_service.rs)     │
            │  - compute_ancestor_context             │
            │  - shape_search_hit                     │
            │  - get_blocks / get_block               │
            └────────────────────┬────────────────────┘
                                 │
            ┌────────────────────▼────────────────────┐
            │  PROJECTIONS LAYER (this doc)           │
            │  floatty_core::projections::            │
            │  - walk_ancestors  (THE walker)         │
            │  - walk_spec_to_markdown (FLO-633)      │
            │  - walk_generic_json_to_markdown        │
            └────────────────────┬────────────────────┘
                                 │
            ┌────────────────────▼────────────────────┐
            │  Y.Doc primitives (yrs::*)              │
            │  - blocks_map.get(&txn, id)             │
            │  - read_block_parent_id                 │
            └─────────────────────────────────────────┘
```

## What lives here today

| Module | Purpose | Source |
|---|---|---|
| `ancestor_walk` | THE canonical parent-chain walker (id-collecting, depth-capped, cycle-safe). Returns `AncestorWalk { ids, nearest_page, depth, termination }`. | [[PR #281]] |
| `walk_spec_to_markdown` | Door-block JSON spec → markdown projection (cached at the response layer). | FLO-633 |
| `walk_generic_json_to_markdown` | Last-resort generic JSON → markdown walker. Used when spec walker returns empty. | FLO-633 |

## When to add a new projection vs a new hook

The boundary is **read-time vs write-time**.

| Add a **projection** when | Add a **hook** when |
|---|---|
| The transform is read-time (response shaping). | The transform must run on Y.Doc mutation. |
| The output is computed from the Y.Doc state plus any indexes that already exist. | The output needs to update an index (Tantivy, PageNameIndex, InheritanceIndex). |
| The transform is pure (same inputs → same outputs). | The transform has side effects (writes to index, broadcasts WebSocket events). |
| Multiple endpoints want the same shape. | One write site needs the side effect. |
| You'd otherwise write the walk inline in 6 different handlers. | The work belongs in the hook system's async pipeline. |

**Concrete example.** PR 1 ([[PR #281]]) had two flavours of work in flight:

- **Projection candidate**: 6 inline ancestor-walk implementations across
  handlers, search composer, cycle detection, export, and Tantivy indexing.
  Single shape (id collection, depth cap, cycle termination), six call sites.
  → Promoted to `walk_ancestors` in `projections/ancestor_walk.rs`.
- **NOT a projection**: `InheritanceIndex` rebuild also walked ancestors,
  but it ALSO collected per-marker structured data, was on the hot path of
  every metadata mutation, and required a benchmark before consolidation.
  → Stays in `hooks/inheritance_index.rs` as a documented carve-out (will
  be revisited in a separate PR).

## Reference contract: `walk_ancestors`

```rust
pub fn walk_ancestors(
    lookup: &impl ParentLookup,
    block_id: &str,
    max_depth: usize,
    page_name_index: Option<&PageNameIndex>,
) -> AncestorWalk;

pub struct AncestorWalk {
    pub ids: Vec<String>,                        // nearest-first, depth-capped
    pub nearest_page: Option<(String, String)>,  // (block_id, page_name)
    pub depth: u32,
    pub termination: WalkTermination,            // Root | MaxDepth | Cycle
}
```

The walker is generic over a `ParentLookup` adapter so it can serve every
parent-resolution shape in the codebase from a single implementation. Three
adapters ship with the module:

| Adapter | Wraps | Use when |
|---|---|---|
| `YDocParentLookup<'a, T: ReadTxn>` | `(&MapRef, &T)` | The caller already holds a Y.Doc transaction (handlers, search composer, reparent cycle detection). Cheapest path. |
| `StoreParentLookup<'a>` | `&YDocStore` | The caller doesn't own a transaction (hooks like `tantivy_index::depth`). Each lookup acquires its own read txn under the hood. |
| `HashMapParentLookup<'a>` | `&HashMap<String, String>` | The caller has a pre-materialised `block_id → parent_id` map (export's single-pass scan). |

Tests use the `OwnedMapLookup` newtype pattern (in `ancestor_walk.rs` `#[cfg(test)]`) so synthetic fixtures don't need `Box::leak`.

**Programmatic contract**: `ids` are nearest-first. The walker terminates
on `Root`, `MaxDepth`, or `Cycle` and surfaces which via `termination` so
write-side callers (reparent, cycle detection) can reject corrupt mutations.

**Wire contract**: read-side callers (search hits, presence, blocks/:id)
project `ids` into rootmost-first order at the response boundary —
matches PR 1's `take(5).rev()` breadcrumb composer. The symmetry harness
in `floatty-server/tests/symmetry_ancestor_context.rs` asserts this for
every shaping helper that flows through `compute_ancestor_context`.

The split between programmatic and wire contracts is deliberate:
WalkTermination::Cycle would be unsoundly buried if the walker shipped
its output reversed; the projection layer keeps the source-of-truth
nearest-first and lets each consumer decide when to flip.

## Adding a new projection: checklist

1. **Verify it's read-time**, not a hook. (See table above.)
2. **Create the module** under `apps/floatty/src-tauri/floatty-core/src/projections/`.
3. **Use existing primitives.** For ancestor traversal, call
   `walk_ancestors` with a `ParentLookup` adapter (`YDocParentLookup`,
   `StoreParentLookup`, or `HashMapParentLookup`) — never write an inline
   `while let Some(parent) = ...` loop. For other reads, take
   `&yrs::MapRef` + `&T: ReadTxn` so the caller controls the transaction
   lifetime; never spawn your own.
4. **Document the contract in the docstring** — what the function returns,
   what cap (if any) it applies, what termination semantics it has.
5. **Write `#[cfg(test)] mod tests`** with deterministic Y.Doc fixtures.
   Use the `OwnedMapLookup` / `BlockMapBuilder`-style scaffolding established
   in `ancestor_walk.rs` rather than `Box::leak`.
6. **Update `.claude/rules/architecture.md`** — add the function to the
   canonical-paths table under "Use This / Not This."
7. **Update this doc** — name the new projection in the table above.
8. **Symmetry-check grep** — run
   `grep -rn 'fn.*ancestor\|while let Some(ref pid)' apps/floatty/src-tauri/ --include='*.rs'`
   (or the equivalent for your projection's shape) and confirm no
   parallel implementations exist. If they do, migrate them in the same PR.

## Hooks vs projections — historical synthesis

The codebase used to have ancestor walks scattered across the handler
layer: each one slightly different (depth caps of 10, 50, 1000, 1001;
cycle detection by visited-set, by depth-saturation, or absent entirely).
The fix wasn't "make hooks more powerful" — hooks are write-time and
side-effecting, which is the wrong primitive for "compose this read shape
across N handlers." It was "introduce a read-time projection layer."

Future contributors: when you reach for a fresh `while let Some(parent) = ...`
loop in a handler, that's a smell — either there's already a projection
that does what you need, or you're about to add the seventh head to the
hydra. The plan §"Why this beats the bundled single-PR plan" is the
explicit lesson; this layer is what makes that lesson recoverable.

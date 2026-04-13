# ADR-005: Search Index Is Ephemeral and Rebuilt on Startup

## Status
Accepted

## Context
Floatty treats the Y.Doc as the canonical source of truth.
The search index (Tantivy) is derived state maintained by hooks and indexing infrastructure.

Under current workloads, cold-start replay and rebuild costs are low enough that preserving the prior search index across restart provides little value relative to the risk of stale or incoherent derived state.

Observed startup costs at current scale:
- Y.Doc replay: ~411ms
- Store open: ~815ms
- Index rebuild: acceptable

## Decision
On startup, Floatty intentionally discards the existing search index and rebuilds it from the current Y.Doc state.

```
search_index::ephemeral
startup_policy::nuke_and_rebuild
truth_source::ydoc
revisit_when::cold_start_cost_visible
```

## Rationale
- Y.Doc is canonical; search index is disposable derived state
- Rebuild from truth is simpler and more trustworthy than validating prior index coherence
- Current rebuild cost is cheap enough that correctness wins over warm-start optimization
- Hook/index coherence is less trustworthy than Y.Doc truth — especially after hook lag or heavy write sessions

## Consequences

**Positive**:
- Avoids stale or divergent index state
- Simplifies startup correctness model
- Reduces need for repair / migration logic in derived search state

**Negative**:
- Search availability is delayed until rebuild completes
- Startup cost will grow with dataset size

## Revisit Conditions
Revisit this decision when:
- Cold start becomes perceptibly annoying to the user
- Search rebuild materially delays usability
- Replay / rebuild costs exceed acceptable thresholds
- Index schema / persistence strategy changes

## References
- `SEARCH_ARCHITECTURE_LAYERS.md` — "Y.Doc is truth, Tantivy is discovery"
- ADR-001: Outline Is Canonical
- ADR-002: Projections Are Not Source

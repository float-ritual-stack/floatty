# Multi-Outline Phase 1 — Code Review Summary

**Date**: 2026-04-07
**Branch**: `feat/multi-outline-phase1`
**Plan**: `~/.claude/plans/replicated-spinning-liskov.md`
**Scope**: 8 commits, ~1339 lines, 8 files
**Reviewers**: architecture-reviewer, code-reviewer, silent-failure-hunter (3 agents, parallel)

---

## Verdict: ALIGNED — no architecture bypasses

Phase 1 is structurally sound. FLO-317 path discipline is clean (injection, not hardcoded). Serde conventions correct. Y.Array mutations surgical. Lock discipline good. Test coverage solid on OutlineName validation.

The duplicate CRUD is explicitly documented Phase 1 debt that Phase 2 BlockService extraction resolves.

---

## Findings (9 total, prioritized)

### Fix Before Phase 2

| # | Severity | Finding | Location |
|---|----------|---------|----------|
| 1 | HIGH | **Tantivy dir not cleaned on delete** — `delete_outline` removes .sqlite but leaves .tantivy/ orphaned | outline_manager.rs:265-297 |
| 2 | HIGH | **IO/Store errors mapped to 400 not 500** — catch-all `_` arms in error handlers map server-side IO errors to `InvalidRequest(400)` | api.rs:3781, 3800, 3846 |
| 3 | HIGH | **OnceLock panic risk** — `hook_system()` uses `get_or_init` with no error handling; if `HookSystem::initialize_at` panics, OnceLock poisons permanently | outline_manager.rs:43-51 |
| 4 | MED | **AlreadyExists → 400 not 409** — should be 409 Conflict; needs `ApiError::Conflict` variant | api.rs:3794-3802 |

### Phase 2 Hardening

| # | Severity | Finding | Location |
|---|----------|---------|----------|
| 5 | MED | **`flush()` discards errors silently** — `let _ = writer.try_send_commit()` with no logging | outline_manager.rs:54-59 |
| 6 | MED | **No `flush()` before delete** — pending search commits lost when outline deleted | outline_manager.rs:265-297 |
| 7 | MED | **Write lock held across `YDocStore::open`** — blocking IO under RwLock write guard; fine for single user, trap for concurrent access | outline_manager.rs:155-188 |

### Minor

| # | Severity | Finding | Location |
|---|----------|---------|----------|
| 8 | MED | **No-op CRDT update on empty PATCH** — `{}` body still writes `updatedAt`, creating unnecessary Y.Doc history | api.rs:4247-4265 |
| 9 | LOW | **"default" readable via outline routes** — `GET /outlines/default/blocks` works but without hook enrichment, silently different from `GET /blocks` | api.rs:3837 |

---

## Suggested Fixes (quick wins for items 1-4)

### 1. Tantivy cleanup on delete

```rust
// In delete_outline, after SQLite file removal:
let tantivy_dir = self.outlines_dir.join(format!("{}.tantivy", name));
if tantivy_dir.exists() {
    if let Err(e) = std::fs::remove_dir_all(&tantivy_dir) {
        warn!("Failed to remove Tantivy index {:?}: {}", tantivy_dir, e);
    }
}
```

### 2. IO/Store errors → 500

Add `ApiError::Internal(String)` variant mapping to 500. Change catch-all `_` arms from `InvalidRequest` to `Internal`.

### 3. OnceLock panic safety

Either:
- Convert `hook_system()` to return `Result<&Arc<HookSystem>, OutlineError>`
- Or use `OnceLock<Result<Arc<HookSystem>, ...>>` so failed init is recorded without poisoning

### 4. AlreadyExists → 409

Add `ApiError::Conflict(String)` variant. Map `OutlineError::AlreadyExists` to it.

---

## Architecture Notes for Phase 2

- `resolve_outline` returns `Arc<YDocStore>`, not `Arc<OutlineContext>` — Phase 1 mutation handlers never call `hook_system()`, so hooks don't fire for non-default outlines. Phase 2 must rewire through OutlineContext.
- Delete ordering should swap: remove from cache FIRST, then delete files (in-flight Arc holders still work via Unix fd semantics).
- `reject_default_mutation` guard is correct Phase 1 scaffolding — Phase 2 BlockService removes it entirely.
- Response shape divergence: outline `GET /blocks/:id` returns raw `serde_json::Value` vs legacy's typed `BlockWithContextResponse`. Phase 2 BlockService unifies this.

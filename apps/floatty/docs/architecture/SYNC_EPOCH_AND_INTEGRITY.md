# Sync Integrity: Doc Epoch, Applied Watermark, Orphan Recovery

**Status**: SHIPPED (2026-07 — [[PR #324]], [[PR #326]], [[PR #327]] on the quirk-audit integration branch)
**Origin**: quirk-audit 2026-07-09 §3 (`docs/audits/2026-07-09-quirk-audit.md`) — four
confirmed resurrection/data-loss holes, closed as prerequisites for the
offline/fast-boot rewrite (`docs/design/2026-06-26-offline-and-fast-boot.md`).

## Doc epoch (lineage tracking)

Every destructive server restore bumps a persisted **doc epoch**
(`sync_meta` table, `persistence.rs::reset_with_snapshot` — one SQLite
transaction covering delete + snapshot + compaction boundary + epoch bump).

The epoch rides:
- `GET /state`, `GET /state/hash`, `GET /updates` responses
- WS restore frames (`broadcast_restore`: data + epoch, no seq)
- WS heartbeats (every 30s)

**Client contract — adopt, never merge**: on any epoch mismatch (restore frame,
heartbeat, resync pre-check) the client hard-resets: drop pending updates, clear
the stale-lineage IndexedDB backup + seq baseline, persist the new epoch,
`location.reload()`. CRDT-merging a restored state into the old doc (the
pre-2026-07 behavior) preserved locally-known deleted content and pushed it back
on the next resync — the resurrection bug.

**Fail-closed pushes**: resync and boot-reconcile pushes require positive lineage
verification — known-matching epoch, or a server that has never restored
(epoch 0). Verification failure → pull-only, backup preserved.

## Applied watermark (latestSeq semantics)

`GET /state`'s `latestSeq` is the seq of the last update **applied to the
returned snapshot** (`store.last_applied_seq`, advanced under the doc write
guard, read under the same guard as the encode). It is NOT persistence
`MAX(id)` — persist-first ordering means the log can briefly run ahead of the
in-memory doc, and reporting log-max let a client baseline past an update its
snapshot didn't contain (permanently skipped). `GET /updates`' `latestSeq`
intentionally stays log-max (pagination bound; safe direction).

**Degraded replay**: if startup replay hits a corrupt update, the watermark
freezes at the last seq before the failure (subsequent writes don't advance it)
until a reset starts a fresh lineage — clients re-fetch across the gap;
re-apply is idempotent.

**Write barrier**: `store.write_lock` serializes apply_update / persist_update /
reset_from_state / force_compact critical sections (a reset can no longer slice
between an update's SQLite append and its in-memory apply). Known limitation:
local mutate→persist call sites in `block_service` mutate the doc BEFORE
`persist_update` — that window is documented on `persist_update` and tracked
for a follow-up unit.

## Offline boot-from-backup

Boot flags are honest (`appliedServerState` / `localDiffComputed` — see
`useSyncedYDoc.ts` loadInitialState): the backup is cleared ONLY when server
state was applied and local changes are known-pushed/absent. If the server is
unreachable at boot and a backup exists, the client **hydrates from the backup**
(offline boot, backup preserved, reconciles on next connect) instead of
presenting an empty doc. This is the first shipped piece of the
offline/fast-boot boot-from-cache design.

## Orphan recovery (the sweep no longer deletes)

`deduplicateChildIds` (startup + post-resync) reattaches content-bearing
orphans under a `recovered::` recovery root (well-known id
`00000000-0000-4000-8000-f10a77000001` — concurrent sweeps converge) instead of
hard-deleting them. Orphans are subtree roots by construction, so the whole
subtree survives. Only empty shells (no content, no children) are deleted.
Strays appear collapsed at the outline bottom for review — visible and undoable.

This is the **sole** tree-integrity authority. A second, older system once ran
beside it — the Rust `orphan_detector` background worker (30s + hourly) →
`orphans-detected` event → `quarantineOrphans`, which minted a fresh
random-UUID `orphaned-blocks::<timestamp>` container **per client per run**. In
multi-client remote-authority mode that manufactured the cross-parent
duplication this sweep then had to clean up (its random roots violated exactly
the "fixed, not random, runs on every client" reasoning above). It was retired
in **FLO-920** (2026-08-21); `deduplicateChildIds` with its one fixed
`RECOVERY_ROOT_ID` is what remains. Any `orphaned-blocks::<timestamp>` root
still present in an old outline is historical debris.

## See also

- `.claude/rules/ydoc-patterns.md` — CRDT ground rules
- `.claude/rules/architecture.md` §Sequence Number — gap detection / heartbeat chain
- `docs/audits/2026-07-09-quirk-audit.md` §3 — the holes this closes + must-not-break list

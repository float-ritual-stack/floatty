# ADR-007: Local Y.Doc as durable boot cache + offline mode

## Status

Proposed → Accepted when Phase 1 verifies against the real outline
(~14k blocks, remote authority). Status label: **experimental** until then.

Design detail lives in [[2026-06-26-offline-and-fast-boot]]
(`apps/floatty/docs/design/`) — this ADR records the architecture-shape
decisions and the rollback story; it does not duplicate the design.

## Context

Remote-authority mode ([[FLO-762]]) is the daily driver: floatty-server on
float-box, both Macs as thin clients. Measured (2026-06-26, 14,237 blocks):
cold start **~104 s** end-to-end, of which network is only ~26 s — ~78 s is
client-side decode + `Y.applyUpdate` of the full 31 MB doc + store
materialization. float-box unreachable = the app refuses to start
(split-brain guard `server.rs:408` — correct instinct, fatal result).
Meanwhile the IndexedDB backup is written ~24.8 MB dozens of times a day and
**ignored on boot** (cleared on sync): the data the fast path needs is paid
for and discarded.

The sync-integrity prerequisites shipped in v0.19.0 (doc epoch, paired
`latestSeq`, orphan reattach, atomic `reset_from_state`) — this ADR builds on
them.

## Decision

1. **The local Y.Doc is the durable thing the client boots from.** Boot:
   hydrate from IndexedDB → render immediately → reconcile with the server
   in the background. Adopt **y-indexeddb** (O(delta) writes) in place of the
   bespoke snapshot `idbBackup`; stop `clearBackup()`-on-sync
   (`useSyncedYDoc.ts:976`). The durable local doc doubles as the offline
   outbox.
2. **One `reconcile()` primitive.** Phase 0 extracts ONE primitive before any
   behavior change, so offline becomes a call site rather than a fourth
   variant.

   **Correction (Phase 0 implementation, 2026-07-12): it was a duplicate, not
   a triplicate.** Only two sites are push-before-pull state-vector
   reconciles — `triggerFullResync` (diff source: the live doc) and the
   `loadInitialState` backup path (diff source: the IDB snapshot, because at
   boot the live doc is still empty). The third site, reconnect in
   `connectWebSocket` onopen, is **not a state-vector reconcile at all**: its
   "push" is a flush of the pending-update *queue* and its "pull" is a
   seq-incremental catch-up. Forcing it through the primitive would re-push a
   diff it already sent. It shares only the pull step and now takes exactly
   that (`pullServerState`). Line citations in earlier drafts (`:378`,
   `:1174`, `:1864`) were all stale; see the Phase 0 commit for the real ones.
3. **New endpoint `POST /api/v1/state-diff`** `{stateVector}` →
   `{update, latestSeq}` — state-vector pull that survives compaction
   (unlike `/updates?after=N`). `latestSeq` MUST be captured under the same
   read guard as the encode (the sync-integrity pairing lesson).
4. **Offline = serverless client, never a local server spawn.** The
   split-brain guard stays; unreachable-remote becomes an offline UI state
   (`offline`/`reconnecting` on the status pill) with a health-poll
   reconnect loop, not a startup failure and not a fork.
5. **Conflict policy: LWW + visible conflict surface** ([[FLO-623]]).
   Y.Text positional ops deferred.
6. **Cache-trust rule (the one data-loss path):** the local cache may only
   be nuked when `server reachable && no pending local-only diff`. Never
   nuke while offline. Epoch mismatch (v0.19.0 machinery) still hard-resets
   — adopt, never merge.

## Phasing

Phase 0 foundation (no user-visible change): reconcile() extraction + seams
+ Rust `{remoteConfigured, reachable}` contract + `/state-diff`. **Landed
2026-07-12** — `reconcile()` / `pullServerState()` / `isLocalCacheRedundant()`
in `useSyncedYDoc.ts`, `POST /api/v1/state-diff`, `resolve_server` +
`get_server_status`. The transport/persistence seam (design §B) was NOT part
of it and remains open.
Phase 1 fast boot: y-indexeddb + durable IDB + boot-from-cache + diff-on-boot.
Phase 2 offline: offline mode + reconnect loop + status states.

Expectation honesty: Phase 1 delivers render-in-<1s with background
reconcile; the ~78 s apply cost persists until the Y.Doc history-size lever
(server-side compaction) is pulled — that is a separate, later decision.

## Consequences

- Boot becomes cache-first; the full-fetch path remains as the cold-cache
  fallback (first boot, post-epoch-reset).
- `useSyncedYDoc.ts` gets structurally smaller before it gets smarter —
  which is also why revamp P1 (path addressing) waits for Phase 0
  ([[2026-07-12-revamp-spine]] §7: `reconcilePageTwins` lives in this file).
- New failure surface: stale-cache-vs-epoch interactions — covered by the
  v0.19.0 epoch adoption (hard reset on mismatch, skip-push resync).

## Rollback

Additive at every step. Phase 1 rollback = boot flag back to full-fetch
(current path retained); y-indexeddb rollback = re-enable snapshot backup +
clear-on-sync; `/state-diff` is a new endpoint with no consumers outside the
boot path. No storage migration — IDB namespace versioning covers format
change. If Phase 1 proves wrong on the real outline, delete the boot branch
of the flow and the app behaves exactly as v0.20.0.

## Bar to revisit

Pull the history-compaction lever (the 78 s) only after instrumenting the
applyUpdate-vs-store-materialization split on a real boot — the design doc
flags this measurement as the gate between history-GC and virtualization.

## See also

[[2026-06-26-offline-and-fast-boot]] · [[2026-07-12-revamp-spine]] §7 ·
[[FLO-762]] [[FLO-764]] [[FLO-623]] · ADR-006 (process precedent:
architecture-shape → ADR + integration branch before mainline)

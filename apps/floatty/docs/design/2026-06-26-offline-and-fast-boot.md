---
title: Offline support + fast boot (local Y.Doc as durable cache, diff-on-boot)
date: 2026-06-26
status: proposed
related: "[[FLO-762]] [[FLO-186]] [[FLO-152]] [[FLO-387]]"
architecture-shape: true   # new storage topology + new API surface → ADR + integration branch (see .claude/rules/integration-branch-discipline.md)
---

# Offline support + fast boot

## The one-sentence version

Today the client treats its local Y.Doc as disposable scratch: full-refetch on
boot, clear-on-sync. Treat it as the **durable thing the client boots from**, and
two problems collapse into one fix — cold start goes from ~26 s to ~1 s, **and**
float-box being unreachable stops being fatal.

## Problem (measured 2026-06-26, float-box v0.17.0, 14,237 blocks)

Remote-authority mode ([[FLO-762]]) is now the daily driver — `floatty-server`
runs on float-box, both laptop and mac mini connect as thin clients. Two
consequences:

| Symptom | Measured | Cause |
|---|---|---|
| Slow cold start, every launch, both machines | **~104 s end-to-end** (on-device, mac mini, 2026-06-26: `httpClient Connected 23:25:49.512` → `Initial load complete 23:27:33.753`, 14,237 blocks). Raw `/state` transfer is only ~26 s of that (curl). | Client refetches the **entire** Y.Doc: `encode_state_as_update_v1(StateVector::default())` (`sync.rs:169`), no client cache consulted (`useSyncedYDoc.ts:1631`). **~¾ of the 104 s is client-side** decode + `Y.applyUpdate` of the full 31 MB CRDT doc + materializing 14k blocks into the SolidJS store — NOT network. |
| float-box down = floatty won't open at all | n/a (but observed: ~53 min float-box outage 00:39–01:32, repeated `SyncHealth Health check failed: Load failed` + `Orphan check: failed to fetch blocks`) | Split-brain guard refuses to start rather than fork a local outline (`server.rs:408`). Correct instinct, fatal result for a daily-driver tool. |

**On-device evidence (2026-06-26 mac mini log):**
- The IDB cache is **written ~24.8 MB dozens of times/day** (`idbBackup Saved backup: 24,8xx,xxx bytes`) — validates decision D's O(docsize)-per-save problem — then **ignored on boot** (no `Loaded backup` line; full 104 s fetch instead, because clear-on-sync + the version-upgrade IDB migration wiped it). The data the fast path needs is being paid for and discarded.
- **Network is only ~¼ of the cost.** Boot-from-cache kills the ~26 s network and stops re-applying the full doc, but the ~78 s client-side processing remains until separately addressed. **Realistic Phase 1: 104 s → ~70–80 s, not ~1 s** — unless paired with the lever below.
- **Y.Doc history compaction promoted from "secondary."** 31 MB / 14k blocks ≈ 1.8 KB/block ⇒ heavy accumulated CRDT history, which drives the `applyUpdate` cost (most of the 78 s). **Action before optimizing: instrument the 78 s split** (applyUpdate vs store materialization) to decide history-GC vs block-virtualization.
- **Version skew:** app `0.18.0` vs float-box server `0.17.0` — update float-box to match.

Reference point: `GET /api/v1/state-vector` is **7.4 KB / 0.29 s**. A diff-on-boot
path transfers the state-vector + only the delta — ~1000× smaller in the common
"I was away an hour" case.

The 31 MB / 14k-block ratio (~2.3 KB/block) also implies the Y.Doc carries
substantial accumulated CRDT history; **server-side history compaction** is a
separate, smaller lever (see Considerations §9).

## What already exists vs what's missing

The CRDT plumbing the intuition expects is **mostly built**:

| Capability | Status | Where |
|---|---|---|
| Client-side Y.Doc in IndexedDB | ✅ but snapshot-only, cleared on sync | `lib/idbBackup.ts` |
| Bidirectional merge (push local diff, pull server) | ✅ | `triggerFullResync()` `useSyncedYDoc.ts:378` |
| Reconnect buffering of in-flight edits | ✅ | [[FLO-152]] `useSyncedYDoc.ts:1174` |
| Keep editing while WS down (queue + backoff) | ✅ | `useSyncedYDoc.ts:525` |
| State-vector push (client computes its diff vs server vector) | ✅ | `Y.encodeStateAsUpdate(doc, serverSV)` |
| **State-vector pull (server returns only what client lacks)** | ❌ **missing** | only `/state` (full) or `/updates?after=N` (seq, fragile) |
| **Boot-from-cache then diff** | ❌ missing | boot always full-fetches |
| **Remote-unreachable → offline mode** (not refuse-to-start) | ❌ missing | `server.rs:408` returns `None` → app fails |
| **Durable local doc** (don't clear on sync) | ❌ missing | `clearBackup()` on sync `useSyncedYDoc.ts:976` |
| Offline UI state | ❌ missing | only `pending`/`synced`/`error` |

## Proposed design

### 1. New server endpoint — state-vector pull diff (the missing primitive)

```
POST /api/v1/state-diff   { stateVector: "<base64 client SV>" }
  → { update: "<base64 of encode_state_as_update_v1(serverDoc, clientSV)>", latestSeq }
```

This is the symmetric partner of the existing push. It is the **robust** pull
because it diffs against actual doc state, not the seq log — so it **survives
compaction** (unlike `/updates?after=N`, which 404s once float-box compacts past
the client's last seq and forces a full 31 MB refetch). Read-only, no Y.Doc
mutation, cacheable by `(clientSV hash)`.

### 2. Unified boot flow (replaces the full-fetch happy path)

```
boot:
  hydrate doc from IndexedDB cache         (instant — no network)
  render outline immediately               (user is working in <1s)
  if server reachable:
      reconcile(doc, server)               (background, non-blocking)
  else:
      enter OFFLINE mode                    (serverless; see §4)
```

`reconcile` is the single primitive (see Pre-refactoring §A):

```
reconcile(doc, server):
  serverSV   = server.getStateVector()                 # 7 KB
  localDiff  = Y.encodeStateAsUpdate(doc, serverSV)
  if localDiff is non-trivial: server.applyUpdate(localDiff)   # PUSH (mine first)
  { update } = server.stateDiff(Y.encodeStateVector(doc))      # PULL (only what I lack)
  Y.applyUpdate(doc, update, 'reconnect-authority')
  persist doc to cache
```

Push-before-pull ordering is mandatory (else local-only edits get masked by the
merge) — already the rule in `triggerFullResync`.

### 3. IndexedDB becomes durable (stop clearing on sync)

- Remove the `clearBackup()`-on-sync call. The local doc is **always** the current
  persisted state, server-slug-namespaced exactly as today ([[FLO-762]] isolation
  preserved — see `deriveServerSlug` / `initBackupNamespace`).
- Persist **committed** Y.Doc state at the **blur/structural boundary** (matches
  [[FLO-387]] — the only times the Y.Doc actually moves). Under decision D this is
  automatic: y-indexeddb appends one record per committed transaction, so committed
  blocks are durable at blur. **Do NOT** add a `beforeunload`/`visibilitychange`
  flush-commit of the DOM composing buffer — that was over-built; it guards an
  accepted loss (below).
- **Durability scope (honest).** Committed edits are never lost. The **one**
  unprotected surface is the DOM composing buffer of the block *under the cursor*:
  content doesn't enter the Y.Doc until commit ([[FLO-387]] composing-vs-committed
  split), so it sits outside the CRDT *and* every storage engine. A sudden close
  before blur loses that single in-flight block — a word to a few lines. **Accepted
  tradeoff**: blocks are small and focused, so it's a reflexive retype, not the
  document. This is *why* the `beforeunload` flush is dropped, not just deferred.
- Consequence the design leans on: **the durable local doc IS the outbox.** No
  separate persisted pending-update queue is needed — un-pushed edits live in the
  cached doc and surface as a state-vector diff on next reconcile. (This is also why
  §7's cache-nuke recovery is a data-loss path that must be gated.)

### 4. Offline mode = serverless client, NOT a local spawn

Critical constraint from the split-brain guard: offline mode must **not** spawn a
local `floatty-server`. That would create a second outline — the exact fork
`server.rs:408` exists to prevent. Offline mode is the *same* client Y.Doc running
with no transport: edits go to doc + cache, a reconnect loop polls
`GET /api/v1/health` on a backoff, and on success runs `reconcile` against the
**same** float-box. (Requires the Rust contract change in Pre-refactoring §C so
"remote configured but unreachable" is a startable state, not a hard error.)

### 5. Status states + UI

Extend `syncStatus` with `offline` and `reconnecting`. Minimal UI: a status pill
(`offline — editing locally`, `reconnecting…`, `synced N changes`). Color-only is
insufficient per the accessibility baseline — pair with text/icon.

## Considerations & risks (the "what am I missing")

1. **Conflict policy — DECIDED: LWW default + visible conflict surface** (was the
   open question; resolved by usage). Blocks here are discrete and small (a word to
   a few paragraphs), edited in focused bursts — not a Google-Doc where the whole
   doc is "in edit mode" — so same-block cross-machine collisions are rare. LWW
   stays the silent default. **Y.Text (character-level auto-merge) is deferred**;
   the existing `conflict-detected` diagnostic logs measure collision frequency and
   tell us empirically if it's ever worth the (large) migration.

   The safety net for the rare real collision is a **visible conflict surface with
   manual apply** — already filed as [[FLO-623]], with detection plumbing built
   under [[FLO-387]]:
   - **Detection (live case, exists):** `contentAtFocus` snapshot + `onConflictDetected`
     hook (`useContentSync.ts:180`, `:222-238`) fire when a remote update lands on a
     block during focus.
   - **Detection (offline case, falls out of reconcile):** the conflict set is the
     **intersection of (blocks in my push-diff) ∩ (blocks in the server's pull-diff)**
     — both already computed during `reconcile`. No separate common-ancestor snapshot
     needed. For each intersection block, capture `mine` + `theirs` *before* applying
     the merge.
   - **Preserve the loser (the gap to close):** today LWW overwrites the losing
     version and it's gone. Store it in a **CRDT-synced `conflicts` Y.Map** keyed by
     block id (`{ mine, theirs, at }`) so the conflict surfaces on whichever machine
     opens next and resolving on one clears it everywhere.
   - **Surface + apply:** a `[conflict]` marker on the block (fits the existing
     pill/marker render path) opens both versions with **Keep mine / Keep theirs /
     Keep both → split into two sibling blocks**. "Keep both" is the recommended
     default — outliner-native, lossless, turns a merge conflict into two blocks
     reconciled by hand rather than a merge editor.

   Scope note: the live-conflict UI ([[FLO-623]]) can ship independently of offline;
   the offline-conflict detection rides on Phase 2's reconcile path.

2. **Two machines offline simultaneously.** Laptop and mac mini both editing
   offline against the same authority is normal CRDT — each pushes its own
   state-vector diff on reconnect, all three merge. Eventual consistency holds, but
   **intermediate states can look surprising** (whoever reconnects second briefly
   sees only their own + float-box's changes before the third party lands). Worth a
   note in UI, not a blocker.

3. **Delete vs edit across the offline gap.** If one machine deletes a block while
   another edits it offline, Y.Map merge can resurrect the key or leave an orphan
   (block exists, not in any `childIds`). `deduplicateChildIds()` and orphan
   handling already exist; offline makes them load-bearing. **Add explicit
   orphan-sweep on post-reconnect** and test the add-wins/remove-wins behavior.

4. **Compaction window.** float-box compacts every 100 updates
   (`COMPACT_THRESHOLD` = `store.rs:54`). **Compaction is lossless** — `compact()`
   (`persistence.rs:236`) replaces the N individual updates with one snapshot of the
   full Y.Doc state and records `compacted_through`. The cost is only catch-up
   *expense*, never data loss: a client requesting `/updates?since=N` with
   `N < compacted_through` gets `UpdatesCompacted` (`sync.rs:377`) → falls back to a
   full `GET /api/v1/state` (31 MB / 26 s). 100 is **low for an active two-machine
   workflow** — a normal session crosses it, so the closed laptop routinely
   full-resyncs.

   - **Stopgap = a bridge until Phase 0, NOT a parallel fix.** Raising
     `COMPACT_THRESHOLD` (100 → 500/1000) widens the seq-catch-up window — pure storage
     optimization, no correctness risk. But once `/state-diff` lands in Phase 0 and
     clients stop using `/updates?since=N`, a higher threshold buys *clients* nothing;
     it then only governs float-box's own restart-replay cost. So: need relief now and
     Phase 0 is weeks out → bump it; Phase 0 is close → skip it (D's seq-deprecation
     retires this lever for clients anyway). Same lever at two times as D's
     `lastContiguousSeq` retirement, not a competing option.
   - **Real fix:** the `/state-diff` endpoint (§1) diffs against doc state, not the
     seq log, so it **survives any amount of compaction** — a client N updates behind
     gets exactly its delta regardless. This removes the seq-window constraint
     entirely and is **the main reason to build the pull-diff endpoint rather than
     lean on the seq path** or chase a higher threshold.
   - **Verified:** the `sh::` path batches. `commandDoor.ts:113` → `insertParsedBlocks`
     → `batchCreateBlocksInside` ([[FLO-322]]), so a structured `sh:: cat` is ~3–4 seqs
     (placeholder create + content set + delete + **one** batch insert for the whole
     tree), not one-per-block. A single big cat does **not** blow the window — aggregate
     session volume across many small edits while the other machine is closed is the
     real driver.

5. **Offline = degraded feature set, not full parity.** Search (Tantivy), ctx::
   aggregation, semantic endpoints, and any MCP/agent writes all live **server-side
   on float-box**. Offline, the outliner works from cache but **search and ctx go
   dark**. Set expectations in UI; don't promise full offline parity.

6. **Terminals are unaffected.** PTYs are spawned locally by Tauri, independent of
   float-box — offline does not kill terminal tabs. (Confirm this stays true; it's
   a nice property to advertise.)

7. **Cache trust / corruption — ⚠ contains a data-loss path (resolve BEFORE the
   Phase 2 branch).** Booting from cache adds stale/corrupt-IDB as a failure mode; the
   recovery is "nuke cache + full resync." But because the durable cache **is** the
   outbox (§3), nuking it while un-pushed offline edits exist **destroys them**. So
   the nuke must be gated on **`server reachable && no pending local-only diff`**:
   compute the local→server state-vector diff first; non-empty → push it before any
   nuke, else refuse. **Never nuke while offline.** Plus a cheap validity check
   (block-count sanity, decode guard) and a `GET /api/v1/state/hash` compare once
   online. This is the **one item in the doc that's a data-loss path** rather than a
   design preference — gate it before the offline branch, not during.

8. **`restore` (nuclear replace) interaction.** If float-box's doc is replaced via
   `/api/v1/restore`, a client's cache is a divergent history. Detect via a **server
   epoch id** — a counter bumped on every `/restore`, returned in the health/state
   response. Client stores its last-seen epoch; a mismatch is a **one-int compare** →
   drop local cache + full-resync, don't merge the stale fork. Preferred over the
   original "hash mismatch + unexpectedly large pull" heuristic (fuzzy). Cheap: one
   `sync_meta` row + one response field.

9. **Y.Doc history size (PRIMARY lever — promoted by on-device measurement).** 31 MB
   for 14k blocks (~1.8 KB/block) is accumulated update history, and that drives the
   ~78 s client-side `applyUpdate` cost that dominates startup (see Problem). Server-side
   compaction/GC shrinks the full-fetch, every `/state-diff`, *and* the per-launch
   apply. Distinct from the seq-window (§4, threshold-driven) — this is tombstone/
   history-driven. File separately, but it's not optional for the real startup win.

## Pre-refactoring (do these first; foundation before feature)

Per the project's refactor-first / foundation-then-feature discipline, the change
is much smaller if these land first as independent, low-risk PRs:

- **A — Extract one `reconcile()` primitive.** Today the "push my diff, pull
  theirs, apply" logic is implemented **three times** with subtle differences:
  `triggerFullResync` (`:378`, server-vector source, full pull), `loadInitialState`
  backup path (`:1555`, `Y.diffUpdate(backup, SV)` source, full pull), and reconnect
  (`:1174`, seq-incremental pull, falls back to resync). This is the hydra. Collapse
  to one function parameterized by `{ diffSource, pullStrategy }`. **No behavior
  change**, independently shippable, makes offline a *call site* not a 4th variant.

- **B — Seam: transport / persistence / doc.** `useSyncedYDoc.ts` mixes HTTP+WS
  transport, IDB persistence, and doc state in one ~1600-line hook with module-level
  shared mutables. Pull a `RemoteSync` (transport) and `LocalStore` (IDB) seam so
  offline = "RemoteSync absent" instead of `if (online)` sprinkled everywhere.

- **C — Rust unreachable-contract change.** `get_server_info` / `connect_remote_server`
  currently collapse "unreachable" into an error that fails the frontend. Return a
  structured `{ remoteConfigured: true, reachable: false }` so the **frontend** owns
  the offline decision (it has the cache; Rust doesn't). Still no local spawn —
  split-brain guard intact.

- **D — DECIDED: adopt y-indexeddb.** Purely the local-cache mechanism — orthogonal
  to the reconcile/transport design.

  | | bespoke `idbBackup` | `y-indexeddb` |
  |---|---|---|
  | Storage | one full snapshot (`'current'`) | incremental log + lazy trim (~500) |
  | Write/save | **O(whole doc)** — rewrites ~24 MB each backup | **O(delta)** — appends the update only |
  | Hydrate | manual, crash-path only today | automatic on construct (`whenSynced`) |
  | When it writes | debounced full-snapshot; cleared on sync | per committed txn ([[FLO-387]] boundary); kept |
  | Seq side-data | in same store | doc-only → separate store (or deprecate, see below) |
  | Namespace | DB name + legacy migrations | DB name via `docName` |
  | Maintenance | ~250 lines owned | delete most; Yjs-maintained |

  **Decisive argument — write *size*, not write *frequency*.** The bespoke path
  rewrites the entire ~24 MB binary snapshot on every debounced backup *regardless of
  how little changed* (on-device: `idbBackup Saved backup: 24.8 MB` dozens of
  times/day, 2026-06-26 log). y-indexeddb appends only the delta. [[FLO-387]]'s
  boundary-gating already cut write *frequency* (commits at blur, not per keystroke) —
  the remaining cost is per-commit write *size*, which O(delta) fixes. The two
  decisions reinforce: boundary-gated commits are *why* "append per update" is cheap
  (no per-keystroke append to begin with).

  **NOT a durability argument (correcting an earlier take).** y-indexeddb's
  "continuous, persist-every-update" pitch does **not** apply to floatty's model:
  content enters the Y.Doc only at commit ([[FLO-387]] composing-vs-committed split),
  so between commits there's nothing to persist — continuous persistence buys zero
  extra content durability. The honest case is exactly **(a) O(delta) writes** and
  **(b) instant hydrate-from-log + deleting most of the bespoke code**. Neither
  touches durability; the in-flight composing buffer is an accepted loss either way
  (Design §3).

  **Compensations (both small):** (a) `docName = floatty-{build}|{ws}|{slug}` ports
  `deriveServerSlug` directly; (b) `lastContiguousSeq` moves to a tiny separate store
  — or is **deprecated outright**, since the §1 `/state-diff` (state-vector) catch-up
  removes the seq-based path. Adopting y-indexeddb and retiring seq-catch-up pair
  naturally.

  **Costs / precautions:** the bespoke code encodes incident lessons (2026-01-23
  localStorage 5 MB data-loss, [[FLO-762]] slug isolation, [[ADR-006]] legacy-DB
  cleanup) — re-validate against the provider. One-time migration: simplest is to let
  the first post-adoption launch full-sync from float-box (one 26 s hit/machine) to
  seed y-indexeddb. Tests need `fake-indexeddb`. **Per read-source-not-docs: confirm
  y-indexeddb's trim/hydrate/doc-only behavior against its actual source before
  building** (small single-file package). Decision feeds §3.

`/state-diff` (Design §1) is new feature code, not refactor, but is a prerequisite
for the diff-on-boot pull — land it in the foundation set.

## Suggested staging

1. **Phase 0 (foundation):** A + B + C + the `/state-diff` endpoint. No user-visible
   change; every surface stays green.
2. **Phase 1 (fast boot):** adopt y-indexeddb (D) + durable IDB + boot-from-cache +
   diff-on-boot. Kills the ~26 s network refetch and stops re-applying the full doc
   each launch — **104 s → ~70-80 s** (the remaining client-side `applyUpdate` +
   materialize cost needs the history-compaction lever; see Problem + §9). No offline
   mode yet; validates cache-as-truth under normal (online) use. **Instrument the
   ~78 s client-side split before fixing it** — measuring already corrected one
   inferred target.
3. **Phase 2 (offline):** offline-mode branch + reconnect loop + UI states + orphan
   sweep + cache-validity/recovery. Builds on a Phase-1 model already proven online.

This ordering means the highest-value, lowest-risk piece (fast boot) ships first and
de-risks the offline work, rather than betting everything on a big offline PR.

## Open decisions (need Evan)

1. ~~Conflict policy~~ — **DECIDED**: LWW default + visible conflict surface ([[FLO-623]]),
   Y.Text deferred. See Considerations §1.
2. ~~D — idbBackup vs y-indexeddb~~ — **DECIDED**: adopt y-indexeddb (O(delta) writes +
   hydrate-speed + code deletion; explicitly NOT durability). See Pre-refactoring D.
3. **Scope appetite** (only one still open): Phase 1 only (fast boot, online) — or
   commit to Phase 2 (full offline) now?

## Process note

This is architecture-shape (new storage topology + new API surface). Per
`.claude/rules/integration-branch-discipline.md` it warrants an **ADR** and an
**integration branch**, not direct-to-main. This doc is the pre-ADR sketch.

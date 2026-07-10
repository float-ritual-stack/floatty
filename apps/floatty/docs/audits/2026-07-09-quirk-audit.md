# Floatty Audit Synthesis — origin/main @ 88788ee

## 1. Executive summary

Twenty-three confirmed findings collapse into six mechanisms, and every long-standing "quirk" now has a traced root cause. The empty-page dead-end (Enter does nothing on a blank zoomed page, recovers on re-navigation) is a missing zoom-root guard in `determineKeyAction` — Enter creates invisible siblings inside the `pages::` container (`useBlockInput.ts:218-246`), and no delete path restores the typeable-child invariant that zoom-entry establishes. "Copy grabbed the whole block" is a deterministic collision: shift+click text extension also block-selects (`BlockItem.tsx:850-862`) and Cmd+C intercepts on `selected.size > 0` alone (`Outliner.tsx:279`). "Text I typed disappeared" is the CE/store decoupling family — a non-reactive `contentRef` plus the `shouldSync` gate leaves remounted or paste-target editors empty while the store holds real content, so the next keystroke silently overwrites it (`useContentSync.ts:337`, `BlockOutputView.tsx:168-171`). Duplicate daily notes are the PageNameIndex hook-lag window plus zero uniqueness enforcement at any layer, with split-brain resolution (frontend first-match vs server LWW) making the twins diverge silently. Most consequentially for the offline/fast-boot rewrite: the sync layer has four independent resurrection/data-loss holes — restore-is-merged-not-adopted (`useSyncedYDoc.ts:810-833`), the `latestSeq`/encode pairing race (`sync.rs:160-190`), the orphan sweep that hard-deletes user content the design doc leans on as a "safety net" (`useSyncedYDoc.ts:259-345`), and a backup-reconcile path that clears the backup and marks the app loaded with an empty doc (`useSyncedYDoc.ts:1621-1648`). The rewrite cannot proceed on top of these; they are its prerequisites, not its cleanup list.

## 2. Root-cause clusters

### A. Zoom scope has no insertion/deletion invariant — the empty-page dead-end
Findings: Enter-on-childless-zoom-root (`useBlockInput.ts:245`); delete paths park focus with no child recreation (`useBlockOperations.ts:175-205`); Backspace merges only-child INTO the page title (`useBlockInput.ts:255-266` + `useBlockOperations.ts:146`); plausible: no empty-state affordance (`Outliner.tsx:801-810`), mid-title split truncation (`useBlockStore.ts:1312-1341`).
Mechanism: zoom-entry paths guarantee a typeable child (`useBacklinkNavigation.ts:290-298`, `useBlockInput.ts:440-449`); Enter/delete/merge are zoom-unaware, and `splitBlock` inserts siblings under `pages::` — invisible in the zoomed view, plus title corruption and junk pages.
Severity: daily pain, moderate depth (view-layer + one store call). Data-integrity edge (title merge/truncation).
Fix shape: `block.id === zoomedRootId` → `create_block_inside` in the Enter branch; post-delete invariant restore (reconcile with `deleteSelection`'s existing unzoom at `useOutlinerSelection.ts:287-295`); guard merge when `prevId === zoomedRootId`. **Any-model** — the spec is fully written by the verdicts.

### B. Block-selection set collides with native text selection
Findings: Cmd+C intercept ignores live text selection (`Outliner.tsx:279`); shift+click double-registers (`BlockItem.tsx:853`); no clear on native-selection drag ending outside `.block-item` (`BlockItem.tsx:858`; only `selectionchange` listener is cursor-cache, `useCursor.ts:139`); stale `selectionAnchor` closure breaks Shift+Arrow range growth entirely (`BlockItem.tsx:383` vs `useBlockInput.ts:519/535` — solidjs-patterns #6 violation; same defect in scaffolded `useNavigationActions.ts:36/65/81`).
Severity: daily (copy is a hundred-times-a-day gesture); shallow depth.
Fix shape: bail to native copy when `isEditing && !getSelection().isCollapsed`; skip block-select modes for shift-clicks inside CE with non-collapsed selection; `getSelectionAnchor: () => props.selectionAnchor`. **Any-model**, mechanical. (The refuted Shift+Arrow finding's trace overlaps this cluster — its hops were accurate and are absorbed by the stale-anchor fix.)

### C. CE/store/overlay decoupling — silent data loss on typing
Findings: structured paste into empty focused block (`pasteHandler.ts:91` + `useContentSync.ts:337` shouldSync gate); CE remount paths mount empty editors (`BlockOutputView.tsx:168-171/357`; the two ad-hoc patches at `BlockItem.tsx:197-225` prove the mechanism); unhandled paste inserts rich HTML that defeats `color: transparent` inheritance and survives blur (`BlockItem.tsx:787`, `index.css:1204-1208`, `useContentSync.ts:394`); async file-paste stale ref (`BlockItem.tsx:741-765`); plausible: stuck `isComposing` disables all commits (`useContentSync.ts:209-211`).
Mechanism: `contentRef` is a plain `let` — the sync effect can never react to CE mount (`BlockItem.tsx:125`, comments at 198/213 admit it).
Severity: highest daily-pain × depth in the frontend — every instance ends in the user's typing destroying real content with no conflict warning.
Fix shape: root fix is making CE mount a first-class sync trigger (signal-based ref or ref-callback repair), which deletes both existing patches and closes future remount paths — **Fable-shaped** (touches the FLO-387 boundary-commit lifecycle, multi-invariant). Point fixes are **any-model**: manual repair after empty-anchor paste (mirror `BlockItem.tsx:438-441`), `preventDefault` + `insertText` on unhandled paste, snapshot-before-await on file paste, reset `isComposing` in `handleBlurSync`/onCleanup.

### D. Per-keystroke O(N)/O(content) work
Findings: full token-span remount per keystroke (`BlockDisplay.tsx:868`, fresh objects from `inlineParser.ts:818`, reference-identity `<For>`); O(N) `isFocused` fanout — no `createSelector` anywhere in src (`BlockItem.tsx:93`); Fuse index rebuilt per keystroke while `[[` active (`fuzzyFilter.ts:26`); unconditional cursor DOM walk + trigger scan even with no `[[` in content (`useContentSync.ts:440`); plausible: `innerText` forced reflow + zero virtualization (`useContentSync.ts:418`, `child_render_limit=0`).
Severity: daily at scale; each fix is shallow and independent.
Fix shape: per-pane `createSelector`; parse cache + stable-keyed spans; cached Fuse alongside the pageNames memo; `!content.includes('[[')` prescreen. All **any-model**. Virtualization deferred until a profile proves the reflow dominates (verdict says WKWebView layout is incremental).

### E. Sync/reconcile resurrection & data-loss holes
The sixth mechanism — four CONFIRMED holes sharing the "healing path destroys data" shape. Broken out in full as §3 below (fix-vs-preserve lists), since it is the offline/fast-boot prerequisite set.

### F. Page-name uniqueness enforced nowhere
Findings (all CONFIRMED): hook-lag window duplicates frontend-created pages (`discovery.rs:454`); frontend first-match vs server LWW split-brain, winner flips across restarts (`page_name_index.rs:274`, `useBacklinkNavigation.ts:91-99`); wikilink-click mirror race (`useBacklinkNavigation.ts:243`); un-normalized `:name` bypasses collision check then hijacks the index (`discovery.rs:445/586` vs `page_name_index.rs:398-409`); name-keyed removal evicts the survivor — deleting one twin makes three (`page_name_index.rs:293-299`, and fires for ANY deleted block whose first line matches a page name); no contract anywhere, container included, with `starts_with` vs exact-match asymmetry (`discovery.rs:474-494`, `page_name_index.rs:412-414`, `useBacklinkNavigation.ts:60`).
Severity: the duplicate-daily-note quirk, and it amplifies under the natural cleanup response.
Fix shape, laddered: (1) normalize once at API boundary — small, **any-model**; (2) id-guarded `remove_existing_page(name, block_id)` — small, **any-model**; (3) Y.Doc `pages::` childIds scan fallback in `find_or_create_page` — medium, **any-model**; (4) deterministic tie-break (oldest-createdAt) applied in BOTH `add_existing_page` and frontend `findPage` — small; (5) name-keyed reconcile pass merging twins (sibling of `deduplicateChildIds`, origin-tagged) — **Fable-shaped** (CRDT mutation, hook interplay); (6) write the collision contract (semantic endpoints=merge, low-level POST under pages::=409 with existing blockId).

## 3. Sync/reconcile — what the offline/fast-boot rewrite must fix vs must not break

**Must fix (prerequisites, all CONFIRMED):**
- **Epoch on restore.** `reset_from_state` bumps an epoch carried in the restore broadcast, `/state`, and heartbeat; on mismatch the client hard-resets (new Y.Doc, drop pending + IDB) — never merges (`useSyncedYDoc.ts:810-833`, `sync.rs:338`, `store.rs:879-924`). Critically, the epoch-mismatch resync must **skip the push step** — `triggerFullResync`'s push (`useSyncedYDoc.ts:404-411`) is the resurrection vector. The design doc §8 epoch proposal must cover the live doc, not just the cache.
- **`latestSeq` = last seq applied to the returned snapshot,** captured under the same read guard as the encode (`sync.rs:160-190`); persist-first (`store.rs:697-733`) means MAX(id) can run ahead of memory. The planned `/state-diff` endpoint must get this pairing right on day one — boot-time seeding past a missed update is permanently invisible.
- **Orphan sweep reattaches, never deletes** (`useSyncedYDoc.ts:259-345`): move unreachable blocks under a recovered root, delete only empty shells, deterministic keep choice. Design doc §3's "orphan handling already exists" is currently silent, unsyncable-to-undo, propagated destruction.
- **Atomic `reset_from_state`** — clear+append in one SQLite transaction, mirroring `compact()` (`persistence.rs:236-285` vs :158-166/:176-197). Plus `apply_update` compensating-delete on apply failure or txId-idempotent append; the client retry loop (`useSyncedYDoc.ts:525-538`) inflates the log unboundedly today.
- **Backup path: never `clearBackup` or set `sharedDocLoaded` until the doc is hydrated** from server OR backup (`useSyncedYDoc.ts:1621-1648`). The verdict widened this: server-down-at-boot (`getStateVector` throws) also clears the backup via the `!hadLocalChanges` conflation — destroys unpushed changes outright. Track an `appliedServerState` flag; hydrating from the local backup IS the boot-from-cache behavior the rewrite wants anyway.
- **Detector**: either a content-shaped digest (sorted `(blockId, contentHash, parentId, childIds)` on both sides) or the cheaper WS-liveness watchdog — the verdict narrowed count-blindness to the zombied-socket case (`useSyncHealth.ts:126`, header line 18's promise is currently unkept).

**Must not break:**
- The heartbeat/gap-fill chain, reconnect incremental sync (`useSyncedYDoc.ts:1190-1274`), and `Y.diffUpdate` backup reconcile — these are the content-complete healing paths that make most divergence transient today.
- Surgical Y.Array helpers + ID-based `deduplicateChildIds` (the ID-dedup half is correct; only the orphan phase is wrong).
- FLO-269's no-refetch-on-first-connect (`useSyncedYDoc.ts:1349-1361`) is only safe once the `latestSeq` pairing is fixed — they're coupled; don't rip out the optimization, fix its precondition.

## 4. Agent-UX, ordered by effort-to-value

1. **409 candidate list** (small): `resolve_block_id` already collects `matches` and drops it (`block_service.rs:102-122`, `api/mod.rs:248-270`). Ship `{error, matches:[{id, contentPreview}]}` — also closes the api-reference.md doc/impl drift.
2. **Remedy-bearing errors + Common-Errors table in floatty-backend skill** (small): generalize the `put_not_supported` pattern (`api/blocks.rs:738-750`) via an optional `hint` field on ErrorResponse.
3. **Delete receipts + destructive gate** (small): return `{deletedCount, rootContent}` (already computed at `block_service.rs:2296-2380`); require `X-Floatty-Confirm-Destructive` above ~25-block subtrees (subtreeSize already computed).
4. **Capabilities probe** (small): `/api/v1/capabilities` with `{apiVersion, routes, includeOptions, limits}` + serve the agent guide; kills version-skew `deny_unknown_fields` 400s across 8765/33333/remote.
5. **Idempotency key on POST /blocks + /daily/append** (medium): extends the existing `upsert_page` 200/201 + `semantic_cache` pattern (`discovery.rs:391-442`); directly attacks retry-duplicate blocks and pairs with cluster F.
6. **POST /blocks/batch** (medium): capture-format doctrine tells agents to write trees; mirror `batchCreateBlocksAfter/Inside` server-side with validate-all-then-one-transaction + `applied[]` receipts.
7. **Agent attribution** (medium): `metadata.author` in the CRDT (ydoc-patterns §2), Tantivy-indexed — "which blocks did cowboy write" becomes answerable.
8. **Reverse presence / navigate endpoint** (medium): `POST /api/v1/navigate` → WS frame → `lib/navigation.ts` funnel. Highest novelty, most wiring; do last.

## 5. Suggested build order for remaining Fable days

1. **Sync integrity branch (Fable, ~1-1.5 days)**: epoch restore adoption + push-skip resync variant; `latestSeq`/encode pairing (`last_applied_seq`); atomic `reset_from_state`; backup-path `appliedServerState` flag. One coherent Rust+TS branch — these four share test infrastructure and are the rewrite's foundation.
2. **Orphan sweep → reattach** (Fable, ~0.5 day): reattach-under-recovered-root + deterministic keep + empty-shell-only deletion. Isolated, high-stakes, CRDT-touching.
3. **CE remount reactivity** (Fable core + delegated points, ~0.5-1 day): signal-based `contentRef` root fix (deletes the FLO-58/FLO-569 patches); spec the four paste/composition point fixes for any-model execution.
4. **Page uniqueness ladder** (mixed): steps 1-4 (normalize, id-guard, Y.Doc fallback, tie-break) are spec-and-delegate; the name-keyed reconcile pass (step 5) is Fable work — schedule after the sync branch since it writes origin-tagged CRDT mutations.
5. **Zoom invariant + selection cluster** (any-model): fully specced by the verdicts; write the two-paragraph spec each, delegate, verify against `tauri:dev` on 33333.
6. **Keyboard perf batch** (any-model): createSelector, Fuse cache, `[[` prescreen, token parse cache — four independent mechanical PRs; profile before touching virtualization.
7. **Agent-UX smalls** (items 1-4 above) fit in gaps; mediums ride behind the sync branch since idempotency reuses `semantic_cache` and batch reuses the validated-transaction shape.

Fable-time goes where invariants interlock: sync integrity, orphan policy, CE lifecycle, CRDT page reconcile. Everything else is now cheaper to spec than to do.
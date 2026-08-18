/**
 * useSyncedYDoc - Bridge between Server (floatty-server) and Frontend (yjs)
 *
 * Phase 3: Uses HTTP client to sync with floatty-server instead of Tauri IPC.
 *
 * Handles:
 * - Loading initial state from server on mount
 * - Observing local Y.Doc changes and syncing to server
 * - Debounced batch updates with retry logic
 */

import { onMount, onCleanup, createSignal, type Accessor } from 'solid-js';
import { getHttpClient, initHttpClient, isClientInitialized, type FloattyHttpClient } from '../lib/httpClient';
import * as Y from 'yjs';
import {
  saveBackup as saveBackupIDB,
  getBackup as getBackupIDB,
  clearBackup as clearBackupIDB,
  hasBackup as hasBackupIDB,
  initBackupNamespace,
  deriveServerSlug,
  saveLastContiguousSeq as saveLastContiguousSeqIDB,
  getLastContiguousSeq as getLastContiguousSeqIDB,
  clearLastContiguousSeq as clearLastContiguousSeqIDB,
  saveKnownEpoch as saveKnownEpochIDB,
  getKnownEpoch as getKnownEpochIDB,
  clearKnownEpoch as clearKnownEpochIDB,
} from '../lib/idbBackup';
import { configReady } from '../context/ConfigContext';
import { SyncSequenceTracker } from '../lib/syncSequenceTracker';
import {
  recordFullResync,
  recordDedupRepairs,
  recordGapFill,
  recordEchoGapFill,
  recordPhantomChildrenRemoved,
  recordCrossParentFixes,
  recordPendingStructsStall,
  recordUnfillableStash,
} from '../lib/syncDiagnostics';
import { createLogger } from '../lib/logger';
import { getSectionKey } from '../lib/pageTitle';
import {
  createPendingStructsWatchdog,
  PENDING_SAMPLE_INTERVAL_MS,
  type StashSignature,
} from '../lib/pendingStructsWatchdog';

const logger = createLogger('useSyncedYDoc');
const wsLogger = createLogger('WS');

// ═══════════════════════════════════════════════════════════════
// SYNC STATUS (singleton signals for UI visibility)
// ═══════════════════════════════════════════════════════════════

export type SyncStatus = 'synced' | 'pending' | 'error' | 'drift';

// Singleton signals - survive component remount like sharedDoc
const [syncStatus, setSyncStatus] = createSignal<SyncStatus>('synced');
const [pendingCount, setPendingCount] = createSignal(0);
const [lastSyncError, setLastSyncError] = createSignal<string | null>(null);

/** Get current sync status (reactive) */
export const getSyncStatus: Accessor<SyncStatus> = syncStatus;

/** Get pending update count (reactive) */
export const getPendingCount: Accessor<number> = pendingCount;

/** Get last sync error message (reactive) */
export const getLastSyncError: Accessor<string | null> = lastSyncError;

/** Set sync status externally (used by useSyncHealth for drift detection) */
export function setSyncStatusExternal(status: SyncStatus, error?: string | null): void {
  setSyncStatus(status);
  if (error !== undefined) setLastSyncError(error);
}

// ═══════════════════════════════════════════════════════════════
// BOOT PROGRESS (singleton signal for the loading UI)
// ═══════════════════════════════════════════════════════════════
//
// The initial load spends most of its time in two invisible main-thread
// walks (fetch+apply of the full doc, then store materialization). The
// Outliner loading fallback renders this so the user can distinguish
// "working" from "hung" — which used to be indistinguishable
// (boot-sequence audit §4a).

export type BootPhase =
  | 'connecting'      // waiting on the HTTP client / server handshake
  | 'cache'           // lineage-verified cache boot — hydrating before the network
  | 'reconciling'     // pushing the local-only diff (backup boot)
  | 'fetching'        // downloading server state
  | 'applying'        // Y.applyUpdate of the downloaded state (the long one)
  | 'offline-cache';  // server unreachable — hydrating from the local backup

export interface BootProgress {
  phase: BootPhase;
  /** Server block count from /state/hash, when the server was reachable. */
  serverBlocks: number | null;
}

const [bootProgress, setBootProgress] = createSignal<BootProgress>({
  phase: 'connecting',
  serverBlocks: null,
});

/** Get boot progress (reactive) — for the Outliner loading fallback. */
export const getBootProgress: Accessor<BootProgress> = bootProgress;

/**
 * Update the phase, preserving the block count already learned.
 * Boot-scoped: once the initial load completes the loading UI is gone, and
 * resync paths reuse pullServerState — don't let them mutate this.
 */
function setBootPhase(phase: BootPhase): void {
  if (sharedDocLoaded) return;
  setBootProgress(prev => ({ ...prev, phase }));
}

/**
 * Check if drift status is currently set.
 * Used to prevent normal sync paths from clobbering drift indicator —
 * only the health check should clear drift (after verifying counts match).
 */
export function isDriftStatus(): boolean {
  return syncStatus() === 'drift';
}

/**
 * Force a new undo capture boundary.
 * Useful for atomic operations that should always be one undo step.
 */
export function stopUndoCaptureBoundary(): void {
  sharedUndoManager?.stopCapturing();
}

/** Check if there are pending updates (for close gate) */
export function hasPendingUpdates(): boolean {
  return sharedPendingUpdates.length > 0 || sharedIsFlushing;
}

/**
 * Force sync pending updates immediately (module-level for close gate).
 * This is a standalone function that can be called without the hook.
 */
export async function forceSyncNow(): Promise<void> {
  // Cancel any pending debounced flush
  if (sharedSyncTimer) {
    clearTimeout(sharedSyncTimer);
    sharedSyncTimer = null;
  }

  // If already flushing or nothing to flush, early return
  if (sharedIsFlushing || sharedPendingUpdates.length === 0) return;

  if (!isClientInitialized()) {
    logger.warn('HTTP client not initialized, cannot force sync');
    return;
  }

  sharedIsFlushing = true;
  const updates = sharedPendingUpdates;
  sharedPendingUpdates = [];

  let sentCount = 0;
  try {
    const httpClient = getHttpClient();
    for (const update of updates) {
      const txId = generateTxId();
      await httpClient.applyUpdate(update, txId);
      sentCount++;
    }
    sharedRetryCount = 0;
    if (!isDriftStatus()) {
      setSyncStatus('synced');
      setLastSyncError(null);
    }
    setPendingCount(0);
    // Durable-cache model (fast-boot Phase 1): the backup is the boot cache,
    // not a crash-only artifact — synced does NOT mean discard.
    logger.info('Force sync completed successfully');
  } catch (err) {
    logger.error('Force sync failed', { err });
    // Restore unsent updates
    sharedPendingUpdates = [...updates.slice(sentCount), ...sharedPendingUpdates];
    setPendingCount(sharedPendingUpdates.length);
    setSyncStatus('error');
    setLastSyncError(String(err));
    throw err; // Re-throw so caller knows it failed
  } finally {
    sharedIsFlushing = false;
  }
}

// ═══════════════════════════════════════════════════════════════
// BASE64 UTILITIES (re-exported for tests and other consumers)
// ═══════════════════════════════════════════════════════════════

// Shared implementation in src/lib/encoding.ts
import { base64ToBytes, bytesToBase64 } from '../lib/encoding';
export { base64ToBytes, bytesToBase64 };

// Re-export diagnostics for dev tools and health endpoint
export { getSyncDiagnostics } from '../lib/syncDiagnostics';

/**
 * Get the singleton Y.Doc instance.
 * Used for testing singleton behavior.
 */
export function getSharedDoc(): Y.Doc {
  return sharedDoc;
}

/**
 * Scan all blocks' childIds and rootIds for duplicate entries, remove them.
 * Safety net for edge cases where CRDT merge produces duplicated array entries
 * (e.g., from the old delete-all-then-push childIds mutation pattern).
 *
 * Returns the number of duplicates removed. All removals happen in a single
 * transaction with 'system' origin (excluded from UndoManager).
 */
// Well-known id for the orphan recovery root. Fixed (not random) because the
// sweep runs on EVERY client: concurrent first-creations converge on one
// blocksMap entry (CRDT last-writer-wins on the same key) instead of minting
// parallel recovered:: containers. Duplicate rootIds pushes of this id are
// cleaned by the sweep's own rootIds dedup on the next pass. "f10a77" ≈ float.
const RECOVERY_ROOT_ID = '00000000-0000-4000-8000-f10a77000001';

export function deduplicateChildIds(targetDoc: Y.Doc = sharedDoc): number {
  const doc = targetDoc;
  const blocksMap = doc.getMap('blocks');
  const rootIds = doc.getArray<string>('rootIds');

  let totalRemoved = 0;

  // Collect duplicates before transacting (read phase)
  const blockDups: Array<{ blockId: string; indicesToRemove: number[] }> = [];

  blocksMap.forEach((value, blockId) => {
    if (!(value instanceof Y.Map)) return;
    const arr = value.get('childIds');
    if (!(arr instanceof Y.Array)) return;

    const items = arr.toArray() as string[];
    const seen = new Set<string>();
    const indicesToRemove: number[] = [];

    for (let i = 0; i < items.length; i++) {
      if (seen.has(items[i])) {
        indicesToRemove.push(i);
      } else {
        seen.add(items[i]);
      }
    }

    if (indicesToRemove.length > 0) {
      blockDups.push({ blockId, indicesToRemove });
    }
  });

  // Check rootIds
  const rootItems = rootIds.toArray();
  const rootSeen = new Set<string>();
  const rootIndicesToRemove: number[] = [];
  for (let i = 0; i < rootItems.length; i++) {
    if (rootSeen.has(rootItems[i])) {
      rootIndicesToRemove.push(i);
    } else {
      rootSeen.add(rootItems[i]);
    }
  }

  // Phase 2: Cross-parent dedup + phantom child detection
  // Builds childId → [parentIds] map and detects childIds pointing to non-existent blocks.
  const childToParents = new Map<string, string[]>();
  const phantomChildren: Array<{ parentId: string; childId: string }> = [];
  blocksMap.forEach((value, parentId) => {
    if (!(value instanceof Y.Map)) return;
    const arr = value.get('childIds');
    if (!(arr instanceof Y.Array)) return;
    for (const childId of arr.toArray() as string[]) {
      // Phantom: childIds references a block that doesn't exist
      if (!blocksMap.has(childId)) {
        phantomChildren.push({ parentId, childId });
        continue; // Don't add to cross-parent map
      }
      const parents = childToParents.get(childId) || [];
      parents.push(parentId);
      childToParents.set(childId, parents);
    }
  });

  // For multi-parent blocks: keep one parent, remove from the rest.
  // Prefer the canonical parent (matches block.parentId), but if it doesn't actually
  // claim the block in its childIds, adopt the first real parent instead.
  const crossParentRemovals: Array<{ parentId: string; childId: string }> = [];
  const parentIdUpdates: Array<{ childId: string; newParentId: string }> = [];
  for (const [childId, parents] of childToParents) {
    if (parents.length <= 1) continue;
    const childBlock = blocksMap.get(childId);
    const declaredParent = childBlock instanceof Y.Map
      ? (childBlock.get('parentId') as string | null)
      : null;

    // Check if declared parent is among the ones that actually have this child
    const declaredParentClaims = declaredParent !== null && parents.includes(declaredParent);
    const keepParent = declaredParentClaims ? declaredParent : parents[0];

    // If we're adopting a different parent, update block.parentId
    if (keepParent !== declaredParent) {
      parentIdUpdates.push({ childId, newParentId: keepParent });
    }

    for (const pid of parents) {
      if (pid !== keepParent) {
        crossParentRemovals.push({ parentId: pid, childId });
      }
    }
  }

  // Phase 3: Orphan blocks — exist in blocksMap but no parent's childIds references them
  // and they're not in rootIds. These are unreachable and cause ghost rendering issues.
  const referenced = new Set<string>(rootIds.toArray());
  blocksMap.forEach((value) => {
    if (!(value instanceof Y.Map)) return;
    const arr = value.get('childIds');
    if (!(arr instanceof Y.Array)) return;
    for (const cid of arr.toArray() as string[]) {
      referenced.add(cid);
    }
  });
  // Orphans are subtree ROOTS by construction (their descendants are still
  // referenced by the orphan's own childIds). Classify: EMPTY SHELLS (no
  // content, no children) are deletable noise; anything with content or
  // children is USER DATA and gets reattached under a recovery root — the old
  // hard-delete here destroyed real content, propagated it to every client,
  // and was not undoable (quirk-audit 2026-07-09, sync cluster; the offline
  // design doc mistook it for a safety net).
  const orphanReattachIds: string[] = [];
  const orphanEmptyShellIds: string[] = [];
  blocksMap.forEach((value, blockId) => {
    if (referenced.has(blockId)) return;
    // Never classify the recovery root itself as an orphan (it would be
    // reattached under itself); the write phase re-adds it to rootIds instead.
    if (blockId === RECOVERY_ROOT_ID) return;
    if (!(value instanceof Y.Map)) {
      orphanEmptyShellIds.push(blockId);
      return;
    }
    const content = typeof value.get('content') === 'string' ? (value.get('content') as string) : '';
    const kids = value.get('childIds');
    const hasKids = kids instanceof Y.Array && kids.length > 0;
    if (content.trim() === '' && !hasKids) {
      orphanEmptyShellIds.push(blockId);
    } else {
      orphanReattachIds.push(blockId);
    }
  });
  // Deterministic processing order — this sweep runs on every client.
  orphanReattachIds.sort();
  orphanEmptyShellIds.sort();

  // The recovery root is excluded from orphan classification, so its own lost
  // rootIds membership must count as work in its own right — otherwise a sweep
  // with nothing else to do early-returns and everything recovered under it
  // stays unreachable.
  const recoveryRootNeedsRepair =
    blocksMap.has(RECOVERY_ROOT_ID) && !referenced.has(RECOVERY_ROOT_ID);

  const hasWork = blockDups.length > 0 || rootIndicesToRemove.length > 0
    || crossParentRemovals.length > 0 || phantomChildren.length > 0
    || orphanReattachIds.length > 0 || orphanEmptyShellIds.length > 0
    || recoveryRootNeedsRepair;
  if (!hasWork) {
    return 0;
  }

  // Write phase — single transaction
  doc.transact(() => {
    for (const { blockId, indicesToRemove } of blockDups) {
      const blockMap = blocksMap.get(blockId);
      if (!(blockMap instanceof Y.Map)) continue;
      const arr = blockMap.get('childIds');
      if (!(arr instanceof Y.Array)) continue;

      // Delete in reverse order so indices stay valid
      for (let i = indicesToRemove.length - 1; i >= 0; i--) {
        arr.delete(indicesToRemove[i], 1);
        totalRemoved++;
      }
    }

    // Dedup rootIds
    for (let i = rootIndicesToRemove.length - 1; i >= 0; i--) {
      rootIds.delete(rootIndicesToRemove[i], 1);
      totalRemoved++;
    }

    // Fix cross-parent duplication: remove from non-canonical parents
    for (const { parentId, childId } of crossParentRemovals) {
      const parentMap = blocksMap.get(parentId);
      if (!(parentMap instanceof Y.Map)) continue;
      const arr = parentMap.get('childIds');
      if (!(arr instanceof Y.Array)) continue;
      const items = arr.toArray() as string[];
      const idx = items.indexOf(childId);
      if (idx >= 0) {
        arr.delete(idx, 1);
        totalRemoved++;
      }
    }

    // Update parentId for blocks adopted by a different parent
    for (const { childId, newParentId } of parentIdUpdates) {
      const childBlock = blocksMap.get(childId);
      if (childBlock instanceof Y.Map) {
        childBlock.set('parentId', newParentId);
      }
    }

    // Remove phantom children (childIds referencing non-existent blocks)
    for (const { parentId, childId } of phantomChildren) {
      const parentMap = blocksMap.get(parentId);
      if (!(parentMap instanceof Y.Map)) continue;
      const arr = parentMap.get('childIds');
      if (!(arr instanceof Y.Array)) continue;
      const items = arr.toArray() as string[];
      const idx = items.indexOf(childId);
      if (idx >= 0) {
        arr.delete(idx, 1);
        totalRemoved++;
      }
    }

    // Standalone membership repair: the recovery root exists but fell out of
    // rootIds (runs even when there are no new orphans this sweep).
    if (recoveryRootNeedsRepair) {
      rootIds.push([RECOVERY_ROOT_ID]);
      totalRemoved++;
    }

    // Reattach content-bearing orphans under a recovery root (never delete
    // user data). The orphan is a subtree root, so reattaching it preserves
    // its whole subtree.
    if (orphanReattachIds.length > 0) {
      // Find an existing recovery root, or create one at the well-known id.
      let recoveryRootId: string | null = null;
      for (const rid of rootIds.toArray()) {
        const rm = blocksMap.get(rid);
        if (rm instanceof Y.Map) {
          const c = rm.get('content');
          if (typeof c === 'string' && c.startsWith('recovered::')) {
            recoveryRootId = rid;
            break;
          }
        }
      }
      if (recoveryRootId === null && blocksMap.has(RECOVERY_ROOT_ID)) {
        // Membership was repaired above (or is being repaired this txn) —
        // reuse the well-known root rather than creating a twin.
        recoveryRootId = RECOVERY_ROOT_ID;
      }
      if (recoveryRootId === null) {
        recoveryRootId = RECOVERY_ROOT_ID;
        const rootMap = new Y.Map<unknown>();
        rootMap.set('id', recoveryRootId);
        rootMap.set('parentId', null);
        rootMap.set('content', 'recovered:: orphaned blocks (auto-reattached — review & re-home)');
        rootMap.set('type', 'text');
        rootMap.set('metadata', null);
        rootMap.set('collapsed', true);
        rootMap.set('createdAt', Date.now());
        rootMap.set('updatedAt', Date.now());
        rootMap.set('childIds', new Y.Array<string>());
        blocksMap.set(recoveryRootId, rootMap);
        rootIds.push([recoveryRootId]);
      }

      const recoveryMap = blocksMap.get(recoveryRootId);
      const recoveryKids = recoveryMap instanceof Y.Map ? recoveryMap.get('childIds') : null;
      if (recoveryKids instanceof Y.Array) {
        for (const orphanId of orphanReattachIds) {
          recoveryKids.push([orphanId]);
          const om = blocksMap.get(orphanId);
          if (om instanceof Y.Map) {
            om.set('parentId', recoveryRootId);
          }
          totalRemoved++;
        }
      }
    }

    // Empty shells (no content, no children) are safe to delete.
    for (const shellId of orphanEmptyShellIds) {
      blocksMap.delete(shellId);
      totalRemoved++;
    }
  }, 'system');

  if (totalRemoved > 0 || parentIdUpdates.length > 0) {
    const parts = [];
    if (blockDups.length > 0 || rootIndicesToRemove.length > 0) {
      parts.push('within-array duplicates');
    }
    if (crossParentRemovals.length > 0) {
      parts.push(`${crossParentRemovals.length} cross-parent`);
    }
    if (parentIdUpdates.length > 0) {
      parts.push(`${parentIdUpdates.length} re-homed`);
    }
    if (phantomChildren.length > 0) {
      parts.push(`${phantomChildren.length} phantom children`);
    }
    if (orphanReattachIds.length > 0) {
      parts.push(`${orphanReattachIds.length} orphans reattached under recovered::`);
    }
    if (orphanEmptyShellIds.length > 0) {
      parts.push(`${orphanEmptyShellIds.length} empty orphan shells deleted`);
    }
    if (recoveryRootNeedsRepair) {
      parts.push('recovery-root rootIds membership repaired');
    }
    logger.warn(`Tree integrity: fixed ${totalRemoved} issues (${parts.join(', ')})`);

    // Record diagnostics — use category-specific counts (not totalRemoved which double-counts)
    const withinArrayDedups = blockDups.reduce((sum, d) => sum + d.indicesToRemove.length, 0) + rootIndicesToRemove.length;
    recordDedupRepairs(withinArrayDedups);
    recordPhantomChildrenRemoved(phantomChildren.length);
    recordCrossParentFixes(crossParentRemovals.length);
  }

  return totalRemoved;
}

/**
 * Merge duplicate pages under the pages:: container(s) — quirk-audit
 * cluster F, ladder step 5 (steps 1-4 shipped server+frontend in PR #325).
 *
 * Twins arise from the PageNameIndex hook-lag window, offline creation on
 * two clients, and the pre-#325 name-keyed index eviction. Steps 1-4 stop
 * NEW twins and make both sides RESOLVE existing twins consistently
 * (oldest-createdAt wins); this pass is the healing half that makes the
 * twins actually disappear.
 *
 * Policy (mirrors the 2026-07-10 prod twin-tidy, preserve-everything):
 * - Winner: oldest createdAt (missing/0 loses to any real timestamp);
 *   tie-break: lexicographically smaller id. Deterministic — this runs on
 *   every client (startup, post-resync) and concurrent runs must converge.
 * - Losers' children are re-homed to the winner (order preserved).
 * - A loser whose content is a single line (the title itself — twin-group
 *   membership means that line normalizes to the same name) is a pure
 *   shell: deleted.
 * - A loser with body content beyond the title line is DEMOTED under the
 *   winner as a regular child — content preserved for manual review/absorb.
 *
 * Single 'system'-origin transaction (authoritative for the sync effect,
 * excluded from UndoManager), sibling of deduplicateChildIds above.
 * Returns the number of loser pages processed (demoted + deleted).
 */
export function reconcilePageTwins(targetDoc: Y.Doc = sharedDoc): number {
  const doc = targetDoc;
  const blocksMap = doc.getMap('blocks');
  const rootIds = doc.getArray<string>('rootIds');

  // ── Read phase ──
  // All pages:: containers (normally one; hook-lag can twin the container
  // itself — children of every container participate in one name space).
  const containerIds: string[] = [];
  for (const rid of rootIds.toArray()) {
    const rm = blocksMap.get(rid);
    if (rm instanceof Y.Map) {
      const c = rm.get('content');
      if (typeof c === 'string' && c.trim() === 'pages::') containerIds.push(rid);
    }
  }
  if (containerIds.length === 0) return 0;
  if (containerIds.length > 1) {
    logger.warn(`reconcilePageTwins: ${containerIds.length} pages:: containers found — reconciling pages across all of them`);
  }

  interface PageEntry {
    id: string;
    containerId: string;
    createdAt: number; // missing/0 → Infinity (loses to any real timestamp)
    singleLine: boolean;
    childIds: string[];
  }
  const byName = new Map<string, PageEntry[]>();
  for (const containerId of containerIds) {
    const cm = blocksMap.get(containerId);
    if (!(cm instanceof Y.Map)) continue;
    const kids = cm.get('childIds');
    if (!(kids instanceof Y.Array)) continue;
    for (const pageId of kids.toArray() as string[]) {
      const pm = blocksMap.get(pageId);
      if (!(pm instanceof Y.Map)) continue;
      const content = typeof pm.get('content') === 'string' ? (pm.get('content') as string) : '';
      // No pre-trim: getSectionKey (getPageTitle + lowercase) reads the RAW
      // first line, matching the server's section_key_from_content
      // (content.lines().next()). Trimming first would fold "\n# Foo" (empty
      // first line — malformed page) into "foo" and destructively merge it
      // with a real Foo page.
      const name = getSectionKey(content);
      if (!name) continue; // empty titles don't participate
      const rawCreated = pm.get('createdAt');
      const createdAt = typeof rawCreated === 'number' && rawCreated > 0 ? rawCreated : Infinity;
      const pageKids = pm.get('childIds');
      const entry: PageEntry = {
        id: pageId,
        containerId,
        createdAt,
        singleLine: !content.trim().includes('\n'),
        childIds: pageKids instanceof Y.Array ? (pageKids.toArray() as string[]) : [],
      };
      const list = byName.get(name) || [];
      list.push(entry);
      byName.set(name, list);
    }
  }

  interface TwinGroup { winner: PageEntry; losers: PageEntry[] }
  const groups: TwinGroup[] = [];
  // Deterministic group order (map iteration order varies with insertion,
  // which varies with container/childIds order — sort by name).
  for (const name of Array.from(byName.keys()).sort()) {
    const entries = byName.get(name)!;
    // Same block id listed in two containers is cross-parent duplication —
    // deduplicateChildIds territory, not a twin. Collapse by id first.
    const unique = Array.from(new Map(entries.map(e => [e.id, e])).values());
    if (unique.length <= 1) continue;
    unique.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    groups.push({ winner: unique[0], losers: unique.slice(1) });
  }
  if (groups.length === 0) return 0;

  // ── Write phase — single transaction ──
  let processed = 0;
  doc.transact(() => {
    for (const { winner, losers } of groups) {
      const winnerMap = blocksMap.get(winner.id);
      if (!(winnerMap instanceof Y.Map)) continue;
      const winnerKids = winnerMap.get('childIds');
      if (!(winnerKids instanceof Y.Array)) continue;

      for (const loser of losers) {
        const loserMap = blocksMap.get(loser.id);
        if (!(loserMap instanceof Y.Map)) continue;

        // 1. Re-home the loser's children to the winner (order preserved).
        const loserKids = loserMap.get('childIds');
        if (loserKids instanceof Y.Array && loserKids.length > 0) {
          const winnerKidSet = new Set(winnerKids.toArray() as string[]);
          const moving = (loserKids.toArray() as string[])
            .filter(cid => cid !== winner.id && !winnerKidSet.has(cid));
          loserKids.delete(0, loserKids.length); // intentional full wipe — the block is being retired
          if (moving.length > 0) {
            winnerKids.push(moving);
            for (const cid of moving) {
              const cm = blocksMap.get(cid);
              if (cm instanceof Y.Map) cm.set('parentId', winner.id);
            }
          }
        }

        // 2. Detach the loser from its container.
        const containerMap = blocksMap.get(loser.containerId);
        if (containerMap instanceof Y.Map) {
          const containerKids = containerMap.get('childIds');
          if (containerKids instanceof Y.Array) {
            const idx = (containerKids.toArray() as string[]).indexOf(loser.id);
            if (idx >= 0) containerKids.delete(idx, 1);
          }
        }

        // 3. Retire the loser: shells die, body-bearing pages demote.
        if (loser.singleLine) {
          blocksMap.delete(loser.id);
        } else {
          winnerKids.push([loser.id]);
          loserMap.set('parentId', winner.id);
        }
        processed++;
      }
    }
  }, 'system');

  if (processed > 0) {
    const demoted = groups.reduce((n, g) => n + g.losers.filter(l => !l.singleLine).length, 0);
    logger.warn(
      `reconcilePageTwins: merged ${processed} twin page(s) across ${groups.length} name group(s) ` +
      `(${demoted} demoted under winners, ${processed - demoted} shells deleted)`
    );
  }
  return processed;
}

// ═══════════════════════════════════════════════════════════════
// RECONCILE — the one push-before-pull primitive (fast-boot Phase 0)
// ═══════════════════════════════════════════════════════════════
//
// "Push my local-only diff, then pull the server's" existed in duplicate:
// `triggerFullResync` (live doc as the diff source) and the boot backup path in
// `loadInitialState` (the IDB snapshot as the diff source). Same three steps,
// same ordering constraint, drifting details. Offline mode would have made it a
// third copy — so it becomes a CALL SITE instead.
//
// The reconnect path (`connectWebSocket` onopen) is deliberately NOT a caller:
// it is not a state-vector reconcile at all. Its "push" is a flush of the
// pending-update QUEUE and its "pull" is a seq-incremental catch-up, falling
// back to full state. It shares only the pull step — which it takes via
// `pullServerState` below. See the note at that call site.

/**
 * An empty Y update is a 2-byte v1 header. Anything above that carries real ops.
 * The threshold for both "do I have local-only changes worth pushing" and "did
 * the server have anything to give me".
 */
const EMPTY_UPDATE_BYTES = 2;

/** The slice of the HTTP client a reconcile needs. Narrow, so tests can fake it. */
type SyncClient = Pick<
  FloattyHttpClient,
  'getState' | 'getStateVector' | 'applyUpdate' | 'stateDiff'
>;

/** Origin tag for the `Y.applyUpdate` of pulled server state (ydoc-patterns §4). */
type PullOrigin = 'remote' | 'reconnect-authority';

interface PullServerStateOptions {
  client: SyncClient;
  /** Doc the pulled state is applied to. */
  doc: Y.Doc;
  applyOrigin: PullOrigin;
  /**
   * Adopt the server's doc epoch as this client's lineage after a successful
   * apply.
   *
   * The reconnect path passes `false` — it learns about restores from the WS
   * restore-broadcast/heartbeat frames instead, and has never adopted here.
   * Preserved as-is rather than "fixed" in a refactor; see the call site.
   */
  adoptEpoch: boolean;
  /**
   * Whether an EMPTY server state (a doc that has never had an update) still
   * counts as "server state applied".
   *
   * Boot says yes: an empty server is a legitimate lineage to adopt on a first
   * launch, and `appliedServerState` is what gates the fall-through to
   * hydrate-from-cache. Resync says no: there was nothing to pull, so nothing
   * was adopted. The flag exists because those two answers are genuinely
   * different, not because the code was sloppy.
   */
  treatEmptyStateAsApplied: boolean;
  /**
   * How to pull (fast-boot Phase 1):
   *
   * - `'full'` (default) — `GET /state`, the whole encoded doc. Cold-cache
   *   boot and resync.
   * - `'diff'` — `POST /state-diff` with the local doc's state vector; the
   *   server returns only the ops this doc lacks. The cache-boot path: the
   *   doc was just hydrated from the local cache, so the delta is a few KB
   *   instead of the full ~31MB. Survives compaction (diffs against doc
   *   state, not the seq log).
   */
  pullVia?: 'full' | 'diff';
  /**
   * Lineage guard (FLO-854): when set, a pulled epoch that differs from this
   * value skips the apply entirely — the diff would cross a /restore boundary
   * (api-reference §state-diff: hard-reset, never merge). The WS restore
   * machinery owns the hard reset; this option only refuses the merge.
   */
  expectedEpoch?: number | null;
  /**
   * Seed the seq tracker monotonically (FLO-854): mid-session pulls run with
   * a LIVE WS, where an unconditional seed can regress the tracker and cause
   * false gap detection (see SyncSequenceTracker.seedFromFullSync). Boot and
   * reconnect paths omit this — they seed with WS down or buffering.
   */
  seedMonotonic?: boolean;
}

interface PullServerStateResult {
  appliedServerState: boolean;
  pulledBytes: number;
  latestSeq: number | null;
  epoch: number | null;
}

/**
 * Pull the server's full state and apply it: the shared tail of every sync path
 * (reconcile, first boot, reconnect fallback).
 */
async function pullServerState(opts: PullServerStateOptions): Promise<PullServerStateResult> {
  setBootPhase('fetching');
  const pullVia = opts.pullVia ?? 'full';
  const fetchStart = performance.now();
  const { state, latestSeq, epoch } =
    pullVia === 'diff'
      ? await opts.client
          .stateDiff(Y.encodeStateVector(opts.doc))
          .then(r => ({ state: r.update, latestSeq: r.latestSeq, epoch: r.epoch }))
      : await opts.client.getState();
  // boot_phase timing (R14): the fetch/apply split is the gate for the
  // history-GC-vs-virtualization decision — ADR-007 "bar to revisit".
  logger.info(
    `boot_phase=pull_${pullVia} elapsed_ms=${Math.round(performance.now() - fetchStart)} bytes=${state?.length ?? 0}`
  );

  // FLO-854 lineage guard: never merge a diff across a /restore boundary.
  // Skipping the apply also skips seq seeding (a seq from another lineage's
  // log is meaningless here) and epoch adoption.
  if (opts.expectedEpoch != null && epoch !== null && epoch !== opts.expectedEpoch) {
    logger.warn(
      `pullServerState: epoch mismatch (expected ${opts.expectedEpoch}, got ${epoch}) — skipping apply`
    );
    return {
      appliedServerState: false,
      pulledBytes: state?.length ?? 0,
      latestSeq,
      epoch,
    };
  }

  let appliedServerState: boolean;
  if (state && state.length > EMPTY_UPDATE_BYTES) {
    // FLO-256: guard the apply so the local update observer doesn't echo the
    // server's own state straight back at it.
    setBootPhase('applying');
    const applyStart = performance.now();
    try {
      isApplyingRemoteGlobal = true;
      Y.applyUpdate(opts.doc, state, opts.applyOrigin);
    } finally {
      isApplyingRemoteGlobal = false;
    }
    logger.info(
      `boot_phase=apply_update elapsed_ms=${Math.round(performance.now() - applyStart)} bytes=${state.length}`
    );
    appliedServerState = true;
  } else {
    logger.info('Server state empty, nothing to pull');
    appliedServerState = opts.treatEmptyStateAsApplied;
  }

  // Adopt the pulled epoch only AFTER its state applied successfully — adopting
  // first would mark a stale doc as new-lineage, letting a later resync push it.
  if (appliedServerState && opts.adoptEpoch && epoch !== null) {
    knownEpoch = epoch;
    saveKnownEpochIDB(epoch).catch((err: unknown) => {
      logger.warn('Failed to persist known epoch', { err });
    });
  }

  // The doc now equals the server's state as of latestSeq (a full state by
  // definition; a diff because it was paired with the encode under one read
  // guard), so seeding the baseline from it is sound. Note the diff path
  // reaches here with a NON-null latestSeq even when the update was the
  // empty 2-byte header — an up-to-date client still learns the seq.
  if (latestSeq !== null) {
    seqTracker.seedFromFullSync(latestSeq, { monotonic: opts.seedMonotonic });
  }

  return {
    appliedServerState,
    pulledBytes: state?.length ?? 0,
    latestSeq,
    epoch,
  };
}

/**
 * Targeted mid-session state-diff pull (FLO-854 fetch-on-miss).
 *
 * The bounded "ask the server NOW" primitive behind navigation's fetch-on-miss
 * retry (and the shape [[FLO-842]] compaction recovery wants): pull only the
 * ops this doc lacks and merge them through the normal guarded apply path.
 * CRDT-safe by construction — no hand-seeded blocks, so the same ops arriving
 * moments later via the WS broadcast merge as no-ops.
 *
 * Returns true iff server state was actually applied. Never merges across a
 * /restore boundary (expectedEpoch = knownEpoch; the WS restore machinery owns
 * the hard reset). Pre-boot it declines: terminal panes exist before the doc
 * loads, and a mid-boot pull would mutate boot-progress UI and race
 * loadInitialState's own reconcile.
 */
export async function pullServerDiffNow(): Promise<boolean> {
  if (!isInitialLoadComplete() || !isClientInitialized()) return false;
  // Fail closed on unknown lineage, mirroring triggerFullResync's pushAllowed
  // gating. Every reachable boot path populates knownEpoch (even to 0) before
  // sharedDocLoaded flips, so this is a stated invariant, not a live branch.
  // Note the epoch-mismatch STRATEGY here differs from its two siblings by
  // design: WS heartbeat/restore hard-resets; triggerFullResync skips the
  // push; this path merely declines the merge and lets the WS machinery act.
  if (knownEpoch === null) return false;

  const result = await pullServerState({
    client: getHttpClient(),
    doc: sharedDoc,
    applyOrigin: 'remote',
    adoptEpoch: false,
    treatEmptyStateAsApplied: false,
    pullVia: 'diff',
    expectedEpoch: knownEpoch,
    seedMonotonic: true,
  });

  if (result.appliedServerState) {
    // Belt-and-braces sweep mirroring the boot delta path. reconcilePageTwins
    // is intentionally NOT run here — it writes merge ops and could merge a
    // page the user is actively editing mid-session.
    deduplicateChildIds();
  }

  return result.appliedServerState;
}

/**
 * Where the local→server push diff is computed FROM.
 *
 * - `doc`   — `Y.encodeStateAsUpdate(doc, serverSV)`. The live doc already holds
 *   everything (resync).
 * - `cache` — `Y.diffUpdate(bytes, serverSV)`. At boot the live doc is still
 *   EMPTY; the local-only edits live in the IndexedDB snapshot, so the diff has
 *   to be taken against those bytes or it would find nothing to push.
 */
type PushSource = { kind: 'doc' } | { kind: 'cache'; bytes: Uint8Array };

interface ReconcileOptions extends PullServerStateOptions {
  pushSource: PushSource;
  /**
   * May we SEND the computed diff?
   *
   * Fail-closed lineage gate: pushing an old-lineage diff resurrects content the
   * server deleted in a restore (quirk-audit Hole 1). When false the diff is
   * still COMPUTED — callers need to know whether local-only changes exist in
   * order to decide whether the local cache is safe to clear — but it is not
   * sent.
   *
   * The lineage CHECK itself stays at the call site: the two sites recover
   * differently (hard-reset-and-reload vs. discard the stale cache), and that
   * recovery is not the reconcile's business.
   */
  pushAllowed: boolean;
  /**
   * Mint a tx id for the push (server-side echo suppression). Called lazily, at
   * push time only — `generateTxId` mutates the recent-txId set, so minting one
   * we never send would poison echo filtering.
   */
  makeTxId?: () => string;
}

interface ReconcileResult extends PullServerStateResult {
  /**
   * The local→server diff was successfully COMPUTED.
   *
   * `false` means we never got far enough to know whether local-only changes
   * exist (server unreachable) — which is NOT the same as "there are none". The
   * boot path leans on this distinction: clearing the local cache on a
   * never-computed diff destroys unpushed edits.
   */
  diffComputed: boolean;
  /** The computed diff carried local-only ops. */
  hadLocalChanges: boolean;
  /** Those ops were accepted by the server. */
  pushed: boolean;
  pushedBytes: number;
  /** The push failed. Non-fatal — the pull still ran. */
  pushError?: unknown;
  /**
   * The pull failed. No server state landed; `appliedServerState` is false.
   * Callers decide what that means: resync rethrows it, boot retries the pull
   * once and then keeps its local cache.
   */
  pullError?: unknown;
}

/**
 * Reconcile the local doc with the server: push what we have that it lacks, then
 * pull what it has that we lack.
 *
 * **Push MUST precede pull.** Pull first and the CRDT merge makes local match
 * server *from the server's perspective* — so the diff we would then compute is
 * empty, and local-only edits are silently masked instead of shipped.
 *
 * **Never throws.** Both failures come back in the result, because the two
 * callers respond to them differently and both need the partial push state to
 * decide (in particular: `diffComputed` is what stands between a server blip and
 * a wiped local cache). A thrown error would take those partials with it.
 */
export async function reconcile(opts: ReconcileOptions): Promise<ReconcileResult> {
  let diffComputed = false;
  let hadLocalChanges = false;
  let pushed = false;
  let pushedBytes = 0;
  let pushError: unknown;

  // ── 1. PUSH (mine first) ──
  try {
    const serverStateVector = await opts.client.getStateVector();
    const localDiff =
      opts.pushSource.kind === 'cache'
        ? Y.diffUpdate(opts.pushSource.bytes, serverStateVector)
        : Y.encodeStateAsUpdate(opts.doc, serverStateVector);
    diffComputed = true;
    hadLocalChanges = localDiff.length > EMPTY_UPDATE_BYTES;

    if (hadLocalChanges && opts.pushAllowed) {
      logger.debug(`Pushing local-only diff to server: ${localDiff.length} bytes`);
      await opts.client.applyUpdate(localDiff, opts.makeTxId?.());
      pushed = true;
      pushedBytes = localDiff.length;
    } else if (hadLocalChanges) {
      logger.warn(
        `Local changes present (${localDiff.length} bytes) but lineage unverified — NOT pushing`
      );
    }
  } catch (err) {
    // Non-fatal: a stale read beats no read, so we still pull.
    pushError = err;
    logger.error('Failed to push local diff (continuing with pull)', { err });
  }

  // ── 2. PULL (theirs second) ──
  try {
    const pull = await pullServerState(opts);
    return { ...pull, diffComputed, hadLocalChanges, pushed, pushedBytes, pushError };
  } catch (err) {
    return {
      appliedServerState: false,
      pulledBytes: 0,
      latestSeq: null,
      epoch: null,
      diffComputed,
      hadLocalChanges,
      pushed,
      pushedBytes,
      pushError,
      pullError: err,
    };
  }
}

/**
 * Is the local cache safe to clear after a reconcile?
 *
 * This is THE data-loss gate: the durable local cache is also the outbox for
 * edits made while the server was away, so clearing it destroys anything that
 * hasn't been pushed.
 *
 * Safe only when the server's state actually landed AND we positively know the
 * cache holds nothing the server lacks — either we pushed it (`pushed`), or the
 * diff came back empty (`diffComputed && !hadLocalChanges`).
 *
 * `!hadLocalChanges` ALONE is not sufficient, and that is the whole point:
 * `hadLocalChanges` also reads false when the diff was never computed because
 * the server was unreachable. "I know there is nothing to push" and "I have no
 * idea whether there is anything to push" are not the same claim (Hole 4,
 * quirk-audit).
 *
 * Since fast-boot Phase 1 the boot path keeps the cache UNCONDITIONALLY (it
 * is the durable boot cache, not a crash artifact) — no live caller clears on
 * this gate today. It remains the canonical rule for any future path that
 * must decide whether the cache is discardable (e.g. storage-quota pressure).
 */
export function isLocalCacheRedundant(
  r: Pick<ReconcileResult, 'appliedServerState' | 'pushed' | 'diffComputed' | 'hadLocalChanges'>
): boolean {
  return r.appliedServerState && (r.pushed || (r.diffComputed && !r.hadLocalChanges));
}

/**
 * Trigger a full bidirectional resync.
 *
 * Returns { pushedBytes } for logging by health check.
 */
export async function triggerFullResync(): Promise<{ pushedBytes: number }> {
  if (!isClientInitialized()) {
    logger.warn('HTTP client not initialized, cannot trigger resync');
    return { pushedBytes: 0 };
  }

  logger.info('Triggering bidirectional resync');
  recordFullResync();
  const httpClient = getHttpClient();

  try {
    // Epoch guard BEFORE the push — if the server restored while we were
    // disconnected, pushing our old-lineage diff would resurrect deleted content
    // into the fresh log. getStateHash is cheap (hash, not state).
    //
    // FAIL CLOSED: if lineage can't be positively verified (check failed, or the
    // server has restore history we never recorded), don't push — never sync
    // unverified local state.
    let pushAllowed = false;
    try {
      const { epoch: serverEpoch } = await httpClient.getStateHash();
      if (knownEpoch !== null && serverEpoch !== knownEpoch) {
        await hardEpochReset(serverEpoch, 'resync epoch mismatch');
        return { pushedBytes: 0 }; // unreachable after reload; satisfies types
      }
      // Known-matching lineage, or a server that has never restored (epoch 0) —
      // nothing a push could resurrect.
      pushAllowed = knownEpoch !== null || serverEpoch === 0;
      if (!pushAllowed) {
        logger.warn(
          `Local lineage unknown but server has restore history (epoch ${serverEpoch}) — skipping push, adopting`
        );
      }
    } catch (epochErr) {
      logger.warn('Epoch pre-check failed — skipping push (pull-only resync)', { err: epochErr });
    }

    const result = await reconcile({
      client: httpClient,
      doc: sharedDoc,
      pushSource: { kind: 'doc' },
      pushAllowed,
      makeTxId: generateTxId,
      applyOrigin: 'reconnect-authority',
      adoptEpoch: true,
      treatEmptyStateAsApplied: false,
    });

    // A failed PULL is a failed resync (a failed push is not — we logged it and
    // pulled anyway).
    if (result.pullError) throw result.pullError;

    if (result.appliedServerState) {
      logger.info(
        `Bidirectional resync complete: pushed ${result.pushedBytes} bytes, pulled ${result.pulledBytes} bytes, seq: ${result.latestSeq}`
      );
    }
    setLastSyncError(null);
    return { pushedBytes: result.pushedBytes };
  } catch (err) {
    logger.error('Full resync failed', { err });
    setLastSyncError(`Resync failed: ${String(err)}`);
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════
// SINGLETON Y.DOC
// ═══════════════════════════════════════════════════════════════

// Y.Doc is a singleton - survives component unmount/remount cycles.
// Only the update observer is cleaned up per-component.
// FLO-197/P4: Enable GC to prevent tombstone accumulation (safe with single-client)
const sharedDoc = new Y.Doc({ gc: true });
let sharedDocLoaded = false;
let sharedDocError: string | null = null;
let sharedDocLoadPromise: Promise<void> | null = null;

// Reactive mirrors of the two load-state vars above. Module-level (like
// syncStatus) so every useSyncedYDoc() consumer shares one source of truth —
// and so retryInitialLoad() can flip them from OUTSIDE the hook. The plain
// vars stay because non-reactive module code reads them without tracking.
const [sharedLoadedSignal, setSharedLoadedSignal] = createSignal(false);
const [sharedErrorSignal, setSharedErrorSignal] = createSignal<string | null>(null);

/** Copy the plain load-state vars into their reactive mirrors. */
function syncLoadSignals(): void {
  setSharedLoadedSignal(sharedDocLoaded);
  setSharedErrorSignal(sharedDocError);
}

/**
 * Reactive initial-load state. App's banner-clear effect watches this so an
 * Outliner-Retry that completes the load also clears the connection banner
 * without waiting for the next reconnect-poll tick.
 */
export const getInitialLoadState: Accessor<boolean> = sharedLoadedSignal;

/**
 * Has the initial load completed? Module-level, non-reactive.
 * useSyncHealth gates on this: a health check against a store that is still
 * empty mid-boot reports a phantom "Local: 0 blocks" mismatch and can trigger
 * a full resync ON TOP of the in-flight boot (boot-sequence audit §3.5).
 */
export function isInitialLoadComplete(): boolean {
  return sharedDocLoaded;
}

// UndoManager for the blocks map (singleton, tied to shared doc)
let sharedUndoManager: Y.UndoManager | null = null;

// Sync machinery is also singleton (tied to the shared doc)
let sharedPendingUpdates: Uint8Array[] = [];
let sharedSyncTimer: number | null = null;
let sharedIsFlushing = false;
let sharedRetryCount = 0;
const MAX_RETRIES = 5;
const DEFAULT_SYNC_DEBOUNCE = 50;

// ═══════════════════════════════════════════════════════════════
// REF-COUNTED HANDLER ATTACHMENT
// ═══════════════════════════════════════════════════════════════
// Multiple Outliner panes call useSyncedYDoc() - each would attach its own
// update handler to the singleton doc. This caused 3x queueUpdate calls
// with 3 panes open. Solution: attach handler once, ref-count consumers.

let handlerRefCount = 0;
let moduleUpdateHandler: ((update: Uint8Array, origin: unknown) => void) | null = null;
let isApplyingRemoteGlobal = false; // Module-level flag for handler

/**
 * Module-level schedule flush - uses DEFAULT_SYNC_DEBOUNCE.
 * Called by the singleton update handler.
 */
function scheduleFlushModule(delay?: number) {
  if (sharedSyncTimer) {
    clearTimeout(sharedSyncTimer);
  }
  sharedSyncTimer = window.setTimeout(flushUpdatesModule, delay ?? DEFAULT_SYNC_DEBOUNCE);
}

/**
 * Module-level flush updates - same logic as hook's flushUpdates but without
 * per-component error signal.
 */
async function flushUpdatesModule() {
  if (sharedIsFlushing || sharedPendingUpdates.length === 0) return;

  if (!isClientInitialized()) {
    logger.warn('HTTP client not initialized, skipping flush');
    return;
  }

  sharedIsFlushing = true;
  const updates = sharedPendingUpdates;
  sharedPendingUpdates = [];

  let sentCount = 0;
  try {
    const httpClient = getHttpClient();
    for (const update of updates) {
      const txId = generateTxId();
      await httpClient.applyUpdate(update, txId);
      sentCount++;
    }
    sharedRetryCount = 0;

    if (sharedPendingUpdates.length === 0) {
      if (!isDriftStatus()) {
        setSyncStatus('synced');
        setLastSyncError(null);
      }
      // Durable-cache model (fast-boot Phase 1): keep the backup — it is the
      // next boot's cache. It was previously cleared here on every completed
      // flush, which is exactly why the cache-boot path could never fire
      // (audit §3.1: written 24.8MB dozens of times a day, then deleted).
    }
    setPendingCount(sharedPendingUpdates.length);
  } catch (err) {
    sharedRetryCount++;
    logger.error(`Failed to sync to server (attempt ${sharedRetryCount}/${MAX_RETRIES})`, { err });
    sharedPendingUpdates = [...updates.slice(sentCount), ...sharedPendingUpdates];
    setPendingCount(sharedPendingUpdates.length);

    if (sharedRetryCount >= MAX_RETRIES) {
      setSyncStatus('error');
      setLastSyncError(`Sync failed after ${MAX_RETRIES} attempts. Changes may not be saved.`);
      sharedRetryCount = 0;
    } else if (sharedPendingUpdates.length > 0) {
      const backoffDelay = Math.min(DEFAULT_SYNC_DEBOUNCE * Math.pow(2, sharedRetryCount), 10000);
      scheduleFlushModule(backoffDelay);
    }
  } finally {
    sharedIsFlushing = false;
  }
}

/**
 * Module-level queue update - called by singleton handler.
 */
function queueUpdateModule(update: Uint8Array) {
  sharedPendingUpdates.push(update);
  setPendingCount(sharedPendingUpdates.length);
  setSyncStatus('pending');
  scheduleFlushModule();
  scheduleBackup();
}

/**
 * Attach the singleton update handler (ref-counted).
 * Call in onMount - only first caller actually attaches.
 */
function attachHandler() {
  handlerRefCount++;
  if (handlerRefCount === 1) {
    moduleUpdateHandler = (update: Uint8Array, origin: unknown) => {
      if (origin === 'remote' || isApplyingRemoteGlobal) return;
      queueUpdateModule(update);
    };
    sharedDoc.on('update', moduleUpdateHandler);
    logger.info('Attached singleton update handler');
  }
}

/**
 * Detach the singleton update handler (ref-counted).
 * Call in onCleanup - only last caller actually detaches.
 */
function detachHandler() {
  handlerRefCount--;
  if (handlerRefCount === 0 && moduleUpdateHandler) {
    sharedDoc.off('update', moduleUpdateHandler);
    moduleUpdateHandler = null;
    logger.info('Detached singleton update handler');

    // Also clean up sync timer since no consumers remain
    if (sharedSyncTimer) {
      clearTimeout(sharedSyncTimer);
      sharedSyncTimer = null;
    }
  }
}

/**
 * Set the global isApplyingRemote flag.
 * Called during initial load and reconciliation.
 */
function setApplyingRemote(value: boolean) {
  isApplyingRemoteGlobal = value;
}

// WebSocket for real-time sync from server
let sharedWebSocket: WebSocket | null = null;
let wsReconnectTimer: number | null = null;
let wsRetryCount = 0;
let wsHasConnectedOnce = false; // FLO-269: Distinguish first connect from reconnect
const WS_RECONNECT_DELAY = 2000;
const WS_MAX_RECONNECT_DELAY = 30000;

// FLO-152: Message buffering to prevent race condition on reconnect
// Problem: onopen schedules microtask, but WS messages arrive before it runs,
// causing live updates to be overwritten by the subsequent full state fetch.
// Solution: Buffer incoming messages until reconnect sync completes, then replay.
let wsReadyForMessages = true; // Start true - only false during reconnect sync
let wsConnectionId = 0; // FLO-152: Guards against stale IIFE setting wsReadyForMessages
const WS_MESSAGE_BUFFER_MAX = 100; // Prevent unbounded growth if sync hangs
let wsBufferOverflowLatched = false; // FLO-289: first overflow triggers forced recovery
let wsOverflowRecoveryInFlight = false; // FLO-289: single-flight recovery guard

type ReconnectBufferAction = 'buffer' | 'overflow-first' | 'overflow-repeat';

/**
 * Decide reconnect buffering behavior.
 * - buffer: safe to enqueue message
 * - overflow-first: first overflow in this reconnect cycle (latch + recovery)
 * - overflow-repeat: overflow already latched; keep dropping to avoid replaying partial stream
 */
export function resolveReconnectBufferAction(
  bufferLength: number,
  maxBufferSize: number,
  overflowLatched: boolean
): ReconnectBufferAction {
  if (overflowLatched) return 'overflow-repeat';
  if (bufferLength < maxBufferSize) return 'buffer';
  return 'overflow-first';
}

/**
 * Returns true when reconnect overflow should trigger a new forced recovery.
 * Used to prevent resync storms.
 */
export function shouldStartOverflowRecovery(
  overflowLatched: boolean,
  recoveryInFlight: boolean
): boolean {
  return overflowLatched && !recoveryInFlight;
}

// ═══════════════════════════════════════════════════════════════
// SEQUENCE NUMBER TRACKING (gap detection & incremental reconnect)
// ═══════════════════════════════════════════════════════════════

/** WS message from server (now includes seq for gap detection) */
interface WsMessage {
  /** Sequence number from persistence layer (for gap detection). Missing on restore broadcasts. */
  seq?: number;
  /** Transaction ID for echo prevention */
  txId?: string;
  /** Base64-encoded Y.Doc update bytes. Undefined for heartbeat messages (seq-only). */
  data?: string;
  /** Doc epoch. Present on restore frames and heartbeats — a change means the
   * server's doc is a NEW LINEAGE (destructive restore) and this client must
   * hard-reset, never merge (quirk-audit 2026-07-09, sync cluster). */
  epoch?: number;
}

// ═══════════════════════════════════════════════════════════════
// DOC EPOCH (destructive-restore lineage tracking)
// ═══════════════════════════════════════════════════════════════
// The server bumps its doc epoch on every destructive restore. This client
// remembers the epoch it synced against (module state + IndexedDB). On any
// mismatch it must ADOPT the server's state into a fresh Y.Doc — merging the
// old doc in (or diff-pushing it back) resurrects deleted content. The
// sharedDoc singleton is referenced everywhere, so "fresh Y.Doc" is
// implemented as: drop pending, clear the stale-lineage backup + seq baseline,
// persist the new epoch, and reload the window. Boot then pulls the restored
// state cleanly. Restores are rare, user-confirmed destructive ops — a reload
// is acceptable (arguably expected) UX.

let knownEpoch: number | null = null;
let epochResetInProgress = false;

async function hardEpochReset(newEpoch: number | null, reason: string): Promise<void> {
  if (epochResetInProgress) return;
  epochResetInProgress = true;
  logger.warn(
    `Doc epoch changed (${knownEpoch} → ${newEpoch}): ${reason} — hard reset (drop pending, clear stale backup, reload)`
  );

  // Stop outbound sync — pending updates are old-lineage and must not land.
  if (sharedSyncTimer) {
    clearTimeout(sharedSyncTimer);
    sharedSyncTimer = null;
  }
  sharedPendingUpdates = [];
  seqTracker.resetForRestore();

  try {
    await clearBackupIDB();
    await clearLastContiguousSeqIDB();
    if (newEpoch !== null) {
      await saveKnownEpochIDB(newEpoch);
    } else {
      // Pre-epoch server restore: lineage unknowable — delete the record so
      // the next boot doesn't compare a stale epoch against hash epoch 0 and
      // discard valid backups / reset repeatedly.
      await clearKnownEpochIDB();
    }
  } catch (err) {
    logger.error('Epoch reset: failed to clear stale persistence (reloading anyway)', { err });
  }

  window.location.reload();
}

// ═══════════════════════════════════════════════════════════════
// SEQUENCE TRACKING (extracted to SyncSequenceTracker)
// ═══════════════════════════════════════════════════════════════

/** How often to persist lastContiguousSeq (debounce interval) */
const CONTIGUOUS_SEQ_PERSIST_DEBOUNCE_MS = 5000;

/** Debounce timer for persisting lastContiguousSeq to IndexedDB */
let contiguousSeqPersistTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Schedule a debounced save of lastContiguousSeq to IndexedDB.
 * Used as callback for SyncSequenceTracker.
 *
 * IMPORTANT: We persist lastContiguousSeq, NOT lastSeenSeq!
 * - lastSeenSeq may jump on gaps (e.g., receive seq 419 but missed 418)
 * - lastContiguousSeq only advances when ALL prior seqs are received
 * - On reload, "since lastContiguousSeq" fetches gaps + new updates safely
 */
function scheduleContiguousSeqPersist(seq: number): void {
  if (contiguousSeqPersistTimer !== null) {
    clearTimeout(contiguousSeqPersistTimer);
  }
  contiguousSeqPersistTimer = setTimeout(() => {
    contiguousSeqPersistTimer = null;
    saveLastContiguousSeqIDB(seq).catch((err: unknown) => {
      logger.warn('Failed to persist lastContiguousSeq', { err });
    });
  }, CONTIGUOUS_SEQ_PERSIST_DEBOUNCE_MS);
}

/**
 * Singleton sequence tracker instance.
 * Manages lastSeenSeq, lastContiguousSeq, gap queue, and fetch coordination.
 * Created with persistence callback that fires on CONTIGUOUS advancement.
 */
const seqTracker = new SyncSequenceTracker(scheduleContiguousSeqPersist);

/**
 * Threshold for gap size before falling back to full resync.
 * If gap > 100, fetching individual updates may be slower than full state.
 */
const GAP_THRESHOLD_FOR_FULL_RESYNC = 100;

/** Message buffer (seq-aware) */
let wsMessageBuffer: WsMessage[] = [];

// Echo prevention: track txIds we sent to filter them from broadcasts
const recentTxIds = new Set<string>();
const MAX_RECENT_TX_IDS = 50; // Prevent unbounded growth
let txIdCounter = 0;

/** Generate a unique transaction ID */
function generateTxId(): string {
  const id = `${Date.now()}-${txIdCounter++}`;
  recentTxIds.add(id);
  // Trim old entries if set gets too large
  while (recentTxIds.size > MAX_RECENT_TX_IDS) {
    const iterator = recentTxIds.values();
    const oldest = iterator.next().value;
    if (oldest !== undefined) {
      recentTxIds.delete(oldest);
    }
  }
  return id;
}

// ═══════════════════════════════════════════════════════════════
// PENDING-STRUCTS WATCHDOG (FLO-895)
// ═══════════════════════════════════════════════════════════════
// Gap detection catches the missing frames we NOTICE. This catches the ones
// we don't: it reads yjs's own stash of un-integrable ops, which is the
// ground truth for "the doc is frozen and nothing reported it".
//
// Decision logic (thresholds, cooldown, escalation) lives in
// `lib/pendingStructsWatchdog.ts` so it can be tested against a fake clock.
// This is the wiring: sample the doc, perform the action.

const pendingWatchdog = createPendingStructsWatchdog();
let pendingWatchdogTimer: ReturnType<typeof setInterval> | null = null;
/** A heal is in flight — don't stack pulls if one runs long on a large doc. */
let pendingWatchdogHealing = false;

/**
 * Identity of the ops yjs is currently unable to integrate, or null if none.
 *
 * `pendingStructs` is an update whose causal dependencies are missing;
 * `pendingDs` is a delete set referencing structs that haven't arrived. Both
 * stall silently and both present as stale content, so both count.
 *
 * The signature includes the missing client/clock pairs so the watchdog can
 * tell "the heal made progress" from "the heal changed nothing" — which is the
 * difference between retrying and giving up (see the module header).
 */
function pendingStructsSignature(): StashSignature {
  const store = sharedDoc.store;
  const ps = store.pendingStructs;
  const ds = store.pendingDs;
  if (!ps && !ds) return null;

  const missing = ps
    ? [...ps.missing.entries()]
        .map(([client, clock]) => `${client}@${clock}`)
        .sort()
        .join(',')
    : '';
  return `structs:${ps?.update.length ?? 0}[${missing}]|ds:${ds?.length ?? 0}`;
}

/** Human-readable detail for the one loud log an unfillable stash earns. */
function pendingStructsDetail(): string {
  const ps = sharedDoc.store.pendingStructs;
  if (!ps) return 'delete-set only';
  const pairs = [...ps.missing.entries()]
    .slice(0, 8)
    .map(([client, clock]) => `${client}@${clock}`)
    .join(', ');
  return `${ps.update.length}B waiting on ${ps.missing.size} client(s): ${pairs}`;
}

async function runPendingStructsHeal(): Promise<void> {
  if (pendingWatchdogHealing) return;
  pendingWatchdogHealing = true;
  try {
    await pullServerDiffNow();
  } catch (err) {
    logger.error('Pending-structs heal failed', { err });
  } finally {
    pendingWatchdogHealing = false;
  }
}

function samplePendingStructs(): void {
  if (!sharedDocLoaded) return;

  const action = pendingWatchdog.sample(pendingStructsSignature(), Date.now());
  switch (action.kind) {
    case 'idle':
    case 'watch':
    case 'settling':
    case 'dormant':
      return;

    case 'cleared':
      logger.info(
        `Pending-structs stash drained after ${Math.round(action.stalledMs / 1000)}s ` +
          `(${action.healAttempts} heal attempt${action.healAttempts === 1 ? '' : 's'})`
      );
      return;

    case 'heal':
      recordPendingStructsStall();
      logger.warn(
        `Pending-structs stall: yjs has held un-integrable ops for ` +
          `${Math.round(action.stalledMs / 1000)}s — this doc is frozen and no other ` +
          `layer reports it. Pulling a state diff (attempt ${action.attempt}). ` +
          pendingStructsDetail()
      );
      void runPendingStructsHeal();
      return;

    case 'unfillable':
      // Not retried: the diff comes from the same server doc that lacks these
      // ops, and a full resync would reproduce the identical stash at far
      // greater cost. Logged once so the doc-level integrity problem is
      // visible without turning into a pull loop.
      recordUnfillableStash();
      logger.error(
        `Pending-structs stash is UNFILLABLE after ${action.attempts} diff pull(s) ` +
          `(${Math.round(action.stalledMs / 1000)}s): the server cannot supply the ` +
          `missing ops, so these will never integrate. ` +
          pendingStructsDetail() +
          ' — no further pulls for this stash.'
      );
      return;
  }
}

/** Start sampling. Idempotent — called once the shared doc is live. */
function startPendingStructsWatchdog(): void {
  if (pendingWatchdogTimer) return;
  pendingWatchdogTimer = setInterval(samplePendingStructs, PENDING_SAMPLE_INTERVAL_MS);
  logger.info(`Pending-structs watchdog armed (${PENDING_SAMPLE_INTERVAL_MS}ms sampling)`);
}

// ═══════════════════════════════════════════════════════════════
// ECHO GAP DEBOUNCE (FLO-391)
// ═══════════════════════════════════════════════════════════════
// Server-side hooks (MetadataExtraction, InheritanceIndex) persist updates
// that consume seq numbers but — prior to FLO-391 — weren't broadcast.
// Now they ARE broadcast, but there's a timing race: the hook runs on
// spawn_blocking, so during fast typing the next client echo can arrive
// before the hook's broadcast. Debouncing echo gap-fill by 200ms lets
// hook broadcasts fill the gap naturally.

let echoGapTimer: ReturnType<typeof setTimeout> | null = null;
let pendingEchoGap: { fromSeq: number; toSeq: number } | null = null;

function scheduleEchoGapFetch(fromSeq: number, toSeq: number): void {
  // Merge with existing pending gap if present
  if (pendingEchoGap) {
    pendingEchoGap.fromSeq = Math.min(pendingEchoGap.fromSeq, fromSeq);
    pendingEchoGap.toSeq = Math.max(pendingEchoGap.toSeq, toSeq);
  } else {
    pendingEchoGap = { fromSeq, toSeq };
  }

  // Reset timer
  if (echoGapTimer) clearTimeout(echoGapTimer);
  echoGapTimer = setTimeout(() => {
    echoGapTimer = null;
    if (!pendingEchoGap) return;

    // Check if gap was filled by intervening messages (hook broadcasts)
    const contiguous = seqTracker.lastContiguousSeq;
    if (contiguous !== null && contiguous >= pendingEchoGap.toSeq - 1) {
      wsLogger.debug('Echo gap resolved by hook broadcasts, skipping fetch');
      pendingEchoGap = null;
      return;
    }

    // Gap still open — genuine missed update, fetch it
    wsLogger.warn(`Echo gap persisted after debounce, fetching: ${pendingEchoGap.fromSeq} → ${pendingEchoGap.toSeq}`);
    recordEchoGapFill();
    queueGapFetch(pendingEchoGap.fromSeq, pendingEchoGap.toSeq);
    pendingEchoGap = null;
  }, 200);
}

/**
 * Apply a WebSocket message to the Y.Doc.
 * Extracted to support buffering during reconnect (FLO-152).
 *
 * Now includes sequence number tracking for gap detection via SyncSequenceTracker.
 */
function applyWsMessage(msg: WsMessage) {
  // Echo prevention: skip APPLICATION if this is our own update
  // But still run gap detection - the seq may reveal missed updates from others
  if (msg.txId && recentTxIds.has(msg.txId)) {
    wsLogger.debug(`Skipping own update application (txId: ${msg.txId})`);
    recentTxIds.delete(msg.txId);

    // Gap detection for echoed messages via tracker
    // Our message's seq may reveal we missed updates from other clients
    // FLO-391: Debounce echo gap-fill by 200ms — hook broadcasts arrive in that window
    if (msg.seq !== undefined) {
      const gap = seqTracker.observeEcho(msg.seq);
      if (gap) {
        wsLogger.debug(`Echo gap (${gap.fromSeq} → ${gap.toSeq}), deferring fetch 200ms for hook broadcasts`);
        scheduleEchoGapFetch(gap.fromSeq, gap.toSeq);
      }
    }
    return;
  }

  // Heartbeat: seq-only message (no payload).
  // Epoch check first — a client that missed the restore frame (zombied
  // socket, reconnect window) learns about the lineage change here.
  if (msg.seq !== undefined && !msg.data) {
    if (msg.epoch !== undefined && knownEpoch !== null && msg.epoch !== knownEpoch) {
      void hardEpochReset(msg.epoch, 'heartbeat epoch mismatch');
      return;
    }
    const gap = seqTracker.observeHeartbeat(msg.seq);
    if (gap) {
      wsLogger.warn(`Gap detected (heartbeat): ${gap.fromSeq} → ${gap.toSeq} (missing up to ${gap.toSeq - gap.fromSeq} updates)`);
      queueGapFetch(gap.fromSeq, gap.toSeq);
    }
    return;
  }

  // Restore/full-state broadcast: data but no seq. The server's doc is a NEW
  // LINEAGE — CRDT-merging it into the old doc (the previous behavior)
  // preserved locally-known deleted content and pushed it back on the next
  // resync (quirk-audit Hole 1). Hard-reset instead: adopt fresh via reload.
  // Frames from pre-epoch servers (no epoch field) hard-reset too — a restore
  // is destructive by definition.
  if (msg.seq === undefined && msg.data) {
    wsLogger.warn('Restore broadcast detected (data without seq) — hard epoch reset');
    void hardEpochReset(msg.epoch ?? null, 'restore broadcast');
    return;
  }

  // Gap detection for regular (non-echo) messages via tracker
  if (msg.seq !== undefined) {
    const gap = seqTracker.observeSeq(msg.seq);
    if (gap) {
      // Gap detected! We missed seq(s) between gap.fromSeq and gap.toSeq
      wsLogger.warn(`Gap detected: ${gap.fromSeq} → ${gap.toSeq} (missing ${gap.toSeq - gap.fromSeq - 1} updates)`);

      // NOTE: We apply this message immediately even though earlier seq(s) are missing.
      // This is safe because Y.Doc CRDT merge is commutative — application order doesn't
      // affect the final document state. The gap-fill fetch runs async and applies the
      // missing updates when they arrive. The end state is identical regardless of order.
      queueGapFetch(gap.fromSeq, gap.toSeq);
    }
  }

  // Decode base64 and apply (skip for heartbeat messages with no data)
  if (msg.data) {
    const update = base64ToBytes(msg.data);
    Y.applyUpdate(sharedDoc, update, 'remote');
  }
}

/**
 * Queue a gap fetch. If no fetch is in progress, starts immediately.
 * If a fetch is in progress, queues the gap to be processed after.
 */
function queueGapFetch(fromSeq: number, toSeq: number): void {
  if (seqTracker.isFetching) {
    // Queue the gap - will be processed after current fetch
    seqTracker.queueGap(fromSeq, toSeq);
    wsLogger.debug(`Queued gap fetch (${fromSeq} → ${toSeq}), queue size: ${seqTracker.pendingGapQueue.length}`);
    return;
  }

  // No fetch in progress - start immediately
  // Note: fetchMissingUpdates has internal try/catch, but add .catch() for any
  // unexpected throws (e.g., dynamic import failure) to prevent unhandled rejection
  fetchMissingUpdates(fromSeq, toSeq).catch((err) =>
    wsLogger.error('Unhandled error in gap fetch', { err })
  );
}

/**
 * Process the next gap in the queue, if any.
 * Called after a gap fetch completes.
 */
function processNextQueuedGap(): void {
  // consolidateGaps handles: empty check, gap consolidation, coverage check, queue clearing
  const consolidated = seqTracker.consolidateGaps();
  if (!consolidated) {
    // Either no gaps queued, or already covered by lastContiguousSeq
    return;
  }

  wsLogger.debug(`Processing consolidated queued gap: ${consolidated.fromSeq} → ${consolidated.toSeq} (contiguous: ${seqTracker.lastContiguousSeq})`);
  fetchMissingUpdates(consolidated.fromSeq, consolidated.toSeq).catch((err) =>
    wsLogger.error('Unhandled error in queued gap fetch', { err })
  );
}

/**
 * Fetch missing updates when a gap is detected.
 * Runs async - doesn't block current message processing.
 * Falls back to full resync if gap is too large or updates are compacted.
 */
async function fetchMissingUpdates(fromSeq: number, toSeq: number): Promise<void> {
  // Guard against concurrent fetches (shouldn't happen with queue, but be safe)
  if (!seqTracker.markFetchStarted()) {
    wsLogger.warn('Unexpected concurrent fetch attempt, queueing');
    seqTracker.queueGap(fromSeq, toSeq);
    return;
  }

  const gapSize = toSeq - fromSeq - 1;

  // Large gap - full resync is faster
  if (gapSize > GAP_THRESHOLD_FOR_FULL_RESYNC) {
    wsLogger.info(`Gap too large (${gapSize} updates), triggering full resync`);
    seqTracker.resetForRestore(); // Clear queue and reset seq tracking
    seqTracker.markFetchDone();
    await triggerFullResync();
    return;
  }

  try {
    const { getHttpClient, isClientInitialized } = await import('../lib/httpClient');
    if (!isClientInitialized()) {
      wsLogger.warn('HTTP client not initialized, cannot fetch missing updates');
      return;
    }

    const httpClient = getHttpClient();
    recordGapFill();
    const result = await httpClient.getUpdatesSince(fromSeq, gapSize + 1);

    if (!result.ok) {
      // 410 Gone - updates were compacted, need full resync
      wsLogger.warn(`Updates compacted (through seq ${result.compactedThrough}), triggering full resync`);
      seqTracker.resetForRestore(); // Clear queue and reset seq tracking
      await triggerFullResync();
      return;
    }

    // Apply the missing updates
    const { updates, latestSeq } = result.response;
    wsLogger.info(`Fetched ${updates.length} missing updates (seq ${fromSeq} → ${latestSeq ?? 'unknown'})`);

    try {
      isApplyingRemoteGlobal = true;
      for (const entry of updates) {
        const update = base64ToBytes(entry.data);
        Y.applyUpdate(sharedDoc, update, 'gap-fill');
        // Gap-fill updates are contiguous - advance contiguous tracking
        seqTracker.advanceContiguous(entry.seq);
      }
    } finally {
      isApplyingRemoteGlobal = false;
    }
  } catch (err) {
    wsLogger.error('Failed to fetch missing updates', { err });
    // Fall back to full resync on any error
    seqTracker.resetForRestore(); // Clear queue and reset seq tracking
    await triggerFullResync();
  } finally {
    seqTracker.markFetchDone();
    // Process any gaps that were queued during this fetch
    processNextQueuedGap();
  }
}

// ═══════════════════════════════════════════════════════════════
// INDEXEDDB BACKUP (crash resilience)
// ═══════════════════════════════════════════════════════════════
// Migrated from localStorage (2026-01-23) due to 5MB limit.
// IndexedDB supports binary storage directly (no base64 overhead)
// and has much higher quotas (typically 50MB+ or % of disk).

const YDOC_BACKUP_KEY = 'floatty_ydoc_backup'; // For migration only
const BACKUP_DEBOUNCE_MS = 1000;
let backupTimer: number | null = null;

/**
 * Schedule a backup of current Y.Doc state to IndexedDB.
 * Called when local changes are queued, providing crash resilience.
 */
function scheduleBackup() {
  if (backupTimer) clearTimeout(backupTimer);
  backupTimer = window.setTimeout(async () => {
    try {
      // Timed as boot_phase: this full-doc encode is a main-thread cost in
      // the same class R14 instruments — and Phase 1 made it fire after
      // every online boot, not just after edits. PR 4 (y-indexeddb) replaces
      // the snapshot model with O(delta) writes; this number is its baseline.
      const encodeStart = performance.now();
      const state = Y.encodeStateAsUpdate(sharedDoc);
      logger.info(
        `boot_phase=backup_encode elapsed_ms=${Math.round(performance.now() - encodeStart)} bytes=${state.length}`
      );
      await saveBackupIDB(state);
      logger.debug(`Backed up Y.Doc to IndexedDB: ${state.length} bytes`);
    } catch (err) {
      logger.error('Failed to backup Y.Doc', { err });
    }
  }, BACKUP_DEBOUNCE_MS);
}

/**
 * Check if a legacy localStorage backup exists (sync check).
 * @deprecated Use getBackup() from idbBackup.ts for new code.
 * This only checks localStorage, not IndexedDB.
 */
export function hasLocalBackup(): boolean {
  try {
    return localStorage.getItem(YDOC_BACKUP_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * Get the backup if it exists (checks both IndexedDB and legacy localStorage).
 */
export async function getLocalBackup(): Promise<Uint8Array | null> {
  try {
    // Try IndexedDB first (new location)
    const idbBackup = await getBackupIDB();
    if (idbBackup) return idbBackup;

    // Fallback to localStorage (legacy migration)
    const lsBackup = localStorage.getItem(YDOC_BACKUP_KEY);
    if (lsBackup) {
      logger.debug('Found legacy localStorage backup, migrating to IndexedDB');
      const bytes = base64ToBytes(lsBackup);
      await saveBackupIDB(bytes);
      localStorage.removeItem(YDOC_BACKUP_KEY);
      logger.debug('Migration complete');
      return bytes;
    }

    return null;
  } catch (err) {
    logger.warn('Failed to read backup', { err });
    return null;
  }
}

/**
 * FLO-247: Startup sanity check - detect suspicious Y.Doc state.
 *
 * Logs warnings for states that might indicate data corruption or
 * accidental wipe. Future: Could show modal for confirmation.
 *
 * NOTE: Returns void - this is logging-only, doesn't gate startup.
 */
async function validateSyncedState(doc: Y.Doc): Promise<void> {
  try {
    const blocksMap = doc.getMap('blocks');
    const rootIdsArray = doc.getArray<string>('rootIds');

    const blockCount = blocksMap.size;
    const rootCount = rootIdsArray.length;

    // Suspicious: 0 blocks but backup existed (possible server wipe)
    if (blockCount === 0) {
      const hadBackup = await hasBackupIDB();
      if (hadBackup) {
        logger.warn('Server returned empty but IndexedDB backup exists!');
        logger.warn('This could indicate server wipe. Check ctx_markers.db in your FLOATTY_DATA_DIR');
        return;
      }
    }

    // Suspicious: Very few blocks (might be test data)
    if (blockCount > 0 && blockCount < 10) {
      logger.warn(`Very few blocks (${blockCount}) - might be test data`);
    }

    // Suspicious: No roots but blocks exist (orphaned blocks)
    if (rootCount === 0 && blockCount > 0) {
      logger.warn(`${blockCount} blocks exist but no root IDs!`);
      return;
    }

    // Suspicious: More roots than expected (usually 2-3)
    if (rootCount > 20) {
      logger.warn(`Unusually many root blocks (${rootCount})`);
    }

    logger.info(`State looks healthy: ${blockCount} blocks, ${rootCount} roots`);
  } catch (err) {
    logger.warn('Sanity check failed', { err });
  }
}

// Export for testing
export { validateSyncedState };

/**
 * Force flush pending updates immediately.
 * Used on WebSocket reconnect to sync state before receiving broadcasts.
 */
async function forceFlushOnReconnect() {
  if (sharedIsFlushing || sharedPendingUpdates.length === 0) return;

  if (!isClientInitialized()) {
    logger.warn('HTTP client not initialized, cannot flush');
    return;
  }

  sharedIsFlushing = true;
  const updates = sharedPendingUpdates;
  sharedPendingUpdates = [];

  try {
    const { getHttpClient } = await import('../lib/httpClient');
    const httpClient = getHttpClient();
    for (const update of updates) {
      const txId = generateTxId();
      await httpClient.applyUpdate(update, txId);
    }
    sharedRetryCount = 0;
    setPendingCount(sharedPendingUpdates.length);
    wsLogger.info('Successfully flushed pending updates on reconnect');
  } catch (err) {
    wsLogger.error('Failed to flush pending updates on reconnect', { err });
    // Restore updates for retry
    sharedPendingUpdates = [...updates, ...sharedPendingUpdates];
    setPendingCount(sharedPendingUpdates.length);
  } finally {
    sharedIsFlushing = false;
  }
}

// Re-exported so existing consumers/tests keep one import surface; canonical
// home is lib/wsUrl.ts (shared with doorSandbox — FLO-762).
import { buildWsUrl } from '../lib/wsUrl';
export { buildWsUrl };

/**
 * Connect to WebSocket for real-time updates from server.
 * Called once after initial state load.
 */
function connectWebSocket() {
  // Already connected, connecting, or closing - avoid duplicate connections
  if (sharedWebSocket?.readyState === WebSocket.OPEN ||
      sharedWebSocket?.readyState === WebSocket.CONNECTING ||
      sharedWebSocket?.readyState === WebSocket.CLOSING) {
    return;
  }

  // Get server URL from httpClient config
  const serverUrl = window.__FLOATTY_SERVER_URL__;
  if (!serverUrl) {
    wsLogger.warn('Server URL not set, skipping WebSocket');
    return;
  }

  // Convert http://localhost:8765 to ws://localhost:8765/ws, with the API key
  // as a query token (FLO-762 — see buildWsUrl).
  const wsUrl = buildWsUrl(serverUrl, window.__FLOATTY_API_KEY__);
  // Log the bare endpoint only — the token is a credential (logging-discipline §1).
  wsLogger.info(`Connecting to ${wsUrl.split('?')[0]}`);

  try {
    sharedWebSocket = new WebSocket(wsUrl);

    sharedWebSocket.onopen = () => {
      wsLogger.info('Connected');
      // Reset retry count on successful connection
      wsRetryCount = 0;

      const isReconnect = wsHasConnectedOnce;
      wsHasConnectedOnce = true;

      // FLO-152: Increment connection ID to invalidate any stale IIFEs
      const thisConnectionId = ++wsConnectionId;

      // Clear any previous connection error now that we're connected
      if (sharedPendingUpdates.length === 0 && !isDriftStatus()) {
        setSyncStatus('synced');
        setLastSyncError(null);
      }

      if (isReconnect) {
        // RECONNECT: sync with buffering (FLO-152)
        // Now supports incremental sync via lastSeenSeq when available
        // FLO-152: Mark NOT ready for messages - buffer incoming until sync completes
        wsReadyForMessages = false;
        wsMessageBuffer = [];
        wsBufferOverflowLatched = false;

        // Reconnection sync: flush local pending, then fetch any missed server updates.
        // This prevents stale state if server received updates while we were disconnected.
        // FLO-152: Use IIFE instead of queueMicrotask to control message buffering
        (async () => {
          try {
            // 1. Flush local pending updates first
            if (sharedPendingUpdates.length > 0) {
              wsLogger.debug(`Flushing ${sharedPendingUpdates.length} pending updates on reconnect`);
              if (sharedSyncTimer) {
                clearTimeout(sharedSyncTimer);
                sharedSyncTimer = null;
              }
              await forceFlushOnReconnect();
            }

            // 2. Fetch any updates we missed during disconnection
            const { getHttpClient } = await import('../lib/httpClient');
            const httpClient = getHttpClient();

            // Try incremental sync if we have a lastSeenSeq
            // Loop through pages since server may paginate results (default limit 100)
            // Cap at 50 pages (5000 updates) to prevent infinite loop if server is receiving
            // updates faster than we can fetch them
            const MAX_RECONNECT_PAGES = 50;
            let syncedIncrementally = false;
            if (seqTracker.lastSeenSeq !== null) {
              wsLogger.debug(`Attempting incremental reconnect sync (since seq: ${seqTracker.lastSeenSeq})`);
              let currentSeq = seqTracker.lastSeenSeq;
              let totalApplied = 0;
              let pageCount = 0;

              // Loop until we've fetched all pages (or hit ceiling)
              while (pageCount < MAX_RECONNECT_PAGES) {
                pageCount++;
                const result = await httpClient.getUpdatesSince(currentSeq);

                if (!result.ok) {
                  // 410 Gone - updates were compacted, need full resync
                  wsLogger.warn(`Incremental sync unavailable (compacted through ${result.compactedThrough}), falling back to full sync`);
                  break;
                }

                const { updates, latestSeq } = result.response;

                if (updates.length === 0) {
                  // No more updates to fetch
                  if (totalApplied > 0) {
                    wsLogger.info(`Incremental sync complete: applied ${totalApplied} updates total`);
                  } else {
                    wsLogger.debug('Incremental sync: no new updates (already up to date)');
                  }
                  syncedIncrementally = true;
                  break;
                }

                // Apply this page of updates
                wsLogger.debug(`Incremental sync: applying ${updates.length} updates (seq ${currentSeq} → ${updates[updates.length - 1].seq})`);
                try {
                  isApplyingRemoteGlobal = true;
                  for (const entry of updates) {
                    const update = base64ToBytes(entry.data);
                    Y.applyUpdate(sharedDoc, update, 'reconnect-authority');
                    // Reconnect sync updates are contiguous - observeSeq handles both seen + contiguous
                    seqTracker.observeSeq(entry.seq);
                    currentSeq = entry.seq;
                  }
                } finally {
                  isApplyingRemoteGlobal = false;
                }
                totalApplied += updates.length;

                // Check if we've caught up (latestSeq matches what we just applied)
                if (latestSeq !== null && currentSeq >= latestSeq) {
                  wsLogger.info(`Incremental sync complete: applied ${totalApplied} updates, caught up to seq ${latestSeq}`);
                  syncedIncrementally = true;
                  break;
                }

                // Continue fetching more pages
              }

              // Hit page ceiling without catching up - fall back to full sync
              if (pageCount >= MAX_RECONNECT_PAGES && !syncedIncrementally) {
                wsLogger.warn(`Incremental sync exceeded ${MAX_RECONNECT_PAGES} pages (${totalApplied} updates), falling back to full sync`);
              }
            }

            // Fall back to full state sync if incremental sync not possible/failed.
            //
            // NOTE: this is NOT a `reconcile()` call, and deliberately so. The
            // reconnect path is not a state-vector reconcile: its "push" is the
            // flush of the pending-update QUEUE above (step 1), and its "pull" is
            // the seq-incremental catch-up, of which this is only the fallback.
            // Forcing it through the push-before-pull primitive would mean
            // re-pushing a diff we already sent. It shares the PULL step, and
            // takes exactly that.
            //
            // `adoptEpoch: false` preserves existing behavior — this path has
            // never adopted the server's epoch; the WS restore-broadcast and
            // heartbeat frames are what tell this client its lineage changed.
            if (!syncedIncrementally) {
              const pull = await pullServerState({
                client: httpClient,
                doc: sharedDoc,
                applyOrigin: 'reconnect-authority',
                adoptEpoch: false,
                treatEmptyStateAsApplied: false,
              });
              if (pull.appliedServerState) {
                wsLogger.info(`Full state sync after reconnect: ${pull.pulledBytes} bytes`);
              }
              if (pull.latestSeq !== null) {
                wsLogger.debug(`Seq tracking re-seeded to: ${pull.latestSeq}`);
              }
            }

            // FLO-152: Guard against stale IIFE from previous connection
            if (thisConnectionId !== wsConnectionId) {
              wsLogger.debug('Stale connection IIFE, ignoring');
              return;
            }

            wsReadyForMessages = true;

            // FLO-289: Buffer overflow means replay stream is incomplete.
            // Skip replay and force one full recovery to converge safely.
            if (wsBufferOverflowLatched) {
              wsMessageBuffer = [];

              if (shouldStartOverflowRecovery(wsBufferOverflowLatched, wsOverflowRecoveryInFlight)) {
                wsOverflowRecoveryInFlight = true;
                wsLogger.warn('Reconnect buffer overflow latched, triggering forced recovery sync');
                try {
                  await triggerFullResync();
                } catch (resyncErr) {
                  wsLogger.error('Forced overflow recovery failed', { err: resyncErr });
                  setLastSyncError(`Overflow recovery failed: ${String(resyncErr)}`);
                } finally {
                  wsOverflowRecoveryInFlight = false;
                }
              } else {
                wsLogger.warn('Overflow recovery already running, skipping duplicate trigger');
              }

              wsBufferOverflowLatched = false;
              return;
            }

            // FLO-152: NOW safe to process messages - replay buffered ones
            wsLogger.info(`Reconnect sync complete, replaying ${wsMessageBuffer.length} buffered messages`);
            for (const msg of wsMessageBuffer) {
              applyWsMessage(msg);
            }
            wsMessageBuffer = [];
          } catch (err) {
            wsLogger.error('Reconnect sync failed', { err });
            // FLO-152: Guard against stale IIFE from previous connection
            if (thisConnectionId !== wsConnectionId) {
              wsLogger.debug('Stale connection IIFE error path, ignoring');
              return;
            }
            // Even on failure, start accepting messages (better than blocking forever)
            wsReadyForMessages = true;
            wsMessageBuffer = [];

            // FLO-289: If reconnect failed after overflow, still force one recovery sync.
            if (wsBufferOverflowLatched) {
              if (shouldStartOverflowRecovery(wsBufferOverflowLatched, wsOverflowRecoveryInFlight)) {
                wsOverflowRecoveryInFlight = true;
                wsLogger.warn('Reconnect failed with overflow latched, forcing recovery sync');
                try {
                  await triggerFullResync();
                } catch (resyncErr) {
                  wsLogger.error('Forced overflow recovery after reconnect failure failed', { err: resyncErr });
                  setLastSyncError(`Overflow recovery failed: ${String(resyncErr)}`);
                } finally {
                  wsOverflowRecoveryInFlight = false;
                }
              } else {
                wsLogger.warn('Overflow recovery already running after reconnect failure');
              }

              wsBufferOverflowLatched = false;
            }
          }
        })();
      } else {
        // FLO-269: FIRST CONNECTION - state just loaded in loadInitialState()
        // No buffering needed — just start accepting WS messages immediately.
        // This eliminates the race where:
        //   1. loadInitialState() fetches full state
        //   2. WS connects, IIFE re-fetches same state (redundant)
        //   3. PATCH arrives between load and re-fetch → absorbed into HTTP response
        //   4. WS delta becomes CRDT no-op → observeDeep never fires → block never renders
        wsReadyForMessages = true;
        wsMessageBuffer = [];
        wsBufferOverflowLatched = false;
        wsLogger.debug('First connection — accepting messages immediately (no redundant fetch)');
      }
    };

    sharedWebSocket.onmessage = (event) => {
      // Server sends JSON text messages: { seq?: number, txId?: string, data: string (base64) }
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data) as WsMessage;

          // FLO-152: Buffer messages during reconnect sync to prevent race condition
          if (!wsReadyForMessages) {
            const bufferAction = resolveReconnectBufferAction(
              wsMessageBuffer.length,
              WS_MESSAGE_BUFFER_MAX,
              wsBufferOverflowLatched
            );

            if (bufferAction === 'buffer') {
              wsMessageBuffer.push(msg);
              if (msg.seq !== undefined) {
                wsLogger.debug(`Buffered message during reconnect sync (seq: ${msg.seq}, total: ${wsMessageBuffer.length})`);
              } else {
                wsLogger.debug(`Buffered message during reconnect sync (total: ${wsMessageBuffer.length})`);
              }
            } else if (bufferAction === 'overflow-first') {
              wsBufferOverflowLatched = true;
              wsMessageBuffer = [];
              setSyncStatus('drift');
              setLastSyncError(`WebSocket reconnect buffer overflowed (${WS_MESSAGE_BUFFER_MAX} messages); forcing recovery sync`);
              wsLogger.error('Message buffer overflow during reconnect sync, replay disabled until forced recovery');
            } else {
              wsLogger.warn('Message dropped while overflow recovery is latched');
            }
            return;
          }

          // Ready for messages - apply directly
          applyWsMessage(msg);
        } catch (err) {
          wsLogger.error('Failed to parse message', { err });
        }
      }
    };

    sharedWebSocket.onclose = (event) => {
      wsLogger.info(`Disconnected, code: ${event.code}`);
      sharedWebSocket = null;
      // Reconnect with exponential backoff
      if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
      const backoffDelay = Math.min(
        WS_RECONNECT_DELAY * Math.pow(2, wsRetryCount),
        WS_MAX_RECONNECT_DELAY
      );
      wsRetryCount++;
      wsLogger.debug(`Reconnecting in ${backoffDelay}ms (attempt ${wsRetryCount})`);
      wsReconnectTimer = window.setTimeout(connectWebSocket, backoffDelay);
    };

    sharedWebSocket.onerror = (error) => {
      wsLogger.error('Error', { err: error });
      // Update sync status so UI can show error state
      // Note: WebSocket error events don't contain useful details - the actual
      // diagnostic info comes through onclose. Set generic message here.
      setSyncStatus('error');
      setLastSyncError('WebSocket connection error. Reconnecting...');
      // onclose will fire next and handle reconnection
    };
  } catch (err) {
    wsLogger.error('Failed to connect', { err });
    setSyncStatus('error');
    setLastSyncError(`WebSocket connection failed: ${err}`);
    // Schedule reconnect — onclose won't fire since the socket never opened
    if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
    const backoffDelay = Math.min(
      WS_RECONNECT_DELAY * Math.pow(2, wsRetryCount),
      WS_MAX_RECONNECT_DELAY
    );
    wsRetryCount++;
    wsLogger.debug(`Reconnecting in ${backoffDelay}ms (attempt ${wsRetryCount})`);
    wsReconnectTimer = window.setTimeout(connectWebSocket, backoffDelay);
  }
}

// ═══════════════════════════════════════════════════════════════
// HOOK
// ═══════════════════════════════════════════════════════════════

export interface UseSyncedYDocOptions {
  /** Debounce time for syncing updates to Rust (ms) */
  syncDebounce?: number;
}

export interface UseSyncedYDocReturn {
  /** The Y.Doc instance */
  doc: Y.Doc;
  /** Whether initial load is complete */
  isLoaded: () => boolean;
  /** Any error that occurred */
  error: () => string | null;
  /** Force sync to Rust */
  forceSync: () => Promise<void>;
  /** Undo last operation */
  undo: () => void;
  /** Redo last undone operation */
  redo: () => void;
  /** Check if undo is available */
  canUndo: () => boolean;
  /** Check if redo is available */
  canRedo: () => boolean;
  /** Clear undo/redo stacks (call after initial setup) */
  clearUndoStack: () => void;
}

export function useSyncedYDoc(
  _options: UseSyncedYDocOptions = {}
): UseSyncedYDocReturn {
  // Note: syncDebounce option is now ignored - module-level DEFAULT_SYNC_DEBOUNCE is used
  // for the singleton handler. Keeping options for API compatibility.

  // Force sync (bypass debounce) - delegates to module-level function
  const forceSync = async () => {
    if (sharedSyncTimer) {
      clearTimeout(sharedSyncTimer);
      sharedSyncTimer = null;
    }
    await flushUpdatesModule();
  };

  onMount(() => {
    // Attach singleton handler (ref-counted - only first caller actually attaches)
    attachHandler();
    ensureInitialLoad().catch(err => {
      logger.error('Initial load failed', { err });
      setSyncStatus('error');
    });

    onCleanup(() => {
      // Detach singleton handler (ref-counted - only last caller actually detaches)
      detachHandler();
    });
  });

  return {
    doc: sharedDoc,
    // Module-level signals: every consumer shares one source of truth, and
    // retryInitialLoad() can flip them from outside the hook.
    isLoaded: sharedLoadedSignal,
    error: sharedErrorSignal,
    forceSync,
    undo: () => sharedUndoManager?.undo(),
    redo: () => sharedUndoManager?.redo(),
    canUndo: () => (sharedUndoManager ? sharedUndoManager.undoStack.length > 0 : false),
    canRedo: () => (sharedUndoManager ? sharedUndoManager.redoStack.length > 0 : false),
    clearUndoStack: () => sharedUndoManager?.clear(),
  };
}

// ═══════════════════════════════════════════════════════════════
// INITIAL LOAD (module-level singleton — was a closure inside the hook)
// ═══════════════════════════════════════════════════════════════

/**
 * Load the initial doc state exactly once (concurrent callers share one
 * promise). Module-level so the Outliner's Retry button and App's reconnect
 * loop can re-drive it after a failed boot — the old closure form made a
 * failed load permanent: `sharedDocLoadPromise` was nulled and nothing could
 * ever re-invoke it (boot-sequence audit §4c).
 */
async function ensureInitialLoad(): Promise<void> {
  if (sharedDocLoaded) return;

  // If currently loading, wait for it
  if (sharedDocLoadPromise) {
    await sharedDocLoadPromise;
    return;
  }

  // The load body below predates the module-level extraction and reads `doc`.
  const doc = sharedDoc;

  // First load - do it
  sharedDocLoadPromise = (async () => {
    try {
      // CRITICAL: Initialize IndexedDB namespace BEFORE any backup operations
      // This isolates dev/release and different workspaces (FLO-247)
      let workspaceName = 'default';
      try {
        const config = await configReady;
        workspaceName = config.workspace_name || 'default';
      } catch (err) {
        logger.warn('Config IPC failed for namespace, using default', { err });
      }
      // FLO-762: namespace includes server identity — flipping
      // remote_server_url must never replay another server's seq baseline
      // or diff-push a stale local backup into the new server.
      initBackupNamespace(workspaceName, deriveServerSlug(window.__FLOATTY_SERVER_URL__));

      // Load persisted lastContiguousSeq for incremental sync after browser refresh
      // IMPORTANT: We persist lastContiguousSeq (not lastSeenSeq) because:
      // - lastSeenSeq may have jumped due to gaps (e.g., saw 419 but missed 418)
      // - lastContiguousSeq is safe baseline where ALL prior seqs were received
      // - Requesting "since lastContiguousSeq" will fetch any gaps + new updates
      try {
        const persistedSeq = await getLastContiguousSeqIDB();
        if (persistedSeq !== null) {
          // Seed tracker with persisted contiguous seq (sets both values)
          seqTracker.seedFromFullSync(persistedSeq);
          logger.debug(`Loaded persisted lastContiguousSeq: ${persistedSeq}`);
        }
      } catch (seqErr) {
        logger.warn('Failed to load lastContiguousSeq', { err: seqErr });
      }

      // Load the doc epoch this client last synced against (lineage guard)
      try {
        knownEpoch = await getKnownEpochIDB();
      } catch (epochErr) {
        logger.warn('Failed to load known epoch', { err: epochErr });
      }

      // Check for backup (crash recovery) - migrates legacy localStorage if found
      const localBackup = await getLocalBackup();

      // Server reachability fork (un-brick). The old code threw
      // `HTTP client not initialized` here, which made the
      // boot-from-cache branch below unreachable in the common case
      // (server already down at launch) — the exact case it was built
      // for. With no client AND no cache there is genuinely nothing to
      // boot from: throw a legible error for the Outliner to render.
      const clientAvailable = isClientInitialized();
      if (!clientAvailable && !localBackup) {
        throw new Error(
          'Server unreachable and no local cache to boot from — retry when the server is back'
        );
      }
      const httpClient = clientAvailable ? getHttpClient() : null;

      // One cheap /state/hash up front: the block count feeds the boot
      // progress UI, the epoch feeds the stale-lineage guard below.
      let serverEpoch: number | null = null;
      let serverEpochKnown = false;
      if (httpClient) {
        try {
          const health = await httpClient.getStateHash();
          serverEpoch = health.epoch;
          serverEpochKnown = true;
          setBootProgress({ phase: 'connecting', serverBlocks: health.blockCount });
        } catch (healthErr) {
          // Fail closed for the push: unverified lineage never syncs.
          logger.warn('Boot epoch check failed — pull-only reconcile, backup preserved', {
            err: healthErr,
          });
        }
      }

      // Hole 4 (quirk-audit): honest boot-state flags. The old logic
      // conflated "no local changes" with "never got far enough to know"
      // (hadLocalChanges initialized false), so a server-down boot cleared
      // the backup — destroying unpushed changes — and marked the app
      // loaded with an EMPTY doc.
      let appliedServerState = false;
      let useBackup = localBackup;

      // Stale-lineage guard: if the server restored while this app was
      // closed, the backup belongs to the OLD lineage — diff-pushing it
      // would resurrect deleted content. Detect via epoch before any push.
      let bootPushAllowed = false;
      if (useBackup && serverEpochKnown) {
        if (knownEpoch !== null && serverEpoch !== knownEpoch) {
          logger.warn(
            `Backup is from old doc lineage (epoch ${knownEpoch} vs server ${serverEpoch}) — discarding, adopting server state fresh`
          );
          useBackup = null;
          await clearBackupIDB().catch((err: unknown) => {
            logger.error('Failed to delete stale-lineage backup', { err });
          });
        } else {
          // Push only with positively verified lineage: known-matching
          // epoch, or a server that has never restored (epoch 0).
          bootPushAllowed = knownEpoch !== null || serverEpoch === 0;
          if (!bootPushAllowed) {
            logger.warn(
              `Local lineage unknown but server has restore history (epoch ${serverEpoch}) — pull-only boot, backup preserved`
            );
          }
        }
      }
      // (When the epoch fetch failed or the server is unreachable,
      // bootPushAllowed stays false — fail-closed, backup preserved.)

      // ── CACHE-FIRST BOOT (fast-boot Phase 1, ADR-007 §1) ──
      // When the cache's lineage is POSITIVELY verified (our recorded epoch
      // matches the server's), hydrate the doc from it and render, then
      // reconcile in the background via POST /state-diff — pulling only the
      // ops we lack instead of re-downloading and re-applying the full doc.
      // This removes the network AND the server's full-state encode from the
      // render path; the main-thread apply/materialize cost remains (that is
      // the history-size lever, a separate later decision — ADR-007) and is
      // now measured precisely by the boot_phase timings.
      //
      // Fail-closed: unknown lineage (no recorded epoch, epoch fetch failed)
      // or a mismatch falls through to the full-fetch paths below.
      const cacheBooted =
        useBackup !== null &&
        httpClient !== null &&
        serverEpochKnown &&
        knownEpoch !== null &&
        serverEpoch === knownEpoch;
      let backgroundBootReconcile: (() => Promise<void>) | null = null;

      if (cacheBooted && useBackup && httpClient) {
        const client = httpClient;
        setBootPhase('cache');
        const hydrateStart = performance.now();
        setApplyingRemote(true);
        try {
          Y.applyUpdate(doc, useBackup, 'remote');
        } finally {
          setApplyingRemote(false);
        }
        logger.info(
          `boot_phase=cache_hydrate elapsed_ms=${Math.round(performance.now() - hydrateStart)} bytes=${useBackup.length}`
        );
        appliedServerState = true; // lineage-verified cache IS server state (minus the delta below)

        const pushAllowed = bootPushAllowed;
        backgroundBootReconcile = async () => {
          try {
            // Epoch RE-check before the push (mirrors triggerFullResync's
            // pre-push guard). The boot hash-check verified lineage, but the
            // cache hydrate widened the window to seconds — a /restore
            // landing in it would otherwise be (a) pushed INTO (old-lineage
            // resurrection, quirk-audit Hole 1), (b) CRDT-merged across the
            // restore boundary (api-reference §state-diff: hard-reset, never
            // merge), and (c) MASKED forever by adoptEpoch. Fail closed.
            const { epoch: liveEpoch } = await client.getStateHash();
            if (knownEpoch !== null && liveEpoch !== knownEpoch) {
              await hardEpochReset(liveEpoch, 'restore during cache boot');
              return; // unreachable after reload; keeps control flow explicit
            }

            const result = await reconcile({
              client,
              doc,
              applyOrigin: 'remote',
              adoptEpoch: true,
              treatEmptyStateAsApplied: true,
              // The reconcile is deliberately kicked AFTER render, so a fast
              // user edit CAN land before the state-vector fetch — and a
              // live-doc diff includes it in the push, which is exactly what
              // we want. That inclusion is the reason for `kind: 'doc'`
              // rather than diffing the cache snapshot bytes.
              pushSource: { kind: 'doc' },
              pushAllowed,
              pullVia: 'diff',
            });
            if (result.pullError) throw result.pullError;
            logger.info(
              `boot_phase=background_reconcile_complete pushed_bytes=${result.pushedBytes} pulled_bytes=${result.pulledBytes} seq=${result.latestSeq}`
            );
            // The delta apply is a divergent-histories CRDT merge — run the
            // same safety nets every other reconcile-completion site runs
            // (ydoc-patterns §10; the boot-tail sweep ran BEFORE this delta).
            const deltaDeduped = deduplicateChildIds();
            reconcilePageTwins();
            if (deltaDeduped > 0) {
              logger.warn(`Post-delta dedup removed ${deltaDeduped} duplicate childIds`);
            }
            connectWebSocket();
            // Refresh the durable cache so the NEXT boot hydrates this state.
            scheduleBackup();
          } catch (err) {
            // Do NOT connect the WS here: its onopen reports 'synced' when
            // the pending queue is empty, and this doc provably MISSED its
            // delta — a green pill over a stale doc is Hole 4's "I know I'm
            // current" vs "I have no idea" collapsed into one status. Status
            // stays 'error'; one delayed retry through the honest recovery
            // primitive (which connects the WS only AFTER a reconcile lands),
            // then the 120s health check is the remaining safety net.
            logger.error('Background boot reconcile failed — cache content stands', { err });
            setSyncStatus('error');
            setLastSyncError('Reconcile failed after cache boot; retrying in background.');
            window.setTimeout(() => {
              void resumeSyncAfterReconnect();
            }, 15_000);
          }
        };
      }

      // The pull half of boot, shared by both branches below.
      // Null when the server is unreachable — the offline-cache branch
      // at the bottom is the boot path in that case.
      const bootPull: PullServerStateOptions | null = httpClient
        ? {
            client: httpClient,
            doc,
            applyOrigin: 'remote',
            adoptEpoch: true,
            // An empty server doc is a legitimate lineage to adopt on a first
            // launch — and `appliedServerState` gates the fall-through to
            // hydrate-from-cache below, so an empty server must not look like a
            // failed load.
            treatEmptyStateAsApplied: true,
          }
        : null;

      if (!cacheBooted && useBackup && bootPull) {
        logger.debug('Found backup, attempting reconciliation...');
        setBootPhase('reconciling');

        let result = await reconcile({
          ...bootPull,
          // The live doc is still EMPTY at boot — the local-only edits are in
          // the IDB snapshot, so the push diff must be taken against those
          // bytes, not against `doc`.
          pushSource: { kind: 'cache', bytes: useBackup },
          pushAllowed: bootPushAllowed,
        });

        if (result.pullError) {
          logger.error('Reconciliation failed, falling back to server state', {
            err: result.pullError,
          });
          // Retry the pull once — a transient blip at boot shouldn't cost the
          // whole session's server state.
          try {
            const fallback = await pullServerState(bootPull);
            result = { ...result, ...fallback, pullError: undefined };
          } catch (stateErr) {
            logger.error('Failed to load server state', { err: stateErr });
          }
        }
        appliedServerState = result.appliedServerState;

        // Durable-cache model (fast-boot Phase 1): the backup is KEPT either
        // way — it is the next boot's cache. This block used to clear it via
        // an isLocalCacheRedundant gate (deleted with its last caller; git
        // holds it), guaranteeing the next boot had to re-download and
        // re-apply the full doc (audit §3.1: the cached boot measured SLOWER
        // than the uncached one, 77.3s vs 71.5s — paid for and discarded).
        logger.info(
          `Reconciliation complete, seq: ${result.latestSeq} — backup kept (boot cache), pushed=${result.pushed}, diffComputed=${result.diffComputed}`
        );
      } else if (!cacheBooted && bootPull) {
        // Normal load - no local backup
        const result = await pullServerState(bootPull);
        appliedServerState = result.appliedServerState;
        if (result.latestSeq !== null) {
          logger.info(`Initial load complete, seq: ${result.latestSeq}`);
        }
      }

      // Boot-from-cache: server unreachable but a backup exists — hydrate
      // from it instead of presenting an empty doc. The backup is NOT
      // cleared; next successful connect reconciles. (Down-payment on the
      // offline/fast-boot design's boot-from-cache behavior.)
      if (!appliedServerState && localBackup && useBackup) {
        logger.warn('Server unreachable — hydrating from local backup (offline boot)');
        setBootPhase('offline-cache');
        setApplyingRemote(true);
        try {
          Y.applyUpdate(doc, localBackup, 'remote');
        } finally {
          setApplyingRemote(false);
        }
        setSyncStatus('error');
        setLastSyncError('Offline: loaded from local backup; will reconcile when the server is reachable.');
      }

      sharedDocLoaded = true;
      sharedDocError = null;

      // Initialize UndoManager for blocks map AND rootIds (after initial load)
      // CRITICAL: Must track both structures to maintain consistency on undo/redo
      if (!sharedUndoManager) {
        const blocksMap = doc.getMap('blocks');
        const rootIds = doc.getArray('rootIds');
        sharedUndoManager = new Y.UndoManager([blocksMap, rootIds], {
          // Track user-originated changes (from useBlockStore transactions)
          // Excludes 'remote' (server sync) and 'hook' (automated processing)
          trackedOrigins: new Set([null, undefined, 'user', 'user-drag']),
        });
        // Clear stack so user can't undo past loaded state
        // (prevents undoing the initial block creation)
        sharedUndoManager.clear();
      }

      // Connect to WebSocket for real-time sync — only when the HTTP client
      // is live AND the boot didn't defer it. Two deferral cases:
      // - Offline-cache boot: the WS retry loop could connect BEFORE the
      //   reconnect poll runs the reconcile, and its onopen would report
      //   'synced' over a stale cache doc. resumeSyncAfterReconnect() brings
      //   the WS up AFTER the reconcile.
      // - Cache boot: same ordering rule — the background reconcile connects
      //   the WS once the delta has landed.
      if (clientAvailable && !cacheBooted) {
        connectWebSocket();
      }

      // FLO-895: watch for silent yjs stalls for the rest of the session.
      startPendingStructsWatchdog();

      // FLO-247: Startup sanity check - detect suspicious state
      validateSyncedState(doc).catch(err => {
        logger.warn('Startup sanity check error', { err });
      });

      // FLO-280: Dedup childIds on startup (catches pre-existing duplicates)
      const startupDeduped = deduplicateChildIds();
      reconcilePageTwins();
      if (startupDeduped > 0) {
        logger.warn(`Startup dedup removed ${startupDeduped} duplicate childIds`);
      }

      // Kick the background reconcile AFTER the render-critical work — the
      // whole point of the cache boot is that first paint doesn't wait for
      // the network.
      if (backgroundBootReconcile) {
        void backgroundBootReconcile();
      }

      // Refresh the durable cache after a successful ONLINE boot so the next
      // launch cache-boots from today's state (a full-fetch boot previously
      // never wrote a backup until the first edit, so the fast path could
      // never fire). Cache boots refresh in the background task once the
      // delta lands; offline boots skip it — the doc IS the backup.
      if (appliedServerState && !cacheBooted) {
        scheduleBackup();
      }
    } catch (err) {
      logger.error('Failed to load initial state from server', { err });
      sharedDocError = String(err);
    }
  })().finally(() => {
    sharedDocLoadPromise = null;
    syncLoadSignals();
  });

  await sharedDocLoadPromise;
}

/**
 * Re-drive a failed initial load (Outliner Retry button).
 *
 * Re-attempts the HTTP client init first: the common failure is that the
 * App-level connect never succeeded, so the client singleton doesn't exist.
 * A second failure here still lands in the offline-cache path inside
 * ensureInitialLoad when a local backup exists.
 */
export async function retryInitialLoad(): Promise<void> {
  if (sharedDocLoaded) return;
  if (sharedDocLoadPromise) {
    await sharedDocLoadPromise;
    return;
  }

  sharedDocError = null;
  syncLoadSignals();
  setBootProgress({ phase: 'connecting', serverBlocks: null });

  if (!isClientInitialized()) {
    try {
      await initHttpClient();
    } catch (err) {
      logger.warn('Retry: server still unreachable, attempting offline boot', { err });
    }
  }
  await ensureInitialLoad();
}

/**
 * Bring sync back up once the server is reachable again (App reconnect loop).
 *
 * - Initial load never completed (bricked boot, no cache): run it now.
 * - The app booted from the offline cache: the live doc holds the cache
 *   content plus any offline edits, so a full push-before-pull reconcile
 *   (the Phase 0 primitive, live doc as diff source) ships them and pulls
 *   what the server accumulated. Then the WS channel comes up.
 *
 * Returns whether sync was actually restored. `false` means the caller must
 * KEEP its recovery machinery running (banner + poll) — resolving quietly on
 * a failed load or failed resync would strand recovery with no retry path.
 */
export async function resumeSyncAfterReconnect(): Promise<boolean> {
  if (!isClientInitialized()) return false;

  // Live (or in-progress) WS = the seq machinery owns catch-up already.
  const wsAlive = () =>
    sharedWebSocket?.readyState === WebSocket.OPEN ||
    sharedWebSocket?.readyState === WebSocket.CONNECTING;

  if (!sharedDocLoaded) {
    await ensureInitialLoad();
    // The load may have failed again (server flapped mid-recovery)…
    if (!sharedDocLoaded) return false;
    // …or we may have merely JOINED an in-flight offline-cache load, which
    // never started the WS. A fresh load with a live client starts it; only
    // that counts as recovered here.
    if (wsAlive()) return true;
  } else if (wsAlive()) {
    // Post-Outliner-Retry case — the retry's full pull just completed and
    // the WS connected on its heels; a second full-doc reconcile here would
    // be a wasted multi-second walk of the whole outline.
    return true;
  }

  try {
    await triggerFullResync();
  } catch (err) {
    logger.error('Reconnect resync failed — will retry on next poll tick', { err });
    return false;
  }
  connectWebSocket();
  return true;
}

// ═══════════════════════════════════════════════════════════════
// HMR CLEANUP
// ═══════════════════════════════════════════════════════════════

/**
 * Clean up module-level state for HMR.
 * Preserves Y.Doc data but closes connections and resets flags.
 */
function cleanupForHMR(): void {
  logger.info('HMR cleanup triggered');

  // Close WebSocket cleanly (prevent reconnect attempt)
  if (sharedWebSocket) {
    sharedWebSocket.onclose = null; // Prevent reconnect trigger
    sharedWebSocket.onerror = null;
    sharedWebSocket.onmessage = null;
    sharedWebSocket.close();
    sharedWebSocket = null;
  }

  // Clear all timers
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  if (sharedSyncTimer) {
    clearTimeout(sharedSyncTimer);
    sharedSyncTimer = null;
  }
  if (backupTimer) {
    clearTimeout(backupTimer);
    backupTimer = null;
  }
  if (contiguousSeqPersistTimer) {
    clearTimeout(contiguousSeqPersistTimer);
    contiguousSeqPersistTimer = null;
  }
  if (echoGapTimer) {
    clearTimeout(echoGapTimer);
    echoGapTimer = null;
  }
  pendingEchoGap = null;
  if (pendingWatchdogTimer) {
    clearInterval(pendingWatchdogTimer);
    pendingWatchdogTimer = null;
  }
  pendingWatchdog.reset();
  pendingWatchdogHealing = false;

  // Remove Y.Doc update handler if attached
  if (moduleUpdateHandler) {
    sharedDoc.off('update', moduleUpdateHandler);
    moduleUpdateHandler = null;
  }

  // Reset module-level flags
  sharedDocLoaded = false;
  sharedDocError = null;
  sharedDocLoadPromise = null;
  syncLoadSignals();
  setBootProgress({ phase: 'connecting', serverBlocks: null });
  sharedIsFlushing = false;
  sharedRetryCount = 0;
  isApplyingRemoteGlobal = false;

  // Reset WebSocket state
  wsHasConnectedOnce = false; // FLO-269: Reset for clean HMR cycle
  wsReadyForMessages = true;
  wsMessageBuffer = [];
  wsBufferOverflowLatched = false;
  wsOverflowRecoveryInFlight = false;
  wsConnectionId = 0;
  wsRetryCount = 0;

  // Reset sequence tracking via tracker (full reset including fetch state)
  seqTracker.resetAll();

  // Reset handler tracking
  handlerRefCount = 0;
  txIdCounter = 0;

  // Clear collections
  sharedPendingUpdates = [];
  recentTxIds.clear();

  // Note: sharedDoc and sharedUndoManager are NOT cleared
  // - Y.Doc holds the actual CRDT data we want to preserve
  // - UndoManager can stay attached (cleared on next load if needed)
}

if (import.meta.hot) {
  import.meta.hot.dispose(cleanupForHMR);
}

/**
 * useSyncedYDoc tests
 *
 * Tests pure functions and singleton behavior.
 * The hook itself requires Tauri IPC, tested via integration.
 */

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import {
  base64ToBytes,
  bytesToBase64,
  getBootProgress,
  getSharedDoc,
  isInitialLoadComplete,
  reconcile,
  resolveReconnectBufferAction,
  resumeSyncAfterReconnect,
  shouldStartOverflowRecovery,
} from './useSyncedYDoc';

describe('base64 utilities', () => {
  it('round-trips binary data', () => {
    const original = new Uint8Array([0, 1, 127, 128, 255]);
    const encoded = bytesToBase64(original);
    const decoded = base64ToBytes(encoded);

    expect(decoded).toEqual(original);
  });

  it('handles empty array', () => {
    const empty = new Uint8Array([]);
    const encoded = bytesToBase64(empty);
    const decoded = base64ToBytes(encoded);

    expect(decoded).toEqual(empty);
  });

  it('handles UTF-8 text as bytes', () => {
    const text = 'Hello, World!';
    const bytes = new TextEncoder().encode(text);
    const encoded = bytesToBase64(bytes);
    const decoded = base64ToBytes(encoded);

    expect(new TextDecoder().decode(decoded)).toBe(text);
  });
});

describe('Y.Doc singleton', () => {
  it('returns the same instance on multiple calls', () => {
    const doc1 = getSharedDoc();
    const doc2 = getSharedDoc();

    expect(doc1).toBe(doc2);
  });

  it('persists data across calls', () => {
    const doc = getSharedDoc();
    const map = doc.getMap('test-singleton-persist');

    // Ensure clean state
    map.clear();

    // Write some data
    map.set('key', 'value');

    // Get doc again and verify data persists
    const doc2 = getSharedDoc();
    const map2 = doc2.getMap('test-singleton-persist');

    expect(map2.get('key')).toBe('value');
  });
});

describe('reconnect buffer overflow guards', () => {
  it('buffers while under capacity', () => {
    expect(resolveReconnectBufferAction(10, 100, false)).toBe('buffer');
  });

  it('latches overflow on first capacity breach', () => {
    expect(resolveReconnectBufferAction(100, 100, false)).toBe('overflow-first');
  });

  it('continues dropping while overflow is latched', () => {
    expect(resolveReconnectBufferAction(0, 100, true)).toBe('overflow-repeat');
    expect(resolveReconnectBufferAction(100, 100, true)).toBe('overflow-repeat');
  });

  it('starts overflow recovery only when latched and not already running', () => {
    expect(shouldStartOverflowRecovery(true, false)).toBe(true);
    expect(shouldStartOverflowRecovery(true, true)).toBe(false);
    expect(shouldStartOverflowRecovery(false, false)).toBe(false);
  });
});

describe('buildWsUrl (FLO-762 WS auth)', () => {
  it('converts http to ws and appends /ws', async () => {
    const { buildWsUrl } = await import('./useSyncedYDoc');
    expect(buildWsUrl('http://127.0.0.1:8765', undefined)).toBe('ws://127.0.0.1:8765/ws');
  });

  it('converts https to wss (tailscale serve case)', async () => {
    const { buildWsUrl } = await import('./useSyncedYDoc');
    expect(buildWsUrl('https://float-box.tailnet.ts.net', undefined)).toBe(
      'wss://float-box.tailnet.ts.net/ws'
    );
  });

  it('appends the API key as an encoded query token', async () => {
    const { buildWsUrl } = await import('./useSyncedYDoc');
    expect(buildWsUrl('http://float-box:8765', 'floatty-abc123')).toBe(
      'ws://float-box:8765/ws?token=floatty-abc123'
    );
    // Characters needing encoding stay unambiguous in the query string
    expect(buildWsUrl('http://float-box:8765', 'k&y=v')).toBe(
      'ws://float-box:8765/ws?token=k%26y%3Dv'
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// reconcile() — the one push-before-pull primitive (fast-boot Phase 0)
// ═══════════════════════════════════════════════════════════════

/**
 * A fake server backed by a REAL Y.Doc, so the CRDT semantics under test are
 * the actual ones and not a mock's opinion of them.
 */
function createFakeServer() {
  const doc = new Y.Doc();
  const calls: string[] = [];
  const fake = {
    doc,
    calls,
    pushedUpdates: [] as Uint8Array[],
    lastTxId: undefined as string | undefined,
    latestSeq: 7 as number | null,
    epoch: 0 as number | null,
    failStateVector: null as Error | null,
    failPush: null as Error | null,
    failPull: null as Error | null,
    client: {
      async getStateVector(): Promise<Uint8Array> {
        calls.push('getStateVector');
        if (fake.failStateVector) throw fake.failStateVector;
        return Y.encodeStateVector(doc);
      },
      async applyUpdate(update: Uint8Array, txId?: string): Promise<void> {
        calls.push('applyUpdate');
        if (fake.failPush) throw fake.failPush;
        fake.pushedUpdates.push(update);
        fake.lastTxId = txId;
        Y.applyUpdate(doc, update, 'test-server');
      },
      async getState() {
        calls.push('getState');
        if (fake.failPull) throw fake.failPull;
        return {
          state: Y.encodeStateAsUpdate(doc),
          latestSeq: fake.latestSeq,
          epoch: fake.epoch,
        };
      },
      async stateDiff(stateVector: Uint8Array) {
        calls.push('stateDiff');
        if (fake.failPull) throw fake.failPull;
        return {
          update: Y.encodeStateAsUpdate(doc, stateVector),
          latestSeq: fake.latestSeq,
          epoch: fake.epoch,
        };
      },
    },
  };
  return fake;
}

function putBlock(doc: Y.Doc, id: string, content: string) {
  doc.transact(() => {
    doc.getMap('blocks').set(id, content);
  });
}

function blockIds(doc: Y.Doc): string[] {
  return [...doc.getMap<string>('blocks').keys()].sort();
}

/** Options every reconcile test shares. Epoch adoption is off unless tested. */
const BASE = {
  applyOrigin: 'remote' as const,
  adoptEpoch: false,
  treatEmptyStateAsApplied: false,
  pushAllowed: true,
};

describe('reconcile — push-before-pull', () => {
  it('pushes BEFORE it pulls', async () => {
    // The ordering IS the primitive. Pull first and the CRDT merge makes local
    // match server from the server's perspective — the diff we would then
    // compute is empty, and local-only edits are silently masked, not shipped.
    const server = createFakeServer();
    const local = new Y.Doc();
    putBlock(local, 'local-only', 'mine');

    await reconcile({ ...BASE, client: server.client, doc: local, pushSource: { kind: 'doc' } });

    expect(server.calls).toEqual(['getStateVector', 'applyUpdate', 'getState']);
  });

  it('converges both directions from the live doc (triggerFullResync path)', async () => {
    const server = createFakeServer();
    putBlock(server.doc, 'server-only', 'theirs');
    const local = new Y.Doc();
    putBlock(local, 'local-only', 'mine');

    const r = await reconcile({
      ...BASE,
      client: server.client,
      doc: local,
      pushSource: { kind: 'doc' },
    });

    expect(r.pushed).toBe(true);
    expect(r.hadLocalChanges).toBe(true);
    expect(r.appliedServerState).toBe(true);
    expect(blockIds(local)).toEqual(['local-only', 'server-only']);
    expect(blockIds(server.doc)).toEqual(['local-only', 'server-only']);
  });

  it('diffs the CACHE, not the doc, when booting (the boot path)', async () => {
    // At boot the live doc is still EMPTY — the local-only edits are in the IDB
    // snapshot. `Y.encodeStateAsUpdate(emptyDoc, serverSV)` would find nothing
    // to push and the unsynced edit would be lost on the next cache clear. This
    // is the entire reason `pushSource: 'cache'` exists.
    const server = createFakeServer();
    putBlock(server.doc, 'server-only', 'theirs');

    const cached = new Y.Doc();
    putBlock(cached, 'unpushed-while-offline', 'mine');
    const cacheBytes = Y.encodeStateAsUpdate(cached);

    const bootDoc = new Y.Doc(); // empty, as at boot
    const r = await reconcile({
      ...BASE,
      client: server.client,
      doc: bootDoc,
      pushSource: { kind: 'cache', bytes: cacheBytes },
    });

    expect(r.pushed).toBe(true);
    expect(blockIds(server.doc)).toEqual(['server-only', 'unpushed-while-offline']);
    // ...and the pull brings both back into the (previously empty) live doc.
    expect(blockIds(bootDoc)).toEqual(['server-only', 'unpushed-while-offline']);
  });

  it('reports no local changes when the local doc adds nothing', async () => {
    const server = createFakeServer();
    putBlock(server.doc, 'shared', 'same');
    const local = new Y.Doc();
    Y.applyUpdate(local, Y.encodeStateAsUpdate(server.doc));

    const r = await reconcile({
      ...BASE,
      client: server.client,
      doc: local,
      pushSource: { kind: 'doc' },
    });

    expect(r.diffComputed).toBe(true);
    expect(r.hadLocalChanges).toBe(false);
    expect(r.pushed).toBe(false);
    expect(server.calls).toEqual(['getStateVector', 'getState']); // no push
  });

  it('mints a tx id only when it actually pushes', async () => {
    // generateTxId mutates the echo-suppression set — minting one we never send
    // would poison echo filtering.
    const server = createFakeServer();
    const local = new Y.Doc();
    Y.applyUpdate(local, Y.encodeStateAsUpdate(server.doc));
    let minted = 0;

    await reconcile({
      ...BASE,
      client: server.client,
      doc: local,
      pushSource: { kind: 'doc' },
      makeTxId: () => `tx-${++minted}`,
    });
    expect(minted).toBe(0);

    putBlock(local, 'now-i-have-something', 'x');
    await reconcile({
      ...BASE,
      client: server.client,
      doc: local,
      pushSource: { kind: 'doc' },
      makeTxId: () => `tx-${++minted}`,
    });
    expect(minted).toBe(1);
    expect(server.lastTxId).toBe('tx-1');
  });
});

describe('reconcile — lineage gate (pushAllowed)', () => {
  it('computes the diff but does NOT send it when lineage is unverified', async () => {
    // Fail-closed: pushing an old-lineage diff resurrects content the server
    // deleted in a restore. But the diff must still be COMPUTED — the caller
    // needs to know local-only changes exist before deciding the cache is safe
    // to clear.
    const server = createFakeServer();
    const local = new Y.Doc();
    putBlock(local, 'local-only', 'mine');

    const r = await reconcile({
      ...BASE,
      pushAllowed: false,
      client: server.client,
      doc: local,
      pushSource: { kind: 'doc' },
    });

    expect(r.diffComputed).toBe(true);
    expect(r.hadLocalChanges).toBe(true);
    expect(r.pushed).toBe(false);
    expect(server.calls).not.toContain('applyUpdate');
    expect(blockIds(server.doc)).toEqual([]);
    // ...and with unpushed local changes the cache must be kept.
  });
});

describe('reconcile — failure surfaces', () => {
  it('a failed push is non-fatal: it still pulls', async () => {
    const server = createFakeServer();
    putBlock(server.doc, 'server-only', 'theirs');
    server.failPush = new Error('network');
    const local = new Y.Doc();
    putBlock(local, 'local-only', 'mine');

    const r = await reconcile({
      ...BASE,
      client: server.client,
      doc: local,
      pushSource: { kind: 'doc' },
    });

    expect(r.pushError).toBeInstanceOf(Error);
    expect(r.pushed).toBe(false);
    expect(r.appliedServerState).toBe(true);
    expect(blockIds(local)).toContain('server-only');
    // Unpushed local changes (pushed=false above) → the cache stays.
  });

  it('a failed pull comes back in the result, with the push partials intact', async () => {
    // reconcile must NOT throw here: `diffComputed` is what stands between a
    // server blip and a wiped local cache, and a thrown error takes it with it.
    const server = createFakeServer();
    server.failPull = new Error('server down');
    const local = new Y.Doc();
    putBlock(local, 'local-only', 'mine');

    const r = await reconcile({
      ...BASE,
      client: server.client,
      doc: local,
      pushSource: { kind: 'doc' },
    });

    expect(r.pullError).toBeInstanceOf(Error);
    expect(r.appliedServerState).toBe(false);
    expect(r.pulledBytes).toBe(0);
    // The push DID happen and its outcome survived the pull failure.
    expect(r.pushed).toBe(true);
    expect(r.diffComputed).toBe(true);
  });

  it('an unreachable server leaves diffComputed FALSE — not "no local changes"', async () => {
    // The distinction the whole cache-clear gate rests on.
    const server = createFakeServer();
    server.failStateVector = new Error('unreachable');
    server.failPull = new Error('unreachable');
    const local = new Y.Doc();

    const r = await reconcile({
      ...BASE,
      client: server.client,
      doc: local,
      pushSource: { kind: 'doc' },
    });

    expect(r.diffComputed).toBe(false);
    expect(r.hadLocalChanges).toBe(false); // ...but we do NOT know that (diffComputed=false)!
  });
});

describe('reconcile — empty server state', () => {
  it('treatEmptyStateAsApplied distinguishes the boot and resync answers', async () => {
    const server = createFakeServer(); // empty doc
    server.latestSeq = null;
    const local = new Y.Doc();

    // Resync: nothing was pulled, so nothing was adopted.
    const resync = await reconcile({
      ...BASE,
      treatEmptyStateAsApplied: false,
      client: server.client,
      doc: local,
      pushSource: { kind: 'doc' },
    });
    expect(resync.appliedServerState).toBe(false);

    // Boot: an empty server is a legitimate lineage to adopt on a first launch —
    // and it must not look like a failed load, or boot would fall through to
    // hydrate-from-cache.
    const boot = await reconcile({
      ...BASE,
      treatEmptyStateAsApplied: true,
      client: server.client,
      doc: local,
      pushSource: { kind: 'doc' },
    });
    expect(boot.appliedServerState).toBe(true);
    expect(boot.diffComputed).toBe(true); // empty diff positively computed
  });
});


describe('boot progress (loading-UI signal)', () => {
  // setBootPhase is boot-scoped: it only mutates while the initial load has
  // not completed. In this test env the load never runs, so phases flow.

  it('advances to `applying` when a pull lands real ops', async () => {
    const server = createFakeServer();
    putBlock(server.doc, 'a', 'x');
    const local = new Y.Doc();

    await reconcile({ ...BASE, client: server.client, doc: local, pushSource: { kind: 'doc' } });

    expect(getBootProgress().phase).toBe('applying');
  });

  it('stays at `fetching` when the server has nothing to give', async () => {
    // Must OVERWRITE the `applying` left by the previous test — proving the
    // fetch marker fires on every pull, not just the first.
    const server = createFakeServer();
    const local = new Y.Doc();

    await reconcile({ ...BASE, client: server.client, doc: local, pushSource: { kind: 'doc' } });

    expect(getBootProgress().phase).toBe('fetching');
  });
});

describe('module load state (retry / reconnect surface)', () => {
  it('reports the initial load as incomplete when it never ran', () => {
    expect(isInitialLoadComplete()).toBe(false);
  });

  it('resumeSyncAfterReconnect reports NOT recovered without an HTTP client', async () => {
    // Bricked-boot recovery path: the reconnect poll may fire before the
    // client exists (connect raced). It must not throw, must not start a
    // load it cannot finish, and must return false so the caller KEEPS its
    // banner + poll running — a quiet resolve here would strand recovery.
    await expect(resumeSyncAfterReconnect()).resolves.toBe(false);
    expect(isInitialLoadComplete()).toBe(false);
  });
});

describe('reconcile — diff pull (fast-boot Phase 1 cache boot)', () => {
  it('pulls via /state-diff and converges without a full-state fetch', async () => {
    // The cache-boot path: the doc is already hydrated from the local cache,
    // so the pull only needs the ops it lacks — never GET /state.
    const server = createFakeServer();
    putBlock(server.doc, 'shared', 'both have this');
    putBlock(server.doc, 'server-only', 'new since last boot');

    const local = new Y.Doc(); // "hydrated from cache": has the shared block
    Y.applyUpdate(local, Y.encodeStateAsUpdate(server.doc));
    // Simulate the server moving ahead after the cache was written
    putBlock(server.doc, 'newer', 'landed after cache write');

    const r = await reconcile({
      ...BASE,
      client: server.client,
      doc: local,
      pushSource: { kind: 'doc' },
      pullVia: 'diff',
    });

    expect(r.appliedServerState).toBe(true);
    expect(server.calls).not.toContain('getState');
    expect(server.calls).toContain('stateDiff');
    expect(blockIds(local)).toEqual(blockIds(server.doc));
  });

  it('an up-to-date doc pulls an empty diff and honors treatEmptyStateAsApplied', async () => {
    const server = createFakeServer();
    putBlock(server.doc, 'a', 'x');
    const local = new Y.Doc();
    Y.applyUpdate(local, Y.encodeStateAsUpdate(server.doc));

    const upToDate = await reconcile({
      ...BASE,
      client: server.client,
      doc: local,
      pushSource: { kind: 'doc' },
      pullVia: 'diff',
      treatEmptyStateAsApplied: true,
    });
    expect(upToDate.appliedServerState).toBe(true);
    expect(upToDate.pulledBytes).toBeLessThanOrEqual(2);
  });
});

describe('reconcile — diff pull replays deletions (the tombstone claim)', () => {
  it('a block deleted server-side while the app was closed disappears after hydrate+diff', async () => {
    // THE load-bearing claim of cache-first boot: hydrating a stale cache
    // must not permanently resurrect blocks the server deleted — the diff
    // carries the delete tombstones and replays them.
    const server = createFakeServer();
    putBlock(server.doc, 'keeper', 'stays');
    putBlock(server.doc, 'doomed', 'deleted while app closed');

    // "Cache written at shutdown": local has both blocks.
    const local = new Y.Doc();
    Y.applyUpdate(local, Y.encodeStateAsUpdate(server.doc));
    expect(blockIds(local)).toEqual(['doomed', 'keeper']);

    // Server deletes one while the app is closed.
    server.doc.transact(() => {
      server.doc.getMap('blocks').delete('doomed');
    });

    const r = await reconcile({
      ...BASE,
      client: server.client,
      doc: local,
      pushSource: { kind: 'doc' },
      pullVia: 'diff',
    });

    expect(r.appliedServerState).toBe(true);
    expect(blockIds(local)).toEqual(['keeper']);
    expect(blockIds(server.doc)).toEqual(['keeper']); // push resurrected nothing
  });
});

// ═══════════════════════════════════════════════════════════════
// expectedEpoch guard + pullServerDiffNow (FLO-854 fetch-on-miss)
// ═══════════════════════════════════════════════════════════════

describe('pullServerState expectedEpoch guard (FLO-854)', () => {
  it('skips the apply when the pulled epoch does not match expectedEpoch', async () => {
    // Epoch doctrine (api-reference §state-diff): a mismatch means the diff
    // crosses a /restore boundary — hard-reset (adopt), never merge. This
    // guard is the "never merge" half; the WS restore machinery does the reset.
    const server = createFakeServer();
    server.epoch = 3; // server restored to a different lineage
    putBlock(server.doc, 'server-only', 'theirs');
    const local = new Y.Doc();

    const r = await reconcile({
      ...BASE,
      client: server.client,
      doc: local,
      pushSource: { kind: 'doc' },
      pullVia: 'diff',
      expectedEpoch: 0,
    });

    expect(r.appliedServerState).toBe(false);
    expect(blockIds(local)).toEqual([]); // never merged across the boundary
  });

  it('applies normally when the epoch matches', async () => {
    const server = createFakeServer();
    server.epoch = 2;
    putBlock(server.doc, 'server-only', 'theirs');
    const local = new Y.Doc();

    const r = await reconcile({
      ...BASE,
      client: server.client,
      doc: local,
      pushSource: { kind: 'doc' },
      pullVia: 'diff',
      expectedEpoch: 2,
    });

    expect(r.appliedServerState).toBe(true);
    expect(blockIds(local)).toEqual(['server-only']);
  });

  it('absent expectedEpoch preserves existing behavior (no guard)', async () => {
    const server = createFakeServer();
    server.epoch = 9; // would mismatch anything — but no expectation is set
    putBlock(server.doc, 'server-only', 'theirs');
    const local = new Y.Doc();

    const r = await reconcile({
      ...BASE,
      client: server.client,
      doc: local,
      pushSource: { kind: 'doc' },
      pullVia: 'diff',
    });

    expect(r.appliedServerState).toBe(true);
    expect(blockIds(local)).toEqual(['server-only']);
  });
});

describe('pullServerDiffNow (FLO-854 fetch-on-miss primitive)', () => {
  it('returns false pre-boot without touching boot progress', async () => {
    // Terminal panes exist before the doc loads — a mid-boot wikilink click
    // must not mutate boot-progress UI or race loadInitialState's reconcile.
    const { pullServerDiffNow } = await import('./useSyncedYDoc');
    const phaseBefore = getBootProgress().phase;

    await expect(pullServerDiffNow()).resolves.toBe(false);

    expect(getBootProgress().phase).toBe(phaseBefore);
  });
});

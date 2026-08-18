import { describe, it, expect } from 'vitest';
import {
  planStoreReconcile,
  fingerprintsDiverge,
  DEFAULT_STORE_AUDIT_WINDOW,
  type BlockFingerprint,
  type StoreReconcileInput,
} from './storeReconcile';

function fp(overrides: Partial<BlockFingerprint> = {}): BlockFingerprint {
  return { content: 'hello', updatedAt: 100, parentId: null, childCount: 0, ...overrides };
}

/**
 * Build a planner input from two plain maps — "what the doc holds" and "what
 * the store holds". Divergence is expressed by giving the same id different
 * fingerprints on each side.
 */
function input(
  doc: Record<string, BlockFingerprint>,
  store: Record<string, BlockFingerprint>,
  overrides: Partial<StoreReconcileInput> = {}
): StoreReconcileInput {
  return {
    docKeys: Object.keys(doc),
    storeKeys: Object.keys(store),
    hasStoreBlock: id => store[id] !== undefined,
    docFingerprint: id => doc[id] ?? null,
    storeFingerprint: id => store[id] ?? null,
    docRootIds: [],
    storeRootIds: [],
    cursor: 0,
    ...overrides,
  };
}

describe('fingerprintsDiverge', () => {
  it('is false for identical fingerprints', () => {
    expect(fingerprintsDiverge(fp(), fp())).toBe(false);
  });

  it.each([
    ['content', { content: 'edited' }],
    ['updatedAt', { updatedAt: 200 }],
    ['parentId', { parentId: 'p2' }],
    ['childCount', { childCount: 3 }],
  ])('detects a %s change', (_field, change) => {
    expect(fingerprintsDiverge(fp(change), fp())).toBe(true);
  });

  it('treats a missed PATCH as divergence — the reported symptom', () => {
    // The failure users see is "renders one edit behind": same block, same
    // count, older text. Block counting cannot see this; fingerprints can.
    const doc = fp({ content: 'v2', updatedAt: 200 });
    const stale = fp({ content: 'v1', updatedAt: 100 });
    expect(fingerprintsDiverge(doc, stale)).toBe(true);
  });
});

describe('planStoreReconcile', () => {
  it('plans nothing when store and doc agree', () => {
    const plan = planStoreReconcile(input({ a: fp(), b: fp() }, { a: fp(), b: fp() }));

    expect(plan.refresh).toEqual([]);
    expect(plan.drop).toEqual([]);
    expect(plan.replaceRootIds).toBe(false);
    expect(plan.report).toMatchObject({ missing: 0, extra: 0, stale: 0, docBlocks: 2 });
  });

  it('materializes blocks the store never received', () => {
    // The core FLO-895 shape: the Y.Doc has it, the store doesn't, and no
    // network repair can help because the doc is already correct.
    const plan = planStoreReconcile(input({ a: fp(), b: fp() }, { a: fp() }));

    expect(plan.refresh).toEqual(['b']);
    expect(plan.report.missing).toBe(1);
    expect(plan.report.storeBlocks).toBe(2);
  });

  it('drops blocks the doc no longer has', () => {
    const plan = planStoreReconcile(input({ a: fp() }, { a: fp(), ghost: fp() }));

    expect(plan.drop).toEqual(['ghost']);
    expect(plan.report.extra).toBe(1);
    expect(plan.report.storeBlocks).toBe(1);
  });

  it('refreshes blocks whose fields drifted', () => {
    const plan = planStoreReconcile(
      input({ a: fp({ content: 'v2', updatedAt: 200 }) }, { a: fp({ content: 'v1' }) })
    );

    expect(plan.refresh).toEqual(['a']);
    expect(plan.report.stale).toBe(1);
    expect(plan.report.missing).toBe(0);
  });

  it('counts a missing block once, not as missing AND stale', () => {
    const plan = planStoreReconcile(input({ a: fp() }, {}));

    expect(plan.report).toMatchObject({ missing: 1, stale: 0 });
    expect(plan.refresh).toEqual(['a']);
  });

  it('does not queue an unrepairable block as missing', () => {
    // A doc entry with no id can never be materialized. Reporting it as
    // `missing` would schedule a refresh that always fails, and every
    // subsequent pass would claim the same repair — permanent churn and a
    // permanently non-zero warning. It is counted separately instead.
    const plan = planStoreReconcile({
      ...input({ a: fp(), broken: fp() }, { a: fp() }),
      docFingerprint: id => (id === 'broken' ? null : fp()),
    });

    expect(plan.refresh).toEqual([]);
    expect(plan.report.missing).toBe(0);
    expect(plan.report.unreadable).toBe(1);
  });

  it('reads doc fingerprints only for store-missing ids, not the whole doc', () => {
    // Presence is checked doc-wide; the fingerprint read is the expensive part
    // and must stay proportional to the damage, not the document.
    const doc = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`b${i}`, fp()]));
    const store = { ...doc };
    delete (store as Record<string, BlockFingerprint>).b400;

    let docReads = 0;
    const plan = planStoreReconcile({
      ...input(doc, store),
      windowSize: 10,
      docFingerprint: id => {
        docReads++;
        return doc[id] ?? null;
      },
    });

    // One read for the missing id, plus the 10-block staleness window.
    expect(docReads).toBe(11);
    expect(plan.report.missing).toBe(1);
  });

  it('ignores blocks the doc cannot read back', () => {
    // `docFingerprint` returning null is a doc-side defect (no id on the
    // Y.Map), not evidence that the store is wrong — repairing from it would
    // write garbage.
    const plan = planStoreReconcile({
      ...input({ a: fp() }, { a: fp({ content: 'different' }) }),
      docFingerprint: () => null,
    });

    expect(plan.refresh).toEqual([]);
    expect(plan.report.stale).toBe(0);
  });
});

describe('planStoreReconcile — rotating window', () => {
  const many = (n: number, f: (i: number) => BlockFingerprint) =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`b${i}`, f(i)]));

  it('field-compares at most windowSize blocks per pass', () => {
    const doc = many(50, () => fp());
    const store = many(50, () => fp());
    let reads = 0;

    const plan = planStoreReconcile({
      ...input(doc, store),
      windowSize: 10,
      docFingerprint: id => {
        reads++;
        return doc[id] ?? null;
      },
    });

    expect(reads).toBe(10);
    expect(plan.report.scanned).toBe(10);
    expect(plan.nextCursor).toBe(10);
  });

  it('advances the window across passes and wraps at the end', () => {
    const doc = many(25, () => fp());
    const store = many(25, () => fp());

    let cursor = 0;
    const scannedRanges: number[] = [];
    for (let pass = 0; pass < 3; pass++) {
      const plan = planStoreReconcile({ ...input(doc, store), windowSize: 10, cursor });
      scannedRanges.push(plan.report.scanned);
      cursor = plan.nextCursor;
    }

    // 10 + 10 + 5, then back to the start.
    expect(scannedRanges).toEqual([10, 10, 5]);
    expect(cursor).toBe(0);
  });

  it('finds a stale block only once its window comes around', () => {
    const doc = many(30, i => (i === 25 ? fp({ content: 'v2' }) : fp()));
    const store = many(30, () => fp());

    const first = planStoreReconcile({ ...input(doc, store), windowSize: 10, cursor: 0 });
    expect(first.report.stale).toBe(0);

    const third = planStoreReconcile({ ...input(doc, store), windowSize: 10, cursor: 20 });
    expect(third.report.stale).toBe(1);
    expect(third.refresh).toEqual(['b25']);
  });

  it('detects a missing block on the very next pass regardless of window', () => {
    // Presence is checked doc-wide every pass — a block absent from the store
    // must not wait up to 30 minutes for its window.
    const doc = many(1000, () => fp());
    const store = many(999, () => fp()); // b999 never materialized

    const plan = planStoreReconcile({ ...input(doc, store), windowSize: 10, cursor: 0 });

    expect(plan.report.missing).toBe(1);
    expect(plan.refresh).toEqual(['b999']);
  });

  it('wraps a cursor left past the end by a shrunken doc', () => {
    const doc = many(5, () => fp());
    const store = many(5, () => fp());

    const plan = planStoreReconcile({ ...input(doc, store), windowSize: 10, cursor: 4000 });

    expect(plan.report.scanned).toBeGreaterThan(0);
    expect(plan.nextCursor).toBe(0);
  });

  it('handles an empty doc without dividing by zero', () => {
    const plan = planStoreReconcile(input({}, {}));

    expect(plan.report).toMatchObject({ docBlocks: 0, scanned: 0, missing: 0, extra: 0 });
    expect(plan.nextCursor).toBe(0);
  });

  it('defaults the window to the documented constant', () => {
    const doc = many(DEFAULT_STORE_AUDIT_WINDOW + 500, () => fp());
    const store = many(DEFAULT_STORE_AUDIT_WINDOW + 500, () => fp());

    const plan = planStoreReconcile(input(doc, store));

    expect(plan.report.scanned).toBe(DEFAULT_STORE_AUDIT_WINDOW);
  });
});

describe('planStoreReconcile — rootIds', () => {
  it('replaces rootIds when order differs', () => {
    const plan = planStoreReconcile(
      input({}, {}, { docRootIds: ['a', 'b'], storeRootIds: ['b', 'a'] })
    );

    expect(plan.replaceRootIds).toBe(true);
    expect(plan.report.rootIdsRepaired).toBe(true);
  });

  it('replaces rootIds when length differs', () => {
    const plan = planStoreReconcile(
      input({}, {}, { docRootIds: ['a', 'b'], storeRootIds: ['a'] })
    );

    expect(plan.replaceRootIds).toBe(true);
  });

  it('leaves matching rootIds alone', () => {
    const plan = planStoreReconcile(
      input({}, {}, { docRootIds: ['a', 'b'], storeRootIds: ['a', 'b'] })
    );

    expect(plan.replaceRootIds).toBe(false);
  });
});

describe('planStoreReconcile — reporting', () => {
  it('caps sample ids for log triage', () => {
    const doc = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`b${i}`, fp()]));
    const plan = planStoreReconcile(input(doc, {}));

    expect(plan.report.missing).toBe(20);
    expect(plan.report.sampleIds).toHaveLength(5);
  });

  it('honours an explicit sample limit', () => {
    const doc = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`b${i}`, fp()]));
    const plan = planStoreReconcile({ ...input(doc, {}), sampleLimit: 2 });

    expect(plan.report.sampleIds).toEqual(['b0', 'b1']);
  });

  it('projects the post-repair store size', () => {
    const plan = planStoreReconcile(
      input({ a: fp(), b: fp(), c: fp() }, { a: fp(), ghost: fp() })
    );

    // 2 present − 1 dropped + 2 materialized = 3, matching the doc.
    expect(plan.report.storeBlocks).toBe(3);
    expect(plan.report.storeBlocks).toBe(plan.report.docBlocks);
  });
});

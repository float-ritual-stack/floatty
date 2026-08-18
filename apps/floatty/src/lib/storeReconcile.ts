/**
 * Store↔Y.Doc reconcile planning ([[FLO-895]]).
 *
 * The Y.Doc is the source of truth; the SolidJS store is a materialized view
 * of it, kept current by `_blocksObserver`. When the observer misses a write,
 * nothing else notices — and critically, no network-level repair can fix it,
 * because the Y.Doc is already correct and a resync therefore pulls nothing.
 * This module decides what a repair pass should do; `useBlockStore.ts` reads
 * yjs and applies the result.
 *
 * Split this way so the decision logic is testable as data-in/data-out, with
 * no Y.Doc, no SolidJS root, and no singleton lifecycle to fight — matching
 * the store-first testability rule in CLAUDE.md.
 */

/**
 * Blocks field-compared per reconcile pass.
 *
 * Presence (missing/extra) is checked doc-wide every pass because set
 * operations over ids are cheap. Field comparison is windowed because reading
 * fields is what costs. At ~27k blocks this audits the whole doc in ~14
 * passes — under 30 minutes at the 120s health-check cadence.
 */
export const DEFAULT_STORE_AUDIT_WINDOW = 2000;

/**
 * The cheap fields that decide whether a materialized block is stale.
 *
 * Deliberately not the whole block: a full comparison would allocate a
 * childIds array and a metadata object per block per pass. These five cover
 * every divergence a user can SEE — text, edit recency, tree position, child
 * count, and whether the subtree renders open or closed.
 *
 * `collapsed` is here because `toggleCollapsed` does NOT bump `updatedAt` — a
 * collapsed-only write that misses the observer is invisible to every other
 * field, so the block would render permanently open (or closed) against its
 * own Y.Doc.
 */
export interface BlockFingerprint {
  content: string;
  updatedAt: number | undefined;
  parentId: string | null;
  childCount: number;
  collapsed: boolean;
}

/** Outcome of one reconcile pass. Zeros everywhere = store and doc agree. */
export interface StoreReconcileReport {
  /** Blocks in the Y.Doc (the authority). */
  docBlocks: number;
  /** Blocks in the store AFTER repair. */
  storeBlocks: number;
  /** Blocks field-compared this pass (the rotating window). */
  scanned: number;
  /** In the Y.Doc, absent from the store — materialized. */
  missing: number;
  /** In the store, absent from the Y.Doc — dropped. */
  extra: number;
  /** In both, fields diverged — re-materialized. */
  stale: number;
  /**
   * In the Y.Doc but not materializable (no id on the Y.Map), so not
   * repairable either.
   *
   * Counted rather than treated as `missing`: reporting these as missing would
   * queue a refresh that always fails, and the pass would claim the same
   * repair forever. A non-zero value here means the DOC is malformed — a
   * different bug from the one this pass fixes, and one worth seeing.
   */
  unreadable: number;
  /** The root-id list diverged and was replaced. */
  rootIdsRepaired: boolean;
  /** First few repaired ids, for log triage. */
  sampleIds: string[];
}

/** What the caller should write. */
export interface StoreReconcilePlan {
  /** Ids to re-materialize from the Y.Doc (missing ∪ stale). */
  refresh: string[];
  /** Ids to delete from the store (present locally, gone from the doc). */
  drop: string[];
  /** Replace the store's root list with the doc's. */
  replaceRootIds: boolean;
  /** Where the next pass should resume field-comparing. */
  nextCursor: number;
  report: StoreReconcileReport;
}

export interface StoreReconcileInput {
  /** Every block id in the Y.Doc, in a stable order. */
  docKeys: string[];
  /** Every block id currently materialized in the store. */
  storeKeys: string[];
  /**
   * Cheap presence check against the store.
   *
   * Separate from `storeFingerprint` on purpose: presence is tested for every
   * key in the doc on every pass, and building a fingerprint object per block
   * would allocate ~27k short-lived objects each time.
   */
  hasStoreBlock: (id: string) => boolean;
  /**
   * Fingerprint of a block as the Y.Doc holds it, or null when it cannot be
   * materialized. Called only for store-missing candidates and for ids inside
   * this pass's window — never for the whole doc.
   */
  docFingerprint: (id: string) => BlockFingerprint | null;
  /**
   * Fingerprint of a block as the store holds it, or null when absent. Called
   * only for ids inside this pass's window.
   */
  storeFingerprint: (id: string) => BlockFingerprint | null;
  /** Root ids per the Y.Doc. */
  docRootIds: string[];
  /** Root ids per the store. */
  storeRootIds: string[];
  /** Where the previous pass stopped field-comparing. */
  cursor: number;
  windowSize?: number;
  /** How many repaired ids to include in the report, for logs. */
  sampleLimit?: number;
}

/**
 * True when the store's copy of a block no longer matches the Y.Doc's.
 *
 * Both sides must be normalized the SAME way the store's materializer
 * normalizes (missing content → `''`, missing childIds → length 0, missing
 * collapsed → `false`). Comparing a raw `undefined` against a normalized `''`
 * would mark such blocks permanently stale and repair them on every pass,
 * forever.
 */
export function fingerprintsDiverge(doc: BlockFingerprint, stored: BlockFingerprint): boolean {
  return (
    doc.content !== stored.content ||
    doc.updatedAt !== stored.updatedAt ||
    doc.parentId !== stored.parentId ||
    doc.childCount !== stored.childCount ||
    doc.collapsed !== stored.collapsed
  );
}

/**
 * Decide what a reconcile pass should repair.
 *
 * Pure: same inputs, same plan. The cursor rotates the field-comparison window
 * so repeated passes eventually cover the whole doc without any single pass
 * walking all of it.
 */
export function planStoreReconcile(input: StoreReconcileInput): StoreReconcilePlan {
  // A non-positive or fractional window is worse than a wrong window: 0 makes
  // `end === start`, so the cursor never advances and field staleness is never
  // checked again on any pass. Fall back rather than silently disable the scan.
  const requestedWindowSize = input.windowSize ?? DEFAULT_STORE_AUDIT_WINDOW;
  const windowSize =
    Number.isInteger(requestedWindowSize) && requestedWindowSize > 0
      ? requestedWindowSize
      : DEFAULT_STORE_AUDIT_WINDOW;
  const sampleLimit = input.sampleLimit ?? 5;
  const docKeySet = new Set(input.docKeys);

  // Presence, doc-wide: a block absent from the store must be caught on the
  // very next pass, not whenever its window comes around. The fingerprint read
  // is deferred to the handful of ids that actually fail the presence check.
  const missing: string[] = [];
  let unreadable = 0;
  for (const id of input.docKeys) {
    if (input.hasStoreBlock(id)) continue;
    if (input.docFingerprint(id) === null) {
      unreadable++;
      continue;
    }
    missing.push(id);
  }

  const drop: string[] = [];
  for (const id of input.storeKeys) {
    if (!docKeySet.has(id)) drop.push(id);
  }

  // Rotating window. A cursor past the end (doc shrank since last pass) wraps
  // to the start rather than scanning nothing.
  const total = input.docKeys.length;
  const start = total === 0 ? 0 : input.cursor % total;
  const end = Math.min(start + windowSize, total);

  const stale: string[] = [];
  for (let i = start; i < end; i++) {
    const id = input.docKeys[i];
    const stored = input.storeFingerprint(id);
    if (stored === null) continue; // already counted as missing
    const doc = input.docFingerprint(id);
    if (doc === null) continue; // unreadable in the doc; not a store defect
    if (fingerprintsDiverge(doc, stored)) stale.push(id);
  }

  const rootIdsDiverged =
    input.docRootIds.length !== input.storeRootIds.length ||
    input.docRootIds.some((id, i) => id !== input.storeRootIds[i]);

  const refresh = [...missing, ...stale];
  const storeBlocks = input.storeKeys.length + missing.length - drop.length;

  return {
    refresh,
    drop,
    replaceRootIds: rootIdsDiverged,
    nextCursor: end >= total ? 0 : end,
    report: {
      docBlocks: total,
      storeBlocks,
      scanned: end - start,
      missing: missing.length,
      extra: drop.length,
      stale: stale.length,
      unreadable,
      rootIdsRepaired: rootIdsDiverged,
      sampleIds: refresh.slice(0, sampleLimit),
    },
  };
}

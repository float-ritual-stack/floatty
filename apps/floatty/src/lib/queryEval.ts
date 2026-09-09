/**
 * `query::` evaluation (query-views track, brief E — FLO-947).
 *
 * Pure: a `QueryParse` plus plain lookups in, block ids out. No stores, no
 * DOM, no clock (`now` is a dep). The reactive memo that calls this lives in
 * `components/views/QueryBlockDisplay.tsx` — P1: views READ the store and
 * fine-grained reactivity is the invalidation; nothing here subscribes.
 *
 * Seeding strategy (cheapest candidate set first, then every term filters):
 *   1. a positive `link:` term → `backlinks.referencing(key)` — the P2 index
 *      is already the `target → sources` instantiation, no new index;
 *   2. else a positive `under:` term → the resolved root's subtree;
 *   3. else a scan over `blocks`.
 *
 * The query block itself and its whole subtree are never "pulled in": real
 * children are shown ONCE, in place (STATE.md decision), so the projection
 * dedupes them by construction rather than at render.
 *
 * Results sort newest-`updatedAt` first BEFORE the cap so a truncated board
 * keeps the live edge; the list's own sort control reorders what survived.
 *
 * TODO(brief B): `marker:` evaluates OWN markers (`block.metadata.markers`).
 * When `markerIndex` lands, swap `ownMarkers()` for the effective set —
 * the term shape (`markerType`, `value`) does not change.
 */

import type { Block } from './blockTypes';
import type { BacklinkIndex } from './backlinkIndex';
import { nearestPageId } from './backlinkScope';
import { getPageTitle, getSectionKey } from './pageTitle';
import { extractWikilinkTargets } from './wikilinkUtils';
import type { QueryMatcher, QueryParse, QueryTerm } from './queryPredicate';

export type QueryBlock = Pick<Block,
  'id' | 'parentId' | 'childIds' | 'content' | 'createdAt' | 'updatedAt' | 'metadata'
>;

export interface QueryEvalDeps {
  getBlock: (id: string) => QueryBlock | null | undefined;
  /** Every block, for the scan fallback (a Solid store proxy is fine). */
  blocks: Readonly<Record<string, QueryBlock>>;
  backlinks: BacklinkIndex;
  pagesContainerId: string | null;
  now: number;
  /** The `query::` block — it and its subtree are excluded from results. */
  queryBlockId: string;
}

export interface QueryEvalResult {
  /** Matching block ids, newest first, capped at `options.limit`. */
  ids: string[];
  /** Match count before the cap. */
  total: number;
  truncated: boolean;
  /** Evaluation-time problems (unresolved `under:`, ambiguous `link:`). */
  errors: string[];
}

const DAY_MS = 86_400_000;

/** Ids of `rootId`'s subtree (root excluded), cycle-guarded. */
export function collectDescendants(
  rootId: string,
  getBlock: QueryEvalDeps['getBlock'],
): Set<string> {
  const seen = new Set<string>();
  const stack = [...(getBlock(rootId)?.childIds ?? [])];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (seen.has(id) || id === rootId) continue;
    seen.add(id);
    const block = getBlock(id);
    if (block) stack.push(...block.childIds);
  }
  return seen;
}

function isUnder(blockId: string, rootId: string, getBlock: QueryEvalDeps['getBlock']): boolean {
  const visited = new Set<string>([blockId]);
  let current = getBlock(blockId)?.parentId ?? null;
  while (current && !visited.has(current)) {
    if (current === rootId) return true;
    visited.add(current);
    current = getBlock(current)?.parentId ?? null;
  }
  return false;
}

function matchText(matcher: QueryMatcher, candidates: string[], exactKey: (s: string) => string): boolean {
  if (matcher.op === 'regex') return candidates.some((candidate) => matcher.regex.test(candidate));
  const wanted = exactKey(matcher.value);
  return candidates.some((candidate) => exactKey(candidate) === wanted);
}

/** Resolve `under:` / `link:` targets once per evaluation, not per block. */
interface ResolvedTerms {
  /** `link:` exact → canonical key (null = unresolvable, never matches). */
  linkKeys: Map<QueryTerm, string | null>;
  /** `under:` → root block id (null = unresolvable, never matches). */
  underRoots: Map<QueryTerm, string | null>;
}

function resolveTerms(parse: QueryParse, deps: QueryEvalDeps, errors: string[]): ResolvedTerms {
  const linkKeys = new Map<QueryTerm, string | null>();
  const underRoots = new Map<QueryTerm, string | null>();
  for (const term of parse.terms) {
    if (term.kind === 'link' && term.match.op === 'exact') {
      const key = deps.backlinks.canonicalTargetKey(term.match.value);
      if (key === null) errors.push(`link: target "${term.match.value}" is empty or ambiguous`);
      linkKeys.set(term, key);
    } else if (term.kind === 'under') {
      // Same identities the wikilink ladder resolves (page name, full id,
      // compact id, unique hex prefix) — read through the index snapshot so
      // nothing is created. An unresolved page name comes back as `page:…`.
      const key = deps.backlinks.canonicalTargetKey(term.target);
      const root = key !== null && !key.startsWith('page:') && deps.getBlock(key) ? key : null;
      if (root === null) errors.push(`under: target "${term.target}" not found`);
      underRoots.set(term, root);
    }
  }
  return { linkKeys, underRoots };
}

export function evaluateQuery(parse: QueryParse, deps: QueryEvalDeps): QueryEvalResult {
  const errors: string[] = [];
  if (!parse.isQuery || parse.terms.length === 0) {
    return { ids: [], total: 0, truncated: false, errors: parse.terms.length === 0 && parse.isQuery ? ['empty query — add a term such as link:⬜'] : [] };
  }
  const resolved = resolveTerms(parse, deps, errors);
  const excluded = collectDescendants(deps.queryBlockId, deps.getBlock);
  excluded.add(deps.queryBlockId);

  // ── candidate seed ────────────────────────────────────────────
  let candidates: Iterable<string>;
  const seedLink = parse.terms.find((term): term is Extract<QueryTerm, { kind: 'link' }> =>
    term.kind === 'link' && !term.negate && term.match.op === 'exact');
  const seedUnder = parse.terms.find((term): term is Extract<QueryTerm, { kind: 'under' }> =>
    term.kind === 'under' && !term.negate);
  if (seedLink) {
    const key = resolved.linkKeys.get(seedLink) ?? null;
    candidates = key === null ? [] : deps.backlinks.referencing(key);
  } else if (seedUnder) {
    const root = resolved.underRoots.get(seedUnder) ?? null;
    candidates = root === null ? [] : collectDescendants(root, deps.getBlock);
  } else {
    candidates = Object.keys(deps.blocks);
  }

  // ── per-block predicate ───────────────────────────────────────
  const matches = (block: QueryBlock): boolean => {
    let outlinks: string[] | null = null;
    const rawOutlinks = () => (outlinks ??= block.content.includes('[[')
      ? extractWikilinkTargets(block.content, 'nested')
      : []);
    let pageId: string | null | undefined;
    const page = () => {
      if (pageId === undefined) pageId = nearestPageId(block.id, deps.pagesContainerId, deps.getBlock);
      return pageId ? deps.getBlock(pageId) ?? null : null;
    };
    const ownMarkers = () => block.metadata?.markers ?? [];

    for (const term of parse.terms) {
      let hit: boolean;
      switch (term.kind) {
        case 'link': {
          if (term.match.op === 'exact') {
            const key = resolved.linkKeys.get(term) ?? null;
            hit = key !== null && rawOutlinks()
              .some((target) => deps.backlinks.canonicalTargetKey(target) === key);
          } else {
            hit = matchText(term.match, rawOutlinks(), (s) => s);
          }
          break;
        }
        case 'page': {
          const pageBlock = page();
          hit = pageBlock !== null && (term.match.op === 'regex'
            ? term.match.regex.test(getPageTitle(pageBlock.content))
            : getSectionKey(pageBlock.content) === getSectionKey(term.match.value));
          break;
        }
        case 'under': {
          const root = resolved.underRoots.get(term) ?? null;
          hit = root !== null && isUnder(block.id, root, deps.getBlock);
          break;
        }
        case 'since': {
          const stamp = block.updatedAt || block.createdAt || 0;
          hit = stamp >= deps.now - term.days * DAY_MS;
          break;
        }
        case 'text':
          hit = term.regex.test(block.content.split('\n')[0] ?? '');
          break;
        case 'marker': {
          const wantedType = term.markerType.toLowerCase();
          const wantedValue = term.value?.toLowerCase() ?? null;
          hit = ownMarkers().some((marker) =>
            marker.markerType.toLowerCase() === wantedType
            && (wantedValue === null || (marker.value ?? '').toLowerCase() === wantedValue));
          break;
        }
        default:
          hit = false;
      }
      if (hit === term.negate) return false;
    }
    return true;
  };

  const matched: QueryBlock[] = [];
  const seen = new Set<string>();
  for (const id of candidates) {
    if (seen.has(id) || excluded.has(id)) continue;
    seen.add(id);
    const block = deps.getBlock(id);
    if (block && matches(block)) matched.push(block);
  }

  matched.sort((a, b) =>
    (b.updatedAt || 0) - (a.updatedAt || 0)
    || (b.createdAt || 0) - (a.createdAt || 0)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const total = matched.length;
  const limit = parse.options.limit;
  const ids = matched.slice(0, limit).map((block) => block.id);
  return { ids, total, truncated: total > limit, errors };
}

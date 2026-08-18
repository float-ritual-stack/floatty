/**
 * floatty-pr Door — fetch one or more GitHub PRs (description, optionally
 * comments) into the outline. Sibling of the linear:: / jira:: doors.
 *
 * Usage:
 *   floatty-pr:: 387                 → title/state envelope + description tree
 *   floatty-pr:: 387 392 PR-395      → one envelope subtree PER PR
 *   floatty-pr:: 387 --comments      → + issue comments and non-empty reviews
 *   floatty-pr::                     → infer number(s) from the nearest
 *                                      ancestor matching "PR #NNN" / "PR-NNN" —
 *                                      a multi-ref ancestor fans out into one
 *                                      fetch per PR
 *
 * Flags: --comments / -c. Repo defaults to float-ritual-stack/floatty;
 * override via config.toml → [plugins.floatty-pr] repo = "owner/name".
 *
 * Child blocks follow the envelope shape (capture-format.md Layer 2,
 * [[bc2f8294]]): parent = headline + metadata line + trailing blank line,
 * detail in children — a collapsed stack scans like `git log --oneline`.
 */

import { exec, parseJSON, addNewChildrenTree, parseMarkdownToOps } from '@floatty/stdlib';

const DEFAULT_REPO = 'float-ritual-stack/floatty';
/** Bot review walkthroughs run 10k+ chars — cap what lands in the outline. */
const COMMENT_CHAR_CAP = 2500;
/** Fan-out sanity cap — a page with 50 refs should not become 50 API calls. */
const MAX_PRS = 8;

const safeRepo = s => (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s) ? s : null);

export function parseArgs(content) {
  let rest = content.replace(/^floatty-pr::\s*/i, '').trim();
  // `// …` is a comment — Evan annotates door blocks this way. Strip it so
  // digits inside prose ("// auto populate 387?") never hijack the number.
  rest = rest.replace(/\/\/.*$/s, '').trim();
  const parts = rest.split(/\s+/).filter(Boolean);
  const comments = parts.some(p => p === '--comments' || p === '-c');
  // Numbers come ONLY from tokens shaped "387" / "#387" / "PR-387" / "PR#387";
  // a standalone "pr" token is skipped (its number arrives as the next token).
  const numbers = [];
  for (const t of parts) {
    if (t.startsWith('-') && !/^-\d/.test(t)) continue;
    if (/^pr$/i.test(t)) continue;
    const m = t.match(/^#?(\d{1,6})$/) ?? t.match(/^pr[-#]?(\d{1,6})$/i);
    if (m) numbers.push(m[1]);
  }
  return { numbers: [...new Set(numbers)], comments };
}

/**
 * Walk up the parent chain for the nearest ancestor matching "PR #NNN" or
 * "PR-NNN" — nearest ancestor wins and contributes ALL its refs, so a block
 * listing [[PR-123]] [[PR-5555]] fans out into one fetch per PR. Deliberately
 * strict (a `#` or `-` must join PR to the digits) so "PR 12 things" or a
 * stray "#386" in prose never hijacks the inference.
 */
export function inferFromAncestors(blockId, actions) {
  const seen = new Set([blockId]);
  let id = blockId;
  for (;;) {
    const parentId = actions.getParentId(id);
    if (!parentId || seen.has(parentId)) return []; // root or cycle — done
    seen.add(parentId);
    const parent = actions.getBlock(parentId);
    const ms = [...String(parent?.content ?? '').matchAll(/\bPR(?:\s*#|-)(\d{1,6})\b/gi)];
    if (ms.length) return [...new Set(ms.map(m => m[1]))];
    id = parentId;
  }
  return [];
}

function truncate(body) {
  if (body.length <= COMMENT_CHAR_CAP) return body;
  return `${body.slice(0, COMMENT_CHAR_CAP)}\n\n… (truncated — full text on GitHub)`;
}

/** "2026-08-18T04:56:15Z" → "2026-08-18 04:56" — scannable, no TZ math. */
const shortDate = iso => (iso || '').replace('T', ' ').slice(0, 16);


/** PR state → glyph + chip color (visual header language). */
export function statusVisual(state) {
  const st = String(state ?? '').toUpperCase();
  if (st === 'MERGED') return { glyph: '\ud83d\udfe3', color: 'purple' };
  if (st === 'OPEN') return { glyph: '\ud83d\udfe2', color: 'green' };
  if (st === 'DRAFT') return { glyph: '\u26aa', color: 'dim' };
  return { glyph: '\ud83d\udd34', color: 'coral' }; // CLOSED etc.
}

/** Compact json-render header card: Card(title/subtitle) + Row of chips. */
export function buildHeaderSpec({ number, title, state, color, author, head, base, adds, dels }) {
  return {
    root: 'r',
    elements: {
      r: { type: 'Card', props: { title: `PR #${number} \u2014 ${title}`, subtitle: `@${author} \u00b7 ${head} \u2192 ${base} \u00b7 +${adds} \u2212${dels}` }, children: ['row'] },
      row: { type: 'Row', props: {}, children: ['st', 'lnk'] },
      st: { type: 'Chip', props: { label: state, color, icon: 'git-pull-request' } },
      lnk: { type: 'WikilinkChip', props: { target: `PR #${number}` } },
    },
  };
}

/** Find an existing header child for PR n (refresh-in-place on re-run). */
export function findExistingHeader(blockId, n, actions) {
  for (const cid of actions.getChildren(blockId) ?? []) {
    const c = actions.getBlock(cid);
    if (c?.content?.includes(`[[PR #${n}]]`)) return cid;
  }
  return null;
}

/** Fetch ONE PR -> header card + markdown children. */
async function fetchPrTree(number, wantComments, repo) {
  const fields = 'number,title,state,author,body,url,headRefName,baseRefName,additions,deletions,mergedAt,comments,reviews';
  const raw = await exec(`gh pr view ${number} -R ${repo} --json ${fields}`);
  const pr = parseJSON(raw);
  if (!pr || typeof pr.number !== 'number') return null;

  const state = pr.mergedAt ? 'MERGED' : pr.state;
  const author = pr.author?.login ?? '?';
  const children = parseMarkdownToOps(pr.body || '(no description)');

  if (wantComments) {
    const entries = [
      ...(pr.comments ?? []).map(c => ({
        at: c.createdAt, who: c.author?.login ?? '?', kind: 'comment', body: c.body ?? '',
      })),
      ...(pr.reviews ?? []).filter(r => (r.body ?? '').trim()).map(r => ({
        at: r.submittedAt, who: r.author?.login ?? '?', kind: `review ${r.state}`, body: r.body ?? '',
      })),
    ].sort((a, b) => String(a.at).localeCompare(String(b.at)));
    children.push({
      content: `## comments (${entries.length})\n`,
      children: entries.map(e => ({
        content: `## @${e.who} · ${shortDate(e.at)}\n[[${e.kind}]]\n`,
        children: parseMarkdownToOps(truncate(e.body)),
      })),
    });
  }

  const vis = statusVisual(state);
  return {
    headerContent: `${vis.glyph} [[PR #${pr.number}]] — ${pr.title}`,
    headerSpec: buildHeaderSpec({
      number: pr.number, title: pr.title, state, color: vis.color, author,
      head: pr.headRefName, base: pr.baseRefName, adds: pr.additions, dels: pr.deletions,
    }),
    cardTitle: `PR #${pr.number} — ${pr.title}`,
    children,
    state,
    title: pr.title,
    number: pr.number,
  };
}

export const door = {
  kind: 'block',
  prefixes: ['floatty-pr::'],

  async execute(blockId, content, ctx) {
    const { actions, log } = ctx;
    const args = parseArgs(content);

    let numbers = args.numbers.length ? args.numbers : inferFromAncestors(blockId, actions);
    if (!numbers.length) {
      actions.setBlockOutput(blockId, {
        type: 'text',
        data: 'Usage: floatty-pr:: <number> [<number> …] [--comments] — or run it under a block carrying "PR #NNN" / "PR-NNN" refs',
      }, 'eval-result');
      actions.setBlockStatus(blockId, 'complete');
      return;
    }
    const dropped = Math.max(0, numbers.length - MAX_PRS);
    numbers = numbers.slice(0, MAX_PRS);

    const repo = safeRepo(String(ctx.settings?.repo ?? DEFAULT_REPO));
    if (!repo) {
      actions.setBlockOutput(blockId, { type: 'error', data: `Invalid [plugins.floatty-pr] repo setting` }, 'eval-result');
      actions.setBlockStatus(blockId, 'error');
      return;
    }

    actions.setBlockStatus(blockId, 'running');
    const misses = [];
    const ok = [];
    const failed = [];
    for (const n of numbers) {
      try {
        const r = await fetchPrTree(n, args.comments, repo);
        if (!r) {
          failed.push(n);
          misses.push({ content: `## [[PR #${n}]] — fetch failed (${repo})\n` });
          continue;
        }
        const existing = findExistingHeader(blockId, n, actions);
        const headerId = existing ?? actions.createBlockInside(blockId);
        actions.updateBlockContent(headerId, r.headerContent);
        actions.setBlockOutput(headerId, {
          kind: 'view', doorId: 'render', schema: 1,
          data: { spec: r.headerSpec, title: r.cardTitle, generatedVia: 'floatty-pr-door' },
        }, 'door');
        actions.setBlockStatus(headerId, 'complete');
        if (!existing) addNewChildrenTree(headerId, r.children, actions);
        ok.push(r);
      } catch (err) {
        failed.push(n);
        misses.push({ content: `## [[PR #${n}]] — fetch failed: ${String(err).slice(0, 120)}\n` });
      }
    }
    if (misses.length) addNewChildrenTree(blockId, misses, actions);
    let summary;
    if (numbers.length === 1 && ok.length === 1) {
      summary = `[[PR #${ok[0].number}]] ${ok[0].state} — ${ok[0].title}`;
    } else {
      summary = `${ok.length}/${numbers.length} PRs — ${numbers.map(n => `[[PR #${n}]]`).join(' ')}`;
      if (dropped) summary += ` (+${dropped} beyond cap)`;
    }
    actions.setBlockOutput(blockId, { type: 'text', data: summary }, 'eval-result');
    actions.setBlockStatus(blockId, failed.length && !ok.length ? 'error' : 'complete');
    log(`Fetched ${ok.length}/${numbers.length} PR(s) from ${repo}${args.comments ? ' +comments' : ''}`);
  },
};

export const meta = {
  id: 'floatty-pr',
  name: 'Floatty PR',
  version: '0.2.0',
  selfRender: true,
};

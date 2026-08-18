/**
 * floatty-pr Door — fetch a GitHub PR (description, optionally comments)
 * into the outline. Sibling of the linear:: door, same shape.
 *
 * Usage:
 *   floatty-pr:: 387              → title/state envelope + description tree
 *   floatty-pr:: 387 --comments   → + issue comments and non-empty reviews
 *   floatty-pr::                  → infer the PR number from the nearest
 *                                   ancestor whose content matches "PR #NNN"
 *                                   (e.g. a block on the "# PR #387" page)
 *   floatty-pr:: --comments       → inferred number + comments
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

const safePrNumber = s => (/^\d{1,6}$/.test(s) ? s : null);
const safeRepo = s => (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s) ? s : null);

function parseArgs(content) {
  let rest = content.replace(/^floatty-pr::\s*/i, '').trim();
  // `// …` is a comment — Evan annotates door blocks this way. Strip it so
  // digits inside prose ("// auto populate 387?") never hijack the number.
  rest = rest.replace(/\/\/.*$/s, '').trim();
  const parts = rest.split(/\s+/).filter(Boolean);
  const comments = parts.some(p => p === '--comments' || p === '-c');
  const positional = parts.filter(p => !p.startsWith('-'));
  // Number comes ONLY from a leading "387" / "#387" / "PR #387" — never from
  // arbitrary digits later in the line.
  let number = null;
  const t0 = positional[0] ?? '';
  const t1 = positional[1] ?? '';
  let m = t0.match(/^#?(\d{1,6})$/);
  if (m) number = m[1];
  else if (/^pr$/i.test(t0) && (m = t1.match(/^#?(\d{1,6})$/))) number = m[1];
  return { number, comments };
}

/**
 * Walk up the parent chain looking for "PR #NNN" in ancestor content —
 * nearest ancestor wins, so a block under the "# PR #387" page resolves 387.
 * Deliberately strict (\bPR\s*#) so a stray issue ref like "#386" in prose
 * never hijacks the inference.
 */
function inferFromAncestors(blockId, actions) {
  let id = blockId;
  for (let hops = 0; hops < 20; hops++) {
    const parentId = actions.getParentId(id);
    if (!parentId) return null;
    const parent = actions.getBlock(parentId);
    const m = parent?.content?.match(/\bPR\s*#(\d{1,6})/i);
    if (m) return m[1];
    id = parentId;
  }
  return null;
}

function truncate(body) {
  if (body.length <= COMMENT_CHAR_CAP) return body;
  return `${body.slice(0, COMMENT_CHAR_CAP)}\n\n… (truncated — full text on GitHub)`;
}

/** "2026-08-18T04:56:15Z" → "2026-08-18 04:56" — scannable, no TZ math. */
const shortDate = iso => (iso || '').replace('T', ' ').slice(0, 16);

export const door = {
  kind: 'block',
  prefixes: ['floatty-pr::'],

  async execute(blockId, content, ctx) {
    const { actions, log } = ctx;
    const args = parseArgs(content);

    const number = args.number
      ? safePrNumber(args.number)
      : inferFromAncestors(blockId, actions);
    if (!number) {
      actions.setBlockOutput(blockId, {
        type: 'text',
        data: 'Usage: floatty-pr:: <number> [--comments] — or run it under a "PR #NNN" page',
      }, 'eval-result');
      actions.setBlockStatus(blockId, 'complete');
      return;
    }

    const repo = safeRepo(String(ctx.settings?.repo ?? DEFAULT_REPO));
    if (!repo) {
      actions.setBlockOutput(blockId, { type: 'error', data: `Invalid [plugins.floatty-pr] repo setting` }, 'eval-result');
      actions.setBlockStatus(blockId, 'error');
      return;
    }

    try {
      actions.setBlockStatus(blockId, 'running');
      const fields = 'number,title,state,author,body,url,headRefName,baseRefName,additions,deletions,mergedAt,comments,reviews';
      const raw = await exec(`gh pr view ${number} -R ${repo} --json ${fields}`);
      const pr = parseJSON(raw);
      if (!pr || typeof pr.number !== 'number') {
        actions.setBlockOutput(blockId, { type: 'error', data: `gh returned no data for #${number} (${repo})` }, 'eval-result');
        actions.setBlockStatus(blockId, 'error');
        return;
      }

      const state = pr.mergedAt ? 'MERGED' : pr.state;
      const author = pr.author?.login ?? '?';

      // ── Envelope: headline + metadata line + trailing blank ──
      const header = {
        content: `## [[PR #${pr.number}]] — ${pr.title}\n[[${state}]] · @${author} · ${pr.headRefName} → ${pr.baseRefName} · +${pr.additions} −${pr.deletions}\n`,
        children: parseMarkdownToOps(pr.body || '(no description)'),
      };
      const tree = [header];

      if (args.comments) {
        // Issue comments + review summaries with bodies, one stream by time.
        const entries = [
          ...(pr.comments ?? []).map(c => ({
            at: c.createdAt, who: c.author?.login ?? '?', kind: 'comment', body: c.body ?? '',
          })),
          ...(pr.reviews ?? []).filter(r => (r.body ?? '').trim()).map(r => ({
            at: r.submittedAt, who: r.author?.login ?? '?', kind: `review ${r.state}`, body: r.body ?? '',
          })),
        ].sort((a, b) => String(a.at).localeCompare(String(b.at)));

        tree.push({
          content: `## comments (${entries.length})\n`,
          children: entries.map(e => ({
            content: `## @${e.who} · ${shortDate(e.at)}\n[[${e.kind}]]\n`,
            children: parseMarkdownToOps(truncate(e.body)),
          })),
        });
      }

      addNewChildrenTree(blockId, tree, actions);
      const summary = `[[PR #${pr.number}]] ${state} — ${pr.title}`;
      actions.setBlockOutput(blockId, { type: 'text', data: summary }, 'eval-result');
      actions.setBlockStatus(blockId, 'complete');
      log(`Fetched ${repo}#${pr.number} (${state}${args.comments ? ', +comments' : ''})`);
    } catch (err) {
      actions.setBlockOutput(blockId, { type: 'error', data: String(err) }, 'eval-result');
      actions.setBlockStatus(blockId, 'error');
    }
  },
};

export const meta = {
  id: 'floatty-pr',
  name: 'Floatty PR',
  version: '0.1.0',
  selfRender: true,
};

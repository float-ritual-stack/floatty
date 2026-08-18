/**
 * az-pr Door — fetch one or more Azure DevOps pull requests (description,
 * optionally comment threads) into the outline. Sibling of floatty-pr:: / jira::.
 *
 * Usage:
 *   az-pr:: 943              → title/status envelope + description tree
 *   az-pr:: !943 !942        → one envelope subtree PER PR (ADO's !NNN form)
 *   az-pr:: 943 --comments   → + text comments from PR threads
 *   az-pr::                  → infer number(s) from the nearest ancestor
 *                              matching "PR #NNN" / "PR-NNN" / "!NNN" —
 *                              a multi-ref ancestor fans out into one fetch per PR
 *
 * Auth: rides the az CLI's own AAD login (`az login` + azure-devops
 * extension) — no PAT to manage. Org/project default to
 * `az devops configure` defaults; override via config.toml:
 *   [plugins.az-pr]
 *   organization = "https://dev.azure.com/RexallCatalyst"
 *   project = "Catalyst"
 *
 * Verified live 2026-08-18 against RexallCatalyst/Catalyst PR !943 —
 * `az repos pr show` carries repository.id + project name, so --comments
 * needs no extra lookup before the threads invoke.
 */

import { exec, parseJSON, addNewChildrenTree, parseMarkdownToOps } from '@floatty/stdlib';

/** Bot/long comments can run huge — cap what lands in the outline. */
const COMMENT_CHAR_CAP = 2500;
/** Fan-out sanity cap — a page with 50 refs should not become 50 az calls. */
const MAX_PRS = 8;

const safePrNumber = s => (/^\d{1,6}$/.test(s) ? s : null);
export const safeOrg = (s) => {
  const t = String(s ?? '').trim().replace(/\/+$/, '');
  return /^https:\/\/dev\.azure\.com\/[A-Za-z0-9_-]+$/.test(t) ? t : null;
};
export const safeProject = s => (/^[A-Za-z0-9 _.-]{1,64}$/.test(s) ? s : null);

export function parseArgs(content) {
  let rest = content.replace(/^az-pr::\s*/i, '').trim();
  // `// …` is a comment — strip so annotation prose never hijacks numbers.
  rest = rest.replace(/\/\/.*$/s, '').trim();
  const parts = rest.split(/\s+/).filter(Boolean);
  const comments = parts.some(p => p === '--comments' || p === '-c');
  // Numbers ONLY from tokens shaped "943" / "#943" / "!943" / "PR-943";
  // a standalone "pr" token is skipped (its number arrives as the next token).
  const numbers = [];
  for (const t of parts) {
    if (t.startsWith('--') || /^-[a-z]/i.test(t)) continue;
    if (/^pr$/i.test(t)) continue;
    const m = t.match(/^[#!]?(\d{1,6})$/) ?? t.match(/^pr[-#!]?(\d{1,6})$/i);
    if (m) numbers.push(m[1]);
  }
  return { numbers: [...new Set(numbers)], comments };
}

/**
 * Walk up the parent chain for the nearest ancestor carrying "PR #NNN",
 * "PR-NNN", or "!NNN" — nearest ancestor wins and contributes ALL its refs.
 * Anchored forms only; a stray "#386" in prose never hijacks the inference.
 */
export function inferFromAncestors(blockId, actions) {
  const seen = new Set([blockId]);
  let id = blockId;
  for (;;) {
    const parentId = actions.getParentId(id);
    if (!parentId || seen.has(parentId)) return []; // root or cycle — done
    seen.add(parentId);
    const parent = actions.getBlock(parentId);
    const ms = [...String(parent?.content ?? '').matchAll(/(?:\bPR(?:\s*[#!]?|-)|!)(\d{1,6})\b/gi)];
    if (ms.length) return [...new Set(ms.map(m => m[1]))];
    id = parentId;
  }
  return [];
}

function truncate(body) {
  if (body.length <= COMMENT_CHAR_CAP) return body;
  return `${body.slice(0, COMMENT_CHAR_CAP)}\n\n… (truncated — full text in Azure DevOps)`;
}

/** "refs/heads/fix/x" → "fix/x" */
export const refShort = r => String(r ?? '').replace(/^refs\/heads\//, '');
/** "2026-08-18T04:56:15.000Z" → "2026-08-18 04:56" */
const shortDate = iso => (iso || '').replace('T', ' ').slice(0, 16);


/** ADO PR status → glyph + chip color (visual header language). */
export function statusVisual(status) {
  const st = String(status ?? '').toUpperCase();
  if (st === 'COMPLETED') return { glyph: '\ud83d\udfe3', color: 'purple' };
  if (st === 'ACTIVE') return { glyph: '\ud83d\udfe2', color: 'green' };
  if (st === 'ABANDONED') return { glyph: '\ud83d\udd34', color: 'coral' };
  return { glyph: '\u26aa', color: 'dim' };
}

/** Compact json-render header card: Card(title/subtitle) + Row of chips. */
export function buildHeaderSpec({ number, title, status, color, author, src, tgt }) {
  return {
    root: 'r',
    elements: {
      r: { type: 'Card', props: { title: `PR !${number} \u2014 ${title}`, subtitle: `@${author} \u00b7 ${src} \u2192 ${tgt}` }, children: ['row'] },
      row: { type: 'Row', props: {}, children: ['st', 'lnk'] },
      st: { type: 'Chip', props: { label: status, color, icon: 'git-pull-request' } },
      lnk: { type: 'WikilinkChip', props: { target: `PR !${number}` } },
    },
  };
}

/** Find an existing header child for PR n (refresh-in-place on re-run). */
export function findExistingHeader(blockId, n, actions) {
  for (const cid of actions.getChildren(blockId) ?? []) {
    const c = actions.getBlock(cid);
    // outputType === 'door' is the generated-header discriminator: a
    // user-authored sibling that merely MENTIONS the ref must never be
    // matched (updateBlockContent would clobber it). A miss here degrades
    // to a duplicate header — annoying, never destructive.
    if (c?.outputType === 'door' && c?.content?.includes(`[[PR !${n}]]`)) return cid;
  }
  return null;
}

/** Fetch ONE PR -> header card + markdown children. */
async function fetchPrTree(number, wantComments, cfg) {
  const raw = await exec(`az repos pr show --id ${number}${cfg.scope} --only-show-errors -o json`);
  const pr = parseJSON(raw);
  if (!pr || typeof pr.pullRequestId !== 'number') return null;

  const status = String(pr.status ?? '?').toUpperCase();
  const author = pr.createdBy?.displayName ?? '?';
  const children = parseMarkdownToOps(pr.description || '(no description)');

  if (wantComments) {
    // repository.id + project name ride the pr show response — no lookup.
    const repoId = pr.repository?.id;
    const proj = safeProject(String(cfg.projSetting ?? pr.repository?.project?.name ?? ''));
    if (repoId && proj) {
      const traw = await exec(
        `az devops invoke --area git --resource pullRequestThreads ` +
        `--route-parameters "project=${proj}" "repositoryId=${repoId}" "pullRequestId=${number}" ` +
        `--api-version 7.1${cfg.scope} --only-show-errors -o json`,
      );
      const tpage = parseJSON(traw);
      if (!tpage || !Array.isArray(tpage.value)) {
        // A failed threads request must NOT masquerade as "comments (0)" —
        // the PR card still lands; the failure is named in its own child.
        children.push({ content: `## comments — fetch failed (threads response was not an ADO payload)\n` });
      } else {
        const entries = tpage.value
          .flatMap(t => t.comments ?? [])
          .filter(c => c.commentType === 'text' && (c.content ?? '').trim())
          .sort((a, b) => String(a.publishedDate).localeCompare(String(b.publishedDate)));
        children.push({
          content: `## comments (${entries.length})\n`,
          children: entries.map(c => ({
            content: `## @${c.author?.displayName ?? '?'} · ${shortDate(c.publishedDate)}\n`,
            children: parseMarkdownToOps(truncate(c.content ?? '')),
          })),
        });
      }
    }
  }

  const vis = statusVisual(status);
  return {
    headerContent: `${vis.glyph} [[PR !${pr.pullRequestId}]] — ${pr.title ?? ''}`,
    headerSpec: buildHeaderSpec({
      number: pr.pullRequestId, title: pr.title ?? '', status, color: vis.color,
      author, src: refShort(pr.sourceRefName), tgt: refShort(pr.targetRefName),
    }),
    cardTitle: `PR !${pr.pullRequestId} — ${pr.title ?? ''}`,
    children,
    status,
    title: pr.title ?? '',
    number: pr.pullRequestId,
  };
}

export const door = {
  kind: 'block',
  prefixes: ['az-pr::'],

  async execute(blockId, content, ctx) {
    const { actions, log } = ctx;
    const args = parseArgs(content);

    let numbers = (args.numbers.length ? args.numbers : inferFromAncestors(blockId, actions))
      .filter(n => safePrNumber(n));
    if (!numbers.length) {
      actions.setBlockOutput(blockId, {
        type: 'text',
        data: 'Usage: az-pr:: <number|!number> [more …] [--comments] — or run it under a block carrying "PR #NNN" / "!NNN" refs',
      }, 'eval-result');
      actions.setBlockStatus(blockId, 'complete');
      return;
    }
    const dropped = Math.max(0, numbers.length - MAX_PRS);
    numbers = numbers.slice(0, MAX_PRS);

    // Org override via settings; else the az CLI's configured defaults.
    let scope = '';
    const orgSetting = ctx.settings?.organization;
    const projSetting = ctx.settings?.project;
    if (orgSetting) {
      const org = safeOrg(orgSetting);
      if (!org) {
        actions.setBlockOutput(blockId, { type: 'error', data: 'Invalid [plugins.az-pr] organization (want https://dev.azure.com/<org>)' }, 'eval-result');
        actions.setBlockStatus(blockId, 'error');
        return;
      }
      scope = ` --organization "${org}"`;
    }
    if (projSetting && !safeProject(String(projSetting))) {
      actions.setBlockOutput(blockId, { type: 'error', data: 'Invalid [plugins.az-pr] project' }, 'eval-result');
      actions.setBlockStatus(blockId, 'error');
      return;
    }

    actions.setBlockStatus(blockId, 'running');
    const cfg = { scope, projSetting };
    const misses = [];
    const ok = [];
    const failed = [];
    for (const n of numbers) {
      try {
        const r = await fetchPrTree(n, args.comments, cfg);
        if (!r) {
          failed.push(n);
          misses.push({ content: `## [[PR !${n}]] — fetch failed (is \`az login\` current on this machine?)\n` });
          continue;
        }
        const existing = findExistingHeader(blockId, n, actions);
        const headerId = existing ?? actions.createBlockInside(blockId);
        actions.updateBlockContent(headerId, r.headerContent);
        actions.setBlockOutput(headerId, {
          kind: 'view', doorId: 'render', schema: 1,
          data: { spec: r.headerSpec, title: r.cardTitle, generatedVia: 'az-pr-door' },
        }, 'door');
        actions.setBlockStatus(headerId, 'complete');
        if (!existing) addNewChildrenTree(headerId, r.children, actions);
        ok.push(r);
      } catch (err) {
        failed.push(n);
        misses.push({ content: `## [[PR !${n}]] — fetch failed: ${String(err).slice(0, 120)}\n` });
      }
    }
    if (misses.length) addNewChildrenTree(blockId, misses, actions);
    let summary;
    if (numbers.length === 1 && ok.length === 1) {
      summary = `[[PR !${ok[0].number}]] ${ok[0].status} — ${ok[0].title}`;
    } else {
      summary = `${ok.length}/${numbers.length} PRs — ${numbers.map(n => `[[PR !${n}]]`).join(' ')}`;
      if (dropped) summary += ` (+${dropped} beyond cap)`;
    }
    actions.setBlockOutput(blockId, { type: 'text', data: summary }, 'eval-result');
    actions.setBlockStatus(blockId, failed.length && !ok.length ? 'error' : 'complete');
    log(`Fetched ${ok.length}/${numbers.length} PR(s)${args.comments ? ' +comments' : ''}`);
  },
};

export const meta = {
  id: 'az-pr',
  name: 'Azure PR',
  version: '0.2.0',
  selfRender: true,
};

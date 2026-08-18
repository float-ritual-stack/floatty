/**
 * az-pr Door — fetch an Azure DevOps pull request (description, optionally
 * comment threads) into the outline. Sibling of floatty-pr:: / jira::.
 *
 * Usage:
 *   az-pr:: 943              → title/status envelope + description tree
 *   az-pr:: !943             → same (ADO's !NNN convention)
 *   az-pr:: 943 --comments   → + text comments from PR threads
 *   az-pr::                  → infer the number from the nearest ancestor
 *                              matching "PR #NNN" or "!NNN"
 *   az-pr:: // comment       → `// …` is comment text, ignored
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

const safePrNumber = s => (/^\d{1,6}$/.test(s) ? s : null);
export const safeOrg = (s) => {
  const t = String(s ?? '').trim().replace(/\/+$/, '');
  return /^https:\/\/dev\.azure\.com\/[A-Za-z0-9_-]+$/.test(t) ? t : null;
};
export const safeProject = s => (/^[A-Za-z0-9 _.-]{1,64}$/.test(s) ? s : null);

export function parseArgs(content) {
  let rest = content.replace(/^az-pr::\s*/i, '').trim();
  // `// …` is a comment — strip so annotation prose never hijacks the number.
  rest = rest.replace(/\/\/.*$/s, '').trim();
  const parts = rest.split(/\s+/).filter(Boolean);
  const comments = parts.some(p => p === '--comments' || p === '-c');
  // Number ONLY from a leading "943" / "#943" / "!943" / "PR 943" token —
  // flag-shaped tokens (--x / -c) are excluded, but "!943"/"#943" survive.
  const pos = parts.filter(p => !p.startsWith('--') && !/^-[a-z]/i.test(p));
  let number = null;
  const t0 = pos[0] ?? '';
  const t1 = pos[1] ?? '';
  let m = t0.match(/^[#!]?(\d{1,6})$/);
  if (m) number = m[1];
  else if (/^pr$/i.test(t0) && (m = t1.match(/^[#!]?(\d{1,6})$/))) number = m[1];
  return { number, comments };
}

/**
 * Walk up the parent chain for the nearest "PR #NNN" or "!NNN" — nearest
 * ancestor wins, so a block under the "# PR !943" page resolves 943.
 * Anchored forms only; a stray "#386" in prose never hijacks the inference.
 */
export function inferFromAncestors(blockId, actions) {
  let id = blockId;
  for (let hops = 0; hops < 20; hops++) {
    const parentId = actions.getParentId(id);
    if (!parentId) return null;
    const parent = actions.getBlock(parentId);
    const m = parent?.content?.match(/(?:\bPR\s*[#!]?|!)(\d{1,6})\b/i);
    if (m) return m[1];
    id = parentId;
  }
  return null;
}

function truncate(body) {
  if (body.length <= COMMENT_CHAR_CAP) return body;
  return `${body.slice(0, COMMENT_CHAR_CAP)}\n\n… (truncated — full text in Azure DevOps)`;
}

/** "refs/heads/fix/x" → "fix/x" */
export const refShort = r => String(r ?? '').replace(/^refs\/heads\//, '');
/** "2026-08-18T04:56:15.000Z" → "2026-08-18 04:56" */
const shortDate = iso => (iso || '').replace('T', ' ').slice(0, 16);

export const door = {
  kind: 'block',
  prefixes: ['az-pr::'],

  async execute(blockId, content, ctx) {
    const { actions, log } = ctx;
    const args = parseArgs(content);

    const number = args.number
      ? safePrNumber(args.number)
      : inferFromAncestors(blockId, actions);
    if (!number) {
      actions.setBlockOutput(blockId, {
        type: 'text',
        data: 'Usage: az-pr:: <number|!number> [--comments] — or run it under a "PR #NNN" / "!NNN" page',
      }, 'eval-result');
      actions.setBlockStatus(blockId, 'complete');
      return;
    }

    // Org/project override via settings; else the az CLI's configured defaults.
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
      scope += ` --organization "${org}"`;
    }
    if (projSetting) {
      const proj = safeProject(String(projSetting));
      if (!proj) {
        actions.setBlockOutput(blockId, { type: 'error', data: 'Invalid [plugins.az-pr] project' }, 'eval-result');
        actions.setBlockStatus(blockId, 'error');
        return;
      }
      // az repos pr show doesn't take --project; kept for the threads invoke.
    }

    try {
      actions.setBlockStatus(blockId, 'running');
      const raw = await exec(`az repos pr show --id ${number}${scope} --only-show-errors -o json`);
      const pr = parseJSON(raw);
      if (!pr || typeof pr.pullRequestId !== 'number') {
        actions.setBlockOutput(blockId, { type: 'error', data: `az returned no data for !${number} — is \`az login\` current on this machine?` }, 'eval-result');
        actions.setBlockStatus(blockId, 'error');
        return;
      }

      const status = String(pr.status ?? '?').toUpperCase();
      const author = pr.createdBy?.displayName ?? '?';
      const src = refShort(pr.sourceRefName);
      const tgt = refShort(pr.targetRefName);

      // ── Envelope: headline + metadata line + trailing blank ──
      const tree = [{
        content: `## [[PR !${pr.pullRequestId}]] — ${pr.title ?? ''}\n[[${status}]] · @${author} · ${src} → ${tgt}\n`,
        children: parseMarkdownToOps(pr.description || '(no description)'),
      }];

      if (args.comments) {
        // repository.id + project name ride the pr show response — no lookup.
        const repoId = pr.repository?.id;
        const proj = safeProject(String(projSetting ?? pr.repository?.project?.name ?? ''));
        if (repoId && proj) {
          const invokeScope = orgSetting ? ` --organization "${safeOrg(orgSetting)}"` : '';
          const traw = await exec(
            `az devops invoke --area git --resource pullRequestThreads ` +
            `--route-parameters "project=${proj}" "repositoryId=${repoId}" "pullRequestId=${number}" ` +
            `--api-version 7.1${invokeScope} --only-show-errors -o json`,
          );
          const threads = parseJSON(traw)?.value ?? [];
          const entries = threads
            .flatMap(t => t.comments ?? [])
            .filter(c => c.commentType === 'text' && (c.content ?? '').trim())
            .sort((a, b) => String(a.publishedDate).localeCompare(String(b.publishedDate)));
          tree.push({
            content: `## comments (${entries.length})\n`,
            children: entries.map(c => ({
              content: `## @${c.author?.displayName ?? '?'} · ${shortDate(c.publishedDate)}\n`,
              children: parseMarkdownToOps(truncate(c.content ?? '')),
            })),
          });
        }
      }

      addNewChildrenTree(blockId, tree, actions);
      const summary = `[[PR !${pr.pullRequestId}]] ${status} — ${pr.title ?? ''}`;
      actions.setBlockOutput(blockId, { type: 'text', data: summary }, 'eval-result');
      actions.setBlockStatus(blockId, 'complete');
      log(`Fetched !${pr.pullRequestId} (${status}${args.comments ? ', +comments' : ''})`);
    } catch (err) {
      actions.setBlockOutput(blockId, { type: 'error', data: String(err) }, 'eval-result');
      actions.setBlockStatus(blockId, 'error');
    }
  },
};

export const meta = {
  id: 'az-pr',
  name: 'Azure PR',
  version: '0.1.0',
  selfRender: true,
};

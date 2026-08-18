/**
 * Jira Door — fetch a Jira issue (summary, status, description, optionally
 * comments) into the outline. Sibling of linear:: / floatty-pr::, same shape.
 *
 * Usage:
 *   jira:: PROJ-123               → status envelope + description tree
 *   jira:: PROJ-123 --comments    → + issue comments (capped)
 *   jira::                        → infer the key from the nearest ancestor
 *                                   matching a "PROJ-123" style key
 *   jira:: // comment             → `// …` is comment text, ignored
 *
 * Auth: token lives in the macOS Keychain (never in a file):
 *   security add-generic-password -s jira-api-token -a evan -w
 * The shell command resolves it at exec time — the token never appears in
 * JS, settings, or logs.
 *
 * Config (config.toml, both machines):
 *   [plugins.jira]
 *   site  = "https://yoursite.atlassian.net"
 *   email = "you@example.com"
 *   # service = "jira-api-token"   # optional keychain service override
 */

import { exec, parseJSON, addNewChildrenTree, parseMarkdownToOps } from '@floatty/stdlib';

/** Bot/long comments can run huge — cap what lands in the outline. */
const COMMENT_CHAR_CAP = 2500;

// Ancestor inference stays letters-only (mirrors linear:: — rejects
// version-like text such as "v1-305"). An EXPLICIT arg may use the wider
// Jira grammar (project keys can carry digits after the first letter).
export const ISSUE_RE = /\b([A-Za-z]{2,6}-\d{1,6})\b/;
export const KEY_RE = /^([A-Za-z][A-Za-z0-9]{0,9}-\d{1,6})$/;

export const safeSite = (s) => {
  const t = String(s ?? '').trim().replace(/\/+$/, '');
  return /^https:\/\/[A-Za-z0-9][A-Za-z0-9.-]*(:\d+)?$/.test(t) ? t : null;
};
export const safeEmail = (s) => {
  const t = String(s ?? '').trim();
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(t) ? t : null;
};
const safeService = (s) => (/^[A-Za-z0-9._-]+$/.test(s) ? s : null);

export function parseArgs(content) {
  let rest = content.replace(/^jira::\s*/i, '').trim();
  // `// …` is a comment — strip so annotation prose never hijacks the key.
  rest = rest.replace(/\/\/.*$/s, '').trim();
  const parts = rest.split(/\s+/).filter(Boolean);
  const comments = parts.some(p => p === '--comments' || p === '-c');
  const positional = parts.filter(p => !p.startsWith('-'));
  const raw = positional[0] || null;
  // A typed-but-malformed token is an error, not a licence to infer.
  const m = raw ? raw.match(KEY_RE) : null;
  const key = m ? m[1].toUpperCase() : null;
  return { key, comments, invalidArg: key ? null : raw };
}

/**
 * Walk up the parent chain for the nearest PROJ-123 style ref — so `jira::`
 * on (or under) the "# SFC-42" page resolves SFC-42. Nearest ancestor wins.
 */
export function inferFromAncestors(blockId, actions) {
  let id = blockId;
  for (let hops = 0; hops < 20; hops++) {
    const parentId = actions.getParentId(id);
    if (!parentId) return null;
    const parent = actions.getBlock(parentId);
    const m = parent?.content?.match(ISSUE_RE);
    if (m) return m[1].toUpperCase();
    id = parentId;
  }
  return null;
}

/**
 * Jira Cloud may return descriptions/comments as an ADF document (nested
 * JSON) instead of a string. Flatten the common node types to plain text —
 * agent-oriented crude walker, structure over visual fidelity.
 */
export function adfToText(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(adfToText).join('');
  const kids = () => (node.content ?? []).map(adfToText).join('');
  switch (node.type) {
    case 'text': return node.text ?? '';
    case 'hardBreak': return '\n';
    case 'paragraph': return `${kids()}\n\n`;
    case 'heading': return `${'#'.repeat(Math.min(node.attrs?.level ?? 2, 6))} ${kids()}\n\n`;
    case 'bulletList': case 'orderedList': return `${kids()}\n`;
    case 'listItem': return `- ${(node.content ?? []).map(adfToText).join('').trim()}\n`;
    case 'codeBlock': return `\`\`\`\n${kids()}\n\`\`\`\n\n`;
    case 'blockquote': return `> ${kids().trim()}\n\n`;
    case 'rule': return '---\n\n';
    case 'mention': return node.attrs?.text ?? '@?';
    case 'inlineCard': return node.attrs?.url ?? '';
    default: return kids();
  }
}

/** description/comment body → text, whatever shape Jira sent. */
export const bodyToText = (b) => (typeof b === 'string' ? b : adfToText(b)).trim();

function truncate(body) {
  if (body.length <= COMMENT_CHAR_CAP) return body;
  return `${body.slice(0, COMMENT_CHAR_CAP)}\n\n… (truncated — full text in Jira)`;
}

/** "2026-08-18T16:41:00.000+0000" → "2026-08-18 16:41" */
const shortDate = iso => (iso || '').replace('T', ' ').slice(0, 16);

/** Keychain-resolving curl: token fetched in-shell, never enters JS. */
const jiraCurl = (service, email, site, path) =>
  `TOKEN=$(security find-generic-password -s ${service} -w) && ` +
  `curl -sf -u "${email}:$TOKEN" -H "Accept: application/json" "${site}${path}"`;

export const door = {
  kind: 'block',
  prefixes: ['jira::'],

  async execute(blockId, content, ctx) {
    const { actions, log } = ctx;
    const { key: parsedKey, comments, invalidArg } = parseArgs(content);
    if (invalidArg) {
      actions.setBlockOutput(blockId, { type: 'error', data: `Invalid issue key: ${invalidArg}` }, 'eval-result');
      actions.setBlockStatus(blockId, 'error');
      return;
    }

    const key = parsedKey ?? inferFromAncestors(blockId, actions);
    if (!key) {
      actions.setBlockOutput(blockId, {
        type: 'text',
        data: 'Usage: jira:: PROJ-123 [--comments] — or run it under a "PROJ-123" page',
      }, 'eval-result');
      actions.setBlockStatus(blockId, 'complete');
      return;
    }

    const site = safeSite(ctx.settings?.site);
    const email = safeEmail(ctx.settings?.email);
    const service = safeService(String(ctx.settings?.service ?? 'jira-api-token'));
    if (!site || !email || !service) {
      actions.setBlockOutput(blockId, {
        type: 'error',
        data: 'Set [plugins.jira] site = "https://yoursite.atlassian.net" and email = "you@example.com" in config.toml (token: security add-generic-password -s jira-api-token -a evan -w)',
      }, 'eval-result');
      actions.setBlockStatus(blockId, 'error');
      return;
    }

    try {
      actions.setBlockStatus(blockId, 'running');
      const fields = 'summary,status,issuetype,assignee,reporter,priority,updated,description';
      const raw = await exec(jiraCurl(service, email, site, `/rest/api/3/issue/${key}?fields=${fields}`));
      const issue = parseJSON(raw);
      if (!issue?.key || !issue?.fields) {
        actions.setBlockOutput(blockId, { type: 'error', data: `Jira returned no data for ${key} (check key, site, and keychain token)` }, 'eval-result');
        actions.setBlockStatus(blockId, 'error');
        return;
      }

      const f = issue.fields;
      const status = f.status?.name ?? '?';
      const kind = f.issuetype?.name ?? 'issue';
      const assignee = f.assignee?.displayName ?? 'unassigned';
      const prio = f.priority?.name;

      // ── Envelope: headline + metadata line + trailing blank ──
      const metaLine = [`[[${status}]]`, kind, `@${assignee}`, prio, `updated ${shortDate(f.updated)}`]
        .filter(Boolean).join(' · ');
      const desc = bodyToText(f.description) || '(no description)';
      const tree = [{
        content: `## [[${issue.key}]] — ${f.summary ?? ''}\n${metaLine}\n`,
        children: parseMarkdownToOps(desc),
      }];

      if (comments) {
        const craw = await exec(jiraCurl(service, email, site, `/rest/api/3/issue/${key}/comment?orderBy=created&maxResults=50`));
        const cs = parseJSON(craw)?.comments ?? [];
        tree.push({
          content: `## comments (${cs.length})\n`,
          children: cs.map(c => ({
            content: `## @${c.author?.displayName ?? '?'} · ${shortDate(c.created)}\n`,
            children: parseMarkdownToOps(truncate(bodyToText(c.body))),
          })),
        });
      }

      addNewChildrenTree(blockId, tree, actions);
      const summary = `[[${issue.key}]] ${status} — ${f.summary ?? ''}`;
      actions.setBlockOutput(blockId, { type: 'text', data: summary }, 'eval-result');
      actions.setBlockStatus(blockId, 'complete');
      log(`Fetched ${issue.key} (${status}${comments ? ', +comments' : ''})`);
    } catch (err) {
      actions.setBlockOutput(blockId, { type: 'error', data: String(err) }, 'eval-result');
      actions.setBlockStatus(blockId, 'error');
    }
  },
};

export const meta = {
  id: 'jira',
  name: 'Jira',
  version: '0.1.0',
  selfRender: true,
};

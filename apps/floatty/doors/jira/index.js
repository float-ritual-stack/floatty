/**
 * Jira Door — fetch one or more Jira issues (summary, status, description,
 * optionally comments) into the outline. Sibling of linear:: / floatty-pr::.
 *
 * Usage:
 *   jira:: PC-333                 → status envelope + description tree
 *   jira:: PC-333 PC-444          → one envelope subtree PER issue
 *   jira:: PC-333 --comments      → + issue comments (capped, nested per issue)
 *   jira::                        → infer key(s) from the nearest ancestor —
 *                                   if that ancestor carries several
 *                                   ([[PC-333]] [[PC-444]]), fetch them all
 *   jira:: // comment             → `// …` is comment text, ignored
 *
 * Auth: token lives in the macOS Keychain (never in a file):
 *   security add-generic-password -U -s jira-api-token -a evan -w "$(pbpaste)"
 *   (-w PROMPT truncates at 128 chars — always store via pbpaste)
 * The shell command resolves it at exec time — the token never appears in
 * JS, settings, or logs.
 *
 * Config (config.toml, both machines):
 *   [plugins.jira]
 *   site  = "https://yoursite.atlassian.net"
 *   email = "you@example.com"
 *   # service = "jira-api-token"   # optional keychain service override
 *
 * API: /rest/api/3 — this site retired v2; v3 bodies are ADF (flattened).
 */

import { exec, parseJSON, addNewChildrenTree, parseMarkdownToOps } from '@floatty/stdlib';

/** Bot/long comments can run huge — cap what lands in the outline. */
const COMMENT_CHAR_CAP = 2500;
/** Fan-out sanity cap — a page with 50 refs should not become 50 API calls. */
const MAX_KEYS = 8;

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
  // `// …` is a comment — strip so annotation prose never hijacks keys.
  rest = rest.replace(/\/\/.*$/s, '').trim();
  const parts = rest.split(/\s+/).filter(Boolean);
  const comments = parts.some(p => p === '--comments' || p === '-c');
  const positional = parts.filter(p => !p.startsWith('-'));
  const keys = [];
  let invalidArg = null;
  for (const raw of positional) {
    const m = raw.match(KEY_RE);
    if (m) keys.push(m[1].toUpperCase());
    else if (!invalidArg) invalidArg = raw; // malformed = error, not inference licence
  }
  return { keys: [...new Set(keys)], comments, invalidArg };
}

/**
 * Walk up the parent chain for the nearest ancestor carrying PROJ-123 style
 * refs — nearest ancestor wins, and contributes ALL of its keys, so a block
 * listing [[PC-333]] [[PC-444]] fans out into one fetch per issue.
 */
export function inferFromAncestors(blockId, actions) {
  const RE_G = new RegExp(ISSUE_RE.source, 'g');
  let id = blockId;
  for (let hops = 0; hops < 20; hops++) {
    const parentId = actions.getParentId(id);
    if (!parentId) return [];
    const parent = actions.getBlock(parentId);
    const ms = [...String(parent?.content ?? '').matchAll(RE_G)];
    if (ms.length) return [...new Set(ms.map(m => m[1].toUpperCase()))];
    id = parentId;
  }
  return [];
}

/**
 * Jira Cloud v3 returns descriptions/comments as ADF documents (nested
 * JSON). Flatten the common node types to plain text — agent-oriented crude
 * walker, structure over visual fidelity.
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

/** Fetch ONE issue → envelope subtree node (comments nested inside). */
async function fetchIssueTree(key, wantComments, cfg) {
  const { service, email, site } = cfg;
  const fields = 'summary,status,issuetype,assignee,reporter,priority,updated,description';
  const raw = await exec(jiraCurl(service, email, site, `/rest/api/3/issue/${key}?fields=${fields}`));
  const issue = parseJSON(raw);
  if (!issue?.key || !issue?.fields) return null;

  const f = issue.fields;
  const status = f.status?.name ?? '?';
  const metaLine = [
    `[[${status}]]`, f.issuetype?.name ?? 'issue',
    `@${f.assignee?.displayName ?? 'unassigned'}`, f.priority?.name,
    `updated ${shortDate(f.updated)}`,
  ].filter(Boolean).join(' · ');
  const children = parseMarkdownToOps(bodyToText(f.description) || '(no description)');

  if (wantComments) {
    const craw = await exec(jiraCurl(service, email, site, `/rest/api/3/issue/${key}/comment?orderBy=created&maxResults=50`));
    const cs = parseJSON(craw)?.comments ?? [];
    children.push({
      content: `## comments (${cs.length})\n`,
      children: cs.map(c => ({
        content: `## @${c.author?.displayName ?? '?'} · ${shortDate(c.created)}\n`,
        children: parseMarkdownToOps(truncate(bodyToText(c.body))),
      })),
    });
  }

  return {
    node: {
      content: `## [[${issue.key}]] — ${f.summary ?? ''}\n${metaLine}\n`,
      children,
    },
    status,
    summary: f.summary ?? '',
  };
}

export const door = {
  kind: 'block',
  prefixes: ['jira::'],

  async execute(blockId, content, ctx) {
    const { actions, log } = ctx;
    const { keys: parsedKeys, comments, invalidArg } = parseArgs(content);
    if (invalidArg) {
      actions.setBlockOutput(blockId, { type: 'error', data: `Invalid issue key: ${invalidArg}` }, 'eval-result');
      actions.setBlockStatus(blockId, 'error');
      return;
    }

    let keys = parsedKeys.length ? parsedKeys : inferFromAncestors(blockId, actions);
    if (!keys.length) {
      actions.setBlockOutput(blockId, {
        type: 'text',
        data: 'Usage: jira:: PROJ-123 [PROJ-124 …] [--comments] — or run it under a block carrying "PROJ-123" refs',
      }, 'eval-result');
      actions.setBlockStatus(blockId, 'complete');
      return;
    }
    const dropped = Math.max(0, keys.length - MAX_KEYS);
    keys = keys.slice(0, MAX_KEYS);

    const site = safeSite(ctx.settings?.site);
    const email = safeEmail(ctx.settings?.email);
    const service = safeService(String(ctx.settings?.service ?? 'jira-api-token'));
    if (!site || !email || !service) {
      actions.setBlockOutput(blockId, {
        type: 'error',
        data: 'Set [plugins.jira] site = "https://yoursite.atlassian.net" and email = "you@example.com" in config.toml (token: security add-generic-password -U -s jira-api-token -a evan -w "$(pbpaste)")',
      }, 'eval-result');
      actions.setBlockStatus(blockId, 'error');
      return;
    }

    actions.setBlockStatus(blockId, 'running');
    const cfg = { service, email, site };
    const tree = [];
    const ok = [];
    const failed = [];
    for (const key of keys) {
      try {
        const r = await fetchIssueTree(key, comments, cfg);
        if (r) { tree.push(r.node); ok.push({ key, status: r.status, summary: r.summary }); }
        else { failed.push(key); tree.push({ content: `## [[${key}]] — fetch failed (check key / permissions)\n` }); }
      } catch (err) {
        failed.push(key);
        tree.push({ content: `## [[${key}]] — fetch failed: ${String(err).slice(0, 120)}\n` });
      }
    }

    addNewChildrenTree(blockId, tree, actions);
    let summary;
    if (keys.length === 1 && ok.length === 1) {
      summary = `[[${ok[0].key}]] ${ok[0].status} — ${ok[0].summary}`;
    } else {
      summary = `${ok.length}/${keys.length} issues — ${keys.map(k => `[[${k}]]`).join(' ')}`;
      if (dropped) summary += ` (+${dropped} beyond cap)`;
    }
    actions.setBlockOutput(blockId, { type: 'text', data: summary }, 'eval-result');
    actions.setBlockStatus(blockId, failed.length && !ok.length ? 'error' : 'complete');
    log(`Fetched ${ok.length}/${keys.length} issue(s)${comments ? ' +comments' : ''}${failed.length ? ` (failed: ${failed.join(', ')})` : ''}`);
  },
};

export const meta = {
  id: 'jira',
  name: 'Jira',
  version: '0.2.0',
  selfRender: true,
};

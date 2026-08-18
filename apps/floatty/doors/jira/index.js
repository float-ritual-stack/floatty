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
 *   If several items share the service name, set [plugins.jira] account to
 *   disambiguate (must match the -a used at store time).
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
const safeAccount = (s) => (/^[A-Za-z0-9._%+@-]+$/.test(s) ? s : null);

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
  const seen = new Set([blockId]);
  let id = blockId;
  for (;;) {
    const parentId = actions.getParentId(id);
    if (!parentId || seen.has(parentId)) return []; // root or cycle — done
    seen.add(parentId);
    const parent = actions.getBlock(parentId);
    const ms = [...String(parent?.content ?? '').matchAll(RE_G)];
    // PR-NNN belongs to the sibling PR doors — never infer it as a Jira key
    // (an explicit `jira:: PR-5` arg still works if such a project exists).
    const keys = [...new Set(ms.map(m => m[1].toUpperCase()))].filter(k => !/^PR-/.test(k));
    if (keys.length) return keys;
    id = parentId;
  }
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
const jiraCurl = (cfg, path) =>
  `TOKEN=$(security find-generic-password -s ${cfg.service}${cfg.account ? ` -a "${cfg.account}"` : ''} -w) && ` +
  `curl -sf -u "${cfg.email}:$TOKEN" -H "Accept: application/json" "${cfg.site}${path}"`;


/** jira statusCategory key → glyph + chip color (visual header language). */
export function statusVisual(categoryKey, statusName) {
  const k = String(categoryKey ?? '').toLowerCase();
  if (k === 'done') return { glyph: '\u2705', color: 'green' };
  if (k === 'indeterminate') return { glyph: '\ud83d\udfe1', color: 'amber' };
  if (k === 'new') return { glyph: '\u2b1c', color: 'cyan' };
  // fallback by name when category is absent
  if (/done|closed|resolved/i.test(statusName ?? '')) return { glyph: '\u2705', color: 'green' };
  return { glyph: '\u2b1c', color: 'dim' };
}

/** Compact json-render header card: Card(title/subtitle) + Row of chips. */
export function buildHeaderSpec({ key, summary, status, color, kind, assignee, prio, updated }) {
  const elements = {
    r: { type: 'Card', props: { title: `${key} \u2014 ${summary}`, subtitle: [kind, `@${assignee}`, `updated ${updated}`].filter(Boolean).join(' \u00b7 ') }, children: ['row'] },
    row: { type: 'Row', props: {}, children: ['st', 'lnk'] },
    st: { type: 'Chip', props: { label: status, color, icon: 'circle-dot' } },
    lnk: { type: 'WikilinkChip', props: { target: key } },
  };
  if (prio) {
    elements.row.children.push('prio');
    elements.prio = { type: 'Chip', props: { label: prio, color: 'dim' } };
  }
  return { root: 'r', elements };
}

/** Find an existing header child for `key` (refresh-in-place on re-run). */
export function findExistingHeader(blockId, key, actions) {
  for (const cid of actions.getChildren(blockId) ?? []) {
    const c = actions.getBlock(cid);
    // outputType === 'door' is the generated-header discriminator: a
    // user-authored sibling that merely MENTIONS the ref must never be
    // matched (updateBlockContent would clobber it). A miss here degrades
    // to a duplicate header — annoying, never destructive.
    if (c?.outputType === 'door' && c?.content?.includes(`[[${key}]]`)) return cid;
  }
  return null;
}

/** Fetch ONE issue -> header card + markdown children. */
async function fetchIssueTree(key, wantComments, cfg) {
  const fields = 'summary,status,issuetype,assignee,reporter,priority,updated,description';
  const raw = await exec(jiraCurl(cfg, `/rest/api/3/issue/${key}?fields=${fields}`));
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
    const craw = await exec(jiraCurl(cfg, `/rest/api/3/issue/${key}/comment?orderBy=created&maxResults=50`));
    const cpage = parseJSON(craw);
    if (!cpage || !Array.isArray(cpage.comments)) {
      // A failed comments request must NOT masquerade as "comments (0)".
      children.push({ content: `## comments — fetch failed (response was not a Jira comment payload)\n` });
    } else {
      const cs = cpage.comments;
      const total = typeof cpage.total === 'number' ? cpage.total : cs.length;
      const truncNote = total > cs.length ? ` — showing first ${cs.length}` : '';
      children.push({
        content: `## comments (${total}${truncNote})\n`,
        children: cs.map(c => ({
          content: `## @${c.author?.displayName ?? '?'} · ${shortDate(c.created)}\n`,
          children: parseMarkdownToOps(truncate(bodyToText(c.body))),
        })),
      });
    }
  }

  const vis = statusVisual(f.status?.statusCategory?.key, status);
  return {
    headerContent: `${vis.glyph} [[${issue.key}]] — ${f.summary ?? ''}`,
    headerSpec: buildHeaderSpec({
      key: issue.key, summary: f.summary ?? '', status, color: vis.color,
      kind: f.issuetype?.name, assignee: f.assignee?.displayName ?? 'unassigned',
      prio: f.priority?.name, updated: shortDate(f.updated),
    }),
    title: `${issue.key} — ${f.summary ?? ''}`,
    children,
    status,
    summary: f.summary ?? '',
    key: issue.key,
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
    // Optional [plugins.jira] projects = ["PC", "SFC"] allowlist: filters
    // INFERRED keys only (explicit args are trusted). Kills UTF-8/ISO-8601
    // style false positives from prose in ancestor blocks.
    const allow = Array.isArray(ctx.settings?.projects)
      ? ctx.settings.projects.map(x => String(x).toUpperCase()) : null;
    if (!parsedKeys.length && allow?.length) {
      keys = keys.filter(k => allow.includes(k.split('-')[0]));
    }
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
    const account = ctx.settings?.account ? safeAccount(String(ctx.settings.account)) : null;
    if (!site || !email || !service || (ctx.settings?.account && !account)) {
      actions.setBlockOutput(blockId, {
        type: 'error',
        data: 'Set [plugins.jira] site = "https://yoursite.atlassian.net" and email = "you@example.com" in config.toml (token: security add-generic-password -U -s jira-api-token -a evan -w "$(pbpaste)")',
      }, 'eval-result');
      actions.setBlockStatus(blockId, 'error');
      return;
    }

    actions.setBlockStatus(blockId, 'running');
    const cfg = { service, email, site, account };
    const misses = [];
    const ok = [];
    const failed = [];
    for (const key of keys) {
      try {
        const r = await fetchIssueTree(key, comments, cfg);
        if (!r) {
          failed.push(key);
          misses.push({ content: `## [[${key}]] — fetch failed (check key / permissions)\n` });
          continue;
        }
        // Header child carries a rendered card (render-door envelope); its
        // content stays plain markdown for grep/agents/raw-toggle. Re-runs
        // refresh the card IN PLACE and never touch the children below it.
        const existing = findExistingHeader(blockId, key, actions);
        const headerId = existing ?? actions.createBlockInside(blockId);
        actions.updateBlockContent(headerId, r.headerContent);
        actions.setBlockOutput(headerId, {
          kind: 'view', doorId: 'render', schema: 1,
          data: { spec: r.headerSpec, title: r.title, generatedVia: 'jira-door' },
        }, 'door');
        actions.setBlockStatus(headerId, 'complete');
        if (!existing) addNewChildrenTree(headerId, r.children, actions);
        ok.push({ key, status: r.status, summary: r.summary });
      } catch (err) {
        failed.push(key);
        misses.push({ content: `## [[${key}]] — fetch failed: ${String(err).slice(0, 120)}\n` });
      }
    }
    if (misses.length) addNewChildrenTree(blockId, misses, actions);
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

/**
 * Digest Door — browse recent session digests from ~/.float/digests/
 *
 * Commands:
 *   digest::                    → list 20 most recent, grouped by project
 *   digest:: 10                 → list N most recent
 *   digest:: floatty            → filter by project name (substring match)
 *   digest:: floatty 5          → filter + limit
 *   digest:: expand <id>        → expand one digest — shows request, completed, deferred, next
 *   digest:: read <post-id>     → read a sysops-log BBS post (wraps floatctl bbs board read)
 */

import { exec, execJSON, parseJSON, addNewChildren, addNewChildrenTree, pipe, sortByDesc, filterBy, take, groupBy, parseMarkdownToOps } from '@floatty/stdlib';

const DIGESTS_DIR = '~/.float/digests';
const DEFAULT_LIMIT = 20;

/** Allowlist for user-supplied args before shell interpolation */
const safeArg = s => /^[a-zA-Z0-9._-]+$/.test(s) ? s : null;

const sessionTime = d =>
  new Date(d.timestamps?.first || d.metrics?.timestamps?.first || d.extracted_at || 0).getTime();

// ═══════════════════════════════════════════════════════════════
// ARG PARSING
// ═══════════════════════════════════════════════════════════════

function parseArgs(content) {
  const match = content.match(/^digest::\s*(.*)/i);
  if (!match) return { cmd: 'list', filter: null, limit: DEFAULT_LIMIT };
  const parts = match[1].trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { cmd: 'list', filter: null, limit: DEFAULT_LIMIT };

  if (parts[0].toLowerCase() === 'expand')
    return { cmd: 'expand', id: parts[1] || '' };

  if (parts[0].toLowerCase() === 'read')
    return { cmd: 'read', postId: parts[1] || '' };

  const last = parts[parts.length - 1];
  const isNum = /^\d+$/.test(last);
  if (isNum && parts.length === 1) return { cmd: 'list', filter: null, limit: parseInt(last, 10) };
  if (isNum) return { cmd: 'list', filter: parts.slice(0, -1).join(' '), limit: parseInt(last, 10) };
  return { cmd: 'list', filter: parts.join(' '), limit: DEFAULT_LIMIT };
}

// ═══════════════════════════════════════════════════════════════
// DATA ACCESS
// ═══════════════════════════════════════════════════════════════

async function readDigestFiles(batchSize) {
  // Use jq -c to compact multi-line JSON to single lines, delimited by newlines
  const raw = await exec(
    `ls -t ${DIGESTS_DIR}/*.json 2>/dev/null | head -${batchSize} | xargs -I{} jq -c '.' {} 2>/dev/null`
  );
  if (!raw) return [];
  return raw.split('\n')
    .map(line => parseJSON(line.trim()))
    .filter(Boolean);
}

async function fetchDigests(filter, limit) {
  // Read generously — many files are unenriched stubs that get filtered out
  const batch = await readDigestFiles(Math.max(limit * 30, 500));
  // Skip unenriched stubs (no summary, no project = raw extraction never completed)
  const isEnriched = d => !!(d.summary || d.project || d.enriched);
  const matchesFilter = filter
    ? d => `${d.project || ''} ${d.summary || ''} ${d.branch || ''}`
        .toLowerCase().includes(filter.toLowerCase())
    : () => true;
  return pipe(sortByDesc(sessionTime), filterBy(isEnriched), filterBy(matchesFilter), take(limit))(batch);
}

async function findDigest(id) {
  if (!id) return null;
  const safeId = safeArg(id);
  if (!safeId) return null;
  const direct = await exec(`ls ${DIGESTS_DIR}/*${safeId}*.json 2>/dev/null | head -1`).catch(() => '');
  if (direct) {
    const d = parseJSON(await exec(`cat "${direct}"`).catch(() => ''));
    if (d) return d;
  }
  const raw = await exec(`ls -t ${DIGESTS_DIR}/*.json 2>/dev/null`);
  if (!raw) return null;
  const idLower = id.toLowerCase();
  for (const file of raw.split('\n').filter(f => f.endsWith('.json'))) {
    const d = parseJSON(await exec(`cat "${file}"`).catch(() => ''));
    if (!d) continue;
    if ((d.slug || '').toLowerCase().includes(idLower)) return d;
  }
  return null;
}

async function resolveBBSPostId(digest) {
  if (digest.bbs_post_id) return digest.bbs_post_id;
  if (!digest.summary) return null;
  try {
    const posts = await execJSON('floatctl bbs board list sysops-log --json --limit 50');
    const match = Array.isArray(posts) && posts.find(p =>
      (p.title || '').startsWith('digest:') &&
      (p.title || '').includes(digest.summary.slice(0, 30))
    );
    return match ? match.id : null;
  } catch (_) { return null; }
}

// ═══════════════════════════════════════════════════════════════
// FORMATTING
// ═══════════════════════════════════════════════════════════════

const getTimestamp = d =>
  d.timestamps?.first || d.metrics?.timestamps?.first || d.extracted_at;

const formatDate = d => {
  const ts = getTimestamp(d);
  if (!ts) return '';
  const date = new Date(ts);
  const opts = { month: 'short', day: 'numeric' };
  if (date.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return date.toLocaleDateString('en-US', opts);
};

const isoDate = d => {
  const ts = getTimestamp(d);
  return ts ? new Date(ts).toISOString().slice(0, 10) : '0000-00-00';
};

const formatDigestLine = d => {
  const label = d.summary || d.slug || d.session_id?.slice(0, 8) || '(untitled)';
  const count = Array.isArray(d.completed) ? `${d.completed.length}✓` : '';
  return [label, count].filter(Boolean).join(' · ');
};

const section = (title, items) =>
  Array.isArray(items) && items.length > 0
    ? [{ content: title, children: items.map(item => ({ content: item })) }]
    : [];

// ═══════════════════════════════════════════════════════════════
// HANDLERS
// ═══════════════════════════════════════════════════════════════

async function handleList(blockId, filter, limit, ctx) {
  const { actions, log } = ctx;
  actions.setBlockStatus(blockId, 'running');

  const digests = await fetchDigests(filter, limit);
  if (digests.length === 0) {
    actions.setBlockOutput(blockId, { type: 'text', data: filter ? `(no digests matching "${filter}")` : '(no digests in ~/.float/digests/)' }, 'eval-result');
    actions.setBlockStatus(blockId, 'complete');
    return;
  }

  // Normalize project names — paths like "projects/_work/pharmacy-online" → "pharmacy-online"
  const normalizeProject = p => {
    if (!p) return 'other';
    // Strip leading path prefixes, keep last meaningful segment
    const clean = p.replace(/^(projects\/[^/]+\/|\.floatty\/|float-hub-operations\/)/, '');
    return clean || p;
  };
  const groups = groupBy(d => normalizeProject(d.project))(digests);

  const toDigestOp = d => {
    // Infer BBS post ID if not stored: floatctl uses YYYY-MM-DD-digest-{title-slug}
    const postId = d.bbs_post_id || (() => {
      if (!d.summary) return null;
      const date = isoDate(d);
      if (date === '0000-00-00') return null;
      const slug = d.summary.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
      return `${date}-digest-${slug}`;
    })();
    return {
      content: formatDigestLine(d),
      children: [
        d.session_id && { content: `digest:: expand ${d.session_id.slice(0, 8)}` },
        postId && { content: `digest:: read ${postId}` },
      ].filter(Boolean),
    };
  };

  const toDateOp = ([iso, dateDigests]) => ({
    content: formatDate(dateDigests[0]),
    children: dateDigests.map(toDigestOp),
  });

  const toGroupOp = ([project, projectDigests]) => {
    const byDate = groupBy(isoDate)(projectDigests);
    const sortedDates = [...byDate].sort(([a], [b]) => b.localeCompare(a));
    return {
      content: `project:: ${project} (${projectDigests.length}) · ${formatDate(projectDigests[0])}`,
      children: sortedDates.map(toDateOp),
    };
  };

  addNewChildrenTree(blockId, [...groups].map(toGroupOp), actions);

  const filterNote = filter ? ` · ${filter}` : '';
  actions.setBlockOutput(blockId, { type: 'text', data: `${digests.length} digests · ${groups.size} projects${filterNote}` }, 'eval-result');
  actions.setBlockStatus(blockId, 'complete');
  log(`Listed ${digests.length} digests across ${groups.size} projects`);
}

async function handleExpand(blockId, id, ctx) {
  const { actions, log } = ctx;
  actions.setBlockStatus(blockId, 'running');

  const d = await findDigest(id);
  if (!d) {
    actions.setBlockOutput(blockId, { type: 'error', data: `No digest found for "${id}"` }, 'eval-result');
    actions.setBlockStatus(blockId, 'error');
    return;
  }

  const bbsPostId = await resolveBBSPostId(d);

  const ops = [
    ...(d.request ? [{ content: `request:: ${d.request}` }] : []),
    ...section(`## Completed (${(d.completed || []).length})`, d.completed),
    ...section('## Deferred', d.deferred),
    ...section('## Next', d.next_steps),
    ...section('## Investigated', d.investigated),
    ...(bbsPostId ? [{ content: `digest:: read ${bbsPostId}` }] : []),
  ];

  if (ops.length === 0) {
    actions.setBlockOutput(blockId, { type: 'text', data: '(digest has no detail fields)' }, 'eval-result');
    actions.setBlockStatus(blockId, 'complete');
    return;
  }

  addNewChildrenTree(blockId, ops, actions);
  const shortSummary = (d.summary || d.slug || id).slice(0, 60);
  actions.setBlockOutput(blockId, { type: 'text', data: shortSummary }, 'eval-result');
  actions.setBlockStatus(blockId, 'complete');
  log(`Expanded digest ${id}: ${shortSummary}`);
}

async function handleRead(blockId, postId, ctx) {
  const { actions, log } = ctx;
  const safe = safeArg(postId);
  if (!safe) {
    actions.setBlockOutput(blockId, { type: 'error', data: `Invalid post ID: ${postId}` }, 'eval-result');
    actions.setBlockStatus(blockId, 'error');
    return;
  }
  actions.setBlockStatus(blockId, 'running');
  try {
    const post = await execJSON(`floatctl bbs board read sysops-log ${safe} --json`);
    const tree = parseMarkdownToOps(post.content || '');
    if (tree.length > 0) addNewChildrenTree(blockId, tree, actions);
    const title = post.title || safe;
    const date = post.date ? new Date(post.date).toLocaleDateString() : '';
    actions.setBlockOutput(blockId, { type: 'text', data: `${title}${date ? ` (${date})` : ''}` }, 'eval-result');
    actions.setBlockStatus(blockId, 'complete');
    log(`Read BBS post: ${title}`);
  } catch (err) {
    actions.setBlockOutput(blockId, { type: 'error', data: String(err) }, 'eval-result');
    actions.setBlockStatus(blockId, 'error');
  }
}

// ═══════════════════════════════════════════════════════════════
// DOOR EXPORT
// ═══════════════════════════════════════════════════════════════

export const door = {
  kind: 'block',
  prefixes: ['digest::'],

  async execute(blockId, content, ctx) {
    const { actions } = ctx;
    try {
      const args = parseArgs(content);
      if (args.cmd === 'expand') await handleExpand(blockId, args.id, ctx);
      else if (args.cmd === 'read') await handleRead(blockId, args.postId, ctx);
      else await handleList(blockId, args.filter, args.limit, ctx);
    } catch (err) {
      actions.setBlockOutput(blockId, { type: 'error', data: String(err) }, 'eval-result');
      actions.setBlockStatus(blockId, 'error');
    }
  },
};

export const meta = {
  id: 'digest',
  name: 'Digest',
  version: '0.3.1',
  selfRender: true,
};

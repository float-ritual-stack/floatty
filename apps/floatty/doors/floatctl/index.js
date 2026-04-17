/**
 * Floatctl Door — CLI-in-outline via schema introspection
 *
 * Commands:
 *   floatctl::                              → list top-level commands
 *   floatctl:: bbs board list               → list boards
 *   floatctl:: bbs board list sysops-log    → list posts as children
 *   floatctl:: bbs board read sysops-log <id> → show post content
 *
 * Uses `floatctl reflect` for schema, `--json` for parseable output.
 * Child blocks are themselves valid floatctl:: commands — turtles all the way down.
 */

import { exec, execJSON, addNewChildren, addNewChildrenTree, parseMarkdownToOps } from '@floatty/stdlib';

/** Allowlist for user-supplied args before shell interpolation */
const safeArg = s => /^[a-zA-Z0-9._-]+$/.test(s) ? s : null;

function parseArgs(content) {
  const match = content.match(/^floatctl::\s*(.*)/i);
  if (!match) return [];
  const argStr = match[1].trim();
  if (!argStr) return [];
  return argStr.split(/\s+/);
}

// ═══════════════════════════════════════════════════════════════
// ROUTE TABLE — pattern → handler
// ═══════════════════════════════════════════════════════════════

const routes = [
  // floatctl:: bbs board read <board> <postId>
  {
    match: (args) => args[0] === 'bbs' && args[1] === 'board' && args[2] === 'read' && args[3] && args[4],
    handle: handleBoardRead,
  },
  // floatctl:: bbs board list <board>
  {
    match: (args) => args[0] === 'bbs' && args[1] === 'board' && args[2] === 'list' && args[3],
    handle: handleBoardListPosts,
  },
  // floatctl:: bbs board list
  {
    match: (args) => args[0] === 'bbs' && args[1] === 'board' && args[2] === 'list',
    handle: handleBoardListBoards,
  },
  // floatctl:: bbs show <id> (read inbox message)
  {
    match: (args) => args[0] === 'bbs' && args[1] === 'show' && args[2],
    handle: handleBbsShow,
  },
  // floatctl:: bbs inbox
  {
    match: (args) => args[0] === 'bbs' && args[1] === 'inbox',
    handle: handleInbox,
  },
  // floatctl:: (bare — no args)
  {
    match: (args) => args.length === 0,
    handle: handleTopLevel,
  },
  // floatctl:: <unrecognized args>
  {
    match: () => true,
    handle: handleUnknown,
  },
];

// ═══════════════════════════════════════════════════════════════
// HANDLERS
// ═══════════════════════════════════════════════════════════════

async function handleTopLevel(blockId, args, ctx) {
  const { actions, log } = ctx;
  const children = [
    { content: 'floatctl:: bbs board list' },
    { content: 'floatctl:: bbs inbox' },
    { content: 'floatctl:: bbs memory list' },
  ];
  addNewChildren(blockId, children, actions);
  actions.setBlockOutput(blockId, { type: 'text', data: 'floatctl bbs' }, 'eval-result');
  actions.setBlockStatus(blockId, 'complete');
  log('Listed floatctl commands');
}

async function handleUnknown(blockId, args, ctx) {
  const { actions } = ctx;
  actions.setBlockOutput(blockId,
    { type: 'text', data: `unknown: ${args.join(' ')}` }, 'eval-result');
  addNewChildren(blockId, [
    { content: 'floatctl:: bbs board list' },
    { content: 'floatctl:: bbs inbox' },
    { content: 'floatctl:: bbs memory list' },
  ], actions);
  actions.setBlockStatus(blockId, 'complete');
}

async function handleBoardListBoards(blockId, args, ctx) {
  const { actions, log } = ctx;
  try {
    const data = await execJSON('floatctl bbs board list --json');
    if (!Array.isArray(data) || data.length === 0) {
      actions.setBlockOutput(blockId, { type: 'text', data: '(no boards found)' }, 'eval-result');
      actions.setBlockStatus(blockId, 'complete');
      return;
    }
    const children = data.map(b => ({
      content: `floatctl:: bbs board list ${b.name || b}`,
      key: b.name || b,
    }));
    addNewChildren(blockId, children, actions);
    actions.setBlockOutput(blockId, { type: 'text', data: `${data.length} board${data.length === 1 ? '' : 's'}` }, 'eval-result');
    actions.setBlockStatus(blockId, 'complete');
    log(`Listed ${data.length} boards`);
  } catch (err) {
    actions.setBlockOutput(blockId, { type: 'error', data: String(err) }, 'eval-result');
    actions.setBlockStatus(blockId, 'error');
  }
}

async function handleBoardListPosts(blockId, args, ctx) {
  const { actions, log } = ctx;
  const board = safeArg(args[3]);
  if (!board) {
    actions.setBlockOutput(blockId, { type: 'error', data: `Invalid board name: ${args[3]}` }, 'eval-result');
    actions.setBlockStatus(blockId, 'error');
    return;
  }
  try {
    const posts = await execJSON(`floatctl bbs board list ${board} --json --limit 20`);
    if (!Array.isArray(posts) || posts.length === 0) {
      actions.setBlockOutput(blockId, { type: 'text', data: `(no posts in ${board})` }, 'eval-result');
      actions.setBlockStatus(blockId, 'complete');
      return;
    }
    const children = posts.map(p => ({
      content: `floatctl:: bbs board read ${board} ${p.id}`,
      key: p.id,
    }));
    addNewChildren(blockId, children, actions);
    actions.setBlockOutput(blockId, { type: 'text', data: `${posts.length} post${posts.length === 1 ? '' : 's'} in ${board}` }, 'eval-result');
    actions.setBlockStatus(blockId, 'complete');
    log(`Listed ${posts.length} posts from ${board}`);
  } catch (err) {
    actions.setBlockOutput(blockId, { type: 'error', data: String(err) }, 'eval-result');
    actions.setBlockStatus(blockId, 'error');
  }
}

async function handleBoardRead(blockId, args, ctx) {
  const { actions, log } = ctx;
  const board = safeArg(args[3]);
  const postId = safeArg(args.slice(4).join('-'));
  if (!board || !postId) {
    actions.setBlockOutput(blockId, { type: 'error', data: `Invalid board or post ID` }, 'eval-result');
    actions.setBlockStatus(blockId, 'error');
    return;
  }
  try {
    const post = await execJSON(`floatctl bbs board read ${board} ${postId} --json`);
    const tree = parseMarkdownToOps(post.content || '');
    if (tree.length > 0) {
      addNewChildrenTree(blockId, tree, actions);
    }
    const title = post.title || postId;
    const date = post.date ? new Date(post.date).toLocaleDateString() : '';
    actions.setBlockOutput(blockId, { type: 'text', data: `${title} (${post.author || '?'}, ${date})` }, 'eval-result');
    actions.setBlockStatus(blockId, 'complete');
    log(`Read post: ${title}`);
  } catch (err) {
    actions.setBlockOutput(blockId, { type: 'error', data: String(err) }, 'eval-result');
    actions.setBlockStatus(blockId, 'error');
  }
}

async function handleBbsShow(blockId, args, ctx) {
  const { actions, log } = ctx;
  const messageId = safeArg(args.slice(2).join('-'));
  if (!messageId) {
    actions.setBlockOutput(blockId, { type: 'error', data: `Invalid message ID` }, 'eval-result');
    actions.setBlockStatus(blockId, 'error');
    return;
  }
  try {
    const msg = await execJSON(`floatctl bbs show ${messageId} --json`);
    const body = msg.content || msg.body || msg.preview || '';
    const tree = parseMarkdownToOps(body);
    if (tree.length > 0) {
      addNewChildrenTree(blockId, tree, actions);
    }
    const subject = msg.subject || msg.title || messageId;
    const from = msg.from || msg.author || '?';
    actions.setBlockOutput(blockId, { type: 'text', data: `${subject} (from ${from})` }, 'eval-result');
    actions.setBlockStatus(blockId, 'complete');
    log(`Read message: ${subject}`);
  } catch (err) {
    actions.setBlockOutput(blockId, { type: 'error', data: String(err) }, 'eval-result');
    actions.setBlockStatus(blockId, 'error');
  }
}

async function handleInbox(blockId, args, ctx) {
  const { actions, log } = ctx;
  const extra = args.slice(2).join(' ');
  try {
    const messages = await execJSON(`floatctl bbs inbox ${extra} --json`);
    if (!Array.isArray(messages) || messages.length === 0) {
      actions.setBlockOutput(blockId, { type: 'text', data: '(inbox empty)' }, 'eval-result');
      actions.setBlockStatus(blockId, 'complete');
      return;
    }
    const children = messages.map(m => ({
      content: `floatctl:: bbs show ${m.id}`,
      key: m.id,
    }));
    addNewChildren(blockId, children, actions);
    actions.setBlockOutput(blockId, { type: 'text', data: `${messages.length} message${messages.length === 1 ? '' : 's'}` }, 'eval-result');
    actions.setBlockStatus(blockId, 'complete');
    log(`Listed ${messages.length} inbox messages`);
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
  prefixes: ['floatctl::'],

  async execute(blockId, content, ctx) {
    const args = parseArgs(content);
    for (const route of routes) {
      if (route.match(args)) {
        await route.handle(blockId, args, ctx);
        return;
      }
    }
  },
};

export const meta = {
  id: 'floatctl',
  name: 'Floatctl',
  version: '0.2.0',
  selfRender: true,
};

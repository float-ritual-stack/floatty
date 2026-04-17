/**
 * render:: door — json-render spec renderer
 *
 * Renders json-render specs inline using @json-render/solid.
 * Content stays visible, rendered output below (artifact:: pattern).
 *
 * Routes:
 *   render:: demo          → hardcoded demo spec
 *   render:: stats         → live outline stats from floatty-server
 *   render:: prompt        → catalog.prompt() output (for debugging)
 *   render:: ai <prompt>   → Claude structured outputs (haiku 4.5), ollama fallback
 *   render:: agent <prompt> → context-aware via CLI agent (claude -p), uses outline data
 *   render:: expand <id>   → block tree as TreeView (local store, no API, no LLM)
 *   render:: kanban <id>   → children-as-columns board (local store, no LLM)
 *   render:: {"root":...}  → raw JSON spec (inline)
 *
 * Compile:
 *   node scripts/compile-door-bundle.mjs doors/render/render.tsx ~/.floatty-dev/doors/render/index.js
 */

import { createSignal, Show, For } from 'solid-js';
import {
  Renderer,
  StateProvider,
  ActionProvider,
  VisibilityProvider,
  ValidationProvider,
} from '@json-render/solid';

import { bbsCatalog } from './catalog';
import { registry as bbsRegistry } from './registry';
import { LAYOUT_PATTERNS } from './patterns';

function getOllamaConfig(ctx: any) {
  return {
    url: ctx.settings?.ollama_endpoint || 'http://float-box:11434',
    model: ctx.settings?.ollama_model || 'qwen2.5:7b',
  };
}

// ═══════════════════════════════════════════════════════════════
// SPEC GENERATORS
// ═══════════════════════════════════════════════════════════════

function demoSpec() {
  return {
    root: 'main',
    state: { count: 0 },
    elements: {
      main: { type: 'Stack' as const, props: { direction: 'vertical' as const, gap: 12 }, children: ['header', 'cards'] },
      header: { type: 'Text' as const, props: { content: 'render:: door', size: 'lg' as const, weight: 'bold' as const, color: 'var(--color-ansi-cyan, #56b6c2)' }, children: [] },
      cards: { type: 'Stack' as const, props: { direction: 'horizontal' as const, gap: 12 }, children: ['card1', 'card2'] },
      card1: { type: 'Card' as const, props: { title: 'json-render', subtitle: '@json-render/solid' }, children: ['desc', 'divider1', 'prompt-btn'] },
      desc: { type: 'Text' as const, props: { content: 'Guardrailed generative UI. AI generates JSON specs, you render them safely. Catalog defines allowed components.' }, children: [] },
      divider1: { type: 'Divider' as const, props: {}, children: [] },
      'prompt-btn': { type: 'Button' as const, props: { label: 'catalog.prompt() →', variant: 'secondary' as const }, children: [] },
      card2: { type: 'Card' as const, props: { title: 'Integration', subtitle: 'floatty door system' }, children: ['items'] },
      items: { type: 'Stack' as const, props: { direction: 'vertical' as const, gap: 4 }, children: ['i1', 'i2', 'i3'] },
      i1: { type: 'Text' as const, props: { content: '1. Define catalog (Zod schemas)', mono: true }, children: [] },
      i2: { type: 'Text' as const, props: { content: '2. LLM generates spec (JSON)', mono: true }, children: [] },
      i3: { type: 'Text' as const, props: { content: '3. Renderer draws it safely', mono: true }, children: [] },
    },
  };
}

async function statsSpec(serverFetch: (path: string) => Promise<Response>) {
  const resp = await serverFetch('/api/v1/stats');
  if (!resp.ok) throw new Error(`Stats fetch failed: ${resp.status}`);
  const stats = await resp.json();

  const typeEntries = Object.entries(stats.typeDistribution || {})
    .sort((a: any, b: any) => b[1] - a[1])
    .slice(0, 6);

  const typeElements: Record<string, any> = {};
  const typeChildren: string[] = [];
  typeEntries.forEach(([type, count]: [string, any], i) => {
    const id = `type-${i}`;
    typeChildren.push(id);
    typeElements[id] = { type: 'Metric', props: { label: type || '(plain)', value: String(count) }, children: [] };
  });

  return {
    root: 'main',
    elements: {
      main: { type: 'Stack', props: { direction: 'vertical', gap: 12 }, children: ['header', 'overview', 'types'] },
      header: { type: 'Text', props: { content: 'Outline Stats', size: 'lg', weight: 'bold', color: 'var(--color-ansi-cyan, #56b6c2)' }, children: [] },
      overview: { type: 'Card', props: { title: 'Overview' }, children: ['metrics'] },
      metrics: { type: 'Stack', props: { direction: 'vertical', gap: 2 }, children: ['m-blocks', 'm-roots', 'm-pages'] },
      'm-blocks': { type: 'Metric', props: { label: 'Total blocks', value: String(stats.blockCount || 0) }, children: [] },
      'm-roots': { type: 'Metric', props: { label: 'Root blocks', value: String(stats.rootCount || 0) }, children: [] },
      'm-pages': { type: 'Metric', props: { label: 'Pages', value: String(stats.pageCount || 0) }, children: [] },
      types: { type: 'Card', props: { title: 'Block Types' }, children: ['type-list'] },
      'type-list': { type: 'Stack', props: { direction: 'vertical', gap: 2 }, children: typeChildren },
      ...typeElements,
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// BLOCK TREE HELPERS — local store access (no API calls)
// ═══════════════════════════════════════════════════════════════

interface LocalBlock {
  id: string;
  content: string;
  childIds: string[];
  parentId?: string | null;
  createdAt?: number;
}

interface BlockActions {
  getBlock: (id: string) => LocalBlock | undefined;
  getChildren: (id: string) => string[];
  rootIds?: () => readonly string[];
}

/** Resolve [[wikilink]] or hash prefix to a full block ID.
 *  Direct lookup first, then prefix scan via rootIds + tree walk. */
function resolveBlockRef(ref: string, actions: BlockActions): LocalBlock | undefined {
  const clean = ref.replace(/^\[\[|\]\]$/g, '').trim();
  // Direct lookup (full UUID)
  const direct = actions.getBlock(clean);
  if (direct) return direct as LocalBlock;
  // Prefix scan — walk from roots to find a block whose ID starts with the ref
  if (clean.length >= 6 && actions.rootIds) {
    const visited = new Set<string>();
    const queue = [...actions.rootIds()];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      if (id.startsWith(clean)) {
        const block = actions.getBlock(id);
        if (block) return block as LocalBlock;
      }
      const children = actions.getChildren(id);
      queue.push(...children);
    }
  }
  return undefined;
}

/** Walk a block tree recursively, collecting all descendants */
function walkTree(blockId: string, actions: BlockActions, depth = 0, maxDepth = 10): LocalBlock[] {
  if (depth > maxDepth) return [];
  const result: LocalBlock[] = [];
  const childIds = actions.getChildren(blockId);
  for (const cid of childIds) {
    const child = actions.getBlock(cid) as LocalBlock | undefined;
    if (!child) continue;
    result.push(child);
    result.push(...walkTree(cid, actions, depth + 1, maxDepth));
  }
  return result;
}

function detectBlockStatus(content: string): string | undefined {
  const lower = content.toLowerCase();
  if (lower.startsWith('✓ ') || lower.includes('shipped') || lower.includes('completed') || lower.includes('merged')) return 'done';
  if (lower.includes('deferred') || lower.includes('on hold') || lower.includes('punt')) return 'deferred';
  if (lower.includes('next') || lower.includes('todo') || lower.includes('pending')) return 'pending';
  if (lower.includes('in progress') || lower.includes('active') || lower.includes('working')) return 'active';
  return undefined;
}

function blockToTreeNode(block: LocalBlock, actions: BlockActions): any {
  const childIds = actions.getChildren(block.id);
  const children = childIds
    .map(id => actions.getBlock(id) as LocalBlock | undefined)
    .filter(Boolean)
    .map(child => blockToTreeNode(child!, actions));

  return {
    id: block.id.slice(0, 8),
    label: block.content,
    status: detectBlockStatus(block.content),
    ...(children.length > 0 ? { children } : {}),
  };
}

// ═══════════════════════════════════════════════════════════════
// EXPAND — block tree → rendered spec (local, no API)
// ═══════════════════════════════════════════════════════════════

function expandSpec(blockRef: string, actions: BlockActions) {
  const root = resolveBlockRef(blockRef, actions);
  if (!root) throw new Error(`Block not found: ${blockRef}`);

  const rootContent = root.content ?? '';
  const directChildIds = actions.getChildren(root.id);
  const allDescendants = walkTree(root.id, actions);

  const elements: Record<string, any> = {};
  const rootChildKeys: string[] = [];

  // Separate ctx:: entries from regular children
  const ctxCaptures: any[] = [];
  const nonCtxChildren: LocalBlock[] = [];

  for (const cid of directChildIds) {
    const child = actions.getBlock(cid) as LocalBlock | undefined;
    if (!child) continue;
    if (child.content.startsWith('ctx::')) {
      const timeMatch = child.content.match(/(\d{1,2}:\d{2}(?:\s*(?:AM|PM))?)/i);
      const projectMatch = child.content.match(/\[project::([^\]]+)\]/);
      const modeMatch = child.content.match(/\[mode::([^\]]+)\]/);
      const text = child.content
        .replace(/^ctx::\s*/, '')
        .replace(/\d{4}-\d{2}-\d{2}\s*@?\s*/, '')
        .replace(/\[(?:project|mode|slug|plan)::[^\]]*\]\s*/g, '')
        .trim();
      ctxCaptures.push({ time: timeMatch?.[1] ?? '', project: projectMatch?.[1] ?? '', mode: modeMatch?.[1] ?? '', text });
    } else {
      nonCtxChildren.push(child);
    }
  }

  // Header
  elements['header'] = { type: 'EntryHeader', props: { type: 'archaeology', title: rootContent, date: root.createdAt ? new Date(root.createdAt).toISOString().slice(0, 10) : '' }, children: [] };
  rootChildKeys.push('header');

  // Stats
  elements['stats'] = { type: 'StatsBar', props: { stats: [
    { label: 'blocks', value: String(allDescendants.length), color: '#00e5ff' },
    { label: 'children', value: String(directChildIds.length), color: '#98c379' },
  ], layout: 'row' }, children: [] };
  rootChildKeys.push('stats');

  // TreeView
  if (nonCtxChildren.length > 0) {
    const treeNodes = nonCtxChildren.map(child => blockToTreeNode(child, actions));
    elements['tree'] = { type: 'TreeView', props: { nodes: treeNodes, defaultExpanded: treeNodes.length <= 8 }, children: [] };
    rootChildKeys.push('tree');
  }

  // ContextStream
  if (ctxCaptures.length > 0) {
    elements['ctx'] = { type: 'ContextStream', props: { title: 'Context Trail', captures: ctxCaptures }, children: [] };
    rootChildKeys.push('ctx');
  }

  // Backlinks from wikilinks
  const wikilinkRe = /\[\[([^\]]+)\]\]/g;
  const allContent = allDescendants.map(b => b.content).join(' ') + ' ' + rootContent;
  const outbound = new Set<string>();
  let m;
  while ((m = wikilinkRe.exec(allContent)) !== null) outbound.add(m[1]);
  if (outbound.size > 0) {
    elements['refs'] = { type: 'BacklinksFooter', props: { inbound: [], outbound: [...outbound] }, children: [] };
    rootChildKeys.push('refs');
  }

  elements['layout'] = { type: 'Stack', props: { gap: 12, direction: 'vertical' }, children: rootChildKeys };
  return { root: 'layout', elements };
}

// ═══════════════════════════════════════════════════════════════
// KANBAN — children-as-columns view (local, no API)
// ═══════════════════════════════════════════════════════════════

const KANBAN_COLORS: Record<string, string> = {
  todo: '#ffb300', backlog: '#888', doing: '#00e5ff', 'in progress': '#00e5ff',
  active: '#00e5ff', done: '#98c379', shipped: '#98c379', complete: '#98c379',
  blocked: '#ff4444', deferred: '#e040a0', review: '#e040a0',
};

export function kanbanSpec(blockRef: string, actions: BlockActions) {
  const root = resolveBlockRef(blockRef, actions);
  if (!root) throw new Error(`Block not found: ${blockRef}`);

  const columns = actions.getChildren(root.id);
  if (columns.length === 0) throw new Error('No children to use as columns');

  const elements: Record<string, any> = {};
  const columnKeys: string[] = [];

  // FLO-587 — state.cards[blockId].content is the binding surface for
  // two-way sync. Card elements declare `bindings: { content: '/cards/<id>/content' }`;
  // StateProvider.onStateChange translates writes back to the outline via
  // the chirp `update-block` verb (see handleRenderStateChange).
  const cardsState: Record<string, { content: string }> = {};

  // Header
  elements['header'] = { type: 'Text', props: { content: root.content, size: 'lg', weight: 'bold', color: '#00e5ff' }, children: [] };

  // Each direct child = a column
  for (let ci = 0; ci < columns.length; ci++) {
    const col = actions.getBlock(columns[ci]) as LocalBlock | undefined;
    if (!col) continue;
    const colKey = `col-${ci}`;
    const colName = col.content.toLowerCase().replace(/[^a-z]+/g, ' ').trim();
    const colColor = KANBAN_COLORS[colName] ?? '#888';

    // Grandchildren = cards in this column
    const cardIds = actions.getChildren(col.id);
    const cardKeys: string[] = [];

    // Count for panel title
    const panelTitle = `${col.content} (${cardIds.length})`;

    for (let ki = 0; ki < cardIds.length; ki++) {
      const card = actions.getBlock(cardIds[ki]) as LocalBlock | undefined;
      if (!card) continue;
      const cardKey = `${colKey}-card-${ki}`;
      cardKeys.push(cardKey);

      // Detect status from content
      const status = detectBlockStatus(card.content);
      const cardColor = status === 'done' ? '#98c379' : status === 'active' ? '#00e5ff' : status === 'deferred' ? '#e040a0' : colColor;

      // Seed state with the current block content so the element's
      // binding resolves to the live value.
      cardsState[card.id] = { content: card.content };

      elements[cardKey] = {
        type: 'KanbanCard',
        props: {
          content: card.content,
          color: cardColor,
          blockId: card.id,
          parentId: col.id,
          index: ki,
        },
        bindings: { content: `/cards/${card.id}/content` },
        children: [],
      };
    }

    elements[colKey] = {
      type: 'KanbanColumn',
      props: {
        title: panelTitle,
        titleColor: colColor,
        blockId: col.id,
        childCount: cardKeys.length,
      },
      children: cardKeys,
    };

    columnKeys.push(colKey);
  }

  elements['columns'] = {
    type: 'Stack',
    props: { gap: 8, direction: 'horizontal' },
    children: columnKeys,
  };

  elements['layout'] = {
    type: 'Stack',
    props: { gap: 10, direction: 'vertical' },
    children: ['header', 'columns'],
  };

  return {
    root: 'layout',
    state: { cards: cardsState },
    elements,
  };
}

// ═══════════════════════════════════════════════════════════════
// AI SPEC GENERATION
// ═══════════════════════════════════════════════════════════════

const RENDER_TOOL_SCHEMA = {
  name: 'render_spec',
  description: 'Generate a UI spec for the json-render system',
  input_schema: {
    type: 'object' as const,
    properties: {
      root: { type: 'string' as const, description: 'Key of the root element' },
      elements: {
        type: 'object' as const,
        description: 'Map of element keys to component definitions',
        additionalProperties: {
          type: 'object' as const,
          properties: {
            type: { type: 'string' as const, enum: bbsCatalog.componentNames },
            props: { type: 'object' as const },
            children: { type: 'array' as const, items: { type: 'string' as const } },
          },
          required: ['type', 'props', 'children'],
        },
      },
    },
    required: ['root', 'elements'],
  },
};

const CLAUDE_SYSTEM_PROMPT = [
  'You are a UI spec generator for a dark-themed terminal outliner app called floatty.',
  '',
  bbsCatalog.prompt(),
  '',
  'Rules: every children key must exist in elements. Use realistic data. gap is a number (not string).',
  'Colors: #00e5ff (cyan), #e040a0 (magenta), #ff4444 (coral), #98c379 (green), #ffb300 (amber), #e5c07b (yellow)',
  'Use TuiPanel for bordered containers, TuiStat for metrics, BarChart+BarItem for data viz.',
  'Use ShippedItem for completed items, PatternCard for expandable technical notes.',
  'Use BacklinksFooter for bidirectional links, WikilinkChip for [[bracket]] links.',
  '',
  LAYOUT_PATTERNS,
].join('\n');

function normalizeSpec(spec: any, ctx: any): any {
  for (const el of Object.values(spec.elements || {}) as any[]) {
    // Translate legacy "component" field → "type" (json-render resolver uses el.type)
    if (el.component && !el.type) {
      el.type = el.component;
      delete el.component;
    }
    if (el.type === 'Stack' && typeof el.props?.gap === 'string') {
      el.props.gap = parseInt(el.props.gap) || 8;
    }
  }
  if (!spec.root || !spec.elements) {
    throw new Error('Invalid spec: missing root or elements');
  }
  if (!spec.elements[spec.root]) {
    const keys = Object.keys(spec.elements);
    if (keys.length > 0) {
      spec.root = keys[0];
      ctx.log('[render] auto-fixed root to:', spec.root);
    }
  }
  for (const [id, el] of Object.entries(spec.elements) as [string, any][]) {
    if (!Array.isArray(el.children)) { el.children = []; continue; }
    const before = el.children.length;
    el.children = el.children.filter((childId: string) => {
      if (typeof childId !== 'string') return false;
      return !!spec.elements[childId];
    });
    if (el.children.length < before) {
      ctx.log(`[render] dropped ${before - el.children.length} dangling child refs from ${id}`);
    }
  }
  return spec;
}

async function generateSpecViaClaude(userPrompt: string, apiKey: string, ctx: any): Promise<any> {
  const model = ctx.settings?.model || 'claude-haiku-4-5-20251001';
  ctx.log('Generating UI via Claude:', model, userPrompt);

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: CLAUDE_SYSTEM_PROMPT,
      tools: [RENDER_TOOL_SCHEMA],
      tool_choice: { type: 'tool', name: 'render_spec' },
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Claude API ${resp.status}: ${body.slice(0, 200)}`);
  }

  const result = await resp.json();
  const toolBlock = result.content?.find((b: any) => b.type === 'tool_use');
  if (!toolBlock?.input) {
    throw new Error('No tool_use block in Claude response');
  }

  const spec = toolBlock.input;
  ctx.log('Claude spec:', Object.keys(spec.elements || {}).length, 'elements');
  return normalizeSpec(spec, ctx);
}

async function generateSpecViaOllama(userPrompt: string, ctx: any): Promise<any> {
  ctx.log('Generating UI via ollama:', userPrompt);

  const systemPrompt = [
    'You are a UI generator. Output ONLY a single valid JSON object, no markdown, no explanation.',
    'Output format: {"root":"<key>","elements":{"<key>":{"type":"<Component>","props":{...},"children":["<child-key>"]},...}}',
    '',
    'AVAILABLE COMPONENTS (only use these):',
    '- Stack: { gap?: number, direction?: "vertical"|"horizontal" } - Layout [children]',
    '- TuiPanel: { title?: string, titleColor?: string } - Bordered container [children]',
    '- TuiStat: { label: string, value: string, color?: string } - Centered metric card',
    '- BarChart: { title?: string, maxHeight?: number } - Vertical bar chart [children=BarItem]',
    '- BarItem: { label: string, value: number, max?: number, color?: string } - Single bar',
    '- Text: { content: string, size?: "sm"|"md"|"lg"|"xl", weight?: "normal"|"medium"|"bold", color?: string, mono?: boolean }',
    '- DataBlock: { label?: string, content: string } - Monospace pre block with label',
    '- ShippedItem: { content: string } - Green bullet item',
    '- PatternCard: { title: string, type?: string, confidence?: string, content: string, connectsTo?: string[] } - Expandable card [children]',
    '- BacklinksFooter: { inbound: string[], outbound: string[] } - Bidirectional link footer',
    '- EntryHeader: { type: "synthesis"|"archaeology"|"bbs-source", title: string, date: string, author?: string }',
    '- Divider: {} - Horizontal line',
    '',
    'RULES:',
    '- Every key in children arrays MUST exist as an element',
    '- All elements need: type, props, children (array)',
    '- gap is a NUMBER not string. colors: #00e5ff (cyan), #e040a0 (magenta), #98c379 (green), #ffb300 (amber)',
  ].join('\n');

  const ollama = getOllamaConfig(ctx);

  const resp = await fetch(`${ollama.url}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: ollama.model,
      system: systemPrompt,
      prompt: userPrompt,
      stream: false,
      options: { temperature: 0.3 },
    }),
  });

  if (!resp.ok) {
    throw new Error(`Ollama error: ${resp.status}`);
  }

  const result = await resp.json();
  const raw = result.response || '';
  ctx.log('Ollama response length:', raw.length);

  let jsonStr = raw.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();

  const start = jsonStr.indexOf('{');
  if (start < 0) throw new Error('No JSON in ollama response');
  jsonStr = jsonStr.slice(start);

  return normalizeSpec(JSON.parse(jsonStr), ctx);
}

// ═══════════════════════════════════════════════════════════════
// TITLE GENERATION
// ═══════════════════════════════════════════════════════════════

async function generateTitle(content: string, ctx: any): Promise<string | null> {
  try {
    const ollama = getOllamaConfig(ctx);

    const resp = await fetch(`${ollama.url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ollama.model,
        system: 'Generate a short title (3-6 words) for this render request. Reply with ONLY the title, no quotes, no explanation.',
        prompt: content.slice(0, 500),
        stream: false,
        options: { temperature: 0.3 },
      }),
    });

    if (!resp.ok) return null;
    const result = await resp.json();
    const title = (result.response || '').trim().replace(/^["']|["']$/g, '');
    return title || null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// AGENT-BASED GENERATION
// ═══════════════════════════════════════════════════════════════

async function tauriShellExec(command: string): Promise<string> {
  const invoke = (window as any).__TAURI_INTERNALS__?.invoke
    || (window as any).__TAURI__?.core?.invoke
    || (window as any).__TAURI_INVOKE__;
  if (!invoke) {
    throw new Error(
      'Tauri invoke not available. Keys on window: ' +
      Object.keys(window).filter(k => k.toLowerCase().includes('tauri')).join(', ')
    );
  }
  return invoke('execute_shell_command', { command });
}

// Cache catalog prompt — it's derived from static catalog definition
let _cachedCatalogPrompt: string | null = null;

// Dynamic prompt from catalog — includes all components, actions, state bindings, repeat fields.
// Replaces old static AGENT_SYSTEM_PROMPT with catalog.prompt() for auto-sync with catalog changes.
function buildAgentSystemPrompt(): string {
  const catalogPrompt = _cachedCatalogPrompt ??= bbsCatalog.prompt();
  const stateIdx = catalogPrompt.indexOf('INITIAL STATE');
  const componentSection = stateIdx > 0 ? catalogPrompt.substring(stateIdx) : catalogPrompt;

  return [
    'You generate JSON render specs for floatty, a dark-themed terminal outliner.',
    '',
    'OUTPUT: A single JSON object on stdout. No markdown fences, no explanation, ONLY the JSON.',
    'Include a top-level "title" field (3-6 word human-readable summary) alongside root/state/elements.',
    '',
    'FORMAT:',
    '{"root":"<key>","title":"<3-6 word title>","state":{...},"elements":{"<key>":{"type":"<Component>","props":{...},"children":["<child-key>"]},...}}',
    '',
    componentSection,
    '',
    'OUTLINE WRITE vs LOCAL STATE:',
    '- createChild/upsertChild write REAL BLOCKS to the outline (persistent, searchable, visible as children)',
    '- pushState/removeState/setState only update LOCAL UI STATE (temporary, gone on re-render)',
    '- When the user says "add to outline", "save", "append", "create block" → use createChild or upsertChild',
    '- When the user wants a local list/counter/toggle within the UI only → use pushState/setState',
    '- Default to outline writes unless the user explicitly wants local-only state',
    '',
    'FLOATTY-SPECIFIC:',
    '- Every children key MUST exist in elements',
    '- gap is a NUMBER not a string',
    '- Use REAL data from the context provided, not placeholder text',
    '- Colors: #00e5ff (cyan), #e040a0 (magenta), #ff4444 (coral), #98c379 (green), #ffb300 (amber)',
    '- Output a SINGLE JSON object, NOT JSONL patches',
    '',
    LAYOUT_PATTERNS,
  ].join('\n');
}

interface AgentResult {
  spec: any;
  raw: string;
  sessionId?: string;
  title?: string;
}

interface AgentOptions {
  continueSession?: boolean;
  resumeSessionId?: string;
}

async function generateSpecViaAgent(userPrompt: string, ctx: any, options?: AgentOptions): Promise<AgentResult> {
  ctx.log('[render::agent] generating:', userPrompt);

  let contextBlock = '';
  try {
    const [statsResp, searchResp] = await Promise.all([
      ctx.server.fetch('/api/v1/stats'),
      ctx.server.fetch(`/api/v1/search?q=${encodeURIComponent(userPrompt)}&limit=10`),
    ]);
    const [stats, searchResults] = await Promise.all([statsResp.json(), searchResp.json()]);
    contextBlock += `Outline stats: ${stats.blockCount} blocks, ${stats.rootCount} roots, ${stats.pageCount} pages\n`;

    if (searchResults.hits?.length > 0) {
      contextBlock += '\nRelevant outline blocks:\n';
      for (const hit of searchResults.hits.slice(0, 10)) {
        contextBlock += `- [${hit.blockId?.slice(0, 8)}] ${(hit.content?.slice(0, 200) || '').replace(/\x00/g, '')}\n`;
      }
    }
  } catch (e: any) {
    ctx.log('[render::agent] context fetch failed (continuing without):', e.message);
  }

  const agentBinary = ctx.settings?.agent_binary || 'claude';
  if (!/^[a-zA-Z0-9._-]+$/.test(agentBinary)) {
    throw new Error(`Invalid agent_binary: must be a simple command name`);
  }
  const rawCwd = ctx.settings?.agent_cwd || '~/.floatty/doors/render/agent';
  if (!/^[a-zA-Z0-9_.~\/-]+$/.test(rawCwd)) {
    throw new Error(`Invalid agent_cwd: contains unsafe characters`);
  }
  const agentCwd = rawCwd.startsWith('~/') ? `$HOME/${rawCwd.slice(2)}` : rawCwd;

  let sessionFlag = '';
  if (options?.resumeSessionId) {
    sessionFlag = ` --resume ${options.resumeSessionId}`;
    ctx.log('[render::agent] resuming session:', options.resumeSessionId);
  } else if (options?.continueSession) {
    sessionFlag = ' --continue';
    ctx.log('[render::agent] continuing most recent session');
  }

  const fullPrompt = [
    ...(sessionFlag ? [] : [buildAgentSystemPrompt(), '']),
    contextBlock ? `CONTEXT FROM OUTLINE:\n${contextBlock}\n---\n` : '',
    `USER REQUEST: ${userPrompt}`,
  ].join('\n');

  const escapedPrompt = fullPrompt.replace(/'/g, "'\\''");
  const command = `cd "${agentCwd}" && ${agentBinary} -p${sessionFlag} --dangerously-skip-permissions --output-format text '${escapedPrompt}' 2>&1`;
  ctx.log('[render::agent] command:', agentBinary, sessionFlag || '(new session)');

  const raw = await tauriShellExec(command);
  ctx.log('[render::agent] response length:', raw.length);

  if (!raw || raw.trim().length === 0) {
    const err = new Error('Agent returned empty response — check if claude CLI is in PATH') as any;
    err.raw = '(empty)';
    throw err;
  }

  let jsonStr = raw.trim();

  // Prefer the last fenced JSON block (agent typically explains before emitting spec).
  // Assumption: the spec object is the LAST JSON block. If agents start emitting
  // summary/metadata JSON after the spec, this heuristic breaks.
  // Only matches blocks starting with '{' (objects, not arrays).
  const fenceMatches = [...jsonStr.matchAll(/```([^\n`]*)\n?([\s\S]*?)```/g)];
  for (let i = fenceMatches.length - 1; i >= 0; i--) {
    const lang = fenceMatches[i][1].trim().toLowerCase();
    const candidate = fenceMatches[i][2].trim();
    if (lang && lang !== 'json') continue;
    if (!candidate.startsWith('{')) continue;
    jsonStr = candidate;
    break;
  }

  const start = jsonStr.indexOf('{');
  const end = jsonStr.lastIndexOf('}');
  if (start < 0 || end < 0) {
    const err = new Error('No JSON object in agent response') as any;
    err.raw = raw;
    throw err;
  }
  jsonStr = jsonStr.slice(start, end + 1);

  let spec: any;
  try {
    spec = JSON.parse(jsonStr);
  } catch (parseErr: any) {
    const err = new Error(`JSON parse failed: ${parseErr.message}`) as any;
    err.raw = raw;
    throw err;
  }

  // Extract agent-generated title before normalizeSpec strips it
  const agentTitle = typeof spec.title === 'string' ? spec.title.trim() : undefined;
  delete spec.title;

  try {
    normalizeSpec(spec, ctx);
  } catch (e: any) {
    const err = new Error(e.message) as any;
    err.raw = raw;
    throw err;
  }

  let sessionId: string | undefined;
  const sessionMatch = raw.match(/session[:\s]+([0-9a-f]{8}-[0-9a-f-]+)/i)
    || raw.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
  if (sessionMatch) {
    sessionId = sessionMatch[1];
    ctx.log('[render::agent] session ID:', sessionId);
  }

  if (!sessionId) {
    try {
      const lsResult = await tauriShellExec(
        `ls -t $HOME/.claude/projects/-Users-*-*floatty-doors-render-agent*/*.jsonl 2>/dev/null | head -1`
      );
      const latestFile = lsResult.trim();
      if (latestFile) {
        const match = latestFile.match(/([0-9a-f]{8}-[0-9a-f-]+)\.jsonl$/);
        if (match) {
          sessionId = match[1];
          ctx.log('[render::agent] session ID (from JSONL):', sessionId);
        }
      }
    } catch { /* ignore */ }
  }

  return { spec, raw, sessionId, title: agentTitle };
}

// ═══════════════════════════════════════════════════════════════
// VIEW COMPONENT
// ═══════════════════════════════════════════════════════════════

interface RenderViewData {
  spec: any;
  title?: string;
  generatedVia?: 'demo' | 'stats' | 'prompt' | 'claude' | 'ollama' | 'agent' | 'raw-json';
  agentRaw?: string;
  agentSessionId?: string;
}

interface DoorViewProps {
  data: RenderViewData;
  settings: Record<string, unknown>;
  server: {
    url: string;
    wsUrl: string;
    fetch(path: string, init?: RequestInit): Promise<Response>;
  };
  onNavigate?: (target: string, opts?: { type?: 'page' | 'block' }) => void;
  onNavigateOut?: (direction: 'up' | 'down') => void;
  onChirp?: (message: string, data?: unknown) => void;
}

/**
 * FLO-587 — translate json-render StateProvider changes into chirp verbs
 * that floatty's chirp handler routes back to useBlockStore. Kanban emits
 * paths of shape `/cards/<blockId>/content`; other modes' bindings (if any)
 * get a no-op here. Runs on every value change (notifyChanges fires once
 * per distinct value per flush in @json-render/solid).
 */
export function handleRenderStateChange(
  changes: Array<{ path: string; value: unknown }>,
  onChirp?: (message: string, data?: unknown) => void,
): void {
  if (!onChirp) return;
  for (const { path, value } of changes) {
    const cardContent = /^\/cards\/([^/]+)\/content$/.exec(path);
    if (cardContent && typeof value === 'string') {
      onChirp('update-block', { blockId: cardContent[1], content: value });
      continue;
    }
    // Any other path is either from a non-kanban render mode that doesn't
    // use block-bound paths, or a kanban path shape we haven't wired yet.
    // Silent no-op — logging every such change would spam demo/stats/etc.
  }
}

function RenderView(props: DoorViewProps) {
  const spec = () => props.data?.spec;
  const generatedVia = () => props.data?.generatedVia;
  const agentRaw = () => props.data?.agentRaw;
  const sessionId = () => props.data?.agentSessionId;

  return (
    <Show when={spec()} fallback={
      <div style={{ padding: '8px', 'font-family': 'JetBrains Mono, monospace' }}>
        <Show when={agentRaw()}>
          <details>
            <summary style={{ color: '#888', cursor: 'pointer', 'font-size': '12px' }}>
              agent raw response ({agentRaw()!.length} chars)
            </summary>
            <pre style={{
              background: 'var(--color-bg-tertiary, #0d0d1a)',
              'border-radius': '6px',
              padding: '12px',
              'font-size': '11px',
              color: 'var(--color-text-secondary, #888)',
              overflow: 'auto',
              'max-height': '300px',
              margin: '4px 0',
              'white-space': 'pre-wrap',
            }}>
              {agentRaw()}
            </pre>
          </details>
        </Show>
        <Show when={!agentRaw()}>
          <div style={{ color: '#888' }}>No spec</div>
        </Show>
      </div>
    }>
      <div style={{ padding: '8px 0', 'font-family': 'JetBrains Mono, monospace' }}>
        <StateProvider
          initialState={spec()?.state || {}}
          onStateChange={(changes) => handleRenderStateChange(changes, props.onChirp)}
        >
          <RenderViewInner spec={spec()!} onNavigate={props.onNavigate} onChirp={props.onChirp} />
        </StateProvider>
        <Show when={generatedVia() || sessionId()}>
          <div style={{
            'margin-top': '8px',
            padding: '4px 8px',
            'font-size': '10px',
            color: 'var(--color-fg-muted, #555)',
            'font-family': 'JetBrains Mono, monospace',
            'border-top': '1px solid var(--color-border, #333)',
          }}>
            <Show when={generatedVia()}>
              <span>via {generatedVia()}</span>
            </Show>
            <Show when={sessionId()}>
              <span style={{ 'margin-left': generatedVia() ? '12px' : '0' }}>
                session: {sessionId()!}
              </span>
              <span style={{ color: 'var(--color-fg-muted, #444)', 'margin-left': '8px' }}>
                → render:: agent --continue | --resume {sessionId()!}
              </span>
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  );
}

function RenderViewInner(props: { spec: any; onNavigate?: (target: string, opts?: any) => void; onChirp?: (message: string, data?: unknown) => void }) {
  const actionHandlers = {
    navigate: async (params: Record<string, unknown>) => {
      const target = params.target as string;
      if (target && props.onNavigate) {
        props.onNavigate(target, { type: 'page' });
      }
    },
    createChild: async (params: Record<string, unknown>) => {
      props.onChirp?.('create-child', { content: params.content as string });
    },
    upsertChild: async (params: Record<string, unknown>) => {
      props.onChirp?.('upsert-child', {
        content: params.content as string,
        match: (params.match ?? params.prefix) as string,
      });
    },
    refresh: async () => {},
  };

  return (
    <div>
      <ActionProvider handlers={actionHandlers}>
        <VisibilityProvider>
          <ValidationProvider>
            <Renderer spec={props.spec} registry={bbsRegistry} />
          </ValidationProvider>
        </VisibilityProvider>
      </ActionProvider>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// DOOR EXPORT
// ═══════════════════════════════════════════════════════════════

function extractTitle(content: string): string | null {
  const match = content.match(/\[title::([^\]]+)\]/);
  return match ? match[1].trim() : null;
}

function setOutput(blockId: string, ctx: any, data: RenderViewData, error?: string) {
  const envelope = { kind: 'view', doorId: 'render', schema: 1, data, error };
  ctx.actions.setBlockOutput(blockId, envelope, 'door');
  ctx.actions.setBlockStatus(blockId, error ? 'error' : 'complete');
}

const executionNonces = new Map<string, number>();

// FLO-587 — per-block subscription to Y.Doc changes so kanban/expand
// re-project when their subtree mutates (e.g. after drag-drop). Key is
// `${blockId}:${cmd}` so kanban and expand for the same block don't
// stomp each other. Re-executing unsubscribes the previous handler
// before installing a new one.
const renderSubscriptions = new Map<string, () => void>();

export const door = {
  kind: 'view' as const,
  prefixes: ['render::'],

  async execute(blockId: string, content: string, ctx: any) {
    const nonce = (executionNonces.get(blockId) ?? 0) + 1;
    executionNonces.set(blockId, nonce);
    const thisExecution = nonce;
    ctx.actions.setBlockStatus(blockId, 'running');
    const raw = content.replace(/^render::\s*/i, '').trim();
    const explicitTitle = extractTitle(raw);
    const arg = raw.replace(/\[title::[^\]]*\]\s*/g, '').trim();

    const setOutputWithTitle = (data: RenderViewData, error?: string) => {
      const out = { ...data };
      if (explicitTitle) out.title = explicitTitle;
      setOutput(blockId, ctx, out, error);

      if (!explicitTitle && !out.title && !error && out.spec) {
        generateTitle(content, ctx).then(title => {
          if (title && executionNonces.get(blockId) === thisExecution) {
            setOutput(blockId, ctx, { ...out, title });
          }
        }).finally(() => {
          // Clean up nonce after title generation completes (or is skipped)
          // to prevent unbounded Map growth over long sessions
          if (executionNonces.get(blockId) === thisExecution) {
            executionNonces.delete(blockId);
          }
        });
      }
    };

    if (arg === 'demo' || arg === '') {
      setOutputWithTitle({ spec: demoSpec(), generatedVia: 'demo', title: 'render:: demo' });
      return;
    }

    if (arg === 'stats') {
      try {
        const spec = await statsSpec(ctx.server.fetch);
        setOutputWithTitle({ spec, generatedVia: 'stats', title: 'outline stats' });
      } catch (e: any) {
        ctx.log('stats fetch failed:', e.message);
        setOutputWithTitle({ spec: null }, e.message);
      }
      return;
    }

    if (arg.startsWith('expand ') || arg.startsWith('kanban ')) {
      const isKanban = arg.startsWith('kanban ');
      const blockRef = arg.slice(isKanban ? 7 : 7).trim();
      const cmd = isKanban ? 'kanban' : 'expand';
      if (!blockRef) {
        setOutputWithTitle({ spec: null }, `Usage: render:: ${cmd} [[blockId]]`);
        return;
      }

      const storeActions = { getBlock: (id: string) => ctx.actions.getBlock(id) as any, getChildren: (id: string) => ctx.actions.getChildren(id), rootIds: () => ctx.actions.rootIds?.() ?? [] };
      const generate = isKanban ? kanbanSpec : expandSpec;

      const refresh = () => {
        try {
          const spec = generate(blockRef, storeActions);
          setOutputWithTitle({ spec: normalizeSpec(spec, ctx), generatedVia: cmd as any, title: `${cmd}: ${blockRef}` });
        } catch (e: any) {
          ctx.log(`[render::${cmd}] refresh failed:`, e.message);
        }
      };

      // Initial render
      try {
        const spec = generate(blockRef, storeActions);
        setOutputWithTitle({ spec: normalizeSpec(spec, ctx), generatedVia: cmd as any, title: `${cmd}: ${blockRef}` });
      } catch (e: any) {
        ctx.log(`[render::${cmd}] failed:`, e.message);
        setOutputWithTitle({ spec: null }, e.message);
        return;
      }

      // FLO-587 — subscribe to block changes so the view re-projects when
      // the subtree mutates (drag-drop moves cards → Y.Doc updates →
      // `refresh()` re-generates spec → setOutputWithTitle propagates).
      // Filter to structural + content fields; ignore metadata-only updates
      // (outlinks/markers) that don't change what the kanban renders.
      const subKey = `${blockId}:${cmd}`;
      const prior = renderSubscriptions.get(subKey);
      if (prior) prior();
      const unsubscribe = ctx.server.subscribeBlockChanges(refresh, {
        fields: ['childIds', 'content', 'parentId'],
      });
      renderSubscriptions.set(subKey, unsubscribe);
      return;
    }

    if (arg === 'prompt') {
      const prompt = bbsCatalog.prompt();
      setOutputWithTitle({
        title: 'catalog prompt',
        generatedVia: 'prompt',
        spec: {
          root: 'main',
          elements: {
            main: { type: 'Stack', props: { direction: 'vertical', gap: 8 }, children: ['header', 'code'] },
            header: { type: 'Text', props: { content: 'catalog.prompt() output', size: 'lg', weight: 'bold', color: 'var(--color-ansi-cyan)' }, children: [] },
            code: { type: 'Code', props: { content: prompt, language: 'text' }, children: [] },
          },
        },
      });
      return;
    }

    if (arg.startsWith('ai ')) {
      const userPrompt = arg.slice(3).trim();
      if (!userPrompt) {
        setOutputWithTitle({ spec: null }, 'Usage: render:: ai <describe what you want>');
        return;
      }

      const anthropicKey = ctx.settings?.anthropic_api_key;

      ctx.log('[render::ai] route selection:', {
        hasAnthropicKey: !!anthropicKey,
        keyLength: anthropicKey ? anthropicKey.length : 0,
        model: ctx.settings?.model || 'claude-haiku-4-5-20251001',
      });

      if (anthropicKey) {
        try {
          ctx.log('[render::ai] using: Claude API');
          const spec = await generateSpecViaClaude(userPrompt, anthropicKey, ctx);
          setOutputWithTitle({ spec, generatedVia: 'claude' });
          return;
        } catch (e: any) {
          ctx.log('[render::ai] Claude API failed, falling back to ollama:', e.message);
        }
      } else {
        ctx.log('[render::ai] no API key found, going straight to ollama');
      }

      try {
        ctx.log('[render::ai] using: ollama', ctx.settings?.ollama_model || 'qwen2.5:7b');
        const spec = await generateSpecViaOllama(userPrompt, ctx);
        setOutputWithTitle({ spec, generatedVia: 'ollama' });
      } catch (e: any) {
        ctx.log('[render::ai] ollama also failed:', e.message);
        setOutputWithTitle({ spec: null }, `AI generation failed: ${e.message}`);
      }
      return;
    }

    if (arg.startsWith('agent ')) {
      let rest = arg.slice(6).trim();
      const options: AgentOptions = {};

      if (rest.startsWith('--continue ') || rest === '--continue') {
        options.continueSession = true;
        rest = rest.slice(11).trim();
      } else if (rest.startsWith('--resume ')) {
        rest = rest.slice(9).trim();
        const spaceIdx = rest.indexOf(' ');
        if (spaceIdx > 0) {
          const sid = rest.slice(0, spaceIdx);
          if (/^[0-9a-f-]+$/i.test(sid)) {
            options.resumeSessionId = sid;
          }
          rest = rest.slice(spaceIdx + 1).trim();
        } else if (/^[0-9a-f-]+$/i.test(rest)) {
          // standalone: --resume <id> with no following prompt
          options.resumeSessionId = rest;
          rest = '';
        }
      }

      const userPrompt = rest;
      if (!userPrompt && !options.continueSession && !options.resumeSessionId) {
        setOutputWithTitle({ spec: null }, 'Usage: render:: agent [--continue|--resume <id>] <prompt>');
        return;
      }

      try {
        ctx.log('[render::agent] using: claude -p', {
          cwd: ctx.settings?.agent_cwd || '~/.floatty/doors/render/agent',
          binary: ctx.settings?.agent_binary || 'claude',
          continue: options.continueSession || false,
          resume: options.resumeSessionId || null,
        });
        const result = await generateSpecViaAgent(userPrompt, ctx, options);
        ctx.log('[render::agent] spec generated:', Object.keys(result.spec?.elements || {}).length, 'elements');
        setOutputWithTitle({
          spec: result.spec,
          generatedVia: 'agent',
          agentRaw: result.raw,
          agentSessionId: result.sessionId,
          title: result.title,
        });
      } catch (e: any) {
        ctx.log('[render::agent] failed:', e.message);
        setOutputWithTitle({ spec: null, agentRaw: e.raw || null }, `Agent generation failed: ${e.message}`);
      }
      return;
    }

    // Raw JSON spec
    try {
      const spec = JSON.parse(arg);
      if (spec.root && spec.elements) {
        setOutputWithTitle({ spec: normalizeSpec(spec, ctx), generatedVia: 'raw-json' });
      } else {
        setOutputWithTitle({ spec: null }, 'JSON must have root + elements');
      }
    } catch {
      setOutputWithTitle({ spec: null }, `Unknown render command: ${arg}`);
    }
  },

  view: RenderView,
};

export const meta = {
  id: 'render',
  name: 'JSON Render',
  version: '0.2.0',
  selfRender: true,
};

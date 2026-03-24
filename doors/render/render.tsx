/**
 * render:: door — JSON Render spike
 *
 * Renders json-render specs inline using @json-render/solid.
 * Proof of concept: can we render guardrailed LLM-generated UIs inside floatty blocks?
 *
 * Usage:
 *   render:: demo          → hardcoded demo spec
 *   render:: stats         → live outline stats from floatty-server
 *   render:: ai <prompt>   → Claude structured outputs (haiku 4.5), ollama fallback
 *   render:: agent <prompt> → context-aware via CLI agent (claude -p), uses outline data
 *   render:: {"root":...}  → raw JSON spec (inline)
 *
 * Compile:
 *   node scripts/compile-door-bundle.mjs doors/render/render.tsx ~/.floatty-dev/doors/render/index.js
 */

import { createSignal, createResource, Show, For, onMount } from 'solid-js';
import { z } from 'zod';
import { schema } from '@json-render/solid/schema';
import {
  defineRegistry,
  Renderer,
  StateProvider,
  ActionProvider,
  VisibilityProvider,
  ValidationProvider,
  useStateStore,
  type BaseComponentProps,
} from '@json-render/solid';

// Import shared BBS catalog + registry for AI generation
import { bbsCatalog } from '../session-garden/catalog';
import { registry as bbsRegistry } from '../session-garden/registry';

// ═══════════════════════════════════════════════════════════════
// CATALOG — defines what components are available
// ═══════════════════════════════════════════════════════════════

const catalog = schema.createCatalog({
  components: {
    Stack: {
      props: z.object({
        gap: z.number().optional(),
        direction: z.enum(['vertical', 'horizontal']).optional(),
      }),
      slots: ['default'],
      description: 'Layout container, stacks children vertically or horizontally',
    },
    Card: {
      props: z.object({
        title: z.string().optional(),
        subtitle: z.string().optional(),
      }),
      slots: ['default'],
      description: 'A card container with optional title',
    },
    Text: {
      props: z.object({
        content: z.string(),
        size: z.enum(['sm', 'md', 'lg', 'xl']).optional(),
        weight: z.enum(['normal', 'medium', 'bold']).optional(),
        color: z.string().optional(),
        mono: z.boolean().optional(),
      }),
      slots: [],
      description: 'Text display',
    },
    Metric: {
      props: z.object({
        label: z.string(),
        value: z.string(),
      }),
      slots: [],
      description: 'A labeled metric value',
    },
    Button: {
      props: z.object({
        label: z.string(),
        variant: z.enum(['primary', 'secondary', 'danger']).optional(),
      }),
      slots: [],
      description: 'Clickable button that emits press event',
    },
    Code: {
      props: z.object({
        content: z.string(),
        language: z.string().optional(),
      }),
      slots: [],
      description: 'Code block display',
    },
    Divider: {
      props: z.object({}),
      slots: [],
      description: 'Horizontal divider line',
    },
  },
  actions: {
    navigate: {
      params: z.object({ target: z.string() }),
      description: 'Navigate to a page or block in the outline',
    },
    refresh: {
      params: z.object({}),
      description: 'Refresh the data',
    },
  },
});

// ═══════════════════════════════════════════════════════════════
// COMPONENTS — SolidJS implementations
// ═══════════════════════════════════════════════════════════════

function StackComponent(props: BaseComponentProps<{ gap?: number | string; direction?: string }>) {
  const dir = () => props.props.direction || 'vertical';
  const gap = () => {
    const g = props.props.gap;
    return typeof g === 'string' ? (parseInt(g) || 8) : (g ?? 8);
  };
  return (
    <div style={{
      display: 'flex',
      'flex-direction': dir() === 'horizontal' ? 'row' : 'column',
      gap: `${gap()}px`,
    }}>
      {props.children}
    </div>
  );
}

function CardComponent(props: BaseComponentProps<{ title?: string; subtitle?: string }>) {
  return (
    <div style={{
      background: 'var(--color-bg-secondary, #1a1a2e)',
      'border-radius': '8px',
      border: '1px solid var(--color-border, #333)',
      padding: '16px',
    }}>
      <Show when={props.props.title}>
        <div style={{
          'font-size': '14px',
          'font-weight': '600',
          color: 'var(--color-text-primary, #e0e0e0)',
          'margin-bottom': props.props.subtitle ? '2px' : '12px',
        }}>
          {props.props.title}
        </div>
      </Show>
      <Show when={props.props.subtitle}>
        <div style={{
          'font-size': '12px',
          color: 'var(--color-text-secondary, #888)',
          'margin-bottom': '12px',
        }}>
          {props.props.subtitle}
        </div>
      </Show>
      {props.children}
    </div>
  );
}

function TextComponent(props: BaseComponentProps<{ content: string; size?: string; weight?: string; color?: string; mono?: boolean }>) {
  const fontSize = () => {
    switch (props.props.size) {
      case 'sm': return '12px';
      case 'lg': return '16px';
      case 'xl': return '20px';
      default: return '13px';
    }
  };
  return (
    <span style={{
      'font-size': fontSize(),
      'font-weight': props.props.weight === 'bold' ? '700' : props.props.weight === 'medium' ? '500' : '400',
      color: props.props.color || 'var(--color-text-primary, #e0e0e0)',
      'font-family': props.props.mono ? 'JetBrains Mono, monospace' : 'inherit',
    }}>
      {props.props.content}
    </span>
  );
}

function MetricComponent(props: BaseComponentProps<{ label: string; value: string }>) {
  return (
    <div style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center', padding: '4px 0' }}>
      <span style={{ 'font-size': '12px', color: 'var(--color-text-secondary, #888)' }}>
        {props.props.label}
      </span>
      <span style={{ 'font-size': '14px', 'font-weight': '600', color: 'var(--color-ansi-cyan, #56b6c2)', 'font-family': 'JetBrains Mono, monospace' }}>
        {props.props.value}
      </span>
    </div>
  );
}

function ButtonComponent(props: BaseComponentProps<{ label: string; variant?: string }>) {
  const bg = () => {
    switch (props.props.variant) {
      case 'primary': return 'var(--color-ansi-cyan, #56b6c2)';
      case 'danger': return 'var(--color-ansi-red, #e06c75)';
      default: return 'var(--color-bg-secondary, #2a2a3e)';
    }
  };
  return (
    <button
      onClick={() => props.emit('press')}
      style={{
        background: bg(),
        color: props.props.variant === 'secondary' ? 'var(--color-text-primary, #e0e0e0)' : '#fff',
        border: props.props.variant === 'secondary' ? '1px solid var(--color-border, #444)' : 'none',
        'border-radius': '6px',
        padding: '6px 12px',
        'font-size': '12px',
        'font-family': 'JetBrains Mono, monospace',
        cursor: 'pointer',
      }}
    >
      {props.props.label}
    </button>
  );
}

function CodeComponent(props: BaseComponentProps<{ content: string; language?: string }>) {
  return (
    <pre style={{
      background: 'var(--color-bg-tertiary, #0d0d1a)',
      'border-radius': '6px',
      padding: '12px',
      'font-size': '12px',
      'font-family': 'JetBrains Mono, monospace',
      color: 'var(--color-text-primary, #e0e0e0)',
      overflow: 'auto',
      margin: '0',
      'white-space': 'pre-wrap',
    }}>
      {props.props.content}
    </pre>
  );
}

function DividerComponent(_props: BaseComponentProps<Record<string, never>>) {
  return <hr style={{ border: 'none', 'border-top': '1px solid var(--color-border, #333)', margin: '8px 0' }} />;
}

// ═══════════════════════════════════════════════════════════════
// REGISTRY
// ═══════════════════════════════════════════════════════════════

const { registry } = defineRegistry(catalog, {
  components: {
    Stack: StackComponent,
    Card: CardComponent,
    Text: TextComponent,
    Metric: MetricComponent,
    Button: ButtonComponent,
    Code: CodeComponent,
    Divider: DividerComponent,
  },
  actions: {
    navigate: async () => {},
    refresh: async () => {},
  },
});

// ═══════════════════════════════════════════════════════════════
// SPEC GENERATORS
// ═══════════════════════════════════════════════════════════════

function demoSpec() {
  return {
    root: 'main',
    state: { count: 0 },
    elements: {
      main: { type: 'Stack' as const, props: { direction: 'vertical' as const, gap: 12 }, children: ['header', 'cards'] },
      header: { type: 'Text' as const, props: { content: 'render:: door spike', size: 'lg' as const, weight: 'bold' as const, color: 'var(--color-ansi-cyan, #56b6c2)' }, children: [] },
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
            type: { type: 'string' as const, enum: [
              'DocLayout', 'NavBrand', 'NavSection', 'NavItem', 'NavFooter',
              'EntryHeader', 'EntryBody', 'Ellipsis',
              'TagBar', 'TagChip', 'RefSection', 'RefCard', 'Breadcrumb',
              'Stack', 'Text', 'Divider',
              'TuiPanel', 'TuiStat', 'BarChart', 'BarItem',
              'DataBlock', 'ShippedItem', 'WikilinkChip', 'BacklinksFooter', 'PatternCard',
              'Card', 'Metric', 'Button', 'Code',
            ] },
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

// Generate system prompt from bbsCatalog — includes all 24 components
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
].join('\n');

/** Normalize an LLM-generated spec: fix gap strings, validate root+elements, auto-fix root */
function normalizeSpec(spec: any, ctx: any): any {
  // Fix gap values — LLMs sometimes return "24px" strings, Stack expects numbers
  for (const el of Object.values(spec.elements || {}) as any[]) {
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
  return spec;
}

async function readAnthropicKeyFromEnv(_ctx: any): Promise<string | null> {
  // Door runs in webview — can't read files directly.
  // Key must be set in config.toml [plugins.render] anthropic_api_key
  return null;
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

  // Ollama gets a simpler prompt — smaller models need tighter constraints
  const systemPrompt = [
    'You are a UI generator. Output ONLY a single valid JSON object, no markdown, no explanation.',
    'Output format: {"root":"<key>","elements":{"<key>":{"type":"<Component>","props":{...},"children":["<child-key>"]},...}}',
    '',
    'AVAILABLE COMPONENTS (only use these):',
    '- Stack: { gap?: number, direction?: "vertical"|"horizontal", sectionId?: string } - Layout [children]',
    '- TuiPanel: { title?: string, titleColor?: string } - Bordered container with floating title [children]',
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

  const ollamaUrl = ctx.settings?.ollama_endpoint || 'http://float-box:11434';
  const ollamaModel = ctx.settings?.ollama_model || 'qwen2.5:7b';

  const resp = await fetch(`${ollamaUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: ollamaModel,
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
// AGENT-BASED GENERATION (claude -p, etc.)
// ═══════════════════════════════════════════════════════════════

/**
 * Shell out via Tauri's execute_shell_command.
 * Door JS runs in the same webview, so __TAURI_INTERNALS__ is available.
 */
async function tauriShellExec(command: string): Promise<string> {
  // Try multiple paths to find Tauri invoke
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

const AGENT_SYSTEM_PROMPT = `You generate JSON render specs for floatty, a dark-themed terminal outliner.

OUTPUT: A single JSON object on stdout. No markdown fences, no explanation, ONLY the JSON.

FORMAT:
{"root":"<key>","elements":{"<key>":{"type":"<Component>","props":{...},"children":["<child-key>"]},...}}

COMPONENTS (24 available — use the right ones for the content):

Layout:
- Stack: { gap?: number, direction?: "vertical"|"horizontal", sectionId?: string } — flex container [children]
- DocLayout: { sidebarWidth?: number } — two-column layout [children: sidebar + main]

Sidebar:
- NavBrand: { title: string, subtitle?: string }
- NavSection: { label: string, accent?: "magenta"|"cyan"|"coral"|"amber" } — [children]
- NavItem: { id: string, label: string, active?: boolean }
- NavFooter: { content: string }

TUI Data:
- TuiPanel: { title?: string, titleColor?: string } — bordered container, title on border [children]
- TuiStat: { label: string, value: string, color?: string } — centered metric card
- BarChart: { title?: string, maxHeight?: number } — vertical bars [children=BarItem]
- BarItem: { label: string, value: number, max?: number, color?: string }

Content:
- EntryHeader: { type: "synthesis"|"archaeology"|"bbs-source", title: string, date: string, author?: string, board?: string }
- EntryBody: { markdown: string } — renders markdown with tables + [[wikilinks]]
- Text: { content: string, size?: "sm"|"md"|"lg"|"xl", weight?: "normal"|"medium"|"bold", color?: string, mono?: boolean }
- DataBlock: { label?: string, content: string } — monospace pre with floating label
- ShippedItem: { content: string } — green * bullet
- PatternCard: { title: string, type?: string, confidence?: string, content: string, connectsTo?: string[] } — expandable [children]

References:
- BacklinksFooter: { inbound: string[], outbound: string[] }
- RefSection: { label?: string } — [children=RefCard]
- RefCard: { id: string, type: string, title: string }
- WikilinkChip: { target: string, label?: string }

Tags:
- TagBar: { gap?: number } — [children=TagChip]
- TagChip: { name: string, active?: boolean }

Other:
- Divider: {}
- Ellipsis: {}
- Breadcrumb: { label: string }

RULES:
- Every children key MUST exist in elements
- gap is a NUMBER not a string
- Use REAL data from the context provided, not placeholder text
- Colors: #00e5ff (cyan), #e040a0 (magenta), #ff4444 (coral), #98c379 (green), #ffb300 (amber)
- For dashboards: TuiPanel + TuiStat + BarChart
- For documents: EntryHeader + EntryBody + RefSection
- For work logs: ShippedItem + BacklinksFooter + PatternCard`;

interface AgentResult {
  spec: any;
  raw: string;
  sessionId?: string;
}

interface AgentOptions {
  continueSession?: boolean;   // --continue (most recent session in cwd)
  resumeSessionId?: string;    // --resume <id>
}

async function generateSpecViaAgent(userPrompt: string, ctx: any, options?: AgentOptions): Promise<AgentResult> {
  ctx.log('[render::agent] generating:', userPrompt);

  // Fetch outline context to feed the agent
  let contextBlock = '';
  try {
    const statsResp = await ctx.server.fetch('/api/v1/stats');
    const stats = await statsResp.json();
    contextBlock += `Outline stats: ${stats.blockCount} blocks, ${stats.rootCount} roots, ${stats.pageCount} pages\n`;

    const searchResp = await ctx.server.fetch(`/api/v1/search?q=${encodeURIComponent(userPrompt)}&limit=10`);
    const searchResults = await searchResp.json();
    if (searchResults.hits?.length > 0) {
      contextBlock += '\nRelevant outline blocks:\n';
      for (const hit of searchResults.hits.slice(0, 10)) {
        contextBlock += `- [${hit.blockId?.slice(0, 8)}] ${hit.content?.slice(0, 200)}\n`;
      }
    }
  } catch (e: any) {
    ctx.log('[render::agent] context fetch failed (continuing without):', e.message);
  }

  const agentBinary = ctx.settings?.agent_binary || 'claude';
  const agentCwd = ctx.settings?.agent_cwd || '~/.floatty/doors/render/agent';

  // Build command with session flags
  let sessionFlag = '';
  if (options?.resumeSessionId) {
    sessionFlag = ` --resume ${options.resumeSessionId}`;
    ctx.log('[render::agent] resuming session:', options.resumeSessionId);
  } else if (options?.continueSession) {
    sessionFlag = ' --continue';
    ctx.log('[render::agent] continuing most recent session');
  }

  const fullPrompt = [
    // Skip system prompt on --continue/--resume — agent already has context
    ...(sessionFlag ? [] : [AGENT_SYSTEM_PROMPT, '']),
    contextBlock ? `CONTEXT FROM OUTLINE:\n${contextBlock}\n---\n` : '',
    `USER REQUEST: ${userPrompt}`,
  ].join('\n');

  const escapedPrompt = fullPrompt.replace(/'/g, "'\\''");
  const command = `cd ${agentCwd} && ${agentBinary} -p${sessionFlag} --dangerously-skip-permissions --output-format text '${escapedPrompt}' 2>&1`;
  ctx.log('[render::agent] command:', agentBinary, sessionFlag || '(new session)');

  const raw = await tauriShellExec(command);
  ctx.log('[render::agent] response length:', raw.length);

  if (!raw || raw.trim().length === 0) {
    const err = new Error('Agent returned empty response — check if claude CLI is in PATH') as any;
    err.raw = '(empty)';
    throw err;
  }

  // Extract JSON from response
  let jsonStr = raw.trim();

  // Strip markdown fences if present
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();

  // Find first { to last }
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

  try {
    normalizeSpec(spec, ctx);
  } catch (e: any) {
    const err = new Error(e.message) as any;
    err.raw = raw;
    throw err;
  }

  // Extract session ID from claude output — look for session patterns in raw
  // claude -p outputs session info to stderr which we capture via 2>&1
  let sessionId: string | undefined;
  const sessionMatch = raw.match(/session[:\s]+([0-9a-f]{8}-[0-9a-f-]+)/i)
    || raw.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
  if (sessionMatch) {
    sessionId = sessionMatch[1];
    ctx.log('[render::agent] session ID:', sessionId);
  }

  // Also try to find session from the JSONL files in the agent workspace
  if (!sessionId) {
    try {
      const lsResult = await tauriShellExec(
        `ls -t ~/.claude/projects/-Users-evan-*floatty-doors-render-agent*/*.jsonl 2>/dev/null | head -1`
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

  return { spec, raw, sessionId };
}

// ═══════════════════════════════════════════════════════════════
// VIEW COMPONENT
// ═══════════════════════════════════════════════════════════════

interface RenderViewData {
  spec: any;
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
}

function RenderView(props: DoorViewProps) {
  const spec = () => props.data?.spec;
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
        <StateProvider initialState={spec()?.state || {}}>
          <RenderViewInner spec={spec()!} onNavigate={props.onNavigate} />
        </StateProvider>
        {/* Agent session footer — shows session ID for --continue/--resume */}
        <Show when={sessionId()}>
          <div style={{
            'margin-top': '8px',
            padding: '4px 8px',
            'font-size': '10px',
            color: 'var(--color-fg-muted, #555)',
            'font-family': 'JetBrains Mono, monospace',
            'border-top': '1px solid var(--color-border, #333)',
          }}>
            session: {sessionId()!.substring(0, 8)}
            <span style={{ color: 'var(--color-fg-muted, #444)', 'margin-left': '8px' }}>
              → render:: agent --continue | --resume {sessionId()!.substring(0, 8)}
            </span>
          </div>
        </Show>
      </div>
    </Show>
  );
}

function RenderViewInner(props: { spec: any; onNavigate?: (target: string, opts?: any) => void }) {
  const handlers = {
    navigate: async (params: Record<string, unknown>) => {
      const target = params.target as string;
      if (target && props.onNavigate) {
        props.onNavigate(target, { type: 'page' });
      }
    },
    refresh: async () => {
      // No-op for now — could trigger re-execute
    },
  };

  return (
    <ActionProvider handlers={handlers}>
      <VisibilityProvider>
        <ValidationProvider>
          <Renderer spec={props.spec} registry={bbsRegistry} />
        </ValidationProvider>
      </VisibilityProvider>
    </ActionProvider>
  );
}

// ═══════════════════════════════════════════════════════════════
// DOOR EXPORT
// ═══════════════════════════════════════════════════════════════

export const door = {
  kind: 'view' as const,
  prefixes: ['render::'],

  async execute(blockId: string, content: string, ctx: any) {
    const arg = content.replace(/^render::\s*/i, '').trim();

    // Route: demo, stats, or raw JSON
    if (arg === 'demo' || arg === '') {
      return { data: { spec: demoSpec() } };
    }

    if (arg === 'stats') {
      try {
        const spec = await statsSpec(ctx.server.fetch);
        return { data: { spec } };
      } catch (e: any) {
        ctx.log('stats fetch failed:', e.message);
        return { data: { spec: null }, error: e.message };
      }
    }

    if (arg === 'prompt') {
      // Show the LLM system prompt that bbsCatalog.prompt() generates
      const prompt = bbsCatalog.prompt();
      return {
        data: {
          spec: {
            root: 'main',
            elements: {
              main: { type: 'Stack', props: { direction: 'vertical', gap: 8 }, children: ['header', 'code'] },
              header: { type: 'Text', props: { content: 'catalog.prompt() output', size: 'lg', weight: 'bold', color: 'var(--color-ansi-cyan)' }, children: [] },
              code: { type: 'Code', props: { content: prompt, language: 'text' }, children: [] },
            },
          },
        },
      };
    }

    // render:: ai <prompt> — generate spec via Claude structured outputs (ollama fallback)
    if (arg.startsWith('ai ')) {
      const userPrompt = arg.slice(3).trim();
      if (!userPrompt) {
        return { data: { spec: null }, error: 'Usage: render:: ai <describe what you want>' };
      }

      // Try Claude API first, fall back to ollama
      const anthropicKey = ctx.settings?.anthropic_api_key
        || await readAnthropicKeyFromEnv(ctx);

      ctx.log('[render::ai] route selection:', {
        hasAnthropicKey: !!anthropicKey,
        keyPrefix: anthropicKey ? anthropicKey.substring(0, 12) + '...' : 'none',
        model: ctx.settings?.model || 'claude-haiku-4-5-20251001',
        settingsKeys: Object.keys(ctx.settings || {}),
      });

      if (anthropicKey) {
        try {
          ctx.log('[render::ai] using: Claude API');
          const spec = await generateSpecViaClaude(userPrompt, anthropicKey, ctx);
          return { data: { spec } };
        } catch (e: any) {
          ctx.log('[render::ai] Claude API failed, falling back to ollama:', e.message);
          // Fall through to ollama
        }
      } else {
        ctx.log('[render::ai] no API key found, going straight to ollama');
      }

      // Ollama fallback
      try {
        ctx.log('[render::ai] using: ollama', ctx.settings?.ollama_model || 'qwen2.5:7b');
        const spec = await generateSpecViaOllama(userPrompt, ctx);
        return { data: { spec } };
      } catch (e: any) {
        ctx.log('[render::ai] ollama also failed:', e.message);
        return { data: { spec: null }, error: `AI generation failed: ${e.message}` };
      }
    }

    // render:: agent [--continue|--resume <id>] <prompt>
    if (arg.startsWith('agent ')) {
      let rest = arg.slice(6).trim();
      const options: AgentOptions = {};

      // Parse flags
      if (rest.startsWith('--continue ') || rest === '--continue') {
        options.continueSession = true;
        rest = rest.slice(11).trim();
      } else if (rest.startsWith('--resume ')) {
        rest = rest.slice(9).trim();
        const spaceIdx = rest.indexOf(' ');
        if (spaceIdx > 0) {
          options.resumeSessionId = rest.slice(0, spaceIdx);
          rest = rest.slice(spaceIdx + 1).trim();
        }
      }

      const userPrompt = rest;
      if (!userPrompt) {
        return { data: { spec: null }, error: 'Usage: render:: agent [--continue|--resume <id>] <prompt>' };
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
        return {
          data: {
            spec: result.spec,
            agentRaw: result.raw,
            agentSessionId: result.sessionId,
          },
        };
      } catch (e: any) {
        ctx.log('[render::agent] failed:', e.message);
        return { data: { spec: null, agentRaw: e.raw || null }, error: `Agent generation failed: ${e.message}` };
      }
    }

    // Try parsing as raw JSON spec
    try {
      const spec = JSON.parse(arg);
      if (spec.root && spec.elements) {
        return { data: { spec } };
      }
      return { data: { spec: null }, error: 'JSON must have root + elements' };
    } catch {
      return { data: { spec: null }, error: `Unknown render command: ${arg}` };
    }
  },

  view: RenderView,
};

export const meta = {
  id: 'render',
  name: 'JSON Render',
  version: '0.1.0',
};

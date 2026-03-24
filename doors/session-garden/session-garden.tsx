/**
 * garden:: door — Session Garden viewer
 *
 * Renders a navigable collection of BBS entries using the bbsCatalog
 * component vocabulary. Data in, specs out.
 *
 * Usage:
 *   garden:: demo         → sunday session data
 *   garden:: board <name> → (future) load from BBS board
 *
 * The catalog (catalog.ts) + components (components.tsx) + registry (registry.ts)
 * are reusable across any door that needs document browsing.
 *
 * Compile:
 *   node scripts/compile-door-bundle.mjs doors/session-garden/session-garden.tsx ~/.floatty-dev/doors/session-garden/index.js
 */

import { createSignal, createMemo, Show, batch, onMount } from 'solid-js';
import {
  Renderer,
  StateProvider,
  ActionProvider,
  VisibilityProvider,
  ValidationProvider,
} from '@json-render/solid';
import { registry } from './registry';
import { injectBodyStyles } from './components';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export interface Entry {
  id: string;
  type: 'synthesis' | 'archaeology' | 'bbs-source';
  title: string;
  tags: string[];
  content: string;
  date: string;
  author?: string;
  board?: string;
  refs?: string[];
}

interface GardenData {
  entries: Entry[];
  title?: string;
  subtitle?: string;
  footer?: string;
}

// ═══════════════════════════════════════════════════════════════
// SPEC BUILDERS
// ═══════════════════════════════════════════════════════════════

const NAV_GROUPS = [
  { type: 'synthesis', label: 'SYNTHESIS', accent: 'magenta' },
  { type: 'archaeology', label: 'ARCHAEOLOGY', accent: 'cyan' },
  { type: 'bbs-source', label: 'BBS SOURCES', accent: 'coral' },
] as const;

/**
 * Build sidebar spec elements from entries
 */
function buildSidebarSpec(
  entries: Entry[],
  currentId: string,
  title: string,
  subtitle?: string,
  footer?: string,
): { elements: Record<string, any>; rootChildren: string[] } {
  const elements: Record<string, any> = {};
  const rootChildren: string[] = ['nav-brand'];

  elements['nav-brand'] = {
    type: 'NavBrand',
    props: { title, subtitle: subtitle || '' },
    children: [],
  };

  for (const group of NAV_GROUPS) {
    const items = entries.filter((e) => e.type === group.type);
    if (items.length === 0) continue;

    const sectionId = `nav-section-${group.type}`;
    const itemIds: string[] = [];

    for (const entry of items) {
      const itemId = `nav-${entry.id}`;
      const short = entry.title.replace(/^Thread [A-D]: /, '').replace(/^The /, '');
      elements[itemId] = {
        type: 'NavItem',
        props: { id: entry.id, label: short, active: entry.id === currentId },
        children: [],
        on: { press: { action: 'selectEntry', params: { id: entry.id } } },
      };
      itemIds.push(itemId);
    }

    elements[sectionId] = {
      type: 'NavSection',
      props: { label: group.label, accent: group.accent },
      children: itemIds,
    };
    rootChildren.push(sectionId);
  }

  if (footer) {
    elements['nav-footer'] = {
      type: 'NavFooter',
      props: { content: footer },
      children: [],
    };
    rootChildren.push('nav-footer');
  }

  return { elements, rootChildren };
}

/**
 * Build main content spec for an entry
 */
function buildEntrySpec(
  entry: Entry,
  entryMap: Map<string, Entry>,
  backLabel: string | null,
  tagFilter: string | null,
): { elements: Record<string, any>; rootChildren: string[] } {
  const elements: Record<string, any> = {};
  const rootChildren: string[] = [];

  // Back breadcrumb
  if (backLabel) {
    elements['breadcrumb'] = {
      type: 'Breadcrumb',
      props: { label: backLabel },
      children: [],
      on: { press: { action: 'goBack' } },
    };
    rootChildren.push('breadcrumb');
  }

  // Header
  elements['entry-header'] = {
    type: 'EntryHeader',
    props: {
      type: entry.type,
      board: entry.board || '',
      title: entry.title,
      date: entry.date,
      author: entry.author || 'mixed',
    },
    children: [],
  };
  rootChildren.push('entry-header');

  // Tags
  if (entry.tags.length > 0) {
    const tagIds: string[] = [];
    for (const tag of entry.tags) {
      const tagId = `tag-${tag}`;
      elements[tagId] = {
        type: 'TagChip',
        props: { name: tag, active: tagFilter === tag },
        children: [],
        on: { press: { action: 'filterTag', params: { tag } } },
      };
      tagIds.push(tagId);
    }
    elements['tag-bar'] = {
      type: 'TagBar',
      props: {},
      children: tagIds,
    };
    rootChildren.push('tag-bar');
  }

  // Body
  elements['entry-body'] = {
    type: 'EntryBody',
    props: { markdown: entry.content },
    children: [],
  };
  rootChildren.push('entry-body');

  // Ellipsis
  if (entry.content.includes('\u00b7\u00b7\u00b7')) {
    elements['ellipsis'] = {
      type: 'Ellipsis',
      props: {},
      children: [],
    };
    rootChildren.push('ellipsis');
  }

  // References
  const refs = (entry.refs || []).map((rid) => entryMap.get(rid)).filter(Boolean) as Entry[];
  if (refs.length > 0) {
    const refIds: string[] = [];
    for (const ref of refs) {
      const refId = `ref-${ref.id}`;
      elements[refId] = {
        type: 'RefCard',
        props: { id: ref.id, type: ref.type, title: ref.title },
        children: [],
        on: { press: { action: 'selectEntry', params: { id: ref.id } } },
      };
      refIds.push(refId);
    }
    elements['ref-section'] = {
      type: 'RefSection',
      props: { label: 'CONNECTED' },
      children: refIds,
    };
    rootChildren.push('ref-section');
  }

  return { elements, rootChildren };
}

/**
 * Build tag filter view spec
 */
function buildTagFilterSpec(
  tag: string,
  matches: Entry[],
): { elements: Record<string, any>; rootChildren: string[] } {
  const elements: Record<string, any> = {};
  const rootChildren: string[] = [];

  elements['back'] = {
    type: 'Breadcrumb',
    props: { label: 'back' },
    children: [],
    on: { press: { action: 'goBack' } },
  };
  rootChildren.push('back');

  elements['filter-header'] = {
    type: 'EntryHeader',
    props: { type: 'synthesis', title: `#${tag}`, date: '', author: '' },
    children: [],
  };
  rootChildren.push('filter-header');

  for (const entry of matches) {
    const refId = `filter-${entry.id}`;
    elements[refId] = {
      type: 'RefCard',
      props: { id: entry.id, type: entry.type, title: entry.title },
      children: [],
      on: { press: { action: 'selectEntry', params: { id: entry.id } } },
    };
    rootChildren.push(refId);
  }

  return { elements, rootChildren };
}

/**
 * Compose full spec from sidebar + main content
 */
function buildFullSpec(
  entries: Entry[],
  currentId: string,
  entryMap: Map<string, Entry>,
  backLabel: string | null,
  tagFilter: string | null,
  title: string,
  subtitle?: string,
  footer?: string,
) {
  const sidebar = buildSidebarSpec(entries, currentId, title, subtitle, footer);

  let main: { elements: Record<string, any>; rootChildren: string[] };
  if (tagFilter) {
    const matches = entries.filter((e) => e.tags.includes(tagFilter));
    main = buildTagFilterSpec(tagFilter, matches);
  } else {
    const entry = entryMap.get(currentId);
    if (!entry) return null;
    main = buildEntrySpec(entry, entryMap, backLabel, tagFilter);
  }

  // Compose into DocLayout
  const elements: Record<string, any> = {
    ...sidebar.elements,
    ...main.elements,
    'sidebar-stack': {
      type: 'Stack',
      props: {
        direction: 'vertical',
        gap: 0,
        width: '280px',
        minWidth: '280px',
        borderRight: `1px solid #222`,
        overflow: 'auto',
      },
      children: sidebar.rootChildren,
    },
    'main-stack': {
      type: 'Stack',
      props: {
        direction: 'vertical',
        gap: 0,
        flex: '1',
        padding: '32px 40px 120px',
        overflow: 'auto',
        maxWidth: '760px',
      },
      children: main.rootChildren,
    },
    root: {
      type: 'DocLayout',
      props: {},
      children: ['sidebar-stack', 'main-stack'],
    },
  };

  return { root: 'root', elements };
}

// ═══════════════════════════════════════════════════════════════
// GARDEN VIEW (stateful wrapper)
// ═══════════════════════════════════════════════════════════════

interface DoorViewProps {
  data: GardenData;
  settings: Record<string, unknown>;
  server: {
    url: string;
    wsUrl: string;
    fetch(path: string, init?: RequestInit): Promise<Response>;
  };
  onNavigate?: (target: string, opts?: { type?: 'page' | 'block' }) => void;
  onNavigateOut?: (direction: 'up' | 'down') => void;
}

function GardenView(props: DoorViewProps) {
  const entries = () => props.data?.entries || [];
  const title = () => props.data?.title || 'FLOAT.DISPATCH';

  const entryMap = createMemo(() => {
    const m = new Map<string, Entry>();
    for (const e of entries()) m.set(e.id, e);
    return m;
  });

  const [currentId, setCurrentId] = createSignal(entries()[0]?.id || '');
  const [history, setHistory] = createSignal<string[]>([]);
  const [tagFilter, setTagFilter] = createSignal<string | null>(null);

  const backLabel = createMemo(() => {
    const h = history();
    if (h.length === 0) return null;
    const prev = entryMap().get(h[h.length - 1]);
    return prev ? prev.title.substring(0, 50) : null;
  });

  const spec = createMemo(() => {
    // Direct spec mode — bypass entry system (used by showcase)
    const direct = (props.data as any)?._directSpec;
    if (direct) return direct;

    return buildFullSpec(
      entries(),
      currentId(),
      entryMap(),
      backLabel(),
      tagFilter(),
      title(),
      props.data?.subtitle,
      props.data?.footer,
    );
  });

  let viewRef: HTMLDivElement | undefined;

  onMount(() => {
    injectBodyStyles();
    // Listen for wikilink navigation from EntryBody
    viewRef?.addEventListener('garden-navigate', ((e: CustomEvent) => {
      const target = e.detail?.target as string;
      if (target && props.onNavigate) {
        props.onNavigate(target, { type: 'page' });
      }
    }) as EventListener);
  });

  // Action handlers — wired into the spec via on: { press: { action: ... } }
  const actionHandlers = {
    selectEntry: async (params: Record<string, unknown>) => {
      const id = params.id as string;
      if (!id || !entryMap().has(id)) return;
      batch(() => {
        setHistory((h) => {
          const next = [...h, currentId()];
          return next.length > 30 ? next.slice(-30) : next;
        });
        setCurrentId(id);
        setTagFilter(null);
      });
    },
    filterTag: async (params: Record<string, unknown>) => {
      const tag = params.tag as string;
      setTagFilter((prev) => (prev === tag ? null : tag));
    },
    goBack: async () => {
      batch(() => {
        const h = history();
        if (h.length === 0) {
          setTagFilter(null);
          return;
        }
        const next = [...h];
        const prev = next.pop()!;
        setHistory(next);
        setCurrentId(prev);
        setTagFilter(null);
      });
    },
    navigate: async (params: Record<string, unknown>) => {
      const target = params.target as string;
      if (target && props.onNavigate) {
        props.onNavigate(target, { type: 'page' });
      }
    },
    scrollTo: async (params: Record<string, unknown>) => {
      const id = params.id as string;
      if (!id) return;
      const el = viewRef?.querySelector(`[data-section-id="${id}"]`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });

      // Update active nav item visually
      if (viewRef) {
        viewRef.querySelectorAll('[data-nav-id]').forEach(nav => {
          const isActive = nav.getAttribute('data-nav-id') === id;
          (nav as HTMLElement).style.color = isActive ? '#fff' : '#888';
          (nav as HTMLElement).style.background = isActive ? '#161616' : 'transparent';
          (nav as HTMLElement).style.borderLeftColor = isActive ? '#e040a0' : 'transparent';
          const dot = nav.querySelector('span') as HTMLElement | null;
          if (dot) {
            dot.style.background = isActive ? '#e040a0' : 'transparent';
            dot.style.boxShadow = isActive ? '0 0 6px #e040a0' : 'none';
          }
        });
      }
    },
  };

  return (
    <div ref={viewRef}>
    <Show
      when={spec()}
      fallback={
        <div style={{
          padding: '16px',
          color: '#888',
          'font-family': "'JetBrains Mono', monospace",
          'font-size': '12px',
        }}>
          No entries loaded
        </div>
      }
    >
      <StateProvider initialState={{}}>
        <ActionProvider handlers={actionHandlers}>
          <VisibilityProvider>
            <ValidationProvider>
              <Renderer spec={spec()!} registry={registry} />
            </ValidationProvider>
          </VisibilityProvider>
        </ActionProvider>
      </StateProvider>
    </Show>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// DOOR EXPORT
// ═══════════════════════════════════════════════════════════════

export const door = {
  kind: 'view' as const,
  prefixes: ['garden::'],

  async execute(blockId: string, content: string, ctx: any) {
    const arg = content.replace(/^garden::\s*/i, '').trim();

    if (arg === 'demo' || arg === '') {
      // Dynamically import demo data to keep the main bundle lean
      const { DEMO_ENTRIES } = await import('./demo-data');
      return {
        data: {
          entries: DEMO_ENTRIES,
          title: 'FLOAT.DISPATCH',
          subtitle: '2026-03-22 \u00b7 Sunday Session',
          footer: 'ctx::2026-03-22<br>05:16 AM &rarr; 10:33 PM EDT<br>10 entries &middot; 4 threads<br>project::float/dispatch',
        },
      };
    }

    // garden:: block <id> — render a block tree as a garden view
    if (arg.startsWith('block ')) {
      const blockId = arg.slice(6).trim().replace(/^\[\[|\]\]$/g, '');
      if (!blockId) return { data: { entries: [] }, error: 'Usage: garden:: block <blockId>' };

      try {
        const resp = await ctx.server.fetch(`/api/v1/blocks/${blockId}?include=tree,ancestors`);
        if (!resp.ok) return { data: { entries: [] }, error: `Block fetch failed: ${resp.status}` };
        const block = await resp.json();

        // Parse block tree into entries — each top-level child with heading-like content becomes an entry
        const entries: Entry[] = [];
        const tree = block.tree || [];
        let currentEntry: { id: string; title: string; lines: string[] } | null = null;

        for (const child of tree) {
          const content = (child.content || '').trim();
          // Section markers: ─── TITLE ─── or ▒▒ TITLE
          const sectionMatch = content.match(/^[─━]+\s+(.+?)\s+[─━]+$/) || content.match(/^▒▒\s+(.+)/);
          if (sectionMatch) {
            if (currentEntry) {
              entries.push({
                id: currentEntry.id,
                type: entries.length === 0 ? 'synthesis' : 'bbs-source',
                title: currentEntry.title,
                tags: [],
                content: currentEntry.lines.join('\n\n'),
                date: new Date().toISOString().split('T')[0],
                author: 'daddy',
                refs: [],
              });
            }
            currentEntry = { id: child.id?.substring(0, 8) || `sec-${entries.length}`, title: sectionMatch[1], lines: [] };
            continue;
          }

          if (!currentEntry) {
            // Content before first section marker — create intro entry
            if (content && content !== block.content) {
              currentEntry = { id: 'intro', title: block.content?.replace(/^#\s*/, '').substring(0, 60) || 'Overview', lines: [] };
            }
          }
          if (currentEntry && content) {
            currentEntry.lines.push(content);
          }
        }
        // Flush last entry
        if (currentEntry) {
          entries.push({
            id: currentEntry.id,
            type: entries.length === 0 ? 'synthesis' : 'bbs-source',
            title: currentEntry.title,
            tags: [],
            content: currentEntry.lines.join('\n\n'),
            date: new Date().toISOString().split('T')[0],
            author: 'daddy',
            refs: [],
          });
        }

        // Cross-ref all entries
        const ids = entries.map(e => e.id);
        for (const entry of entries) {
          entry.refs = ids.filter(id => id !== entry.id);
        }

        const pageTitle = block.content?.replace(/^#\s*/, '') || blockId;
        return {
          data: {
            entries,
            title: 'BLOCK VIEW',
            subtitle: pageTitle,
            footer: `${entries.length} sections<br>block::${blockId.substring(0, 8)}`,
          },
        };
      } catch (e: any) {
        return { data: { entries: [] }, error: `Block fetch failed: ${e.message}` };
      }
    }

    // garden:: showcase — demonstrate all catalog components (direct spec, bypasses entry system)
    if (arg === 'showcase') {
      const { buildShowcaseSpec } = await import('./showcase-spec');
      return {
        data: {
          _directSpec: buildShowcaseSpec(),
          entries: [],
          title: 'COMPONENT CATALOG',
        },
      };
    }

    // garden:: rangle [week] — render rangle weekly view
    if (arg.startsWith('rangle')) {
      const weekArg = arg.replace(/^rangle\s*/i, '').trim().toUpperCase();
      try {
        const { rangleWeekToEntries, parseRangleWeekFiles } = await import('./rangle-weekly');

        // Parse week arg: "2025-W52", "W12", or empty (current week)
        let year = new Date().getFullYear();
        let week: string;
        if (!weekArg) {
          const now = new Date();
          const jan1 = new Date(now.getFullYear(), 0, 1);
          const days = Math.floor((now.getTime() - jan1.getTime()) / 86400000);
          week = `W${String(Math.ceil((days + jan1.getDay() + 1) / 7)).padStart(2, '0')}`;
        } else if (/^\d{4}-W\d+$/i.test(weekArg)) {
          // Full year-week: 2025-W52
          const parts = weekArg.split('-');
          year = parseInt(parts[0]);
          week = parts[1];
        } else {
          // Just week: W12
          week = weekArg.startsWith('W') ? weekArg : `W${weekArg}`;
        }

        const basePath = `~/float-hub/float.dispatch/boards/rangle-weekly/${year}-${week}`;

        // Read files via Tauri shell (door runs in webview, can't read fs directly)
        const invoke = (window as any).__TAURI_INTERNALS__?.invoke
          || (window as any).__TAURI__?.core?.invoke;
        if (!invoke) {
          return { data: { entries: [] }, error: 'Tauri invoke not available' };
        }

        // Read tracker
        const trackerPath = `${basePath}/${year}-${week}-rangle-weekly.md`;
        const trackerRaw = await invoke('execute_shell_command', {
          command: `cat ${trackerPath}`,
        }) as string;

        // List and read headline files
        const lsOutput = await invoke('execute_shell_command', {
          command: `ls ${basePath}/*-headlines.md 2>/dev/null`,
        }) as string;

        const headlineFiles: { filename: string; content: string }[] = [];
        const files = lsOutput.trim().split('\n').filter(Boolean);
        for (const filePath of files) {
          const content = await invoke('execute_shell_command', {
            command: `cat "${filePath}"`,
          }) as string;
          const filename = filePath.split('/').pop() || '';
          headlineFiles.push({ filename, content });
        }

        const weekData = parseRangleWeekFiles(trackerRaw, headlineFiles);
        const entries = rangleWeekToEntries(weekData);

        return {
          data: {
            entries,
            title: 'RANGLE WEEKLY',
            subtitle: `${week} \u00b7 ${weekData.dates} \u00b7 ${weekData.status || 'active'}`,
            footer: `project::rangle/pharmacy<br>${week} \u00b7 ${entries.length - 1} headlines`,
          },
        };
      } catch (e: any) {
        ctx.log?.('rangle weekly failed:', e.message);
        return { data: { entries: [] }, error: `Rangle weekly failed: ${e.message}` };
      }
    }

    return { data: { entries: [] }, error: `Unknown garden command: ${arg}` };
  },

  view: GardenView,
};

export const meta = {
  id: 'session-garden',
  name: 'Session Garden',
  version: '0.1.0',
};

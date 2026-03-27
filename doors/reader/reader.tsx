import { createSignal, createEffect, on, For, Show, onMount } from 'solid-js';
import type { DoorViewProps } from '../door-types';

// ── Types ──

interface BlockData {
  id: string;
  content: string;
  childIds: string[];
  collapsed?: boolean;
  metadata?: Record<string, unknown>;
}

// API returns block fields flat at top level, with tree alongside
interface TreeResponse extends BlockData {
  tree: BlockData[];
}

// ── Inline parser (lightweight) ──

function parseInline(text: string): { type: string; value: string; target?: string }[] {
  const tokens: { type: string; value: string; target?: string }[] = [];
  let i = 0;
  while (i < text.length) {
    // Wikilinks [[target]] or [[target|display]]
    if (text[i] === '[' && text[i + 1] === '[') {
      const start = i + 2;
      let depth = 1;
      let j = start;
      while (j < text.length && depth > 0) {
        if (text[j] === '[' && text[j + 1] === '[') { depth++; j += 2; }
        else if (text[j] === ']' && text[j + 1] === ']') { depth--; if (depth > 0) j += 2; }
        else j++;
      }
      if (depth === 0) {
        const inner = text.slice(start, j);
        const pipe = inner.indexOf('|');
        const target = pipe >= 0 ? inner.slice(0, pipe) : inner;
        const display = pipe >= 0 ? inner.slice(pipe + 1) : inner;
        tokens.push({ type: 'wikilink', value: display, target });
        i = j + 2;
        continue;
      }
    }
    // Bold **text**
    if (text[i] === '*' && text[i + 1] === '*') {
      const end = text.indexOf('**', i + 2);
      if (end > i) {
        tokens.push({ type: 'bold', value: text.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }
    // Inline code `text`
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i) {
        tokens.push({ type: 'code', value: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    // Plain text — accumulate
    let end = i + 1;
    while (end < text.length && text[end] !== '[' && text[end] !== '*' && text[end] !== '`') end++;
    tokens.push({ type: 'text', value: text.slice(i, end) });
    i = end;
  }
  return tokens;
}

// ── Components ──

function InlineContent(props: {
  text: string;
  onNavigate: (target: string) => void;
}) {
  const tokens = () => parseInline(props.text);
  return (
    <span>
      <For each={tokens()}>
        {(tok) => {
          if (tok.type === 'wikilink') {
            return (
              <span
                tabIndex={0}
                role="link"
                style={{ color: 'var(--color-ansi-cyan, #00bcd4)', cursor: 'pointer', 'text-decoration': 'underline', 'text-decoration-style': 'dotted', 'text-underline-offset': '3px' }}
                onClick={(e) => { e.stopPropagation(); props.onNavigate(tok.target!); }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); props.onNavigate(tok.target!); } }}
              >{tok.value}</span>
            );
          }
          if (tok.type === 'bold') return <strong>{tok.value}</strong>;
          if (tok.type === 'code') {
            return <code style={{ background: 'var(--color-bg-lighter, #2a2a3a)', padding: '1px 5px', 'border-radius': '3px', 'font-size': '0.9em' }}>{tok.value}</code>;
          }
          return <>{tok.value}</>;
        }}
      </For>
    </span>
  );
}

function TableBlock(props: { content: string; onNavigate: (target: string) => void }) {
  const rows = () => {
    const lines = props.content.split('\n').filter(l => l.trim().startsWith('|'));
    return lines
      .filter(l => !/^\|[\s-:|]+\|$/.test(l.trim())) // skip separator rows
      .map(line =>
        line.split('|').slice(1, -1).map(cell => cell.trim())
      );
  };
  const isHeader = (_r: string[], i: number) => i === 0;

  return (
    <div style={{ 'overflow-x': 'auto', 'margin': '0.75em 0' }}>
      <table style={{
        'border-collapse': 'collapse', 'font-size': '0.85em', width: '100%',
        'font-family': 'var(--font-mono, monospace)',
      }}>
        <For each={rows()}>
          {(row, i) => (
            <tr style={{
              'border-bottom': '1px solid var(--color-border, #2a2a3a)',
            }}>
              <For each={row}>
                {(cell) => {
                  const Tag = isHeader(row, i()) ? 'th' : 'td';
                  return (
                    <Tag style={{
                      padding: '0.4em 0.75em',
                      'text-align': 'left',
                      color: isHeader(row, i()) ? 'var(--color-accent, #00bcd4)' : 'var(--color-fg, #ddd)',
                      'font-weight': isHeader(row, i()) ? '600' : '400',
                      'font-size': isHeader(row, i()) ? '0.85em' : '1em',
                      'text-transform': isHeader(row, i()) ? 'uppercase' : 'none',
                      'letter-spacing': isHeader(row, i()) ? '0.03em' : 'normal',
                      'white-space': 'nowrap',
                    }}>
                      <InlineContent text={cell} onNavigate={props.onNavigate} />
                    </Tag>
                  );
                }}
              </For>
            </tr>
          )}
        </For>
      </table>
    </div>
  );
}

function BlockRenderer(props: {
  block: BlockData;
  blockMap: Map<string, BlockData>;
  depth: number;
  onNavigate: (target: string) => void;
}) {
  const content = () => props.block.content || '';
  const children = () => (props.block.childIds || []).map(id => props.blockMap.get(id)).filter(Boolean) as BlockData[];

  // Detect block type from content
  const isH3 = () => content().startsWith('### ');
  const isH2 = () => !isH3() && content().startsWith('## ');
  const isHeading = () => !isH2() && !isH3() && content().startsWith('# ');
  const isList = () => content().startsWith('- ') || content().startsWith('* ');
  const isCtx = () => content().startsWith('ctx::');
  const isCodeFence = () => content().startsWith('```');
  const isHr = () => /^-{3,}$/.test(content().trim());
  const isTable = () => content().includes('|') && content().trim().startsWith('|');
  const isPrefix = () => /^\w+::/.test(content());
  const isEmpty = () => !content().trim();

  // Strip prefix markers for display
  const displayContent = () => {
    const c = content();
    if (isH3()) return c.slice(4);
    if (isH2()) return c.slice(3);
    if (isHeading()) return c.slice(2);
    if (isList()) return c.slice(2);
    return c;
  };

  return (
    <>
      <Show when={!isEmpty()}>
        <Show when={isHeading()}>
          <h2 style={{
            color: 'var(--color-fg, #e0e0e0)', 'font-size': '1.4em', 'font-weight': '700',
            'margin-top': '2em', 'margin-bottom': '0.6em',
            'border-bottom': '1px solid var(--color-border, #333)', 'padding-bottom': '0.4em',
            'letter-spacing': '-0.01em',
          }}>
            <InlineContent text={displayContent()} onNavigate={props.onNavigate} />
          </h2>
        </Show>
        <Show when={isH2()}>
          <h3 style={{
            color: 'var(--color-fg, #ccc)', 'font-size': '1.15em', 'font-weight': '600',
            'margin-top': '1.6em', 'margin-bottom': '0.5em',
          }}>
            <InlineContent text={displayContent()} onNavigate={props.onNavigate} />
          </h3>
        </Show>
        <Show when={isH3()}>
          <h4 style={{
            color: 'var(--color-fg-muted, #aaa)', 'font-weight': '600',
            'margin-top': '1.3em', 'margin-bottom': '0.4em',
            'text-transform': 'uppercase', 'font-size': '0.8em', 'letter-spacing': '0.05em',
          }}>
            <InlineContent text={displayContent()} onNavigate={props.onNavigate} />
          </h4>
        </Show>
        <Show when={isCtx()}>
          <div style={{
            color: 'var(--color-fg-muted, #666)', 'font-size': '0.75em',
            'font-family': 'var(--font-mono, monospace)',
            'margin': '0.2em 0', 'padding': '0.15em 0.5em',
            opacity: '0.6',
          }}>
            {content()}
          </div>
        </Show>
        <Show when={isCodeFence()}>
          <pre style={{
            background: 'var(--color-bg-lighter, #1a1a2e)', padding: '0.75em 1em',
            'border-radius': '4px', 'font-size': '0.85em', 'overflow-x': 'auto',
            'margin': '0.75em 0', 'white-space': 'pre-wrap',
            'border': '1px solid var(--color-border, #2a2a3a)',
          }}>
            <code>{content().replace(/^```[^\n]*\n?/, '').replace(/\n?```\s*$/, '')}</code>
          </pre>
        </Show>
        <Show when={isList()}>
          <div style={{
            color: 'var(--color-fg, #ddd)', 'line-height': '1.65',
            'padding-left': '1.2em', 'text-indent': '-0.8em',
            'margin-bottom': '0.25em',
          }}>
            <span style={{ color: 'var(--color-fg-muted, #666)', 'margin-right': '0.4em' }}>{'•'}</span>
            <InlineContent text={displayContent()} onNavigate={props.onNavigate} />
          </div>
        </Show>
        <Show when={isHr()}>
          <hr style={{
            border: 'none', 'border-top': '1px solid var(--color-border, #333)',
            'margin': '1.5em 0',
          }} />
        </Show>
        <Show when={isTable()}>
          <TableBlock content={content()} onNavigate={props.onNavigate} />
        </Show>
        <Show when={!isHeading() && !isH2() && !isH3() && !isList() && !isCtx() && !isCodeFence() && !isPrefix() && !isHr() && !isTable()}>
          <p style={{
            color: 'var(--color-fg, #ddd)', 'line-height': '1.75',
            'margin': '0.5em 0',
          }}>
            <InlineContent text={displayContent()} onNavigate={props.onNavigate} />
          </p>
        </Show>
        <Show when={isPrefix() && !isCtx()}>
          <div style={{
            color: 'var(--color-fg-muted, #777)', 'font-size': '0.8em',
            padding: '0.15em 0.5em',
            'font-family': 'var(--font-mono, monospace)',
            opacity: '0.5',
            'margin': '0.2em 0',
          }}>
            {content()}
          </div>
        </Show>
      </Show>

      <Show when={children().length > 0}>
        <div style={{ 'padding-left': props.depth > 0 ? '0.3em' : '0' }}>
          <For each={children()}>
            {(child) => (
              <BlockRenderer
                block={child}
                blockMap={props.blockMap}
                depth={props.depth + 1}
                onNavigate={props.onNavigate}
              />
            )}
          </For>
        </div>
      </Show>
    </>
  );
}

// ── Main view ──

function ReaderView(props: DoorViewProps) {
  const [blocks, setBlocks] = createSignal<BlockData[]>([]);
  const [root, setRoot] = createSignal<BlockData | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  const [pageName, setPageName] = createSignal(props.data?.query || '');

  const blockMap = () => {
    const m = new Map<string, BlockData>();
    for (const b of blocks()) m.set(b.id, b);
    return m;
  };

  async function loadPage(rawQuery: string) {
    setLoading(true);
    setError('');
    try {
      // Strip [[ ]] wikilink wrapper if pasted from double-tap-cmd
      const query = rawQuery.replace(/^\[\[|\]\]$/g, '').trim();
      let blockId: string | null = null;
      let displayName = query;

      // If query looks like a hex hash (6+ chars), try direct block fetch
      if (/^[0-9a-f]{6,}$/i.test(query)) {
        blockId = query;
      } else {
        // Search by page name — try exact "# Name" first, then fuzzy
        const searchResp = await props.server.fetch(
          `/api/v1/search?q=${encodeURIComponent('# ' + query)}&limit=5`
        );
        if (!searchResp.ok) throw new Error(`Search failed: ${searchResp.status}`);
        const searchData = await searchResp.json();

        // Find the best match — prefer exact page title "# query"
        const hits = searchData.hits || [];
        const exactPage = hits.find((h: any) =>
          (h.content || '').trim() === '# ' + query
        );
        const startsWithPage = !exactPage && hits.find((h: any) =>
          (h.content || '').startsWith('# ' + query)
        );
        const anyHeading = !exactPage && !startsWithPage && hits.find((h: any) =>
          (h.content || '').startsWith('# ') &&
          (h.content || '').toLowerCase().includes(query.toLowerCase())
        );
        const pageHit = exactPage || startsWithPage || anyHeading || hits[0];

        if (!pageHit) {
          setError(`Page not found: ${query}`);
          setLoading(false);
          return;
        }
        blockId = pageHit.blockId || pageHit.block_id || pageHit.id;
      }

      // Fetch the full subtree
      const treeResp = await props.server.fetch(
        `/api/v1/blocks/${blockId}?include=tree`
      );
      if (!treeResp.ok) {
        setError(`Block not found: ${blockId}`);
        setLoading(false);
        return;
      }
      const treeData = await treeResp.json();

      // API returns block fields flat (id, content, childIds, tree)
      const rootBlock: BlockData = {
        id: treeData.id,
        content: treeData.content,
        childIds: treeData.childIds,
        collapsed: treeData.collapsed,
        metadata: treeData.metadata,
      };

      if (!rootBlock.id) {
        setError(`Invalid response for block: ${blockId}`);
        setLoading(false);
        return;
      }

      // Derive display name — check root, then scan children for first heading
      const rootContent = rootBlock.content || '';
      if (rootContent.startsWith('# ')) {
        displayName = rootContent.slice(2).trim();
      } else {
        // Root isn't a heading — look for first child with # prefix
        const tree = treeData.tree || [];
        const firstHeading = tree.find((b: BlockData) => b.content?.startsWith('# '));
        if (firstHeading) {
          displayName = firstHeading.content.slice(2).trim();
        } else if (rootContent.length > 0) {
          // Use first line of content, stripped of prefix
          displayName = rootContent.split('\n')[0].replace(/^\w+::\s*/, '').slice(0, 60);
        }
      }

      setRoot(rootBlock);
      setBlocks(treeData.tree || []);
      setPageName(displayName);
    } catch (err) {
      setError(String(err));
    }
    setLoading(false);
  }

  onMount(() => {
    const q = props.data?.query;
    if (q) {
      loadPage(q);
    } else {
      // Sidebar mode — no query, show idle state
      setLoading(false);
    }
  });

  function handleNavigate(target: string) {
    // Navigate to a page — reload reader with new target
    loadPage(target);
    // Also tell the parent for pane-link cascading
    props.onNavigate?.(target, { type: 'page' });
  }

  return (
    <div style={{
      'font-family': '"Inter", "SF Pro Text", -apple-system, sans-serif',
      color: 'var(--color-fg, #e0e0e0)',
      padding: '1rem 1.25rem',
      'max-width': '65ch',
      'line-height': '1.7',
      overflow: 'auto',
      'min-height': '0',
    }}>
      <Show when={loading()}>
        <div style={{ color: 'var(--color-fg-muted, #888)', 'font-style': 'italic' }}>loading...</div>
      </Show>

      <Show when={error()}>
        <div style={{ color: 'var(--color-ansi-red, #ff6b6b)' }}>{error()}</div>
      </Show>

      <Show when={!loading() && !root() && !error()}>
        <div style={{ color: 'var(--color-fg-muted, #666)', 'font-size': '0.9em', padding: '1em 0' }}>
          Type <code style={{ background: 'var(--color-bg-lighter, #2a2a3a)', padding: '1px 5px', 'border-radius': '3px' }}>read:: Page Name</code> in a block to render a page here.
        </div>
      </Show>

      <Show when={!loading() && root()}>
        <h1 style={{
          'font-size': '1.6em', 'font-weight': '700',
          color: 'var(--color-accent, #00bcd4)',
          'margin-bottom': '1em', 'padding-bottom': '0.5em',
          'border-bottom': '1px solid var(--color-border, #333)',
          'letter-spacing': '-0.02em',
        }}>
          {pageName()}
        </h1>

        <For each={(root()!.childIds || []).map(id => blockMap().get(id)).filter(Boolean) as BlockData[]}>
          {(child) => (
            <BlockRenderer
              block={child}
              blockMap={blockMap()}
              depth={0}
              onNavigate={handleNavigate}
            />
          )}
        </For>

        <div style={{
          color: 'var(--color-fg-muted, #666)', 'font-size': '0.75em',
          'margin-top': '2em', 'padding-top': '0.5em',
          'border-top': '1px solid var(--color-border, #333)',
          'font-family': 'var(--font-mono, monospace)',
        }}>
          read:: {pageName()} — {blocks().length} blocks
        </div>
      </Show>
    </div>
  );
}

// ── Door contract ──

export const door = {
  kind: 'view' as const,
  prefixes: ['read::'],
  async execute(blockId: string, content: string, ctx: any) {
    const query = content.replace(/^read::\s*/i, '').trim().replace(/^\[\[|\]\]$/g, '');
    return { data: { query } };
  },
  view: ReaderView,
};

export const meta = {
  id: 'reader',
  name: 'Reader',
  version: '0.1.0',
  sidebarEligible: true,
};

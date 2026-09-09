/**
 * Removable reader experiment. Delete (1) this component, (2) the reader
 * branch in QueryBlockDisplay + reader option parsing, (3) the query-reader-*
 * CSS block. InlineContent's pretty prop may stay: false is inert.
 */
import { createEffect, createMemo, createSignal, on, Show } from 'solid-js';
import { Key } from '@solid-primitives/keyed';
import { InlineContent } from '../BlockDisplay';
import type { RefListRows } from '../BlockRefList';
import { buildRowModel, crumbEntries, midTruncate, type RowDeps } from '../../lib/backlinkRows';
import { parseAllInlineTokens } from '../../lib/inlineParser';
import { DEFAULT_READER_FLAGS, type ReaderFlags } from '../../lib/queryPredicate';

interface QueryReaderViewProps {
  ids: string[];
  flags: ReaderFlags;
  chrome: boolean;
  onFlagsChange: (flags: ReaderFlags) => void;
  getBlock: RowDeps['getBlock'];
  pagesContainerId: string | null;
  paneId: string;
  highlightedRowId?: string;
  onVisibleRows: (rows: RefListRows) => void;
  onNavigate: (id: string) => void;
  onNavigateWikilink?: (target: string, event: MouseEvent) => void;
  onDragHandlePointerDown?: (event: PointerEvent, blockId: string, paneId: string) => void;
  pageNameSet?: Set<string>;
  stubPageNameSet?: ReadonlySet<string>;
}

export function QueryReaderView(props: QueryReaderViewProps) {
  const [folded, setFolded] = createSignal<ReadonlySet<string>>(new Set());
  const toggleExpanded = (id: string) => setFolded((previous) => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const childrenVisible = (id: string) => props.flags.children !== folded().has(id);
  // Direct child projection only: no recursive traversal or derived persistence.
  const articles = createMemo(() => props.ids.map((id) => ({
    id,
    children: childrenVisible(id) ? (props.getBlock(id)?.childIds ?? []) : [],
  })));
  const visibleIds = createMemo(() => articles().flatMap((article) => [article.id, ...article.children]));
  createEffect(on(visibleIds, (ids) => props.onVisibleRows({ ids, toggleExpanded: (id) => {
    // Children are depth-one summaries; only result articles expand.
    if (props.ids.includes(id)) toggleExpanded(id);
  } })));

  // Reuse the canonical token style scope; CSS makes this an ordinary inline
  // span, not an absolute, pointer-transparent editing overlay.
  const inline = (content: string) => <span class="query-reader-inline block-display"><InlineContent content={content}
    pretty={{ marks: props.flags.marks, headings: props.flags.headings }}
    onWikilinkClick={props.onNavigateWikilink}
    pageNameSet={props.pageNameSet} stubPageNameSet={props.stubPageNameSet} /></span>;

  // Local to this removable component, with live getters from <Key> at both levels.
  function ReaderRow(rowProps: { id: string; child?: boolean }) {
    let rowRef: HTMLDivElement | undefined;
    const block = () => props.getBlock(rowProps.id);
    const model = createMemo(() => buildRowModel(rowProps.id, {
      getBlock: props.getBlock, pagesContainerId: props.pagesContainerId,
    }));
    const content = () => rowProps.child
      ? (block()?.content.split('\n')[0] ?? rowProps.id.slice(0, 8))
      : (block()?.content ?? rowProps.id.slice(0, 8));
    const heading = createMemo(() => {
      const token = parseAllInlineTokens(content())[0];
      return token?.type === 'heading-marker' ? Math.min(token.raw.trim().length + 1, 4) : undefined;
    });
    createEffect(() => {
      if (props.highlightedRowId === rowProps.id) rowRef?.scrollIntoView({ block: 'nearest' });
    });
    return <div ref={rowRef} class="query-reader-row"
      classList={{ 'blockref-row-focused': props.highlightedRowId === rowProps.id }}
      data-source-block-id={rowProps.id}
      onClick={(event) => {
        const origin = event.target as HTMLElement | null;
        if (origin?.closest('button, input, select, .md-wikilink, .blockref-drag-handle')) return;
        event.preventDefault();
        props.onNavigate(rowProps.id);
      }}>
      <Show when={props.flags.meta}>
        <span class="blockref-drag-handle" title="Drag to another board"
          onPointerDown={(event) => {
            event.preventDefault(); event.stopPropagation();
            props.onDragHandlePointerDown?.(event, rowProps.id, props.paneId);
          }}>⋮⋮</span>
        <span class={`blockref-kind blockref-kind-${model()?.kind ?? 'content_block'}`}>
          {model()?.kind === 'nav_node' ? '◆' : model()?.kind === 'leaf_marker' ? '·' : '•'}
        </span>
      </Show>
      <Show when={props.flags.bullets}><span class="query-reader-bullet">•</span></Show>
      <div class="query-reader-main">
        <Show when={props.flags.crumbs && (model()?.chain.length ?? 0) > 0}>
          <div class="blockref-crumb">
            <Key each={crumbEntries(model()?.chain ?? [])} by={(entry) => entry.gap ? 'gap' : entry.segment.id}>
              {(entry, index) => <>
                <Show when={index() > 0}><span class="blockref-crumb-sep">›</span></Show>
                <Show when={!entry().gap} fallback={<span class="blockref-crumb-sep" title="levels elided">⋯</span>}>
                  <button class="blockref-crumb-seg" title={(() => { const e = entry(); return e.gap ? '' : `Go to ${e.segment.label}`; })()}
                    onClick={() => { const e = entry(); if (!e.gap) props.onNavigate(e.segment.id); }}>
                    {(() => { const e = entry(); return e.gap ? '' : midTruncate(e.segment.label, 28); })()}
                  </button>
                </Show>
              </>}
            </Key>
          </div>
        </Show>
        <div class="query-reader-content" data-heading={heading()} role={heading() ? 'heading' : undefined} aria-level={heading()}>
          {inline(content())}
        </div>
        <Show when={rowProps.child && (block()?.childIds.length ?? 0) > 0}>
          <span class="query-reader-more">+{block()?.childIds.length} more</span>
        </Show>
        <Show when={props.flags.peek && model()?.childPreview != null}>
          <div class="blockref-child-preview">└ {inline(model()?.childPreview ?? '')}
            <Show when={(model()?.childCount ?? 0) > 1}><span class="blockref-child-more"> +{(model()?.childCount ?? 0) - 1}</span></Show>
          </div>
        </Show>
      </div>
      <Show when={props.flags.meta}>
        <span class="blockref-age" title={[
          model()?.updatedAt ? `updated ${new Date(model()!.updatedAt).toLocaleString()}` : null,
          model()?.createdAt ? `created ${new Date(model()!.createdAt).toLocaleString()}` : null,
        ].filter(Boolean).join(' · ') || undefined}>{model()?.age}</span>
        <button class="blockref-nav" aria-label="Navigate to source block" title="Go to source (⌘/Ctrl-click the row)"
          onClick={() => props.onNavigate(rowProps.id)}>→</button>
      </Show>
    </div>;
  }

  return <div class="query-reader-view">
    <Show when={props.chrome}>
      <div class="query-reader-controls" aria-label="Reader options">
        <Key each={Object.keys(DEFAULT_READER_FLAGS) as (keyof ReaderFlags)[]} by={(name) => name}>
          {(name) => <button class="query-header-toggle" aria-pressed={props.flags[name()]}
            onClick={() => props.onFlagsChange({ ...props.flags, [name()]: !props.flags[name()] })}>
            {props.flags[name()] ? '✓ ' : ''}{name()}
          </button>}
        </Key>
      </div>
    </Show>
    <Show when={props.ids.length === 0}><div class="blockref-row-none">no matches</div></Show>
    <Key each={articles()} by={(article) => article.id}>
      {(article) => <article class="query-reader-article">
        <ReaderRow id={article().id} />
        <div class="query-reader-children">
          <Key each={article().children} by={(id) => id}>
            {(id) => <ReaderRow id={id()} child />}
          </Key>
        </div>
      </article>}
    </Key>
  </div>;
}

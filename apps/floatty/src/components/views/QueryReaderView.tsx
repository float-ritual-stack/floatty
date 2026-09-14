/**
 * Removable reader experiment. Delete (1) this component, (2) the reader
 * branch in QueryBlockDisplay + reader option parsing, (3) the query-reader-*
 * CSS block. InlineContent's pretty prop may stay: false is inert.
 */
import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from 'solid-js';
import { Dynamic } from 'solid-js/web';
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
  onMoveRow?: (blockId: string) => void;
  pageNameSet?: Set<string>;
  stubPageNameSet?: ReadonlySet<string>;
}

/**
 * Line-level structure for the reader: what this block's text would be as
 * HTML. Pure and exported for tests. Consecutive `- `/`* ` lines form a <ul>
 * (indent = nesting), `1. ` an <ol>, ``` fences a <pre>, `> ` a <blockquote>,
 * `#`/`##`/`###` a heading, blank lines split paragraphs; everything else is
 * a paragraph whose lines keep their breaks (floatty lines are meaningful).
 */
export type ReaderSegment =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'para'; lines: string[] }
  | { kind: 'list'; ordered: boolean; items: Array<{ depth: number; text: string }> }
  | { kind: 'fence'; lang: string; lines: string[] }
  | { kind: 'quote'; lines: string[] };

/** `- `/`* ` or `1. `/`1) ` at the start of a line: the list marker and what follows it. */
export function readListMarker(line: string): { ordered: boolean; number: number | null; indent: string; text: string } | null {
  const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
  if (bullet) return { ordered: false, number: null, indent: bullet[1], text: bullet[2] };
  const number = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
  if (number) return { ordered: true, number: Number(number[2]), indent: number[1], text: number[3] };
  return null;
}

export type ChildGroup =
  | { key: string; list: false; ids: string[] }
  | { key: string; list: true; ordered: boolean; start: number; ids: string[] };

/**
 * An outline list is usually one block per item, not lines inside one block:
 * `1.` / `2.` / `3.` as siblings. Consecutive children whose first line carries
 * the same kind of list marker form one <ol>/<ul>; everything else stays a
 * run of plain child rows. Pure and exported for tests.
 */
export function groupChildRows(ids: readonly string[], firstLine: (id: string) => string): ChildGroup[] {
  const groups: ChildGroup[] = [];
  for (const id of ids) {
    const marker = readListMarker(firstLine(id));
    const prev = groups[groups.length - 1];
    if (marker) {
      if (prev?.list && prev.ordered === marker.ordered) { prev.ids.push(id); continue; }
      groups.push({ key: `${id}:list`, list: true, ordered: marker.ordered, start: marker.number ?? 1, ids: [id] });
    } else if (prev && !prev.list) {
      prev.ids.push(id);
    } else {
      groups.push({ key: `${id}:rows`, list: false, ids: [id] });
    }
  }
  return groups;
}

export function parseReaderBlocks(content: string): ReaderSegment[] {
  const out: ReaderSegment[] = [];
  const lines = content.split('\n');
  let i = 0;
  const last = () => out[out.length - 1];
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*```(\S*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence (or EOF)
      out.push({ kind: 'fence', lang: fence[1] ?? '', lines: body });
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) { out.push({ kind: 'heading', level: heading[1].length + 1, text: line }); i++; continue; }
    const marker = readListMarker(line);
    if (marker) {
      const item = { depth: Math.floor(marker.indent.replace(/\t/g, '  ').length / 2), text: marker.text };
      const prev = last();
      if (prev?.kind === 'list' && prev.ordered === marker.ordered) prev.items.push(item);
      else out.push({ kind: 'list', ordered: marker.ordered, items: [item] });
      i++; continue;
    }
    if (/^>\s?/.test(line)) {
      const text = line.replace(/^>\s?/, '');
      const prev = last();
      if (prev?.kind === 'quote') prev.lines.push(text); else out.push({ kind: 'quote', lines: [text] });
      i++; continue;
    }
    if (/^\s*$/.test(line)) { i++; continue; } // paragraph break
    const prev = last();
    if (prev?.kind === 'para' && !/^\s*$/.test(lines[i - 1] ?? '')) prev.lines.push(line);
    else out.push({ kind: 'para', lines: [line] });
    i++;
  }
  return out;
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
  const firstLine = (id: string) => props.getBlock(id)?.content.split('\n')[0] ?? '';
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
  function ReaderRow(rowProps: { id: string; child?: boolean; listItem?: boolean }) {
    let rowRef: HTMLDivElement | undefined;
    const block = () => props.getBlock(rowProps.id);
    const model = createMemo(() => buildRowModel(rowProps.id, {
      getBlock: props.getBlock, pagesContainerId: props.pagesContainerId,
    }));
    const content = () => {
      if (!rowProps.child) return block()?.content ?? rowProps.id.slice(0, 8);
      const line = block()?.content.split('\n')[0] ?? rowProps.id.slice(0, 8);
      // Inside a grouped <ol>/<ul> the list supplies the marker.
      return rowProps.listItem ? (readListMarker(line)?.text ?? line) : line;
    };
    // Child rows show their first line; count the non-blank lines they hide.
    const hiddenLines = () => rowProps.child
      ? (block()?.content.split('\n').slice(1).filter((line) => line.trim()).length ?? 0) : 0;
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
      // Same contract as the backlinks drawer (FLO-953, D3): ⌘/Ctrl-click
      // anywhere on the article navigates; a plain click focuses the pane or
      // selects text and does nothing else. Reader mode is for reading —
      // plain-click navigation made copying a paragraph a page jump (Evan,
      // first evening on the daily board). Inline wikilinks keep their own
      // clicks; real controls never reach this branch.
      onClick={(event) => {
        if (!(event.metaKey || event.ctrlKey)) return;
        const origin = event.target as HTMLElement | null;
        if (origin?.closest('button, input, select, .md-wikilink, .blockref-drag-handle')) return;
        event.preventDefault();
        props.onNavigate(rowProps.id);
      }}>
      <Show when={props.flags.meta}>
        <button type="button" class="blockref-drag-handle" title="Drag to another board"
          aria-label="Move row to another board"
          onClick={(event) => {
            event.stopPropagation();
            if (event.detail === 0) props.onMoveRow?.(rowProps.id);
          }}
          onPointerDown={(event) => {
            event.preventDefault(); event.stopPropagation();
            props.onDragHandlePointerDown?.(event, rowProps.id, props.paneId);
          }}>⋮⋮</button>
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
          <Show when={!rowProps.child} fallback={inline(content())}>
            {/* Article body: what this block would be as HTML. Segments are
                rebuilt per content change — keyed by index+kind so a
                paragraph that grows keeps its node. */}
            <Key each={parseReaderBlocks(content())} by={(segment, index) => `${index}:${segment.kind}`}>
              {(segment) => {
                const seg = segment();
                if (seg.kind === 'heading') return <div class="query-reader-h" data-heading={seg.level} role="heading" aria-level={seg.level}>{inline(seg.text)}</div>;
                if (seg.kind === 'fence') return <pre class="query-reader-pre" data-lang={seg.lang}>{seg.lines.join('\n')}</pre>;
                if (seg.kind === 'quote') return <blockquote class="query-reader-quote">{seg.lines.map((l) => <div>{inline(l)}</div>)}</blockquote>;
                if (seg.kind === 'list') {
                  const items = seg.items.map((item) => <li class="query-reader-li" style={{ 'margin-left': `${item.depth * 1.2}em` }}>{inline(item.text)}</li>);
                  return seg.ordered ? <ol class="query-reader-ol">{items}</ol> : <ul class="query-reader-ul">{items}</ul>;
                }
                return <p class="query-reader-p">{seg.lines.map((l, k) => <>{k > 0 ? <br /> : null}{inline(l)}</>)}</p>;
              }}
            </Key>
          </Show>
        </div>
        <Show when={hiddenLines() > 0}>
          <span class="query-reader-more" title={`${hiddenLines()} more line${hiddenLines() === 1 ? '' : 's'} in this block`}> …</span>
        </Show>
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

  // Hover feedback while a modifier is held (`:hover` cannot see keys): the
  // view carries .query-reader-modnav, mirroring .blockref-modnav. Cleared on
  // window blur because keyup never arrives after ⌘-Tab.
  const [modHeld, setModHeld] = createSignal(false);
  onMount(() => {
    const onKey = (event: KeyboardEvent) => setModHeld(event.metaKey || event.ctrlKey);
    const clear = () => setModHeld(false);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    window.addEventListener('blur', clear);
    onCleanup(() => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
      window.removeEventListener('blur', clear);
    });
  });

  return <div class="query-reader-view" classList={{ 'query-reader-modnav': modHeld() }}
    onPointerMove={(event) => setModHeld(event.metaKey || event.ctrlKey)}>
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
      {(article) => <article class="query-reader-article" classList={{ 'query-reader-article-folded': !childrenVisible(article().id) }}>
        {/* Header-level fold: same toggle Space/⌘. drives; only shown when there is something to fold. */}
        <Show when={(props.getBlock(article().id)?.childIds.length ?? 0) > 0}>
          <button
            class="query-reader-fold"
            aria-label={childrenVisible(article().id) ? 'Fold children' : 'Unfold children'}
            aria-expanded={childrenVisible(article().id)}
            onClick={() => toggleExpanded(article().id)}
          >{childrenVisible(article().id) ? '▾' : '▸'}</button>
        </Show>
        <ReaderRow id={article().id} />
        <div class="query-reader-children">
          <Key each={groupChildRows(article().children, firstLine)} by={(group) => group.key}>
            {(group) => <Show when={group().list} fallback={
              <Key each={group().ids} by={(id) => id}>{(id) => <ReaderRow id={id()} child />}</Key>
            }>
              <Dynamic component={(group() as Extract<ChildGroup, { list: true }>).ordered ? 'ol' : 'ul'}
                class={(group() as Extract<ChildGroup, { list: true }>).ordered ? 'query-reader-ol query-reader-block-list' : 'query-reader-ul query-reader-block-list'}
                start={(group() as Extract<ChildGroup, { list: true }>).start}>
                <Key each={group().ids} by={(id) => id}>
                  {(id) => <li class="query-reader-li"><ReaderRow id={id()} child listItem /></li>}
                </Key>
              </Dynamic>
            </Show>}
          </Key>
        </div>
      </article>}
    </Key>
  </div>;
}

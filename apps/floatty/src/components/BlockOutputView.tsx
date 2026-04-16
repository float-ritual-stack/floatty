/**
 * BlockOutputView — renders all output block types (search, door, eval, img, filter).
 *
 * Extracted from BlockItem.tsx (Unit 1.5, FLO-539).
 * Owns: outputFocusRef, handleOutputBlockKeyDown, search focus state,
 * output block focus routing effect, and all output JSX.
 *
 * Display-only for embedded views (search results, img) — single focus point
 * pattern per output-block-patterns.md.
 */
import { Show, createSignal, createEffect, createMemo, on, onCleanup, ErrorBoundary } from 'solid-js';
import { useWorkspace } from '../context/WorkspaceContext';
import { useBlockOperations } from '../hooks/useBlockOperations';
import { navigateToBlock, handleChirpNavigate, resolveSameTabLink } from '../lib/navigation';
import { handleChirpWrite, isChirpWriteVerb, type ChirpWriteData } from '../lib/chirpWriteHandler';
import { isMac } from '../lib/keybinds';
import { SearchResultsView, SearchErrorView } from './views/SearchResultsView';
import { DoorHost, DoorExecCard } from './views/DoorHost';
import { ImgView } from './views/ImgView';
import { EvalOutput } from './EvalOutput';
import type { SearchResults, DoorEnvelope } from '../lib/handlers';
import type { EvalResult } from '../lib/evalEngine';

// ─── Error fallback ─────────────────────────────────────────────────────

function doorErrorFallback(onClear: () => void) {
  return (err: unknown) => (
    <div style={{ padding: '8px', color: 'var(--color-error)', 'font-size': '12px', 'font-family': 'JetBrains Mono, monospace', background: 'var(--color-bg-secondary)', 'border-radius': '4px', 'border': '1px solid var(--color-error)', display: 'flex', 'align-items': 'center', gap: '8px' }}>
      <span style={{ flex: 1 }}>
        <span style={{ 'font-weight': 'bold' }}>Door error: </span>
        {(err as Error)?.message || String(err)}
      </span>
      <button
        onClick={onClear}
        style={{ background: 'var(--color-bg-hover)', color: 'var(--color-fg)', border: '1px solid var(--color-border)', 'border-radius': '3px', padding: '2px 8px', cursor: 'pointer', 'font-size': '11px', 'font-family': 'inherit', 'white-space': 'nowrap' }}
      >
        Clear
      </button>
    </div>
  );
}

// Chirp throttle timestamps — module-level map replaces window[key] to prevent leak
const chirpThrottleMap = new Map<string, number>();
if (import.meta.hot) {
  import.meta.hot.dispose(() => chirpThrottleMap.clear());
}

// ─── Types ──────────────────────────────────────────────────────────────

interface BlockOutputViewProps {
  blockId: string;
  paneId: string;
  isFocused: () => boolean;
  isCollapsed: () => boolean;
  isOutputBlock: () => boolean;
  onFocus: (id: string) => void;
  cancelContentUpdate: () => void;
  isBlockSelected?: (id: string) => boolean;
  /** Signal setter for inline door ref — useDoorChirpListener wired in BlockItem */
  setInlineDoorRef: (el: HTMLElement | undefined) => void;
}

// ─── Component ──────────────────────────────────────────────────────────

export function BlockOutputView(props: BlockOutputViewProps) {
  const { blockStore, paneStore } = useWorkspace();
  const store = blockStore;
  const { findNextVisibleBlock, findPrevVisibleBlock, findFocusAfterDelete } = useBlockOperations();

  const block = createMemo(() => store.blocks[props.blockId]);
  let outputFocusRef: HTMLDivElement | undefined;

  // Clean up throttle entry on unmount
  onCleanup(() => chirpThrottleMap.delete(props.blockId));

  // Shared navigation handler for DoorHost instances
  const handleDoorNavigate = (target: string, opts?: { type?: 'block' | 'page' | 'wikilink'; splitDirection?: 'horizontal' | 'vertical' }) => {
    handleChirpNavigate(target, {
      type: opts?.type,
      sourcePaneId: props.paneId,
      sourceBlockId: props.blockId,
      splitDirection: opts?.splitDirection,
      originBlockId: props.blockId,
    });
  };

  // ─── Search results keyboard navigation state ─────────────────────
  const [searchFocusedIdx, setSearchFocusedIdx] = createSignal(-1);

  // Reset search focus when output type/status changes
  createEffect(() => {
    const ot = block()?.outputType;
    const st = block()?.outputStatus;
    if (ot !== 'search-results' || st !== 'complete') {
      setSearchFocusedIdx(-1);
    }
  });

  // Reset search focus on focus GAIN (back-nav via Cmd+[)
  createEffect(on(props.isFocused, (focused, wasFocused) => {
    if (focused && !wasFocused && props.isOutputBlock()) {
      setSearchFocusedIdx(-1);
    }
  }));

  // ─── Focus routing for output blocks ──────────────────────────────
  createEffect(() => {
    if (props.isFocused() && props.isOutputBlock() && outputFocusRef) {
      requestAnimationFrame(() => {
        outputFocusRef?.focus({ preventScroll: true });
        outputFocusRef?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      });
    }
  });

  // ─── Keyboard handler for output blocks ───────────────────────────
  const handleOutputBlockKeyDown = (e: KeyboardEvent) => {
    props.cancelContentUpdate();
    const idx = searchFocusedIdx();
    const modKey = isMac ? e.metaKey : e.ctrlKey;

    const refocusAfterMove = () => {
      requestAnimationFrame(() => outputFocusRef?.focus({ preventScroll: true }));
    };

    // Cmd+. toggle collapse
    if (modKey && e.key === '.') {
      e.preventDefault();
      const b = block();
      if (b && (b.childIds?.length > 0 || b.outputType)) {
        paneStore.toggleCollapsed(props.paneId, props.blockId, b.collapsed || false);
      }
      return;
    }

    if (modKey && e.key === 'ArrowUp') {
      e.preventDefault();
      store.moveBlockUp(props.blockId);
      refocusAfterMove();
      return;
    } else if (modKey && e.key === 'ArrowDown') {
      e.preventDefault();
      store.moveBlockDown(props.blockId);
      refocusAfterMove();
      return;
    } else if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey) {
        store.outdentBlock(props.blockId);
      } else {
        store.indentBlock(props.blockId);
      }
      refocusAfterMove();
      return;
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      const hasChildren = !!block()?.childIds?.length;
      const isSelected = props.isBlockSelected?.(props.blockId) ?? false;
      if (hasChildren && !isSelected) return;
      const target = findFocusAfterDelete(props.blockId, props.paneId);
      store.deleteBlock(props.blockId);
      if (target) props.onFocus(target);
      return;
    } else if (e.key === 'Escape' && (block()?.outputType === 'img-view' || block()?.outputType === 'door')) {
      e.preventDefault();
      store.setBlockOutput(props.blockId, null, '');
      return;
    }

    // Search results navigation (idx >= 0)
    if (idx >= 0) {
      const data = block()?.output as SearchResults | undefined;
      const hits = data?.hits ?? [];
      if (!hits.length) { setSearchFocusedIdx(-1); return; }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (idx < hits.length - 1) {
          setSearchFocusedIdx(idx + 1);
        } else {
          setSearchFocusedIdx(-1);
          const next = findNextVisibleBlock(props.blockId, props.paneId);
          if (next) props.onFocus(next);
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (idx > 0) {
          setSearchFocusedIdx(idx - 1);
        } else {
          setSearchFocusedIdx(-1);
          const prev = findPrevVisibleBlock(props.blockId, props.paneId);
          if (prev) props.onFocus(prev);
        }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const hit = hits[idx];
        if (hit) {
          navigateToBlock(hit.blockId, {
            paneId: resolveSameTabLink(props.paneId),
            highlight: true,
            originBlockId: props.blockId,
          });
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setSearchFocusedIdx(-1);
      }
      return;
    }

    // Block-level navigation (idx === -1)
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const ot = block()?.outputType;
      if (ot === 'search-results' && block()?.outputStatus === 'complete') {
        const data = block()?.output as SearchResults | undefined;
        if (data?.hits?.length) {
          setSearchFocusedIdx(data.hits.length - 1);
          return;
        }
      }
      const prev = findPrevVisibleBlock(props.blockId, props.paneId);
      if (prev) props.onFocus(prev);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const ot = block()?.outputType;
      if (ot === 'search-results' && block()?.outputStatus === 'complete') {
        const data = block()?.output as SearchResults | undefined;
        if (data?.hits?.length) {
          setSearchFocusedIdx(0);
          return;
        }
      }
      const next = findNextVisibleBlock(props.blockId, props.paneId);
      if (next) props.onFocus(next);
    }
  };

  // ─── JSX ──────────────────────────────────────────────────────────
  return (
    <>
      {/* OUTPUT BLOCKS: search-* and door get a focusable wrapper for keyboard nav */}
      <Show when={props.isOutputBlock()}>
        <div
          ref={outputFocusRef}
          tabIndex={0}
          class="output-block-focus-target"
          onKeyDown={handleOutputBlockKeyDown}
          onFocus={() => props.onFocus(props.blockId)}
        >
          {/* SEARCH OUTPUT VIEW */}
          <Show when={block()?.outputType === 'search-results' || block()?.outputType === 'search-error'}>
            <div class="search-output">
              <Show when={block()?.outputStatus === 'running' || block()?.outputStatus === 'pending'}>
                <div class="daily-running">
                  <span class="daily-running-spinner">◐</span>
                  <span class="daily-running-text">Searching...</span>
                </div>
              </Show>
              <Show when={block()?.outputType === 'search-results' && block()?.outputStatus === 'complete'}>
                <SearchResultsView
                  data={block()!.output as SearchResults}
                  paneId={props.paneId}
                  blockId={props.blockId}
                  focusedIdx={searchFocusedIdx}
                />
              </Show>
              <Show when={block()?.outputType === 'search-error' && block()?.outputStatus !== 'running' && block()?.outputStatus !== 'pending'}>
                <SearchErrorView data={block()!.output as { error: string; query?: string }} />
              </Show>
            </div>
          </Show>

          {/* DOOR OUTPUT VIEW — single branch for all doors */}
          <Show when={block()?.outputType === 'door'}>
            <ErrorBoundary fallback={doorErrorFallback(() => store.setBlockOutput(props.blockId, null, ''))}>
              {(() => {
                const envelope = block()!.output as DoorEnvelope;
                if (!envelope || !envelope.kind) return null;
                return envelope.kind === 'view'
                  ? <DoorHost
                      doorId={envelope.doorId}
                      data={envelope.data}
                      error={envelope.error}
                      status={block()?.outputStatus}
                      onNavigate={handleDoorNavigate}
                    />
                  : <DoorExecCard
                      doorId={envelope.doorId}
                      ok={envelope.ok}
                      startedAt={envelope.startedAt}
                      finishedAt={envelope.finishedAt}
                      summary={envelope.summary}
                      error={envelope.error}
                      createdBlockIds={envelope.createdBlockIds}
                    />;
              })()}
            </ErrorBoundary>
          </Show>

          {/* IMG VIEW — local attachment from __attachments/ */}
          <Show when={block()?.outputType === 'img-view'}>
            <ImgView
              filename={(block()!.output as { filename: string })?.filename ?? ''}
              serverUrl={window.__FLOATTY_SERVER_URL__ ?? ''}
              apiKey={window.__FLOATTY_API_KEY__ ?? ''}
            />
          </Show>
        </div>
      </Show>

      {/* EVAL OUTPUT: inline result below contentEditable for eval:: blocks */}
      <Show when={block()?.outputType === 'eval-result' && block()?.output && !props.isCollapsed()}>
        {(() => {
          let pokeIframe: ((message: string, data?: unknown) => void) | undefined;
          return (
            <EvalOutput
              output={block()!.output as EvalResult}
              onChirp={(message: string, data?: unknown) => {
                if (message === 'navigate' && typeof data === 'object' && data) {
                  const nav = data as { target: string; type?: 'block' | 'page' | 'wikilink'; splitDirection?: 'horizontal' | 'vertical' };
                  const result = handleChirpNavigate(nav.target, {
                    type: nav.type, sourcePaneId: props.paneId,
                    sourceBlockId: props.blockId, splitDirection: nav.splitDirection,
                    originBlockId: props.blockId,
                  });
                  pokeIframe?.('ack: navigate', { success: result.success, target: nav.target, error: result.error });
                  return;
                }
                if (isChirpWriteVerb(message)) {
                  const result = handleChirpWrite(message, data as ChirpWriteData, props.blockId, store);
                  pokeIframe?.(`ack: ${message}`, result);
                  return;
                }
                const now = Date.now();
                const lastTime = chirpThrottleMap.get(props.blockId);
                if (lastTime && now - lastTime < 100) {
                  pokeIframe?.(`ack: ${message}`, { throttled: true });
                  return;
                }
                chirpThrottleMap.set(props.blockId, now);
                store.batchCreateBlocksInside(props.blockId, [{ content: `chirp:: ${message}` }]);
                pokeIframe?.(`ack: ${message}`, data);
              }}
              onPokeReady={(poke) => { pokeIframe = poke; }}
            />
          );
        })()}
      </Show>

      {/* INLINE DOOR OUTPUT: below contentEditable for selfRender doors (like artifact::) */}
      <Show when={block()?.outputType === 'door' && block()?.content && block()?.output && !props.isCollapsed()}>
        <ErrorBoundary fallback={doorErrorFallback(() => store.setBlockOutput(props.blockId, null, ''))}>
        {(() => {
          const env = block()!.output as DoorEnvelope;
          if (!env || !env.kind) return null;
          return env.kind === 'view'
            ? <div
                ref={(el) => props.setInlineDoorRef(el)}
                // contenteditable is an ENUMERATED attr, not a boolean. SolidJS strips
                // `contenteditable={false}` when evaluated as a boolean-false attribute,
                // so pass the literal string "false" to guarantee the attribute lands.
                attr:contenteditable="false"
                style={{ 'user-select': 'text' }}
              >
              <DoorHost
                doorId={env.doorId}
                data={env.data}
                error={env.error}
                status={block()?.outputStatus}
                onNavigate={handleDoorNavigate}
                onChirp={(message, data) => {
                  if (isChirpWriteVerb(message)) {
                    handleChirpWrite(message, data as ChirpWriteData, props.blockId, store);
                  }
                }}
              />
            </div>
            : <DoorExecCard
                doorId={env.doorId}
                ok={env.ok}
                startedAt={env.startedAt}
                finishedAt={env.finishedAt}
                summary={env.summary}
                error={env.error}
                createdBlockIds={env.createdBlockIds}
              />;
        })()}
        </ErrorBoundary>
      </Show>

    </>
  );
}

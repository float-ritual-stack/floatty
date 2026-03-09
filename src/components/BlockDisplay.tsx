/**
 * BlockDisplay - Styled overlay for inline markdown formatting
 *
 * Renders the display layer in the overlay architecture.
 * Shows raw text (with markers) but applies styling to formatted spans.
 *
 * Architecture:
 *   <div class="block-content-wrapper">
 *     <BlockDisplay ... />        ← This component (pointer-events: none)
 *     <div contentEditable ... /> ← Edit layer (transparent text, visible cursor)
 *   </div>
 */

import { createMemo, createSignal, createEffect, on, onCleanup, For, Show } from 'solid-js';
import { parseAllInlineTokens, hasInlineFormatting, type InlineToken } from '../lib/inlineParser';
import { findWikilinkEnd, parseWikilinkInner } from '../lib/wikilinkUtils';
import type { TableConfig } from '../lib/blockTypes';

interface BlockDisplayProps {
  content: string;
  /** Called when a [[wikilink]] is clicked. Receives target page name and mouse event. */
  onWikilinkClick?: (target: string, event: MouseEvent) => void;
  /** Block ID for table editing (optional - tables are read-only without this) */
  blockId?: string;
  /** Called when table content is updated (optional - tables are read-only without this) */
  onUpdateContent?: (newContent: string) => void;
  /** Set of existing page names (lowercase) for stub detection */
  pageNameSet?: Set<string>;
  /** Set of page names (lowercase) that exist but have no real content */
  stubPageNameSet?: ReadonlySet<string>;
}

interface TokenSpanProps {
  token: InlineToken;
  onWikilinkClick?: (target: string, event: MouseEvent) => void;
  pageNameSet?: Set<string>;
  stubPageNameSet?: ReadonlySet<string>;
}

/**
 * Render nested [[wikilinks]] within bare text (no outer brackets).
 * Used for alias text in [[target|alias with [[nested]] links]].
 * Bracket-counting via findWikilinkEnd, no regex.
 */
function renderNestedLinks(
  text: string,
  onWikilinkClick?: (target: string, event: MouseEvent) => void
): (string | Element)[] {
  const parts: (string | Element)[] = [];
  let i = 0;
  let lastEnd = 0;

  while (i < text.length - 1) {
    const openIdx = text.indexOf('[[', i);
    if (openIdx === -1) break;

    const endIdx = findWikilinkEnd(text, openIdx);
    if (endIdx === -1) { i = openIdx + 2; continue; }

    if (openIdx > lastEnd) parts.push(text.slice(lastEnd, openIdx));

    const nestedRaw = text.slice(openIdx, endIdx);
    const nestedInner = text.slice(openIdx + 2, endIdx - 2);
    const { target: nestedTarget } = parseWikilinkInner(nestedInner);

    parts.push(
      <span
        class="md-wikilink md-wikilink-nested"
        data-target={nestedTarget}
        onClick={(e: MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          onWikilinkClick?.(nestedTarget, e);
        }}
      >
        {nestedRaw}
      </span> as Element
    );

    lastEnd = endIdx;
    i = endIdx;
  }

  if (lastEnd < text.length) parts.push(text.slice(lastEnd));
  return parts.length > 0 ? parts : [text];
}

/**
 * Render wikilink content with nested wikilinks as clickable children.
 * For `[[outer [[inner]]]]`, renders "[[outer " + clickable [[inner]] + "]]"
 */
function renderWikilinkContent(
  raw: string,
  onWikilinkClick?: (target: string, event: MouseEvent) => void
): (string | Element)[] {
  const parts: (string | Element)[] = [];

  // Quick check - no nested brackets means just return raw
  // Count [[ occurrences - if only one pair, no nesting
  const openCount = (raw.match(/\[\[/g) || []).length;
  if (openCount <= 1) {
    return [raw];
  }

  // Find nested wikilinks using shared utility
  let i = 0;
  let lastEnd = 0;

  while (i < raw.length - 1) {
    const openIdx = raw.indexOf('[[', i);
    if (openIdx === -1) break;

    // Skip the outermost [[ (at position 0)
    if (openIdx === 0) {
      i = 2;
      continue;
    }

    // Find matching ]] with bracket counting
    const endIdx = findWikilinkEnd(raw, openIdx);
    if (endIdx === -1) {
      i = openIdx + 2;
      continue;
    }

    // Add text before this nested link
    if (openIdx > lastEnd) {
      parts.push(raw.slice(lastEnd, openIdx));
    }

    // Extract nested wikilink
    const nestedRaw = raw.slice(openIdx, endIdx);
    const nestedInner = raw.slice(openIdx + 2, endIdx - 2);

    // Parse target (handle alias) using shared utility
    const { target: nestedTarget } = parseWikilinkInner(nestedInner);

    // Render nested wikilink as clickable span
    parts.push(
      <span
        class="md-wikilink md-wikilink-nested"
        data-target={nestedTarget}
        onClick={(e: MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          onWikilinkClick?.(nestedTarget, e);
        }}
      >
        {nestedRaw}
      </span> as Element
    );

    lastEnd = endIdx;
    i = endIdx;
  }

  // Add remaining text (including final ]])
  if (lastEnd < raw.length) {
    parts.push(raw.slice(lastEnd));
  }

  return parts.length > 0 ? parts : [raw];
}

/**
 * Render a single inline token with appropriate styling.
 * Shows the RAW text (with markers) but applies class for styling.
 * Wikilinks get special handling with pointer-events: auto for interactivity.
 */
/**
 * Render cell content with inline formatting (wikilinks, bold, etc.)
 */
function CellContent(props: { content: string; onWikilinkClick?: (target: string, event: MouseEvent) => void }) {
  const tokens = createMemo(() => parseAllInlineTokens(props.content));
  const hasTokens = createMemo(() => tokens().length > 0);

  return (
    <Show when={hasTokens()} fallback={props.content}>
      <For each={tokens()}>
        {(token) => <InlineTokenSpan token={token} onWikilinkClick={props.onWikilinkClick} />}
      </For>
    </Show>
  );
}

export interface TableViewProps {
  token: InlineToken;
  blockId: string;
  onUpdate: (newContent: string) => void;
  onWikilinkClick?: (target: string, event: MouseEvent) => void;
  /** Whether this block is focused (for auto-focusing table on block focus) */
  isFocused?: boolean;
  /** Called when navigating out of table bounds (Up from first row, Down from last row) */
  onNavigateOut?: (direction: 'up' | 'down') => void;
  /** Called when user clicks toggle to switch to raw markdown editing */
  onSwitchToRaw?: () => void;
  /** Table config from block.tableConfig (FLO-58) */
  tableConfig?: TableConfig;
  /** Called when column widths change (FLO-58) */
  onTableConfigChange?: (config: TableConfig) => void;
}

// ═══════════════════════════════════════════════════════════════
// FLO-58: Column Width Utilities
// ═══════════════════════════════════════════════════════════════

/** Minimum column width as percentage (prevents disappearing columns) */
const MIN_COLUMN_WIDTH_PERCENT = 5;

/**
 * Normalize widths to prevent floating-point drift (33.333336 → 33.33).
 * Ensures widths sum to exactly 100% by adjusting largest column.
 */
function normalizeWidths(widths: number[]): number[] {
  const rounded = widths.map(w => Math.round(w * 100) / 100);
  const total = rounded.reduce((a, b) => a + b, 0);
  const remainder = Math.round((100 - total) * 100) / 100;
  if (remainder !== 0 && rounded.length > 0) {
    const largestIdx = rounded.indexOf(Math.max(...rounded));
    rounded[largestIdx] += remainder;
  }
  return rounded;
}

/**
 * Get column widths from config or compute equal distribution.
 * Returns undefined if column count doesn't match (stale config).
 */
function getColumnWidths(
  config: TableConfig | undefined,
  columnCount: number
): number[] {
  // Equal distribution by default
  const equalWidths = () => Array(columnCount).fill(100 / columnCount);

  if (!config?.columnWidths) return equalWidths();

  // Stale config - column count changed
  if (config.columnWidths.length !== columnCount) return equalWidths();

  return config.columnWidths;
}

/**
 * Escape pipe characters in table cell content.
 * Without this, a | in cell content breaks table parsing.
 */
function escapePipe(str: string): string {
  return str.replace(/\|/g, '\\|');
}

/**
 * Serialize table data back to markdown format.
 */
function serializeToMarkdown(
  headers: string[],
  rows: string[][],
  alignments: ('left' | 'center' | 'right')[]
): string {
  const headerLine = `| ${headers.map(escapePipe).join(' | ')} |`;
  const sepLine = `|${alignments.map(a =>
    a === 'center' ? ':---:' : a === 'right' ? '---:' : '---'
  ).join('|')}|`;
  const rowLines = rows.map(row => `| ${row.map(escapePipe).join(' | ')} |`);
  return [headerLine, sepLine, ...rowLines].join('\n');
}

/**
 * Table renderer with cell editing, keyboard navigation, and column resizing.
 * FLO-58: Full keyboard control - arrow keys navigate, Enter edits, Escape cancels.
 * Column resizing via drag handles with zero-sum model (A grows, B shrinks).
 * Supports wikilinks in cells and serializes back to markdown on edit.
 *
 * CRITICAL SolidJS pattern: Use separate editValue signal for input to avoid
 * re-rendering the entire table on every keystroke. Only update localRows on save.
 */
export function TableView(props: TableViewProps) {
  const [editingCell, setEditingCell] = createSignal<{ row: number; col: number } | null>(null);
  const [focusedCell, setFocusedCell] = createSignal<{ row: number; col: number }>({ row: 0, col: 0 });
  const [localRows, setLocalRows] = createSignal<string[][]>([]);
  const [editValue, setEditValue] = createSignal(''); // Separate signal for input value
  let tableRef: HTMLTableElement | undefined;
  let inputRef: HTMLInputElement | undefined;

  // ═══════════════════════════════════════════════════════════════
  // FLO-58: Column Resize State
  // ═══════════════════════════════════════════════════════════════
  const [resizing, setResizing] = createSignal<{
    colIdx: number;
    startX: number;      // Original drag start (never mutated during drag)
    startWidths: number[]; // Original widths at drag start (never mutated)
    tableWidth: number;
  } | null>(null);

  // Separate signal for visual feedback during drag (updated each frame)
  const [dragWidths, setDragWidths] = createSignal<number[] | null>(null);

  // Sync local rows from token data (only when token changes, not during editing)
  createEffect(() => {
    // Don't sync while editing - would overwrite user's changes
    if (editingCell()) return;
    const rows = props.token.rows ?? [];
    setLocalRows(rows.map(row => [...row]));
  });

  // Initialize editValue when starting to edit a cell
  createEffect(() => {
    const cell = editingCell();
    if (cell) {
      const rows = localRows();
      const value = rows[cell.row]?.[cell.col] ?? '';
      setEditValue(value);
    }
  });

  // Focus input when editing starts (separate effect to avoid dependency on editValue)
  createEffect(() => {
    if (editingCell()) {
      // Use queueMicrotask to ensure input is mounted
      queueMicrotask(() => {
        if (inputRef) {
          inputRef.focus();
          inputRef.select();
        }
      });
    }
  });

  // Focus table when block becomes focused (for keyboard navigation into table)
  // Use on() for explicit tracking - props.isFocused is passed as a value, not accessor
  createEffect(on(() => props.isFocused, (isFocused) => {
    if (isFocused && tableRef && !editingCell()) {
      tableRef.focus();
    }
  }));

  // ═══════════════════════════════════════════════════════════════
  // FLO-58: Column Width Management
  // ═══════════════════════════════════════════════════════════════

  // Compute current column widths from config or equal distribution
  const columnWidths = createMemo(() => {
    const colCount = props.token.headers?.length ?? 0;
    if (colCount === 0) return [];
    return getColumnWidths(props.tableConfig, colCount);
  });

  // Resize handlers
  const handleResizeStart = (colIdx: number, e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (!tableRef) return;

    const startWidths = [...columnWidths()];
    const tableWidth = tableRef.offsetWidth;

    setResizing({
      colIdx,
      startX: e.clientX,
      startWidths,
      tableWidth,
    });

    // Set cursor on body for consistent feedback during drag
    document.body.style.cursor = 'col-resize';
    document.body.classList.add('resizing');
  };

  const handleResizeMove = (e: PointerEvent) => {
    const state = resizing();
    if (!state) return;

    // Delta from ORIGINAL start position (not mutated during drag)
    const deltaX = e.clientX - state.startX;
    const deltaPercent = (deltaX / state.tableWidth) * 100;

    const leftIdx = state.colIdx;
    const rightIdx = state.colIdx + 1;

    // Zero-sum: left grows, right shrinks (or vice versa)
    let newLeft = state.startWidths[leftIdx] + deltaPercent;
    let newRight = state.startWidths[rightIdx] - deltaPercent;

    // Enforce minimum widths with final clamp to avoid edge case
    // where sequential adjustments leave one column below minimum
    if (newLeft < MIN_COLUMN_WIDTH_PERCENT) {
      newRight -= (MIN_COLUMN_WIDTH_PERCENT - newLeft);
      newLeft = MIN_COLUMN_WIDTH_PERCENT;
    }
    if (newRight < MIN_COLUMN_WIDTH_PERCENT) {
      newLeft -= (MIN_COLUMN_WIDTH_PERCENT - newRight);
      newRight = MIN_COLUMN_WIDTH_PERCENT;
    }
    // Final clamp for robustness
    newLeft = Math.max(newLeft, MIN_COLUMN_WIDTH_PERCENT);
    newRight = Math.max(newRight, MIN_COLUMN_WIDTH_PERCENT);

    // Update visual feedback via separate signal (startWidths stays stable)
    const newWidths = [...state.startWidths];
    newWidths[leftIdx] = newLeft;
    newWidths[rightIdx] = newRight;
    setDragWidths(newWidths);
  };

  const handleResizeEnd = () => {
    const state = resizing();
    if (!state) return;

    // Normalize and persist - use dragWidths if available, else startWidths
    const finalWidths = dragWidths() ?? state.startWidths;
    const normalized = normalizeWidths(finalWidths);
    props.onTableConfigChange?.({ columnWidths: normalized });

    // Reset cursor and state
    document.body.style.cursor = '';
    document.body.classList.remove('resizing');
    setDragWidths(null);
    setResizing(null);
  };

  // Window event listeners for drag (cleanup on unmount)
  createEffect(() => {
    if (resizing()) {
      const moveHandler = (e: PointerEvent) => handleResizeMove(e);
      const upHandler = () => handleResizeEnd();

      window.addEventListener('pointermove', moveHandler);
      window.addEventListener('pointerup', upHandler);

      onCleanup(() => {
        window.removeEventListener('pointermove', moveHandler);
        window.removeEventListener('pointerup', upHandler);
        // Ensure cursor is reset even if cleanup fires unexpectedly
        document.body.style.cursor = '';
        document.body.classList.remove('resizing');
      });
    }
  });

  // Get active widths (during resize use dragWidths, otherwise use memo)
  const activeWidths = () => {
    const dw = dragWidths();
    if (dw) return dw;
    return columnWidths();
  };

  const handleCellSave = () => {
    const cell = editingCell();
    if (!cell) return;

    // Update localRows with the edited value
    const currentValue = editValue();
    const newRows = localRows().map((row, ri) =>
      ri === cell.row
        ? row.map((cellVal, ci) => ci === cell.col ? currentValue : cellVal)
        : row
    );
    setLocalRows(newRows);

    const newMarkdown = serializeToMarkdown(
      props.token.headers ?? [],
      newRows,
      props.token.alignments ?? []
    );
    props.onUpdate(newMarkdown);
    setEditingCell(null);

    // Refocus table for continued keyboard navigation
    queueMicrotask(() => tableRef?.focus());
  };

  const handleCellCancel = () => {
    // Just clear editing state - localRows wasn't modified during typing
    setEditingCell(null);
    queueMicrotask(() => tableRef?.focus());
  };

  const alignmentClass = (index: number): string => {
    const align = props.token.alignments?.[index] ?? 'left';
    return `md-table-align-${align}`;
  };

  const numRows = () => localRows().length;
  const numCols = () => props.token.headers?.length ?? 0;

  // Keyboard handler for table navigation (when not editing)
  const handleTableKeyDown = (e: KeyboardEvent) => {
    const cell = focusedCell();
    const editing = editingCell();

    // If editing, let the input handle everything
    if (editing) return;

    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault();
        e.stopPropagation();
        if (cell.row > 0) {
          setFocusedCell({ ...cell, row: cell.row - 1 });
        } else {
          // At first row - navigate out of table
          props.onNavigateOut?.('up');
        }
        break;
      case 'ArrowDown':
        e.preventDefault();
        e.stopPropagation();
        if (cell.row < numRows() - 1) {
          setFocusedCell({ ...cell, row: cell.row + 1 });
        } else {
          // At last row - navigate out of table
          props.onNavigateOut?.('down');
        }
        break;
      case 'ArrowLeft':
        e.preventDefault();
        e.stopPropagation();
        if (cell.col > 0) {
          setFocusedCell({ ...cell, col: cell.col - 1 });
        }
        break;
      case 'ArrowRight':
        e.preventDefault();
        e.stopPropagation();
        if (cell.col < numCols() - 1) {
          setFocusedCell({ ...cell, col: cell.col + 1 });
        }
        break;
      case 'Enter':
        e.preventDefault();
        e.stopPropagation();
        setEditingCell(cell);
        break;
      case 'Tab':
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) {
          // Backward: move to prev cell, wrap to prev row
          if (cell.col > 0) {
            setFocusedCell({ row: cell.row, col: cell.col - 1 });
          } else if (cell.row > 0) {
            setFocusedCell({ row: cell.row - 1, col: numCols() - 1 });
          } else {
            // At first cell - navigate out of table
            props.onNavigateOut?.('up');
          }
        } else {
          // Forward: move to next cell, wrap to next row
          if (cell.col < numCols() - 1) {
            setFocusedCell({ row: cell.row, col: cell.col + 1 });
          } else if (cell.row < numRows() - 1) {
            setFocusedCell({ row: cell.row + 1, col: 0 });
          } else {
            // At last cell - navigate out of table
            props.onNavigateOut?.('down');
          }
        }
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        // Navigate out (up by default)
        props.onNavigateOut?.('up');
        break;
    }
  };

  // Input keyboard handler - stop all propagation to prevent block-level handlers
  const handleInputKeyDown = (e: KeyboardEvent) => {
    e.stopPropagation(); // CRITICAL: prevent contentEditable/block handlers

    // Handle Cmd+A to select input text, not entire block
    if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
      e.preventDefault();
      inputRef?.select();
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      handleCellSave();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      handleCellCancel();
    }
    // Tab while editing: save and move to next/prev cell
    if (e.key === 'Tab') {
      e.preventDefault();
      const cell = editingCell(); // Capture before save clears it
      handleCellSave();
      if (cell) {
        if (e.shiftKey) {
          // Backward
          if (cell.col > 0) {
            const prevCell = { row: cell.row, col: cell.col - 1 };
            setFocusedCell(prevCell);
            setEditingCell(prevCell);
          } else if (cell.row > 0) {
            const prevCell = { row: cell.row - 1, col: numCols() - 1 };
            setFocusedCell(prevCell);
            setEditingCell(prevCell);
          }
          // At first cell - just exit editing (table nav will take over)
        } else {
          // Forward
          if (cell.col < numCols() - 1) {
            const nextCell = { row: cell.row, col: cell.col + 1 };
            setFocusedCell(nextCell);
            setEditingCell(nextCell);
          } else if (cell.row < numRows() - 1) {
            const nextCell = { row: cell.row + 1, col: 0 };
            setFocusedCell(nextCell);
            setEditingCell(nextCell);
          }
          // At last cell - just exit editing (table nav will take over)
        }
      }
    }
  };

  const isCellFocused = (r: number, c: number) => {
    const f = focusedCell();
    return f.row === r && f.col === c && !editingCell();
  };

  const isCellEditing = (r: number, c: number) => {
    const ed = editingCell();
    return ed?.row === r && ed?.col === c;
  };

  return (
    <div class="md-table-wrapper">
      <button
        class="md-table-toggle"
        onClick={() => props.onSwitchToRaw?.()}
        title="Show raw markdown"
      >
        ≡
      </button>
        <table
          ref={tableRef}
          class={`md-table${resizing() ? ' md-table-resizing' : ''}`}
          tabindex={0}
          onKeyDown={handleTableKeyDown}
        >
          {/* FLO-58: colgroup controls column widths */}
          <colgroup>
            <For each={activeWidths()}>
              {(width) => <col style={{ width: `${width}%` }} />}
            </For>
          </colgroup>
          <thead>
            <tr>
              <For each={props.token.headers ?? []}>
                {(header, i) => (
                  <th class={alignmentClass(i())} style={{ position: 'relative' }}>
                    <CellContent content={header} onWikilinkClick={props.onWikilinkClick} />
                    {/* Resize handle (not on last column) */}
                    <Show when={i() < (props.token.headers?.length ?? 0) - 1}>
                      <div
                        class="table-resize-handle"
                        onPointerDown={(e) => handleResizeStart(i(), e)}
                      />
                    </Show>
                  </th>
                )}
              </For>
            </tr>
          </thead>
          <tbody>
            <For each={localRows()}>
              {(row, r) => (
                <tr>
                  <For each={row}>
                    {(cell, c) => (
                      <td
                        class={`${alignmentClass(c())}${isCellEditing(r(), c()) ? ' md-table-cell-editing' : ''}${isCellFocused(r(), c()) ? ' md-table-cell-focused' : ''}`}
                        onClick={() => {
                          setFocusedCell({ row: r(), col: c() });
                          if (!isCellEditing(r(), c())) {
                            setEditingCell({ row: r(), col: c() });
                          }
                        }}
                      >
                        <Show
                          when={isCellEditing(r(), c())}
                          fallback={<CellContent content={cell} onWikilinkClick={props.onWikilinkClick} />}
                        >
                          <input
                            ref={inputRef}
                            type="text"
                            value={editValue()}
                            class="md-table-input"
                            spellcheck={false}
                            autocomplete="off"
                            autocorrect="off"
                            autocapitalize="off"
                            onInput={(e) => setEditValue(e.currentTarget.value)}
                            onBlur={handleCellSave}
                            onKeyDown={handleInputKeyDown}
                          />
                        </Show>
                      </td>
                    )}
                  </For>
                </tr>
              )}
            </For>
          </tbody>
        </table>
    </div>
  );
}

function InlineTokenSpan(props: TokenSpanProps) {
  const classMap: Record<string, string> = {
    text: '',
    bold: 'md-bold',
    italic: 'md-italic',
    code: 'md-code',
    wikilink: 'md-wikilink',
    'ctx-prefix': 'ctx-inline-prefix',
    'ctx-timestamp': 'ctx-inline-timestamp',
    'ctx-tag': 'ctx-inline-tag',
    'code-fence': 'md-code-fence',
    'line-comment': 'md-line-comment',
    'filter-function': 'md-filter-function',
    'filter-prefix': 'filter-inline-prefix',
    'box-heavy': 'md-box-heavy',
    'box-double': 'md-box-double',
    'box-tree': 'md-box-tree',
    'box-indicator': 'md-box-indicator',
    'heading-marker': 'md-heading-marker',
    'time': 'md-time',
    'prefix-marker': 'md-prefix-marker',
    'issue-ref': 'md-issue-ref',
    'pr-ref': 'md-pr-ref',
    'number-ref': 'md-number-ref',
    'kbd': 'md-kbd',
    table: '', // Tables are rendered separately via TableView
  };

  // For ctx-tag, add type-specific class for color coding
  const getClass = () => {
    const baseClass = classMap[props.token.type] || '';
    if (props.token.type === 'ctx-tag' && props.token.tagType) {
      return `${baseClass} ctx-inline-tag-${props.token.tagType}`;
    }
    return baseClass;
  };

  // Wikilinks get special rendering with click handler and nested link support
  if (props.token.type === 'wikilink' && props.token.target) {
    const inner = props.token.raw.slice(2, -2);
    const { target, alias } = parseWikilinkInner(inner);

    // Stub detection: page doesn't exist OR exists but has no real content
    const isStub = () => {
      if (!props.pageNameSet) return false;
      const t = props.token.target!;
      if (/^[0-9a-f]{6,}$/i.test(t)) return false; // block ID ref, not a page
      const lower = t.toLowerCase();
      if (!props.pageNameSet.has(lower)) return true; // doesn't exist
      return props.stubPageNameSet?.has(lower) ?? false; // exists but empty
    };

    const content = alias
      // Aliased wikilink: dim the [[target| scaffolding, show alias at full weight.
      // Block refs ([[d3599940|label]]) become readable; page aliases stay clear.
      ? (
        <>
          <span class="md-wikilink-punct">[[</span>
          <span class="md-wikilink-id">{target}</span>
          <span class="md-wikilink-punct">|</span>
          <span class="md-wikilink-label">
            {alias.includes('[[')
              ? renderNestedLinks(alias, props.onWikilinkClick)
              : alias}
          </span>
          <span class="md-wikilink-punct">]]</span>
        </>
      )
      : renderWikilinkContent(props.token.raw, props.onWikilinkClick);

    return (
      <span
        class={`${getClass()}${isStub() ? ' md-wikilink-stub' : ''}`}
        data-target={props.token.target}
        onClick={(e: MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          props.onWikilinkClick?.(props.token.target!, e);
        }}
      >
        {content}
      </span>
    );
  }

  // Code fences render with line-by-line structure for fence marker styling
  // Unlanguaged fences (or text/ascii) get box-drawing coloring instead of flat green
  if (props.token.type === 'code-fence') {
    const lines = props.token.raw.split('\n');
    const lang = props.token.lang?.toLowerCase() ?? '';
    const isPlainFence = !lang || lang === 'text' || lang === 'ascii';
    return (
      <span class={getClass()} data-lang={props.token.lang}>
        <For each={lines}>
          {(line, i) => {
            const isLastLine = i() === lines.length - 1;
            const isFenceMarker = line.trimStart().startsWith('```');

            if (isFenceMarker) {
              return <><span class="md-fence-marker">{line}</span>{!isLastLine && '\n'}</>;
            }

            // Plain fences: run full inline parser for wikilinks, ctx::, box-drawing, etc.
            if (isPlainFence) {
              const lineTokens = parseAllInlineTokens(line);
              if (lineTokens.length > 0) {
                return (
                  <>
                    <For each={lineTokens}>
                      {(sub) => <InlineTokenSpan token={sub} onWikilinkClick={props.onWikilinkClick} pageNameSet={props.pageNameSet} stubPageNameSet={props.stubPageNameSet} />}
                    </For>
                    {!isLastLine && '\n'}
                  </>
                );
              }
              // No formatting found — plain text, inherit foreground
              return <><span>{line}</span>{!isLastLine && '\n'}</>;
            }

            return <><span class="md-fence-content">{line}</span>{!isLastLine && '\n'}</>;
          }}
        </For>
      </span>
    );
  }

  return (
    <span class={getClass()}>
      {props.token.raw}
    </span>
  );
}

export function BlockDisplay(props: BlockDisplayProps) {
  // Early-exit hint for parser work.
  // Rendering gate uses parsed token count (not this hint) to avoid empty overlays.
  const hasFormattingHint = createMemo(() => hasInlineFormatting(props.content));

  // Parse tokens reactively - only recomputes when content changes
  const tokens = createMemo(() => {
    if (!hasFormattingHint()) return [];
    return parseAllInlineTokens(props.content);
  });
  const hasRenderableTokens = createMemo(() => tokens().length > 0);

  // NOTE: Table rendering is handled directly in BlockItem (picker pattern)
  // BlockDisplay only handles inline formatting tokens

  return (
    <div class="block-display" aria-hidden="true">
      <Show when={hasRenderableTokens()}>
        <For each={tokens()}>
          {(token) => (
            <InlineTokenSpan
              token={token}
              onWikilinkClick={props.onWikilinkClick}
              pageNameSet={props.pageNameSet}
              stubPageNameSet={props.stubPageNameSet}
            />
          )}
        </For>
      </Show>
      <Show when={!hasRenderableTokens()}>
        {/* No formatting - render plain text directly */}
        {props.content}
      </Show>
    </div>
  );
}

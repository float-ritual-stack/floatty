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

import { createMemo, For, Show } from 'solid-js';
import {
  parseAllInlineTokens,
  hasInlineFormatting,
  parseMarkdownTable,
  parseInlineTokens,
  type InlineToken,
  type ParsedTable,
} from '../lib/inlineParser';

interface BlockDisplayProps {
  content: string;
  // Future: wikilink interactions
  // onWikilinkHover?: (link: string, rect: DOMRect) => void;
  // onWikilinkClick?: (link: string) => void;
}

/**
 * Render a single inline token with appropriate styling.
 * Shows the RAW text (with markers) but applies class for styling.
 */
function InlineTokenSpan(props: { token: InlineToken }) {
  // For styled tokens, we show the raw text but wrap inner content in styled span
  // Example: **bold** → <span class="md-bold">**<span class="md-bold-inner">bold</span>**</span>
  //
  // Simpler approach for now: just color the whole thing including markers
  // This matches the "markers visible, text colored" requirement

  const classMap: Record<string, string> = {
    text: '',
    bold: 'md-bold',
    italic: 'md-italic',
    code: 'md-code',
    'ctx-prefix': 'ctx-inline-prefix',
    'ctx-timestamp': 'ctx-inline-timestamp',
    'ctx-tag': 'ctx-inline-tag',
  };

  // For ctx-tag, add type-specific class for color coding
  const getClass = () => {
    const baseClass = classMap[props.token.type] || '';
    if (props.token.type === 'ctx-tag' && props.token.tagType) {
      return `${baseClass} ctx-inline-tag-${props.token.tagType}`;
    }
    return baseClass;
  };

  return (
    <span class={getClass()}>
      {props.token.raw}
    </span>
  );
}

/**
 * Render cell content with inline markdown formatting
 */
function CellContent(props: { content: string }) {
  const tokens = createMemo(() => {
    if (!props.content || !hasInlineFormatting(props.content)) return [];
    return parseInlineTokens(props.content);
  });

  return (
    <Show when={tokens().length > 0} fallback={props.content}>
      <For each={tokens()}>
        {(token) => <InlineTokenSpan token={token} />}
      </For>
    </Show>
  );
}

/**
 * Render a markdown table as an HTML table element
 */
function TableDisplay(props: { table: ParsedTable }) {
  return (
    <table class="md-table">
      <thead>
        <tr>
          <For each={props.table.headers}>
            {(cell) => (
              <th class={`md-table-cell md-table-align-${cell.alignment}`}>
                <CellContent content={cell.content} />
              </th>
            )}
          </For>
        </tr>
      </thead>
      <tbody>
        <For each={props.table.rows}>
          {(row) => (
            <tr>
              <For each={row}>
                {(cell) => (
                  <td class={`md-table-cell md-table-align-${cell.alignment}`}>
                    <CellContent content={cell.content} />
                  </td>
                )}
              </For>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  );
}

export function BlockDisplay(props: BlockDisplayProps) {
  // Check if content is a markdown table (parseMarkdownTable returns null if not)
  const tableData = createMemo(() => {
    if (!props.content) return null;
    return parseMarkdownTable(props.content);
  });

  // Early exit optimization - if no formatting, just render plain text
  const hasFormatting = createMemo(() => hasInlineFormatting(props.content));

  // Parse tokens reactively - only recomputes when content changes
  const tokens = createMemo(() => {
    if (!hasFormatting()) return [];
    return parseAllInlineTokens(props.content);
  });

  return (
    <div class="block-display" aria-hidden="true">
      <Show when={tableData()} fallback={
        hasFormatting() ? (
          <For each={tokens()}>
            {(token) => <InlineTokenSpan token={token} />}
          </For>
        ) : (
          // No formatting - render plain text directly
          props.content
        )
      }>
        {(table) => <TableDisplay table={table()} />}
      </Show>
    </div>
  );
}

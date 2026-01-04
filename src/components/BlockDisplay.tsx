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
  parseTableTokens,
  isMarkdownTable,
  type InlineToken,
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
    'table-pipe': 'md-table-pipe',
    'table-separator': 'md-table-separator',
    'table-header': 'md-table-header',
    'table-cell': 'md-table-cell',
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

export function BlockDisplay(props: BlockDisplayProps) {
  // Check if content is a markdown table - uses token-based highlighting
  const isTable = createMemo(() => props.content && isMarkdownTable(props.content));

  // Parse table tokens if it's a table
  const tableTokens = createMemo(() => {
    if (!isTable()) return null;
    return parseTableTokens(props.content);
  });

  // Early exit optimization - if no formatting and not a table, just render plain text
  const hasFormatting = createMemo(() => hasInlineFormatting(props.content));

  // Parse inline tokens reactively - only for non-table content
  const tokens = createMemo(() => {
    if (isTable() || !hasFormatting()) return [];
    return parseAllInlineTokens(props.content);
  });

  return (
    <div class="block-display" aria-hidden="true">
      <Show when={tableTokens()} fallback={
        hasFormatting() ? (
          <For each={tokens()}>
            {(token) => <InlineTokenSpan token={token} />}
          </For>
        ) : (
          // No formatting - render plain text directly
          props.content
        )
      }>
        {(tblTokens) => (
          <For each={tblTokens()}>
            {(token) => <InlineTokenSpan token={token} />}
          </For>
        )}
      </Show>
    </div>
  );
}

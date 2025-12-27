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

import { createMemo, For } from 'solid-js';
import { parseInlineTokens, hasInlineFormatting, type InlineToken } from '../lib/inlineParser';

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
  };

  return (
    <span class={classMap[props.token.type] || ''}>
      {props.token.raw}
    </span>
  );
}

export function BlockDisplay(props: BlockDisplayProps) {
  // Early exit optimization - if no formatting, just render plain text
  const hasFormatting = createMemo(() => hasInlineFormatting(props.content));

  // Parse tokens reactively - only recomputes when content changes
  const tokens = createMemo(() => {
    if (!hasFormatting()) return [];
    return parseInlineTokens(props.content);
  });

  return (
    <div class="block-display" aria-hidden="true">
      {hasFormatting() ? (
        <For each={tokens()}>
          {(token) => <InlineTokenSpan token={token} />}
        </For>
      ) : (
        // No formatting - render plain text directly
        props.content
      )}
    </div>
  );
}

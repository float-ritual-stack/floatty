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
import { parseAllInlineTokens, hasInlineFormatting, type InlineToken } from '../lib/inlineParser';
import { findWikilinkEnd, parseWikilinkInner } from '../lib/wikilinkUtils';

interface BlockDisplayProps {
  content: string;
  /** Called when a [[wikilink]] is clicked. Receives target page name and mouse event. */
  onWikilinkClick?: (target: string, event: MouseEvent) => void;
}

interface TokenSpanProps {
  token: InlineToken;
  onWikilinkClick?: (target: string, event: MouseEvent) => void;
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
    const contentParts = renderWikilinkContent(props.token.raw, props.onWikilinkClick);

    return (
      <span
        class={getClass()}
        data-target={props.token.target}
        onClick={(e: MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          props.onWikilinkClick?.(props.token.target!, e);
        }}
      >
        {contentParts}
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
  // Early exit optimization - if no formatting, just render plain text
  const hasFormatting = createMemo(() => hasInlineFormatting(props.content));

  // Parse tokens reactively - only recomputes when content changes
  const tokens = createMemo(() => {
    if (!hasFormatting()) return [];
    return parseAllInlineTokens(props.content);
  });

  return (
    <div class="block-display" aria-hidden="true">
      {hasFormatting() ? (
        <For each={tokens()}>
          {(token) => (
            <InlineTokenSpan
              token={token}
              onWikilinkClick={props.onWikilinkClick}
            />
          )}
        </For>
      ) : (
        // No formatting - render plain text directly
        props.content
      )}
    </div>
  );
}

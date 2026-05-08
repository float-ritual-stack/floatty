// Backlink kind classifier — gives each LinkedReferences entry one of three
// shapes so the renderer can differentiate nav nodes from content blocks
// from leaf markers. The right axis for backlink legibility is structural
// depth, not character count: a heading-only block with children IS the
// page's section header, not the section's content.
//
// Mirrored on the Rust side as `classify_block_kind` in floatty-server's
// block_service.rs (PR-B). Both sides compose over their respective
// block-type parsers (`parseBlockType` here, `parse_block_type` there) —
// neither re-implements heading prefix detection.

import { parseBlockType, type Block } from './blockTypes';

export type BacklinkKind = 'nav_node' | 'content_block' | 'leaf_marker';

/**
 * Classify a backlink block by structural shape, NOT content length.
 *
 * - `leaf_marker`: heading-only + no children (pure crumb, like `## empty-section`).
 *   The "heading-only" qualifier matters — a heading WITH prose is a content
 *   block whether or not it has children, because the prose IS the content.
 * - `nav_node`: heading-only + has children (the daily-note `## arcs` /
 *   `## bones` case — auto-expand previews).
 * - `content_block`: anything else (the existing default render).
 *
 * The "heading_only" check is the load-bearing piece — `parseBlockType`
 * only categorizes the first line's prefix, doesn't tell you whether prose
 * follows. Edge cases verified:
 *
 *     "# foo"        → split slice rest "" → empty.trim() empty → true
 *     "# foo\n"      → rest is ""           → empty.trim() empty → true
 *     "# foo\n\n"    → rest is "\n"         → "\n".trim()  empty → true
 *     "# foo\nbody"  → rest is "body"       → "body".trim() text → false
 */
export function classifyBacklink(block: Block): BacklinkKind {
  const isHeading = ['h1', 'h2', 'h3'].includes(parseBlockType(block.content));
  const hasChildren = block.childIds.length > 0;
  const afterFirstLine = block.content.split('\n').slice(1).join('\n');
  const headingOnly = isHeading && afterFirstLine.trim() === '';

  if (headingOnly && hasChildren) return 'nav_node';
  if (headingOnly && !hasChildren) return 'leaf_marker';
  return 'content_block';
}

/**
 * Page title normalization — THE single frontend definition.
 *
 * PARITY CONTRACT: must match the server's `page_title_from_content`
 * (floatty-core/src/hooks/page_name_index.rs). Both sides derive a page's
 * name as: first line, strip a leading ATX heading marker (`#`s followed by
 * whitespace), trim. Lookups additionally compare case-insensitively.
 * If this drifts from the server, wikilink resolution and the twin
 * reconcile pass route the same name to different blocks (quirk-audit
 * cluster F split-brain).
 *
 * Lives in lib/ (leaf module, no store imports) so both
 * useBacklinkNavigation and useSyncedYDoc can use it without cycles.
 *
 * Examples:
 *   "# Summary\n[board:: recon]" → "Summary"
 *   "### Deep" → "Deep"
 *   "#2817" → "#2817"   (no whitespace after #, not a heading)
 *   "# #2817" → "#2817" (outer # is heading, inner # is part of the name)
 *   "No prefix" → "No prefix"
 */
export function getPageTitle(content: string): string {
  const firstLine = content.split('\n')[0];
  return firstLine.replace(/^#+\s+/, '').trim();
}

/**
 * Canonical section/page key for path-addressing (ADR-008 Decision 8).
 *
 * Composition ONLY: title extraction (`getPageTitle`) + lowercase. This is the
 * same key `find_or_create_page` / `findPage` already compare on
 * (`getPageTitle(x).toLowerCase()`), lifted to a named sibling so the matcher
 * and the write predicate share one definition. Markdown emphasis is
 * DELIBERATELY preserved here — stripping it is fuzzy rung 2 in the matcher,
 * kept out of rung 1 so the exact/write predicate stays strict.
 *
 * PARITY: mirrors `section_key_from_content` in floatty-core
 * `hooks/page_name_index.rs`; shared corpus `__fixtures__/path-grammar.json`
 * `canonicalize` section asserts both.
 */
export function getSectionKey(content: string): string {
  return getPageTitle(content).toLowerCase();
}

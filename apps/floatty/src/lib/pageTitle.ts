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

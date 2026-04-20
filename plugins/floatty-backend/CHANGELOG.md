# Changelog

All notable changes to `floatty-backend` are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
semver ([semver.org](https://semver.org/)). The authoritative version lives
in `marketplace.json` (per Claude Code's
[relative-path plugin guidance](https://code.claude.com/docs/en/plugin-marketplaces#version-resolution-and-release-channels)).

## [0.6.0] — 2026-04-20

ngrok browser-warning interstitial workaround. Discovered by a parallel kitty session probing `floatty.ngrok.app` from a sandbox environment — ngrok 3.37.6+ serves a 503 "DNS cache overflow" interstitial to agent UAs unless `ngrok-skip-browser-warning: 1` is set.

### Fixed

- `floatty_curl` in `scripts/floatty-api.sh` now sends `ngrok-skip-browser-warning: 1` on every request. Harmless on localhost (ignored), fixes the 503 interstitial on ngrok-tunneled floatty-server endpoints.

### Why it matters

Before 0.6.0, any agent calling `floatty_curl` against `https://*.ngrok.app` from a UA that triggered ngrok's anti-bot detection got `503 "DNS cache overflow"` instead of the real JSON response — misleading because the error body looks like a server failure, not a tunnel-interstitial.

## [0.5.0] — 2026-04-20

New doctrine section in `SKILL.md` on how to format block content for the floatty renderer. Authored by a parallel kitty session that initially landed the edit in the marketplace checkout (which gets clobbered on `/plugin marketplace update`) rather than the monorepo source — ported over here so it persists.

### Added

- **`Rules > Render hygiene — write shape matches read shape`** in `SKILL.md`. Four-layer doctrine covering:
  - Layer 0 — parser color semantics (code/pills/bold/timestamps/tree-chars)
  - Layer 1 — per-block content shape (one logical chunk, fenced trees, paragraph breaks)
  - Layer 2 — parent/child tree structure over flat ASCII art
  - Layer 3 — single-blob leaf captures (active_context stream discipline)
  - `◆` vs `•` convention for named-vs-ambient list items
  - Anti-patterns: over-pilling, 30-line ASCII trees inside one block, wall-of-numbered-prose
  - References external rule file at `~/.claude/rules/capture-format.md` for the full doctrine + examples

## [0.4.0] — 2026-04-20

Layout aligned with the Agent Skills convention. Scripts directory moved
inside the skill root so the skill can be zipped and uploaded to
claude.ai directly. See [[PR #254]].

### Added

- `${CLAUDE_PLUGIN_ROOT}` support in the `SKILL.md` setup snippet — the
  official Claude Code resolution mechanism per the Plugins reference,
  now the primary path. Legacy/zip fallback and version-descending cache
  glob kept as secondary resolution steps.
- `CHANGELOG.md` (this file).

### Changed

- **Breaking**: `scripts/` moved from `plugins/floatty-backend/scripts/`
  to `plugins/floatty-backend/skills/floatty-backend/scripts/`. Users
  sourcing via `$FLOATTY_SKILL_DIR/scripts/...` continue to work
  unchanged — the variable now points at the skill root instead of the
  plugin root. Users hard-coding `~/.claude/skills/floatty-backend/scripts/`
  also unaffected (that layout is unchanged). Users sourcing via
  `~/.claude/plugins/cache/...` paths directly need to update.
- `version` removed from `plugin.json`. Per the marketplace docs, for
  relative-path plugins the version should live only in the marketplace
  entry; setting it in both causes `plugin.json` to win silently. One
  version, one place going forward.
- Inline comments in all scripts updated to reflect the new install
  layouts (marketplace-cache / --plugin-dir / legacy / claude.ai zip).

### Fixed

- `SKILL.md` Vocabulary Discovery table previously implied `/stats`
  returned `{blockCount, markerCoverage}` — it actually returns
  `{totalBlocks, rootCount, typeDistribution, withMarkers, withOutlinks}`.
  Corrected.
- `SKILL.md` Page Search section previously implied scored results with
  `pageName` field. `/pages/search` actually returns
  `{pages: [{name, isStub, blockId}]}` with lowercased `name` and no
  `score`. Documented.

## [0.3.0] — 2026-04-20

### Fixed

- `SKILL.md` setup probe now picks the **highest** cached plugin version
  instead of whichever sorts first. Multi-version caches exist normally
  between `/plugin marketplace update` and the 7-day orphan GC; bash
  glob returns ascending, so `0.1.0` was winning over `0.2.0` without
  `sort -V -r`. See [[PR #253]].

## [0.2.0] — 2026-04-20

### Fixed

- Plugin cache now actually picks up fixes shipped on main. Claude Code's
  plugin cache is keyed by `plugin.json` version — file changes shipped
  under the same version string never trigger a re-fetch. The fix for
  `FLO-653` in [[PR #251]] didn't reach any installed machine until this
  bump. See [[PR #252]].

### Policy

Any change inside `plugins/floatty-backend/` going forward requires a
version bump in `marketplace.json` (and `plugin.json` until 0.4.0). This
is in the commit messages on PR #252 and will eventually be a CI check.

## [0.1.0] — 2026-04-20

Initial plugin marketplace release. See [[PR #250]].

### Added

- `floatty-backend` skill packaged as a Claude Code plugin distributed via
  the top-level `.claude-plugin/marketplace.json` catalog at the floatty
  monorepo root.
- 65 shell helpers wrapping the floatty-server REST API:
  - **Core**: `floatty_curl`, `floatty_health`
  - **Blocks CRUD**: `floatty_block_get`, `floatty_block_create`,
    `floatty_block_update`, `floatty_block_delete`,
    `floatty_block_context`, `floatty_block_tree`, `floatty_page`,
    `floatty_resolve`, `floatty_blocks_list`
  - **Search (20+ variants)**: `floatty_search`, `floatty_search_pages`,
    `floatty_search_pages_fuzzy`, `floatty_search_backlinks`,
    `floatty_search_by_marker`, `floatty_search_by_outlink`,
    `floatty_search_ctx_range`, `floatty_search_filter`,
    `floatty_search_exclude`, etc.
  - **Daily notes**: `floatty_daily_get`, `floatty_daily_append`,
    `floatty_daily_add`, `floatty_tldr`, `floatty_ctx`,
    `floatty_daily_find_or_create`, `floatty_page_upsert`
  - **Gardening**: `floatty_find_page`, `floatty_find_blocks`,
    `floatty_sort_children`, `floatty_dedup_pages`, `floatty_dedup_sh`,
    `floatty_orphan_sweep`
  - **Vocabulary**: `floatty_markers`, `floatty_marker_values`,
    `floatty_stats`
  - **Presence**: `floatty_presence`, `floatty_presence_context`
  - **Ops**: `floatty_topology`, `floatty_page_content`,
    `floatty_page_content_pretty`, `floatty_state_hash`,
    `floatty_export_binary`, `floatty_export_json`,
    `floatty_search_reindex`, `floatty_search_clear`,
    `floatty_backup_{status,list,config,trigger,restore}`
  - **Context CLI**: `floatty-context today|yesterday|sysop-notes|todos|project|meeting|search|block|context|tree` (runnable as a script)
- FLO-652 semantic endpoint wrappers (`floatty_page_upsert`,
  `floatty_daily_append`) with 404 fallback for pre-FLO-652 release
  servers.
- `references/` progressive disclosure docs: `api-reference.md`,
  `helpers.md`, `workflows.md`, `anti-patterns.md`.

### Fixed in the initial cut

- `floatty_daily_find_or_create` previously ran a heading search for
  `## $date` and, on miss, created a root-level `## $date` block — wrong
  shape AND wrong location. Replaced with a direct `GET /api/v1/daily/:date`
  lookup. See [[FLO-636]].
- `floatty_find_page` previously downloaded every block and ran a Python
  filter to find pages by name. Now uses `GET /api/v1/pages/search`
  (PageNameIndex) — 6.8× faster (183ms → 27ms), supports `isStub`.
- 12 new helper wrappers added for previously-unwrapped endpoints
  (topology, page content, export, backup, etc.). Audit surfaced during
  [[PR #250]] code review — see commit `4312867`.
- 3 critical `garden.sh` Python-heredoc arg bugs: quoted heredocs were
  receiving no args, so `--fix` / `--dry-run` flags were always false.
- `api.sh` URL resolution: explicit `FLOATTY_URL` now wins over localhost
  probe (was silently redirecting ngrok / Desktop Daddy flows).
- Source guards in blocks/garden/daily switched from `$FLOATTY_URL`
  (preset in floatty terminals) to `declare -F floatty_curl` — correctly
  detects whether the function has been defined rather than whether a
  URL exists.

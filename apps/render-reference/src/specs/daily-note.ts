/**
 * Daily Note — preferred shape per render agent self-audit 2026-04-20.
 * Uses ArcTimeline (replaces 5 PatternCards + hand-written timelog),
 * MetadataHeader, QuoteBlock, StatsBar, Section + GapItems, BacklinksFooter.
 */

import type { Spec } from '@json-render/core';

export const dailyNoteSpec: Spec = {
  root: 'doc',
  state: {},
  elements: {
    doc: {
      type: 'Stack',
      props: { direction: 'vertical', gap: 16, padding: 16 },
      children: ['header', 'shape', 'ship-stats', 'timelog', 'corrections-sec', 'doctrine-sec', 'backlinks'],
    },

    header: {
      type: 'MetadataHeader',
      props: {
        title: 'Doctrine morning, two parallel ships, three corrections',
        subtitle: 'Monday after go-live week — opened with markers, ended with evna dogfooding its own recovery',
        date: '2026-04-20',
      },
    },

    shape: {
      type: 'QuoteBlock',
      props: {
        type: 'insight',
        text: "Two parallel ship-lines (evna recall fix + floatty-backend plugin marketplace) interwoven with generi-co (quiet brain-boot → sam sync → SFC single-line fix). Three wrap-corrections landed as footnotes, not rewrites. The day's cohesion is the material-correction discipline — repeated three times against three different diagnoses.",
        attribution: 'shape of the day',
      },
    },

    'ship-stats': {
      type: 'StatsBar',
      props: {
        layout: 'row',
        stats: [
          { label: 'arcs', value: '5', color: '#00e5ff' },
          { label: 'ships', value: 'evna recall · floatty 0.7.1 · SFC #4', color: '#98c379' },
          { label: 'corrections', value: '3', color: '#ffb300' },
          { label: 'FLO filed', value: '655 · 656 · 657 · 658 · 659', color: '#e040a0' },
        ],
      },
    },

    // ArcTimeline — the purpose-built component the self-audit recommended.
    // One component replaces a hand-written timelog + 5 PatternCards stuffed with arc narrative.
    timelog: {
      type: 'ArcTimeline',
      props: {
        title: '2026-04-20 TIMELOG',
        arcs: [
          { name: 'Morning doctrine', start: '06:53', end: '10:23', project: 'float-hub' },
          { name: 'Floatty plugin marketplace', start: '12:37', end: '17:50', project: 'floatty' },
          { name: 'Evna three-layer detour', start: '14:14', end: '15:15', project: 'evna' },
          { name: 'Generi-Co sam sync', start: '13:17', end: '15:06', project: 'generi-co' },
          { name: 'SFC ship + wrap', start: '15:21', end: '15:42', project: 'generi-co' },
        ],
        entries: [
          { time: '06:53', label: 'inline markers doctrine → userStyle + memory #28', project: 'float-hub' },
          { time: '07:35', label: 'evna chunking gap — supersedes:: primitive named', project: 'float-hub' },
          { time: '07:47', label: 'session wrap — marathon-framing correction, memory #29', project: 'float-hub' },
          { time: '08:29', label: 'bbs-cli-daddy + bbs-enrichment YAML → single-line []', project: 'float-hub' },
          { time: '08:57', label: 'bun aube pebble → symlinks fix, 7× warm install', project: 'float-hub' },
          { time: '09:54', label: 'echo-refactor target:: env param → divergence axis', project: 'float-hub' },
          { time: '10:00', label: 'inline marker discipline extended to prose', project: 'float-hub' },
          { time: '10:23', label: 'desktop-daddy userStyle marker imperative flagged', project: 'float-hub' },
          { time: '12:37', label: 'PR #250 rescue → skill API audit → marketplace', project: 'floatty' },
          { time: '14:35', label: 'ngrok tunnel sick (DNS cache overflow loop)', project: 'evna' },
          { time: '14:47', label: 'doctrine → rename connector when MCP bridge stuck', project: 'evna' },
          { time: '14:55', label: 'dogfooding win → lf1m capture 0.81 top-rank', project: 'evna' },
          { time: '15:15', label: 'evna-remote MCP recovery via session resume', project: 'evna' },
          { time: '13:17', label: '[meeting::sam-sync] basket bug + warning ticket thin', project: 'generi-co' },
          { time: '15:06', label: 'basket-bug cowboy correction: 3-fn may not match code', project: 'generi-co' },
          { time: '15:21', label: 'PR #4 Supabase transaction-pooler prepare:false fix', project: 'generi-co' },
          { time: '15:42', label: '/util:daily-sync + /generi-co:sync wrap', project: 'float-hub' },
        ],
      },
    },

    // Corrections Section — using GapItem for each correction.
    'corrections-sec': {
      type: 'Section',
      props: { title: 'Cross-cutting — three wrap corrections, same discipline', variant: 'warning' },
      children: ['c1', 'c2', 'c3', 'c-rule'],
    },
    c1: {
      type: 'GapItem',
      props: {
        severity: 'warning',
        description: "Basket bug (sam sync wrap) — Kai's stated 3-fn diagnosis may not match code; cowboy investigation 03:06 PM. Wrap stands with footnote, Jordan's AM investigation = confirmation point.",
        target: 'ARC 2 · generi-co/pharma-app',
      },
    },
    c2: {
      type: 'GapItem',
      props: {
        severity: 'warning',
        description: 'ngrok 503 cause — "DNS cache overflow" body is misleading; actually browser-warning interstitial. Daddy correction 04:32 PM. Header fix replaces cleanup-restart loop as real remedy.',
        target: 'ARC 4 · evna layer 1',
      },
    },
    c3: {
      type: 'GapItem',
      props: {
        severity: 'info',
        description: 'MCP bridge stuck — rename connector, don\'t restart. Fresh-name forces Anthropic-side teardown. Doctrine banked.',
        target: 'ARC 4 · evna layer 2',
      },
    },
    'c-rule': {
      type: 'QuoteBlock',
      props: {
        type: 'quote',
        text: "Material-correction discipline: when post-wrap investigation finds the wrap's diagnosis may be wrong, add a footnote + flag for the next human checkpoint — do not rewrite. Wraps capture what was known at wrap-time. Corrections layer on top. Applied three times today.",
        attribution: 'doctrine landed 2026-04-20',
      },
    },

    'doctrine-sec': {
      type: 'Section',
      props: { title: 'Doctrine landed today', variant: 'highlight' },
      children: ['d1', 'd2', 'd3', 'd4'],
    },
    d1: {
      type: 'QuoteBlock',
      props: {
        type: 'insight',
        text: 'Inline markers live in prose + section headers + responses — not only captures. Ceremony on `ctx::`, substance skipped on `project::` / `mode::` / `type::` / `bridge::` is backwards.',
        attribution: 'memory #28 · userStyle',
      },
    },
    d2: {
      type: 'QuoteBlock',
      props: {
        type: 'insight',
        text: 'When the MCP bridge looks stuck — rename the connector, don\'t restart. Same-name re-add does not trigger fresh handshake; a new name does.',
        attribution: 'evna type::doctrine',
      },
    },
    d3: {
      type: 'QuoteBlock',
      props: {
        type: 'insight',
        text: 'Claude Code plugin cache is semver-keyed, not SHA-keyed. Every plugin-file change requires a version bump in BOTH `plugin.json` and `marketplace.json` — otherwise the fix dies in cache.',
        attribution: 'floatty-backend 7-PR lesson',
      },
    },
    d4: {
      type: 'QuoteBlock',
      props: {
        type: 'insight',
        text: 'Defensive fallbacks like `similarity ?? threshold` make missing data look like real low values. Same anti-pattern shape hid flat-0.9 for 5 months and flat-0.1 for 6 hours. Prefer explicit null/NaN.',
        attribution: 'evna recall fix postmortem',
      },
    },

    backlinks: {
      type: 'BacklinksFooter',
      props: {
        inbound: ['2026-04-19', '2026-W17-index.bridge'],
        outbound: [
          '2026-04-21',
          '2026-04-20-evna-and-the-detours',
          '2026-04-20-pharma-sam-sync-basket-bug-assessment-warning',
          '2026-04-20-fuck-off-fixed-it-mcp-bridge-rename-doctrine-evna-',
          'FLO-655',
          'FLO-656',
          'FLO-657',
        ],
      },
    },
  },
};

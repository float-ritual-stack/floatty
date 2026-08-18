/**
 * render:: reference App
 *
 * Authoritative reference renders for common floatty content types.
 * Each spec runs through @json-render/solid's Renderer with the real
 * catalog + registry + components from the floatty render door.
 *
 * This is NOT hand-rolled CSS mimicry — it's the real rendering pipeline.
 */

import { createSignal, For } from 'solid-js';
import { Key } from '@solid-primitives/keyed';
import { Renderer, JSONUIProvider } from '@json-render/solid';
import { JsonRenderDevtools } from '@json-render/devtools-solid';
import { markDevtoolsActive } from '@json-render/core';
import type { Spec } from '@json-render/core';

// Pre-activate the devtools flag at module scope so the Renderer picks the
// "wrap in <span data-jr-key>" branch from the very first render.
//
// Why: @json-render/solid@0.18.0's ElementRendererContent captures a `rendered`
// JSX reference and uses it in BOTH the Show fallback and children branches:
//
//     const rendered = <Component>{children()}</Component>;
//     <Show when={devtoolsActive() && elementKey} fallback={rendered}>
//       <span data-jr-key={elementKey}>{rendered}</span>
//     </Show>
//
// When devtoolsActive toggles from false→true AFTER the first render (because
// JsonRenderDevtools calls markDevtoolsActive() in onMount, which fires after
// Renderer has already mounted via the fallback path), Solid tries to re-parent
// the same reactive node from the fallback slot into the span — and ends up with
// an empty <span data-jr-key="doc"></span> at the root, zero descendants.
//
// Calling markDevtoolsActive() at module load (before App mounts) makes the
// Show pick the span branch on the first render, so `rendered` only ever
// mounts once. The returned releaser is intentionally never called — we want
// the flag to stay set for the lifetime of the SPA.
markDevtoolsActive();

// Real catalog + registry from the floatty render door (via vite alias)
import { bbsCatalog } from '@render-door/catalog';
import { registry as bbsRegistry } from '@render-door/registry';

// Our 14 reference specs
import { dailyNoteSpec } from './specs/daily-note';
import { weeklyTrackerSpec } from './specs/weekly-tracker';
import { meetingNotesSpec } from './specs/meeting-notes';
import { sprintWrapSpec } from './specs/sprint-wrap';
import { standupHeadlineSpec } from './specs/standup-headline';
import { bbsPostSpec } from './specs/bbs-post';
import { catalogAtomsSpec } from './specs/catalog-atoms';
import { conceptualPatternsSpec } from './specs/conceptual-patterns';
import { synthFidgetSpec } from './specs/synth-fidget';
import { presetRigSpec } from './specs/preset-rig';
import { hubStackSpec } from './specs/hub-stack';
import { hubTuiGridSpec } from './specs/hub-tui-grid';
import { hubFilteredSpec } from './specs/hub-filtered';
import { hubRichSpec } from './specs/hub-rich';

type LayoutEntry = {
  id: string;
  label: string;
  description: string;
  spec: Spec;
};

const LAYOUTS: LayoutEntry[] = [
  {
    id: 'daily-note',
    label: '1. Daily Note',
    description: 'ArcTimeline + QuoteBlock doctrine band + GapItem corrections + BacklinksFooter.',
    spec: dailyNoteSpec,
  },
  {
    id: 'weekly-tracker',
    label: '2. Weekly Tracker',
    description: 'MetadataHeader + EntryBody tables + DecisionLog for meeting decisions.',
    spec: weeklyTrackerSpec,
  },
  {
    id: 'meeting-notes',
    label: '3. Meeting Notes',
    description: 'PatternCard per decision + MeetingDiff for process delta + action table.',
    spec: meetingNotesSpec,
  },
  {
    id: 'sprint-wrap',
    label: '4. Sprint Wrap (W15)',
    description: 'StatsBar + TuiPanel SHIPPED/SLIPPED + PatternCard for crystallized patterns.',
    spec: sprintWrapSpec,
  },
  {
    id: 'standup-headline',
    label: '5. Standup Headline',
    description: 'GapItem for blockers + DependencyChain for issue deps + QuoteBlock Q&A.',
    spec: standupHeadlineSpec,
  },
  {
    id: 'bbs-post',
    label: '6. BBS Post / Long-form',
    description: 'EntryHeader + QuoteBlock tldr + Section per beat. Pushes past the "## → h2" markdown floor: Callout(question) wraps the catch-probe, nested Callout(failure) holds the honest answer, Callout(warning) escalates with a nested Callout(danger) for the load-bearing diagnosis, Callout(example) for "where it applies", TreeView only where genuinely tree-shaped (countermeasures with statused sub-paths), Callout(tip) for THE rule, Callout(abstract) for bridges. No pre-blocks of ASCII tree chars — each shape gets its right primitive.',
    spec: bbsPostSpec,
  },
  {
    id: 'catalog-atoms',
    label: '7. Catalog Atoms',
    description: 'Coverage map. Every catalog component the 6 composition specs don\'t already exercise, rendered in isolation through the real @json-render/solid pipeline. 35 atoms grouped by section. If it renders here, the wiring works.',
    spec: catalogAtomsSpec,
  },
  {
    id: 'conceptual-patterns',
    label: '8. Conceptual Patterns',
    description: 'How to shape a spec to achieve X. JSON side-by-side with live render. Six patterns: visibility conditions, TabNav + visibility switching, sibling-visibility value switch, $cond on prop values, repeat + $item/$template for dynamic lists, Stack + Section composition.',
    spec: conceptualPatternsSpec,
  },
  {
    id: 'synth-fidget',
    label: '9. Synth Fidget',
    description: 'Techno-fidget audio components. Tone (single voice), DrumPad (click grid), StepSequencer (transport + 16-step grid), AcidBass (303-style mono bass), EuclideanDrums (Bjorklund n-of-k generator), XYPad (continuous filter sweep). All Web Audio, no libraries. Click anything; sound unlocks on first interaction. Section 0 (Rig) shows MasterClock + MasterFX driving slave-mode sequencers.',
    spec: synthFidgetSpec,
  },
  {
    id: 'preset-rig',
    label: '10. Preset Rig',
    description: 'Full techno-fidget rig assembled entirely from synth-presets.ts imports — drum kits, patterns, acid lines, euclidean classics, send recipes. Demonstrates compose-not-synthesize: agents grab from the library; remix by swapping one import name. Edit the spec to change recipes.',
    spec: presetRigSpec,
  },
  {
    id: 'hub-stack',
    label: '11. Hub · Card Stack',
    description: 'Hub-page Option 1 (familiar dashboard). MetadataHeader + StatsBar → CollapsibleSection × 4 (recent / decisions / meetings / docs) → BacklinksFooter. One column, top-to-bottom, sections collapse for scan and expand for detail.',
    spec: hubStackSpec,
  },
  {
    id: 'hub-tui-grid',
    label: '12. Hub · TUI Grid',
    description: 'Hub-page Option 2 (terminal-feel status board). TuiStat row + 2-column TuiPanel grid: Recent + Decisions on the left, Meetings + Docs (TreeView) + Open Questions on the right. Information density over whitespace; tabular shape over collapsibles.',
    spec: hubTuiGridSpec,
  },
  {
    id: 'hub-filtered',
    label: '13. Hub · TabNav Filtered',
    description: 'Hub-page Option 3 (interactive). TabNav at top switches a single body section via $bindState — Recent / Decisions / Meetings / Docs cycle one at a time. Persistent header + footer; only the body changes. Same state-switching primitive as conceptual-patterns.',
    spec: hubFilteredSpec,
  },
  {
    id: 'hub-rich',
    label: '14. Hub · Rich Primitives',
    description: 'Uses the four new rich-doc components: Hero (page intro with eyebrow/cover/actions), GalleryGrid + CardCover (Notion-style collection of recent work with cover-icons + properties pills + footer), Callout (typed/nestable/foldable — info pinned at top with nested quote + warning, success/note/abstract/question section wrappers, nested bug callout in Open Questions). Plus existing LinkGraph and ActivityHeatmap to fill the visualization layer.',
    spec: hubRichSpec,
  },
];

/**
 * Serialise a gallery entry as a paste-ready floatty block.
 *
 * These specs are already complete (`root` + `elements`) and are verified by
 * construction — this app renders them through the real catalog, so a broken
 * one fails visibly here first. That makes them the trustworthy source for
 * "give me a working render:: block", unlike the fragments in
 * `~/.floatty/doors/render/agent/patterns.html`, 10 of whose 14 examples
 * aren't valid JSON (`//` comments, truncations, unquoted keys).
 *
 * The `[title:: …]` marker matters: without it the render door fetches a title
 * via a SECOND async `claude -p` call after the spec already rendered, so the
 * block shows raw spec JSON in the editor until that lands — and permanently
 * if it fails. With the marker `extractTitle` sets it synchronously.
 * See `.claude/rules/render-door-agent.md`.
 */
function toRenderBlock(layout: LayoutEntry): string {
  // Strip the gallery ordinal ("1. Daily Note" → "Daily Note") — the number is
  // a nav affordance here, not part of the block's identity in the outline.
  const title = layout.label.replace(/^\d+\.\s*/, '').trim();
  return `render:: [title:: ${title}] ${JSON.stringify(layout.spec)}`;
}

export function App() {
  const [activeId, setActiveId] = createSignal(LAYOUTS[0].id);
  const [copied, setCopied] = createSignal(false);

  const active = () => LAYOUTS.find((l) => l.id === activeId()) ?? LAYOUTS[0];

  const copySpec = async () => {
    const text = toRenderBlock(active());
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      // Clipboard API needs a secure context; fall back for file:// previews
      // and older webviews so the button is never a dead control.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      try {
        ta.select();
        // Returns false without throwing when the copy is refused — the
        // indicator must follow that result, not the attempt.
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      } finally {
        ta.remove();
      }
    }
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div class="app">
      <aside class="tabs">
        <div class="tabs-brand">
          <h1>render:: reference</h1>
          <p>
            Authoritative layouts rendered via <code>@json-render/solid</code>.
            Not mockups — real pipeline output.
          </p>
        </div>
        <For each={LAYOUTS}>
          {(layout) => (
            <button
              class={`tab ${activeId() === layout.id ? 'active' : ''}`}
              onClick={() => setActiveId(layout.id)}
            >
              {layout.label}
            </button>
          )}
        </For>
      </aside>

      <main class="main">
        <div class="main-header">
          <h2>
            {active().label}
            <span class="pipeline-badge">@json-render/solid</span>
            <button
              class={`copy-spec ${copied() ? 'copied' : ''}`}
              onClick={copySpec}
              title="Copy as a render:: block — paste straight into the floatty outline"
            >
              {copied() ? '✓ copied' : 'copy render:: block'}
            </button>
          </h2>
          <div class="meta">{active().description}</div>
        </div>

        <div class="render-area">
          {/*
            Re-key the provider stack on activeId so StateProvider reads
            `initialState` anew on every layout switch. Without this, state
            mutations from one spec persist silently into the next because
            @json-render's StateProvider captures initialState once at mount
            (see node_modules/@json-render/solid/dist/index.mjs:17-22).

            Greptile: 3114157962 | CodeRabbit: 3120946042
          */}
          <Key each={[activeId()]} by={(id) => id}>
            {(id) => (
              <JSONUIProvider
                registry={bbsRegistry}
                initialState={active().spec.state ?? {}}
                handlers={{}}
              >
                <Renderer spec={active().spec} registry={bbsRegistry} />
                <JsonRenderDevtools
                  spec={active().spec}
                  catalog={bbsCatalog as any}
                  position="right"
                />
              </JSONUIProvider>
            )}
          </Key>
        </div>
      </main>
    </div>
  );
}

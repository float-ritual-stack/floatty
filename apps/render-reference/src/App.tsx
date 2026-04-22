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

// Our 8 reference specs
import { dailyNoteSpec } from './specs/daily-note';
import { weeklyTrackerSpec } from './specs/weekly-tracker';
import { meetingNotesSpec } from './specs/meeting-notes';
import { sprintWrapSpec } from './specs/sprint-wrap';
import { standupHeadlineSpec } from './specs/standup-headline';
import { bbsPostSpec } from './specs/bbs-post';
import { catalogAtomsSpec } from './specs/catalog-atoms';
import { conceptualPatternsSpec } from './specs/conceptual-patterns';

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
    description: 'EntryHeader + QuoteBlock tldr + Section per beat + pull-quote catch-probe + RefSection + TagBar + BacklinksFooter. Content-centric, not dashboard.',
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
];

export function App() {
  const [activeId, setActiveId] = createSignal(LAYOUTS[0].id);

  const active = () => LAYOUTS.find((l) => l.id === activeId()) ?? LAYOUTS[0];

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

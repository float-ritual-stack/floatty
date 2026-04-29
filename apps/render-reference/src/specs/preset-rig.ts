/**
 * Preset rig — a full techno-fidget rig assembled entirely from
 * synth-presets.ts imports. Demonstrates: agents do not synthesize
 * patterns from scratch — they compose pre-baked kits + patterns +
 * acid lines + euclidean classics + send recipes.
 *
 * Switch any single import to remix the rig without touching the spec
 * shape: change `drumKits.technoPure` → `drumKits.dubTechno`, change
 * `acidLines.rolling` → `acidLines.hoover`, etc.
 */
import type { Spec } from '@json-render/core';
import {
  drumKits,
  drumPatterns,
  drumPadKits,
  acidLines,
  euclidClassics,
  sendRecipes,
  scales,
} from './synth-presets';

export const presetRigSpec: Spec = {
  root: 'doc',
  state: {},
  elements: {
    doc: {
      type: 'Stack',
      props: { direction: 'vertical', gap: 18, padding: 16 },
      children: [
        'header',
        'banner',
        'recipe',
        'master-row',
        'drums-h',
        'drums',
        'bass-h',
        'bass',
        'euclid-h',
        'euclid',
        'pads-h',
        'pads',
        'tones-h',
        'tones-row',
        'remix-doc',
      ],
    },

    header: {
      type: 'MetadataHeader',
      props: {
        title: 'Preset rig — composed from synth-presets.ts',
        subtitle: '[project::floatty/render-door] [mode::compose-not-synthesize] [audio::WebAudio]',
        date: '2026-04-29',
      },
    },

    banner: {
      type: 'QuoteBlock',
      props: {
        type: 'insight',
        text: 'Every block below is one or two imports — drumKits.technoPure + drumPatterns.fourOnFloor, acidLines.rolling, euclidClassics.cascading. Swap any single name to remix the rig.',
      },
    },

    recipe: {
      type: 'EntryBody',
      props: {
        markdown:
          '**Recipe**: `technoPure` kit + `fourOnFloor` pattern + `rolling` acid line + `cascading` euclid + `dub` send recipe.\n\n' +
          'All slaved to `clock: \'main\'`. Hit the master clock and watch them lock together.',
      },
    },

    'master-row': {
      type: 'Stack',
      props: { direction: 'horizontal', gap: 14 },
      children: ['master-clock', 'master-fx'],
    },

    'master-clock': {
      type: 'MasterClock',
      props: { rigId: 'main', bpm: 124, steps: 16, title: 'tap PLAY → all blocks lock' },
    },

    'master-fx': {
      type: 'MasterFX',
      props: { rigId: 'main', delayTime: 0.42, delayFeedback: 0.42, delayMix: 0.32, reverbMix: 0.30, title: 'shared bus' },
    },

    'drums-h': {
      type: 'Text',
      props: { content: '## Drums — drumKits.technoPure + drumPatterns.fourOnFloor', size: 'lg', weight: 'bold' },
    },

    drums: {
      type: 'StepSequencer',
      props: {
        title: 'technoPure / fourOnFloor',
        clock: 'main',
        rigId: 'main',
        sends: sendRecipes.glow,
        steps: 16,
        tracks: drumKits.technoPure,
        initial: drumPatterns.fourOnFloor,
      },
    },

    'bass-h': {
      type: 'Text',
      props: { content: '## Bass — acidLines.rolling + sendRecipes.acid', size: 'lg', weight: 'bold' },
    },

    bass: {
      type: 'AcidBass',
      props: {
        title: 'rolling — sends → delay+reverb',
        clock: 'main',
        rigId: 'main',
        sends: sendRecipes.acid,
        steps: 16,
        ...acidLines.rolling,
      },
    },

    'euclid-h': {
      type: 'Text',
      props: { content: '## Polyrhythm — euclidClassics.cascading + sendRecipes.echoes', size: 'lg', weight: 'bold' },
    },

    euclid: {
      type: 'EuclideanDrums',
      props: {
        title: 'cascading polyrhythm — sends → delay',
        clock: 'main',
        rigId: 'main',
        sends: sendRecipes.echoes,
        steps: 16,
        tracks: euclidClassics.cascading,
      },
    },

    'pads-h': {
      type: 'Text',
      props: { content: '## Pads (one-shot) — drumPadKits.bash', size: 'lg', weight: 'bold' },
    },

    pads: {
      type: 'DrumPad',
      props: {
        title: 'click bash kit',
        rigId: 'main',
        sends: sendRecipes.glow,
        columns: 4,
        pads: drumPadKits.bash,
      },
    },

    'tones-h': {
      type: 'Text',
      props: { content: '## Melodic — scales.minorPent', size: 'lg', weight: 'bold' },
    },

    'tones-row': {
      type: 'Stack',
      props: { direction: 'horizontal', gap: 6 },
      children: scales.minorPent.map((_, i) => `tone-${i}`),
    },

    ...Object.fromEntries(
      scales.minorPent.map((toneProps, i) => [
        `tone-${i}`,
        {
          type: 'Tone',
          props: { ...toneProps, rigId: 'main', sends: sendRecipes.glow },
        },
      ])
    ),

    'remix-doc': {
      type: 'EntryBody',
      props: {
        markdown:
          '### Remix recipes\n\n' +
          'Edit `apps/render-reference/src/specs/preset-rig.ts` and swap one name:\n\n' +
          '- `drumKits.technoPure` → `drumKits.dubTechno` | `tribal` | `glitch` | `minimal`\n' +
          '- `drumPatterns.fourOnFloor` → `halfTime` | `breakbeat` | `tribal` | `glitch` | `minimal` | `hatChain`\n' +
          '- `acidLines.rolling` → `slidey` | `percussive` | `dnbBass` | `hoover`\n' +
          '- `euclidClassics.cascading` → `afroCuban` | `aksak` | `hatStorm` | `sparseDrift`\n' +
          '- `drumPadKits.bash` → `bassTones` | `bleeps`\n' +
          '- `scales.minorPent` → `phrygDom` | `wholeTone`\n' +
          '- `sendRecipes.glow` → `dry` | `wash` | `echoes` | `dub` | `acid` | `hatGlue`\n\n' +
          'See `synth-presets.ts` for additions. Adding a new kit/pattern/line is a 5-line PR.',
      },
    },
  },
};

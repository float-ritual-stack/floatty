/**
 * Synth Fidget — techno-fidget audio components.
 *
 * Tone (single button), DrumPad (grid of click-to-play pads), StepSequencer
 * (multi-track 16-step grid with PLAY transport), AcidBass (303-style mono
 * bass with per-step pitch/accent/slide + filter envelope), EuclideanDrums
 * (Bjorklund n-of-k pattern generator), XYPad (continuous filter sweep
 * with sustained drone).
 *
 * All audio runs on a shared module-singleton AudioContext that lazy-inits
 * on first user gesture (browser autoplay policy).
 */
import type { Spec } from '@json-render/core';

export const synthFidgetSpec: Spec = {
  root: 'doc',
  state: {},
  elements: {
    doc: {
      type: 'Stack',
      props: { direction: 'vertical', gap: 20, padding: 16 },
      children: [
        'header',
        'banner',
        'rig-h',
        'rig-readme',
        'rig-master-row',
        'rig-stepseq',
        'rig-acid',
        'rig-euclid',
        'tone-h',
        'tone-row',
        'drumpad-h',
        'drumpad',
        'stepseq-h',
        'stepseq',
        'acidbass-h',
        'acidbass',
        'euclid-h',
        'euclid',
        'xypad-h',
        'xypad-row',
        'footer',
      ],
    },

    header: {
      type: 'MetadataHeader',
      props: {
        title: 'Synth Fidget — techno toys',
        subtitle: '[project::floatty/render-door] [mode::yolo] [audio::WebAudio]',
        date: '2026-04-29',
      },
    },

    banner: {
      type: 'QuoteBlock',
      props: {
        type: 'insight',
        text: 'Click anything. AudioContext unlocks on first interaction. Volume up but not up-up.',
      },
    },

    'rig-h': {
      type: 'Text',
      props: { content: '## 0. Rig — multi-block sync via MasterClock + MasterFX', size: 'lg', weight: 'bold' },
    },

    'rig-readme': {
      type: 'EntryBody',
      props: {
        markdown:
          'Below: a **MasterClock** + **MasterFX** drive three slave sequencers.\n\n' +
          '- `clock: \'main\'` makes a sequencer follow rig `main` (no own transport — see △ badge).\n' +
          '- `sends: { delay, reverb }` routes audio through MasterFX on the same `rigId`.\n' +
          '- Hit PLAY on the master and all three slaves tick in sync. Tweak filter knobs on the AcidBass while the rig runs; tweak hits/rotation on the Euclidean tracks; everything stays locked.\n\n' +
          'This is the rig pattern — composable blocks instead of one monolith. Same primitive scales to N rigs (`rigId: \'aux\'` for a polyrhythm bus).',
      },
    },

    'rig-master-row': {
      type: 'Stack',
      props: { direction: 'horizontal', gap: 14 },
      children: ['rig-master-clock', 'rig-master-fx'],
    },

    'rig-master-clock': {
      type: 'MasterClock',
      props: {
        rigId: 'main',
        bpm: 124,
        steps: 16,
        title: 'drives all clock="main" slaves',
      },
    },

    'rig-master-fx': {
      type: 'MasterFX',
      props: {
        rigId: 'main',
        delayTime: 0.42,
        delayFeedback: 0.42,
        delayMix: 0.32,
        reverbMix: 0.28,
        title: 'shared by all sends',
      },
    },

    'rig-stepseq': {
      type: 'StepSequencer',
      props: {
        title: 'drums (slave) — sends → reverb',
        clock: 'main',
        rigId: 'main',
        sends: { reverb: 0.4 },
        steps: 16,
        tracks: [
          { label: 'KICK',  freq: 60,   wave: 'sine',     duration: 180, color: '#ff4444' },
          { label: 'SNARE', freq: 200,  wave: 'square',   duration: 100, color: '#ffb300' },
          { label: 'HAT',   freq: 6500, wave: 'sawtooth', duration: 50,  color: '#00e5ff' },
          { label: 'PERC',  freq: 320,  wave: 'triangle', duration: 90,  color: '#e040a0' },
        ],
        initial: [
          [true, false, false, false, true, false, false, false, true, false, false, false, true, false, false, false],
          [false, false, false, false, true, false, false, false, false, false, false, false, true, false, false, false],
          [false, false, true, false, false, false, true, false, false, false, true, false, false, false, true, false],
          [false, false, false, false, false, false, false, true, false, false, false, false, false, false, true, false],
        ],
      },
    },

    'rig-acid': {
      type: 'AcidBass',
      props: {
        title: 'bass (slave) — sends → delay + reverb',
        clock: 'main',
        rigId: 'main',
        sends: { delay: 0.5, reverb: 0.2 },
        steps: 16,
        notes: [0, null, 12, 0, 3, null, 7, 0, 0, null, 10, 5, 0, null, 7, 3],
        accents: [true, false, false, false, true, false, false, false, true, false, false, false, true, false, false, false],
        slides:  [false, false, true, false, false, false, false, false, false, false, true, false, false, false, false, false],
        baseFreq: 55,
        wave: 'sawtooth',
        cutoff: 700,
        resonance: 16,
        envAmount: 2600,
        envDecay: 200,
      },
    },

    'rig-euclid': {
      type: 'EuclideanDrums',
      props: {
        title: 'polyrhythm layer (slave) — sends → delay',
        clock: 'main',
        rigId: 'main',
        sends: { delay: 0.35 },
        steps: 16,
        tracks: [
          { label: 'TOM',   hits: 5, rotation: 1, freq: 160, wave: 'triangle', duration: 90,  color: '#a02070' },
          { label: 'BLIP',  hits: 7, rotation: 0, freq: 880, wave: 'sine',     duration: 50,  color: '#98c379' },
          { label: 'CLAVE', hits: 3, rotation: 2, freq: 1500, wave: 'square',   duration: 40,  color: '#ffb300' },
        ],
      },
    },

    'tone-h': {
      type: 'Text',
      props: { content: '## 1. Tone — single voice', size: 'lg', weight: 'bold' },
    },

    'tone-row': {
      type: 'Stack',
      props: { direction: 'horizontal', gap: 8 },
      children: ['tone-c4', 'tone-e4', 'tone-g4', 'tone-c5', 'tone-saw', 'tone-sq'],
    },

    'tone-c4': { type: 'Tone', props: { freq: 261.63, label: 'C4', wave: 'sine', color: '#00e5ff' } },
    'tone-e4': { type: 'Tone', props: { freq: 329.63, label: 'E4', wave: 'sine', color: '#00e5ff' } },
    'tone-g4': { type: 'Tone', props: { freq: 392.0, label: 'G4', wave: 'sine', color: '#00e5ff' } },
    'tone-c5': { type: 'Tone', props: { freq: 523.25, label: 'C5', wave: 'sine', color: '#00e5ff' } },
    'tone-saw': { type: 'Tone', props: { freq: 220.0, label: 'A3 saw', wave: 'sawtooth', color: '#e040a0', duration: 350 } },
    'tone-sq': { type: 'Tone', props: { freq: 110.0, label: 'A2 sq', wave: 'square', color: '#ffb300', duration: 350 } },

    'drumpad-h': {
      type: 'Text',
      props: { content: '## 2. DrumPad — click to bash', size: 'lg', weight: 'bold' },
    },

    drumpad: {
      type: 'DrumPad',
      props: {
        title: 'Bash kit',
        columns: 4,
        pads: [
          { label: 'KICK',  freq: 60,   wave: 'sine',     duration: 200, color: '#ff4444' },
          { label: 'SNARE', freq: 200,  wave: 'square',   duration: 120, color: '#ffb300' },
          { label: 'HAT',   freq: 6500, wave: 'sawtooth', duration: 60,  color: '#00e5ff' },
          { label: 'PERC',  freq: 320,  wave: 'triangle', duration: 100, color: '#e040a0' },
          { label: 'TOM-L', freq: 110,  wave: 'sine',     duration: 220, color: '#a02070' },
          { label: 'TOM-H', freq: 175,  wave: 'sine',     duration: 200, color: '#a02070' },
          { label: 'CLAP',  freq: 1500, wave: 'square',   duration: 80,  color: '#98c379' },
          { label: 'COW',   freq: 800,  wave: 'square',   duration: 120, color: '#ffb300' },
        ],
      },
    },

    'stepseq-h': {
      type: 'Text',
      props: { content: '## 3. StepSequencer — 16-step transport', size: 'lg', weight: 'bold' },
    },

    stepseq: {
      type: 'StepSequencer',
      props: {
        title: 'four-on-the-floor seed',
        bpm: 124,
        steps: 16,
        tracks: [
          { label: 'KICK',  freq: 60,   wave: 'sine',     duration: 180, color: '#ff4444' },
          { label: 'SNARE', freq: 200,  wave: 'square',   duration: 100, color: '#ffb300' },
          { label: 'HAT',   freq: 6500, wave: 'sawtooth', duration: 50,  color: '#00e5ff' },
          { label: 'PERC',  freq: 320,  wave: 'triangle', duration: 90,  color: '#e040a0' },
        ],
        // 4-on-floor kick, snare on 5/13, hat off-beat, perc sparse
        initial: [
          [true, false, false, false, true, false, false, false, true, false, false, false, true, false, false, false],
          [false, false, false, false, true, false, false, false, false, false, false, false, true, false, false, false],
          [false, false, true, false, false, false, true, false, false, false, true, false, false, false, true, false],
          [false, false, false, false, false, false, false, true, false, false, false, false, false, false, true, false],
        ],
      },
    },

    'acidbass-h': {
      type: 'Text',
      props: { content: '## 4. AcidBass — 303-style mono bass', size: 'lg', weight: 'bold' },
    },

    acidbass: {
      type: 'AcidBass',
      props: {
        title: 'TB-3rb (squelch on)',
        bpm: 124,
        steps: 16,
        // semitones from base; null = rest
        notes: [0, null, 12, 0, 3, null, 7, 0, 0, null, 10, 5, 0, null, 7, 3],
        accents: [true, false, false, false, true, false, false, false, true, false, false, false, true, false, false, false],
        slides:  [false, false, true, false, false, false, false, false, false, false, true, false, false, false, false, false],
        baseFreq: 55, // A1
        wave: 'sawtooth',
        cutoff: 800,
        resonance: 14,
        envAmount: 2400,
        envDecay: 220,
      },
    },

    'euclid-h': {
      type: 'Text',
      props: { content: '## 5. EuclideanDrums — Bjorklund n-of-k', size: 'lg', weight: 'bold' },
    },

    euclid: {
      type: 'EuclideanDrums',
      props: {
        title: 'cascading polyrhythm',
        bpm: 132,
        steps: 16,
        tracks: [
          { label: 'KICK',  hits: 4,  rotation: 0,  freq: 60,   wave: 'sine',     duration: 180, color: '#ff4444' },
          { label: 'SNARE', hits: 2,  rotation: 4,  freq: 200,  wave: 'square',   duration: 100, color: '#ffb300' },
          { label: 'HAT',   hits: 11, rotation: 0,  freq: 6500, wave: 'sawtooth', duration: 40,  color: '#00e5ff' },
          { label: 'PERC',  hits: 5,  rotation: 2,  freq: 320,  wave: 'triangle', duration: 80,  color: '#e040a0' },
        ],
      },
    },

    'xypad-h': {
      type: 'Text',
      props: { content: '## 6. XYPad — drone with filter sweep', size: 'lg', weight: 'bold' },
    },

    'xypad-row': {
      type: 'Stack',
      props: { direction: 'horizontal', gap: 12 },
      children: ['xypad', 'xypad-doc'],
    },

    xypad: {
      type: 'XYPad',
      props: {
        title: 'press + drag',
        baseFreq: 110,
        wave: 'sawtooth',
        width: 280,
        height: 220,
        color: '#e040a0',
      },
    },

    'xypad-doc': {
      type: 'EntryBody',
      props: {
        markdown:
          '**X axis** → filter cutoff (200 Hz left → 8 kHz right, log).\n\n' +
          '**Y axis** → resonance (0.5 bottom → 25 top).\n\n' +
          'Hold pointer to sustain a sawtooth drone through a lowpass filter with cutoff/resonance modulated by your finger. Release to release.\n\n' +
          'Layer it over the AcidBass for ambient pad mode.',
      },
    },

    footer: {
      type: 'BacklinksFooter',
      props: {
        inbound: ['render-door catalog', 'FLO-techno-fidget'],
        outbound: ['Web Audio API', 'Bjorklund algorithm', 'TB-303'],
      },
    },
  },
};

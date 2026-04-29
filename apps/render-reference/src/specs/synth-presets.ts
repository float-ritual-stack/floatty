/**
 * Synth presets — composable building blocks for rigs.
 *
 * Per user direction: "loop packs / sample packs / stems / presets" —
 * agents shouldn't have to synthesize every beat from scratch. These
 * exports are pure data, drop-in composable. Mix and match drum kits,
 * patterns, and acid lines to assemble a rig spec quickly.
 *
 * USAGE:
 *   import { drumKits, drumPatterns, acidLines, euclidClassics } from './synth-presets';
 *
 *   {
 *     type: 'StepSequencer',
 *     props: {
 *       tracks: drumKits.technoPure,
 *       initial: drumPatterns.fourOnFloor,
 *       clock: 'main',
 *     }
 *   }
 *
 *   {
 *     type: 'AcidBass',
 *     props: { ...acidLines.rolling, clock: 'main', sends: { delay: 0.4 } }
 *   }
 *
 *   {
 *     type: 'EuclideanDrums',
 *     props: { tracks: euclidClassics.cascading, clock: 'main' }
 *   }
 *
 * NAMING:
 *   - Kits/patterns are 4-track 16-step (most common)
 *   - 8-step variants suffixed _8 (tresillo land)
 *   - Patterns assume kit-track order: KICK / SNARE / HAT / PERC
 *
 * Hand-tuned. Add as needed; agents compose, never re-synthesize.
 */

// ─── Drum kits ──────────────────────────────────────────────────
//
// Track-shape voicings. Pair with `drumPatterns.*` of matching length.
// Each track: { label, freq, wave, duration, color }.

const C = {
  red: '#ff4444',    amb: '#ffb300',
  cy: '#00e5ff',     mag: '#e040a0',
  green: '#98c379',  purple: '#a02070',
  white: '#cccccc',
} as const;

type DrumTrack = {
  label: string;
  freq: number;
  duration: number;
  wave: 'sine' | 'square' | 'sawtooth' | 'triangle';
  color: string;
};

export const drumKits = {
  // Classic Detroit techno: deep kick, tight snare, sizzling hat, perc.
  technoPure: [
    { label: 'KICK',  freq: 55,   wave: 'sine',     duration: 220, color: C.red },
    { label: 'SNARE', freq: 220,  wave: 'square',   duration: 110, color: C.amb },
    { label: 'HAT',   freq: 7000, wave: 'sawtooth', duration: 40,  color: C.cy },
    { label: 'PERC',  freq: 320,  wave: 'triangle', duration: 80,  color: C.mag },
  ] satisfies DrumTrack[],

  // Dub techno: subby kick, longer reverb-friendly tail, soft hat.
  dubTechno: [
    { label: 'KICK',  freq: 50,   wave: 'sine',     duration: 320, color: C.red },
    { label: 'STAB',  freq: 180,  wave: 'square',   duration: 200, color: C.amb },
    { label: 'HAT',   freq: 5000, wave: 'sawtooth', duration: 60,  color: C.cy },
    { label: 'PERC',  freq: 280,  wave: 'sine',     duration: 140, color: C.mag },
  ] satisfies DrumTrack[],

  // Tribal/Latin: tom-driven, woody perc, cowbell.
  tribal: [
    { label: 'KICK',  freq: 60,   wave: 'sine',     duration: 180, color: C.red },
    { label: 'TOM-L', freq: 110,  wave: 'sine',     duration: 200, color: C.purple },
    { label: 'TOM-H', freq: 175,  wave: 'sine',     duration: 180, color: C.purple },
    { label: 'COW',   freq: 800,  wave: 'square',   duration: 90,  color: C.amb },
  ] satisfies DrumTrack[],

  // Glitch / IDM: short ticky kick, white-noise-ish hat, bleeps.
  glitch: [
    { label: 'TICK',  freq: 90,   wave: 'square',   duration: 80,  color: C.red },
    { label: 'BLIP',  freq: 1200, wave: 'sine',     duration: 50,  color: C.green },
    { label: 'HAT',   freq: 8000, wave: 'sawtooth', duration: 30,  color: C.cy },
    { label: 'CLAP',  freq: 1500, wave: 'square',   duration: 60,  color: C.mag },
  ] satisfies DrumTrack[],

  // Minimal: kick + clap + hat only — leave room for bass + FX.
  minimal: [
    { label: 'KICK',  freq: 58,   wave: 'sine',     duration: 200, color: C.red },
    { label: 'CLAP',  freq: 1500, wave: 'square',   duration: 70,  color: C.amb },
    { label: 'HAT',   freq: 6800, wave: 'sawtooth', duration: 45,  color: C.cy },
    { label: '·',     freq: 100,  wave: 'sine',     duration: 50,  color: C.white },
  ] satisfies DrumTrack[],
};

// ─── Drum patterns (16 steps, 4 tracks) ─────────────────────────
//
// Boolean grids matching the 4-track kit shape (KICK/SNARE-or-equivalent/
// HAT/PERC). Pass as `initial` on StepSequencer.

const T = true;
const F = false;

export const drumPatterns = {
  // Four-on-floor kick, snare on 5/13, hat off-beat, sparse perc.
  fourOnFloor: [
    [T, F, F, F, T, F, F, F, T, F, F, F, T, F, F, F],
    [F, F, F, F, T, F, F, F, F, F, F, F, T, F, F, F],
    [F, F, T, F, F, F, T, F, F, F, T, F, F, F, T, F],
    [F, F, F, F, F, F, F, T, F, F, F, F, F, F, T, F],
  ],

  // Half-time: kick on 1/9, snare on 5/13. Roomier, slower-feeling.
  halfTime: [
    [T, F, F, F, F, F, F, F, T, F, F, F, F, F, F, F],
    [F, F, F, F, T, F, F, F, F, F, F, F, T, F, F, F],
    [T, F, T, F, T, F, T, F, T, F, T, F, T, F, T, F],
    [F, F, F, F, F, F, F, T, F, F, F, F, F, F, F, T],
  ],

  // Breakbeat: kick on 1, 11; snare on 5, 13; busy hat.
  breakbeat: [
    [T, F, F, F, F, F, F, F, F, F, T, F, F, F, F, F],
    [F, F, F, F, T, F, F, F, F, F, F, F, T, F, F, F],
    [T, F, T, F, T, F, T, T, T, F, T, F, T, F, T, T],
    [F, F, F, T, F, F, T, F, F, F, F, F, F, T, F, F],
  ],

  // Tribal: layered toms, kick on 1, stomping perc.
  tribal: [
    [T, F, F, F, T, F, F, F, T, F, F, F, T, F, F, F],
    [F, F, T, F, F, F, F, F, F, F, T, F, F, F, F, F],
    [F, F, F, F, F, T, F, F, F, F, F, F, F, T, F, F],
    [F, F, F, F, F, F, F, F, T, F, F, F, F, F, F, F],
  ],

  // Glitch: irregular kick, snapping clap, dense hat.
  glitch: [
    [T, F, F, T, F, F, T, F, F, T, F, F, F, T, F, F],
    [F, F, T, F, F, F, F, T, F, F, F, T, F, F, F, F],
    [T, T, F, T, T, F, T, T, T, T, F, T, T, F, T, T],
    [F, F, F, F, F, F, F, F, F, F, F, F, T, F, T, F],
  ],

  // Minimal: just the bones — kick on 1/5/9/13, clap on 5/13.
  minimal: [
    [T, F, F, F, T, F, F, F, T, F, F, F, T, F, F, F],
    [F, F, F, F, T, F, F, F, F, F, F, F, T, F, F, F],
    [F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F],
    [F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F],
  ],

  // Off-beat hat only (great as a layer).
  hatChain: [
    [F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F],
    [F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F],
    [F, F, T, F, F, F, T, F, F, F, T, F, F, F, T, F],
    [F, F, F, F, F, F, F, F, F, F, F, F, F, F, F, F],
  ],
};

// ─── Acid lines (303-style) ─────────────────────────────────────
//
// Each preset = full prop bundle for AcidBass: notes/accents/slides +
// timbral defaults. Spread into AcidBass props; rig wiring (clock/sends)
// stays the agent's choice.

type AcidLine = {
  notes: Array<number | null>;
  accents: boolean[];
  slides: boolean[];
  baseFreq: number;
  wave: 'sawtooth' | 'square';
  cutoff: number;
  resonance: number;
  envAmount: number;
  envDecay: number;
};

export const acidLines = {
  // Rolling: octaves + 5ths, accents on the 1, slides on offbeats.
  rolling: {
    notes:   [0, null, 12, 0,    3, null, 7, 0,     0, null, 10, 5,    0, null, 7, 3],
    accents: [T, F,    F,  F,    T, F,    F, F,     T, F,    F,  F,    T, F,    F, F],
    slides:  [F, F,    T,  F,    F, F,    F, F,     F, F,    T,  F,    F, F,    F, F],
    baseFreq: 55,
    wave: 'sawtooth',
    cutoff: 700,
    resonance: 16,
    envAmount: 2400,
    envDecay: 200,
  } satisfies AcidLine,

  // Slidey: every step, lots of portamento, weaving line.
  slidey: {
    notes:   [0, 5, 7,  3,   5, 0, 12, 7,   3, 0, 7,  10,   5, 3, 0, -2],
    accents: [T, F, F,  F,   T, F, F,  F,   T, F, F,  F,    T, F, F,  F],
    slides:  [F, T, T,  T,   F, T, T,  T,   F, T, T,  T,    F, T, T,  T],
    baseFreq: 55,
    wave: 'sawtooth',
    cutoff: 500,
    resonance: 18,
    envAmount: 2800,
    envDecay: 280,
  } satisfies AcidLine,

  // Percussive: short staccato hits, no slides, accents marking 1/5/9/13.
  percussive: {
    notes:   [0, null, 0,  null,   3, null, 0,  null,   7, null, 0,  null,   5, null, 0,  null],
    accents: [T, F,    F,  F,      T, F,    F,  F,      T, F,    F,  F,      T, F,    F,  F   ],
    slides:  [F, F,    F,  F,      F, F,    F,  F,      F, F,    F,  F,      F, F,    F,  F   ],
    baseFreq: 55,
    wave: 'sawtooth',
    cutoff: 1200,
    resonance: 10,
    envAmount: 1800,
    envDecay: 120,
  } satisfies AcidLine,

  // DnB-bass: 1-bar phrase, low octave drop, accent on 1, gritty.
  dnbBass: {
    notes:   [0, null, null, null,   12, null, 0,  null,   0, 0,    -5, null,   7, null, 5,  3],
    accents: [T, F,    F,    F,      T,  F,    F,  F,      T, F,    F,  F,      T, F,    F,  F],
    slides:  [F, F,    F,    F,      F,  F,    F,  F,      F, T,    F,  F,      F, F,    T,  F],
    baseFreq: 41.2, // E1
    wave: 'square',
    cutoff: 400,
    resonance: 14,
    envAmount: 3200,
    envDecay: 160,
  } satisfies AcidLine,

  // Hoover: long slides up the scale, big resonance.
  hoover: {
    notes:   [0, null, null, 7,   12, null, null, 7,   0, null, null, 10,   12, null, 5,    null],
    accents: [T, F,    F,    F,   T,  F,    F,    F,   T, F,    F,    F,    T,  F,    F,    F   ],
    slides:  [F, F,    F,    T,   T,  F,    F,    T,   F, F,    F,    T,    T,  F,    T,    F   ],
    baseFreq: 55,
    wave: 'sawtooth',
    cutoff: 350,
    resonance: 22,
    envAmount: 3600,
    envDecay: 380,
  } satisfies AcidLine,
};

// ─── Euclidean classics ─────────────────────────────────────────
//
// Track-set arrays for EuclideanDrums. Each track: { label, hits, rotation,
// freq, wave, duration, color }. Spread into props.tracks.

type EuclidTrack = {
  label: string;
  hits: number;
  rotation: number;
  freq: number;
  duration: number;
  wave: 'sine' | 'square' | 'sawtooth' | 'triangle';
  color: string;
};

export const euclidClassics = {
  // Cascading polyrhythm: 4-2-11-5 across 16 = locks then drifts.
  cascading: [
    { label: 'KICK',  hits: 4,  rotation: 0, freq: 60,   wave: 'sine',     duration: 180, color: C.red },
    { label: 'SNARE', hits: 2,  rotation: 4, freq: 200,  wave: 'square',   duration: 100, color: C.amb },
    { label: 'HAT',   hits: 11, rotation: 0, freq: 6500, wave: 'sawtooth', duration: 40,  color: C.cy },
    { label: 'PERC',  hits: 5,  rotation: 2, freq: 320,  wave: 'triangle', duration: 80,  color: C.mag },
  ] satisfies EuclidTrack[],

  // Tresillo + cinquillo + complementary fill.
  afroCuban: [
    { label: 'KICK',  hits: 3,  rotation: 0, freq: 60,   wave: 'sine',     duration: 200, color: C.red },
    { label: 'CLAVE', hits: 5,  rotation: 0, freq: 1500, wave: 'square',   duration: 50,  color: C.amb },
    { label: 'COW',   hits: 2,  rotation: 6, freq: 800,  wave: 'square',   duration: 90,  color: C.green },
    { label: 'HAT',   hits: 8,  rotation: 0, freq: 6500, wave: 'sawtooth', duration: 40,  color: C.cy },
  ] satisfies EuclidTrack[],

  // Aksak (7/12) + 4/12 + 5/12 — odd-meter feel.
  aksak: [
    { label: 'KICK',  hits: 4, rotation: 0, freq: 60,   wave: 'sine',     duration: 220, color: C.red },
    { label: 'CLAP',  hits: 7, rotation: 1, freq: 1500, wave: 'square',   duration: 60,  color: C.amb },
    { label: 'HAT',   hits: 5, rotation: 0, freq: 6500, wave: 'sawtooth', duration: 45,  color: C.cy },
    { label: 'TOM',   hits: 3, rotation: 5, freq: 160,  wave: 'sine',     duration: 140, color: C.purple },
  ] satisfies EuclidTrack[],

  // Hi-hat heavy techno: dense hat against minimal kick.
  hatStorm: [
    { label: 'KICK',  hits: 4,  rotation: 0, freq: 55,   wave: 'sine',     duration: 200, color: C.red },
    { label: 'HAT-A', hits: 13, rotation: 0, freq: 6500, wave: 'sawtooth', duration: 30,  color: C.cy },
    { label: 'HAT-B', hits: 9,  rotation: 1, freq: 8500, wave: 'sawtooth', duration: 25,  color: C.cy },
    { label: 'CLAP',  hits: 2,  rotation: 4, freq: 1500, wave: 'square',   duration: 60,  color: C.amb },
  ] satisfies EuclidTrack[],

  // Sparse drift: each track at its own modulus, all relatively prime.
  sparseDrift: [
    { label: 'TOM',   hits: 5, rotation: 1, freq: 160,  wave: 'triangle', duration: 90,  color: C.purple },
    { label: 'BLIP',  hits: 7, rotation: 0, freq: 880,  wave: 'sine',     duration: 50,  color: C.green },
    { label: 'CLAVE', hits: 3, rotation: 2, freq: 1500, wave: 'square',   duration: 40,  color: C.amb },
    { label: 'WHISP', hits: 11,rotation: 6, freq: 4200, wave: 'sawtooth', duration: 30,  color: C.cy },
  ] satisfies EuclidTrack[],
};

// ─── DrumPad voicings (one-shot kits for click-bash) ────────────
//
// Pads array for the DrumPad component. 8 pads in 4 columns is the
// standard layout; vary freq/wave per pad.

type DrumPadVoice = {
  label: string;
  freq: number;
  duration: number;
  wave: 'sine' | 'square' | 'sawtooth' | 'triangle';
  color: string;
};

export const drumPadKits = {
  // Bash kit: full standard set.
  bash: [
    { label: 'KICK',  freq: 60,   wave: 'sine',     duration: 200, color: C.red },
    { label: 'SNARE', freq: 200,  wave: 'square',   duration: 120, color: C.amb },
    { label: 'HAT',   freq: 6500, wave: 'sawtooth', duration: 60,  color: C.cy },
    { label: 'PERC',  freq: 320,  wave: 'triangle', duration: 100, color: C.mag },
    { label: 'TOM-L', freq: 110,  wave: 'sine',     duration: 220, color: C.purple },
    { label: 'TOM-H', freq: 175,  wave: 'sine',     duration: 200, color: C.purple },
    { label: 'CLAP',  freq: 1500, wave: 'square',   duration: 80,  color: C.green },
    { label: 'COW',   freq: 800,  wave: 'square',   duration: 120, color: C.amb },
  ] satisfies DrumPadVoice[],

  // Bass tones — chromatic from A1.
  bassTones: [
    { label: 'A1',  freq: 55,   wave: 'sawtooth', duration: 220, color: C.red },
    { label: 'C2',  freq: 65.4, wave: 'sawtooth', duration: 220, color: C.red },
    { label: 'D2',  freq: 73.4, wave: 'sawtooth', duration: 220, color: C.amb },
    { label: 'E2',  freq: 82.4, wave: 'sawtooth', duration: 220, color: C.amb },
    { label: 'G2',  freq: 98,   wave: 'sawtooth', duration: 220, color: C.cy },
    { label: 'A2',  freq: 110,  wave: 'sawtooth', duration: 220, color: C.cy },
    { label: 'C3',  freq: 130.8,wave: 'sawtooth', duration: 220, color: C.mag },
    { label: 'D3',  freq: 146.8,wave: 'sawtooth', duration: 220, color: C.mag },
  ] satisfies DrumPadVoice[],

  // Bleeps — dnb / acid / chiptune flavor.
  bleeps: [
    { label: 'PIP',  freq: 1200, wave: 'square',   duration: 50,  color: C.green },
    { label: 'BLIP', freq: 880,  wave: 'sine',     duration: 80,  color: C.green },
    { label: 'CHIRP',freq: 2200, wave: 'sawtooth', duration: 40,  color: C.cy },
    { label: 'TICK', freq: 4400, wave: 'square',   duration: 25,  color: C.cy },
    { label: 'BOOP', freq: 440,  wave: 'triangle', duration: 120, color: C.amb },
    { label: 'WIRR', freq: 660,  wave: 'sawtooth', duration: 90,  color: C.amb },
    { label: 'BUZZ', freq: 90,   wave: 'square',   duration: 150, color: C.red },
    { label: 'PING', freq: 3300, wave: 'sine',     duration: 60,  color: C.mag },
  ] satisfies DrumPadVoice[],
};

// ─── Tone scales (for Tone-button rows) ─────────────────────────
//
// Pre-baked Tone prop sets — pair with `type: 'Tone'` in a horizontal
// Stack. Drop into spec children with mapping:
//   children: scales.minorPent.map((_, i) => `tone-${i}`),
//   ...scales.minorPent.reduce((acc, t, i) => ({ ...acc, [`tone-${i}`]:
//     { type: 'Tone', props: t } }), {})

type ToneVoice = {
  freq: number;
  label: string;
  wave: 'sine' | 'square' | 'sawtooth' | 'triangle';
  color: string;
  duration: number;
};

export const scales = {
  // C minor pentatonic (C, Eb, F, G, Bb) over one octave from C4.
  minorPent: [
    { freq: 261.63, label: 'C4',  wave: 'sine', color: C.cy, duration: 250 },
    { freq: 311.13, label: 'Eb4', wave: 'sine', color: C.cy, duration: 250 },
    { freq: 349.23, label: 'F4',  wave: 'sine', color: C.cy, duration: 250 },
    { freq: 392.0,  label: 'G4',  wave: 'sine', color: C.cy, duration: 250 },
    { freq: 466.16, label: 'Bb4', wave: 'sine', color: C.cy, duration: 250 },
    { freq: 523.25, label: 'C5',  wave: 'sine', color: C.cy, duration: 250 },
  ] satisfies ToneVoice[],

  // Phrygian dominant (E, F, G#, A, B, C, D, E) — flamenco/middle-eastern.
  phrygDom: [
    { freq: 164.81, label: 'E3', wave: 'sawtooth', color: C.mag, duration: 300 },
    { freq: 174.61, label: 'F3', wave: 'sawtooth', color: C.mag, duration: 300 },
    { freq: 207.65, label: 'G#3',wave: 'sawtooth', color: C.mag, duration: 300 },
    { freq: 220.0,  label: 'A3', wave: 'sawtooth', color: C.mag, duration: 300 },
    { freq: 246.94, label: 'B3', wave: 'sawtooth', color: C.mag, duration: 300 },
    { freq: 261.63, label: 'C4', wave: 'sawtooth', color: C.mag, duration: 300 },
    { freq: 293.66, label: 'D4', wave: 'sawtooth', color: C.mag, duration: 300 },
  ] satisfies ToneVoice[],

  // Whole-tone (C, D, E, F#, G#, A#) — dreamy, ambiguous.
  wholeTone: [
    { freq: 261.63, label: 'C4', wave: 'triangle', color: C.amb, duration: 350 },
    { freq: 293.66, label: 'D4', wave: 'triangle', color: C.amb, duration: 350 },
    { freq: 329.63, label: 'E4', wave: 'triangle', color: C.amb, duration: 350 },
    { freq: 369.99, label: 'F#4',wave: 'triangle', color: C.amb, duration: 350 },
    { freq: 415.30, label: 'G#4',wave: 'triangle', color: C.amb, duration: 350 },
    { freq: 466.16, label: 'A#4',wave: 'triangle', color: C.amb, duration: 350 },
  ] satisfies ToneVoice[],
};

// ─── Send recipes (typical mix wiring) ──────────────────────────
//
// Common sends={} prop values agents can grab when wiring a rig.

export const sendRecipes = {
  /** Bone dry — no FX. */
  dry: undefined,

  /** Hint of reverb — for kicks/snares that want space without wash. */
  glow: { reverb: 0.18 },

  /** Splashy reverb — pads, bells, everything-with-tail. */
  wash: { reverb: 0.55 },

  /** Dotted-eighth delay echo — the classic techno move. */
  echoes: { delay: 0.45 },

  /** Heavy delay + reverb — fully wet, ambient/dub territory. */
  dub: { delay: 0.55, reverb: 0.4 },

  /** Acid bass mix — moderate delay, light reverb to glue with kit. */
  acid: { delay: 0.4, reverb: 0.2 },

  /** Hat send — short verb only, keep timing tight. */
  hatGlue: { reverb: 0.22 },
};

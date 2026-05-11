// Set B — 9 surface-bound music components. The rest (~48) moved into
// `shared.ts` as the symmetry contract in PR B. These stay door-only
// because they're Tauri+Solid+Web-Audio-native (Tone.js, Strudel) — no
// equivalent React runtime in outline-explorer.

import { z } from "zod";

export const doorComponentDefinitions = {
  // ─── Audio / Synth (FLO-techno-fidget) ───────────────
  // Web Audio API primitives. AudioContext lazy-inits on first click
  // (browser autoplay policy). No external libs — built on `OscillatorNode`.
  //
  // Rig wiring (cross-block sync):
  //   - `rigId` (default 'main') — namespace for clock + FX bus
  //   - `clock: '<rigId>'` — listen to MasterClock on that rig (slave mode);
  //     omit to run own internal transport (master mode, default)
  //   - `sends: { delay, reverb }` — route audio output through MasterFX
  //     bus on the same rigId. 0..1 send levels. No-op if no MasterFX.

  Tone: {
    props: z.object({
      freq: z.number().optional(),
      duration: z.number().optional(),
      wave: z.enum(["sine", "square", "sawtooth", "triangle"]).optional(),
      label: z.string().optional(),
      color: z.string().optional(),
      gain: z.number().optional(),
      rigId: z.string().optional(),
      sends: z.object({
        delay: z.number().optional(),
        reverb: z.number().optional(),
      }).optional(),
    }),
    slots: [],
    description: "Boring synth primitive: a button that plays one note via Web Audio. Props: freq (Hz, default 440), duration (ms, default 200), wave (sine|square|sawtooth|triangle, default sine), label (default freq label), color (hex), gain (0..2.5, default 1.0 — voice-level attenuation, multiplied into the ADSR peak). Optional rig wiring: rigId + sends={delay, reverb} routes through MasterFX bus on that rig.",
  },

  DrumPad: {
    props: z.object({
      pads: z.array(z.object({
        label: z.string(),
        freq: z.number(),
        duration: z.number().optional(),
        wave: z.enum(["sine", "square", "sawtooth", "triangle"]).optional(),
        color: z.string().optional(),
        gain: z.number().optional(),
      })),
      columns: z.number().optional(),
      title: z.string().optional(),
      gain: z.number().optional(),
      rigId: z.string().optional(),
      sends: z.object({
        delay: z.number().optional(),
        reverb: z.number().optional(),
      }).optional(),
    }),
    slots: [],
    description: "A grid of clickable pads, each plays a tone. Props: pads (array of {label, freq, duration?, wave?, color?, gain?}), columns (default 4), title (optional header), gain (component-level, 0..2.5, default 1.0 — attenuates whole pad). Per-pad gain (0..2.5, default 1.0) for mix-balance (kick loud, hat quiet). Build kick/snare/hi-hat/perc with different freqs+waves: kick~80Hz sine, snare~200Hz square, hat~6000Hz sawtooth, low-tom~120Hz triangle. Color by role. Optional rig wiring: rigId + sends route all pads through MasterFX bus.",
  },

  StepSequencer: {
    props: z.object({
      bpm: z.number().optional(),
      steps: z.number().optional(),
      gain: z.number().optional(),
      tracks: z.array(z.object({
        label: z.string(),
        freq: z.number(),
        duration: z.number().optional(),
        wave: z.enum(["sine", "square", "sawtooth", "triangle"]).optional(),
        color: z.string().optional(),
        gain: z.number().optional(),
        // Per-track FX sends override component-level sends. Useful when
        // kick should stay dry but hat goes wet.
        sends: z.object({
          delay: z.number().optional(),
          reverb: z.number().optional(),
        }).optional(),
      })),
      initial: z.array(z.array(z.boolean())).optional(),
      title: z.string().optional(),
      clock: z.string().optional(),
      rigId: z.string().optional(),
      sends: z.object({
        delay: z.number().optional(),
        reverb: z.number().optional(),
      }).optional(),
    }),
    slots: [],
    description: "Step sequencer: tracks × steps grid. Click cells to toggle, PLAY to loop at BPM (16th-note timing). Props: bpm (default 120), steps (default 16), tracks (array of {label, freq, wave?, duration?, color?, gain?, sends?}), initial (optional [tracks][steps] boolean grid to seed the pattern). Current step has amber outline. Built-in transport bar. Gain: component-level gain (0..2.5, default 1.0) attenuates the whole sequencer; per-track gain (0..2.5, default 1.0) attenuates one voice for mix-balance (kick loud, hat quiet). Both layered with rig-level MasterOut. Rig wiring: clock='<rigId>' makes it a slave of MasterClock (no own transport); component-level sends={delay, reverb} routes all tracks through MasterFX on the same rigId, OR set per-track sends on individual tracks (kick dry, hat wet).",
  },

  AcidBass: {
    props: z.object({
      bpm: z.number().optional(),
      steps: z.number().optional(),
      // Per-step semitone offset from baseFreq. null = rest.
      notes: z.array(z.union([z.number(), z.null()])),
      accents: z.array(z.boolean()).optional(),
      slides: z.array(z.boolean()).optional(),
      baseFreq: z.number().optional(),
      wave: z.enum(["sawtooth", "square"]).optional(),
      gain: z.number().optional(),
      cutoff: z.number().optional(),
      resonance: z.number().optional(),
      envAmount: z.number().optional(),
      envDecay: z.number().optional(),
      title: z.string().optional(),
      clock: z.string().optional(),
      rigId: z.string().optional(),
      sends: z.object({
        delay: z.number().optional(),
        reverb: z.number().optional(),
      }).optional(),
    }),
    slots: [],
    description: "303-style mono bass step sequencer. 16 steps × {pitch (semitones from baseFreq), accent (louder + brighter), slide (portamento to next note), gate (null = rest)}. Lowpass filter with envelope: cutoff=base cutoff (Hz), resonance=Q, envAmount=Hz added to cutoff at note-on, envDecay=ms. Live knobs: gain/cutoff/resonance/envAmount/envDecay. baseFreq default 55Hz (A1), wave default 'sawtooth', gain default 1.0 (range 0..2.5, attenuates the bass voice — useful when bass is dominating the mix). The squelch lives in cutoff+resonance+envAmount interaction. Rig wiring: clock='<rigId>' = slave; sends={delay, reverb} routes through MasterFX.",
  },

  EuclideanDrums: {
    props: z.object({
      bpm: z.number().optional(),
      steps: z.number().optional(),
      gain: z.number().optional(),
      tracks: z.array(z.object({
        label: z.string(),
        hits: z.number(),
        rotation: z.number().optional(),
        freq: z.number(),
        duration: z.number().optional(),
        wave: z.enum(["sine", "square", "sawtooth", "triangle"]).optional(),
        color: z.string().optional(),
        gain: z.number().optional(),
        // Per-track FX sends override component-level sends.
        sends: z.object({
          delay: z.number().optional(),
          reverb: z.number().optional(),
        }).optional(),
      })),
      title: z.string().optional(),
      clock: z.string().optional(),
      rigId: z.string().optional(),
      sends: z.object({
        delay: z.number().optional(),
        reverb: z.number().optional(),
      }).optional(),
    }),
    slots: [],
    description: "Bjorklund-algorithm Euclidean rhythm sequencer. Per-track (hits, steps, rotation) generates the most-evenly-distributed pattern. Live-tweaking hits/steps cascades polyrhythms. Built-in transport. Props: bpm (default 120), steps (default 16), tracks (array of {label, hits, rotation?, freq, wave?, duration?, color?, gain?, sends?}). Gain: component-level (0..2.5, default 1.0) attenuates whole sequencer; per-track gain (0..2.5, default 1.0) for mix-balance. Try (3,8) → tresillo, (5,8) → cinquillo, (7,16) → variable. Rig wiring: clock='<rigId>' = slave; component-level sends={delay, reverb} routes all tracks through MasterFX, OR per-track sends to mix kick-dry-hat-wet style.",
  },

  XYPad: {
    props: z.object({
      baseFreq: z.number().optional(),
      wave: z.enum(["sine", "square", "sawtooth", "triangle"]).optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      color: z.string().optional(),
      title: z.string().optional(),
    }),
    slots: [],
    description: "Press-and-drag pad for sustained drone with continuous filter sweep. X axis = lowpass cutoff (200Hz–8kHz log). Y axis = resonance (0.5–25). Pointer down starts a sustained oscillator through the filter; release stops. Props: baseFreq (default 110Hz), wave (default 'sawtooth'), width (default 280), height (default 220), color (hex). Layer over the AcidBass for ambient pad mode.",
  },

  // ─── Rig: cross-block clock + FX bus ─────────────────
  // Multiple sequencer blocks can attach to the same `rigId`. MasterClock
  // emits step events, slaves listen via clock prop. MasterFX provides
  // shared delay+reverb sends voices opt into via sends prop.

  MasterClock: {
    props: z.object({
      rigId: z.string().optional(),
      bpm: z.number().optional(),
      steps: z.number().optional(),
      swing: z.number().optional(),
      title: z.string().optional(),
    }),
    slots: [],
    description: "Rig clock — drives all sequencers tagged with `clock: '<rigId>'`. Props: rigId (default 'main'), bpm (default 124), steps (master loop length, default 16), swing (0..1, off-beat 16th delay, default 0), title. PLAY/STOP controls all attached slaves. Display shows step indicator. Voices route audio through MasterFX on same rigId if present.",
  },

  MasterFX: {
    props: z.object({
      rigId: z.string().optional(),
      gain: z.number().optional(),
      delayTime: z.number().optional(),
      delayFeedback: z.number().optional(),
      delayMix: z.number().optional(),
      reverbMix: z.number().optional(),
      title: z.string().optional(),
    }),
    slots: [],
    description: "Rig FX bus — shared delay + convolution reverb sends + master output gain. Voices on the same rigId opt into sends via the sends prop ({ delay: 0..1, reverb: 0..1 }) AND all transit a per-rig master GainNode controlled by the gain prop here. Props: rigId (default 'main'), gain (master output level, 0..2.5, default 1.0 — turn down to mix-balance, push past 1.0 for laptop-speaker boost), delayTime (sec, default 0.375 ≈ dotted-eighth at 120 BPM), delayFeedback (0..0.85, default 0.35), delayMix (0..1, default 0.35), reverbMix (0..1, default 0.25). Live knobs.",
  },

  Strudel: {
    props: z.object({
      pattern: z.string(),
      cps: z.number().optional(),
      height: z.string().optional(),
      title: z.string().optional(),
    }),
    slots: [],
    description: "Strudel REPL embed — runs at strudel.cc via iframe with the pattern URL-encoded into the hash. Pattern is mini-notation source (e.g. `note(\"c4 eb4 g4\").s(\"sine\")`). Props: pattern (required, mini-notation string), cps (cycles per second, default 0.5 = 120 BPM), height (default '420px'), title. Note: external dependency on strudel.cc; works offline only if strudel.cc was loaded previously and cached. Doesn't currently sync with MasterClock — runs its own clock.",
  },
};

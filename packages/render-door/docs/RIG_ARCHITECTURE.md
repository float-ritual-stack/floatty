# Rig Architecture — multi-block audio composition

> **For future agents picking up this work**: this doc is the why-and-how. Read it before
> proposing changes to `MasterClock`, `MasterFX`, the `clock`/`rigId`/`sends` props, or
> the bjorklund + RigBus internals in `components.tsx`.

## TL;DR

The render-door ships an audio-rig pattern: multiple sequencer blocks attach to a shared
master clock and shared FX bus by name (`rigId`). One `MasterClock` + one `MasterFX` +
N slave-mode sequencers compose into a "rig" — a small group of blocks in
communication. The user's framing was *"a rig is several blocks in communication, not
one massive monolith,"* which is the test for any change here.

Quick map of the parts:

```text
spec props                    runtime                    audio graph
──────────────────────────    ─────────────────────────  ─────────────────────────
MasterClock { rigId: 'x' } ── emits rig:step events  ──▶ (no audio — pure clock)
                              + rig:transport events
                              on RigBus[rigId]

MasterFX { rigId: 'x',     ── builds shared            ──▶ delayInput → delay
  delayMix, reverbMix }       FX bus on rigId               → delayMix → destination
                                                            reverbInput → convolver
                                                            → reverbMix → destination

StepSequencer {            ── subscribes to            ──▶ playTone(...) routes through
  clock: 'x',                 RigBus[rigId]                routeVoiceToFx(rigId, sends)
  rigId: 'x',                 (no own transport)
  sends: { delay, reverb } }
```

Three semantic props ride on every voice/sequencer:

| Prop                     | Meaning                                              | Default |
|--------------------------|------------------------------------------------------|---------|
| `rigId: string`          | Which rig's FX bus to send to.                       | `'main'` |
| `clock: string`          | Subscribe to this rigId's MasterClock as a slave.    | undefined (= master mode, own transport) |
| `sends: { delay, reverb }` | Audio send levels (0..1) into MasterFX on rigId.    | undefined (= dry only) |

The "naming reads like wiring" was deliberate. `clock: 'main'` is the wiring declaration:
"my time signal comes from rig main's clock." `sends: { delay: 0.4 }` is the wiring
declaration: "40% of my output goes to rig main's delay send." When floatty's `instrument::`
markers eventually land (Phase 3 below), these props become the closest in-spec analog to
`in:: clock=main` / `out:: delay=0.4`.

## What lives where

`packages/render-door/src/components.tsx`:

- **AUDIO / SYNTH PRIMITIVES section** (~line 3475): everything below this header is
  audio. The split between sections matters because the upstream catalog is large
  (~3400 lines of non-audio components above) and audio internals shouldn't bleed
  upward.
- **`getAudioContext()`**: lazy module-singleton AudioContext. Survives Vite HMR via
  `_audioCtx` module ref. Resumes on every access (autoplay-policy-safe).
- **RigBus**: window-attached registries (`__floatty_rig_listeners`,
  `__floatty_rig_transport`, `__floatty_rig_state`) keyed by `rigId`. **Window-attached
  on purpose** — survives Vite HMR (the door bundle re-runs but listeners persist) and
  spans separate `<JSONUIProvider>` instances. Shape: `Map<rigId, Set<callback>>`.
  `subscribeRigStep` / `subscribeRigTransport` return unsub closures.
- **FX bus**: `getOrCreateFxBus(rigId)` returns a `FxBus` with delay + convolution
  reverb routing graph + setters that ramp via `linearRampToValueAtTime`. The bus is
  **never torn down on cleanup** — it's a shared resource indexed by rigId; voices
  may still send to it after the MasterFX component unmounts. Cleanup is implicit at
  AudioContext close.
- **`routeVoiceToFx(source, ctx, rigId, delaySend, reverbSend)`**: dry connection
  always; FX sends only if the bus exists and send level > 0.
- **`bjorklund(hits, steps)`**: E. Bjorklund 2003 recursive algorithm + rotate-to-first-hit.
  Tests in `audio-rig.test.ts` lock canonical outputs.

`packages/render-catalog/src/components/door.ts`: schema entries for `MasterClock`,
`MasterFX`, plus rig-prop additions on `Tone`, `DrumPad`, `StepSequencer`, `AcidBass`,
`EuclideanDrums`. Description fields call out the rig wiring explicitly so the LLM
prompt-generation surface (`bbsCatalog.prompt()`) tells future agents how to wire up.

`packages/render-door/src/audio-rig.test.ts`: 25 tests covering bjorklund canonical
patterns, rotateArray semantics, RigBus pub/sub.

`apps/render-reference/src/specs/synth-fidget.ts`: tab 9 in render-reference. Section 0
"Rig" demonstrates 1 master + 3 slaves.

`apps/render-reference/src/specs/synth-presets.ts`: composable preset library —
`drumKits` / `drumPatterns` / `acidLines` / `euclidClassics` / `drumPadKits` / `scales` /
`sendRecipes`. Pure-data exports. Goal: agents compose, never re-synthesize.

`apps/render-reference/src/specs/preset-rig.ts`: tab 10. Full rig assembled entirely
from preset imports. Remix recipe = swap one import name.

## Phase 1 → 2 → 3 (forward compatibility)

The rig pattern is forward-compatible across three implementations of the same
contract. **Don't break the prop names** — they survive across phases.

### Phase 1: in-bundle window singleton (shipped)

**Where it lives**: module singletons inside `components.tsx`, attached to `window`.

**Why we chose it**: 
1. Spans multiple `<JSONUIProvider>` instances (one per render:: block) — JR's
   StateProvider is per-provider-instance, so it can't bridge two render:: blocks on
   the same page.
2. No floatty-side changes needed. Door bundle ships; the rig works.
3. Survives Vite HMR.

**What it doesn't give us**:
1. Patterns aren't Y.Doc-synced. Restart loses tweaks.
2. Cross-page rig identity is by string convention, not enforced.
3. No introspection — you can't ask floatty "what's listening on rigId=main?"

### Phase 2: chirp transport + JR StateStore (next session)

**Where to migrate**:

- `subscribeRigStep` / `emitRigStep` calls become chirp events:
  ```ts
  emitChirp(el, 'audio:rig-step', { rigId, step, ... })
  ```
  BlockItem (host) fans them out to sibling render:: blocks via the chirp protocol.
  The chirp infrastructure already exists (search for `handleChirpNavigate` in floatty's
  `lib/navigation.ts` for the existing pattern).

- Pattern state (`grid`, `notes`, `accents`, `slides`) moves into JR's StateStore via
  `$bindState`. Use one of the published adapters (`@json-render/redux`,
  `@json-render/zustand`, `@json-render/jotai`, `@json-render/xstate`) — Evan flagged
  these as available. Patterns then survive Y.Doc sync via spec.state mutations.

- FX bus stays in module memory (audio routing graphs aren't Y.Doc-syncable), but its
  knob values become bound state.

**Prop names stay the same**: `clock`, `rigId`, `sends`. The transport changes, the
contract doesn't.

### Phase 3: floatty-native `instrument::` markers (future)

Evan's instinct from the original session:

```text
instrument:: kick
  in:: clock=main
  out:: delay=0.4 reverb=0.2
```

This becomes a floatty-level primitive. New marker `instrument::` recognized by a new
`instrumentRouterHook.ts` (see `apps/floatty/src/lib/handlers/hooks/` for the pattern
— `ctxRouterHook`, `outlinksHook` are the templates). The hook extracts `in::` and
`out::` markers from children, builds a `block.metadata.rigging` object describing the
topology, and exposes it via window or chirp for the render-door audio runtime to read.

The render:: block then disappears as the unit of rigging — the rig becomes the outline
itself. Children of an `instrument::` node are the audio graph.

**Why this is a big change**: requires floatty hook system + outline-level routing
semantics. But it's where the "shacks not cathedrals" architecture wants to land —
audio rigs as outline structure, not embedded blob.

## Decision records

### Why Web Audio API directly, not Tone.js?

Tone.js is excellent. We didn't pull it in because:

- The door bundle is a separate compiled module loaded by floatty as `index.js`. Adding
  Tone.js bumps bundle size by ~600KB. With the current Web-Audio-direct approach the
  whole render-door bundle stays under 1MB.
- The audio components we shipped (Tone, DrumPad, StepSequencer, AcidBass,
  EuclideanDrums, XYPad, MasterClock, MasterFX) are simple enough that Tone.js abstractions
  are more friction than help. Filter envelope, oscillator + biquad lowpass, convolution
  reverb, delay with feedback — all <30 lines of raw Web Audio.
- AcidBass is the most "Tone.js-shaped" component (persistent voice, scheduled note
  events). Implementing it with `Tone.MonoSynth` would have been a 5-line component. We
  chose to write it explicitly to keep the audio plumbing visible — the explicit code
  is the documentation of how a 303 voice retrigger envelope works.

When to revisit: if a component genuinely needs `Tone.Players` for sample playback,
`Tone.Sequence` for complex polyrhythmic scheduling beyond Bjorklund, or audio worklet
for DSP that would be tedious to write by hand. Strudel is a separate question
(see below).

### What about Strudel?

Evan has a `v0-float-omg-forgot-how-pretty-claude-fucks` repo that uses `@strudel/core`
+ `@strudel/mini` + `@strudel/repl` + `@strudel/webaudio`. The Strudel REPL component
in that repo is implemented as an iframe pointing at
`https://strudel.cc/?<base64-encoded-pattern>`.

This is a clean path to a `Strudel` render-door component. Schema would be:

```ts
Strudel: {
  props: z.object({
    pattern: z.string(),        // mini-notation source
    cps: z.number().optional(), // cycles per second
    rigId: z.string().optional(),
    height: z.string().optional(),
    title: z.string().optional(),
  }),
  slots: [],
  description: '...',
}
```

Implementation: encode the pattern via `btoa()` and render an `<iframe>`. Pros: zero
bundle cost (Strudel runs at strudel.cc). Cons: external dependency on strudel.cc;
patterns can't sync with our RigBus clock without postMessage glue.

If a future agent ships this: pair it with a `clock: 'main'` semantic that pings the
iframe via postMessage on each rig step (Strudel can hook external clock).

### Why bjorklund needs a rotate-to-first-hit step

The recursive Bjorklund algorithm produces e.g. `[F, T, F, F, T, F, F, T]` for `(3, 8)`.
Musically valid, but musicians expect tresillo to *start with* a hit. We rotate the
output so the first `true` lands at position 0. The user-facing `rotation` prop on
`EuclidTrack` is a separate post-rotation knob.

Test `produces tresillo (3, 8) — canonical Cuban rhythm` is the contract: any future
refactor must produce `[T, F, F, T, F, F, T, F]` from `bjorklund(3, 8)`.

### Why FX bus is never torn down

`MasterFX` mounts the bus via `getOrCreateFxBus(rigId)`. On unmount, we don't tear the
bus down. Reasons:

1. Voices that opted into `sends: { delay: 0.4 }` are still pointing at the bus's
   delay/reverb input nodes. Disconnecting the bus mid-flight would silence them.
2. The user can re-mount `MasterFX` (e.g., remix while live). An always-on bus indexed
   by rigId is the simpler invariant.
3. The bus doesn't accumulate cost — empty AudioNodes are cheap. Browser tears them
   down when the AudioContext closes (which only happens at page unload).

If memory becomes an issue: add a `MasterFX.clearOnUnmount` opt-in prop later.

### Why `rotateArray` is left-shift, not right-shift

Documented in tests. Either choice would be valid; we picked left-shift because
`arr.slice(by)` is the natural JS idiom and the EuclideanDrums `rotation` knob feels
fine either way (the user is comparing the rotated pattern to the unrotated one
visually, direction doesn't matter once the convention is consistent). Tests lock the
direction. If a future agent flips it, every rotation-using preset needs updating.

## Testability strategy

Three layers, three different test surfaces:

1. **Pure-function layer** — `bjorklund`, `rotateArray`. Deterministic, no side effects.
   Test with simple input/output assertions. Lives in `audio-rig.test.ts`.

2. **Pub/sub layer** — `subscribeRigStep`, `emitRigStep`, etc. Stateful (window
   registries), but easily testable via the `cleanups: Array<() => void>` pattern
   (each test registers, runs, then unsubs in `beforeEach`). Lives in `audio-rig.test.ts`.

3. **Component layer** — SolidJS components rendering audio. Hard to test directly
   because:
   - jsdom has no AudioContext.
   - Audio scheduling depends on real wall-clock time.
   - Visual feedback (current step highlight, knob colors) is the contract, not the audio.

   Approach: don't test the components. Test the pure logic (layer 1) and the pub/sub
   contract (layer 2). For end-to-end verification of audio rigs, use the
   `apps/render-reference` dev server + chrome MCP — we did this for the Phase 1 ship.

   If a future agent really needs component tests:
   - Mock `getAudioContext()` to return a stub with no-op methods.
   - Use `@solidjs/testing-library` (already on deps) to mount components.
   - Assert on signal state (`playing()`, `currentStep()`) instead of audio output.

## Component inventory (current)

| Component        | Type      | What it does                                          |
|------------------|-----------|-------------------------------------------------------|
| `Tone`           | Voice     | Single click-to-play oscillator note                  |
| `DrumPad`        | Voice grid| Click-to-play grid of tones                           |
| `StepSequencer`  | Sequencer | Multi-track 16-step grid + transport                  |
| `AcidBass`       | Sequencer | 303-style mono with filter envelope                   |
| `EuclideanDrums` | Sequencer | Bjorklund n-of-k pattern generator                    |
| `XYPad`          | Voice     | Press-drag drone with continuous filter sweep         |
| `MasterClock`    | Rig hub   | Drives RigBus on a named rigId                        |
| `MasterFX`       | Rig FX    | Mounts shared delay+reverb bus on a rigId             |

## What's next (in vague priority order)

These are concrete, decomposed enough for a future-agent first-PR:

1. **Strudel component** (small, see decision record above) — iframe wrapper.
2. **AudioVisualizer** — FFT analyser on the master FX bus output, render to
   `<canvas>`. Reference: `e-schultz/sonic-geometry-explorer` has 6 visualizer types
   (Bars, Circles, Diamond, Lines, Maze, Spiral). Three.js dep would make this big;
   plain canvas is the lighter path.
3. **PatternBank component** — save/recall A/B/C/D pattern slots. Hooks into JR
   StateStore (Phase 2 prerequisite).
4. **Per-track sends on EuclideanDrums** — currently the whole component shares one
   `sends` prop. Per-track sends (`tracks: [{ ..., sends: { delay: 0.6 } }, ...]`) would
   let the kick stay dry while hat goes wet. Schema change + per-track playTone call.
5. **Swing on MasterClock** — UI knob exists but doesn't actually delay odd 16ths yet.
   The `swing` value rides the `rig:step` event already; slaves just need to honor it.
6. **AcidBass octave knob** — currently fixed at `baseFreq`. A `+12 / 0 / -12` button
   would help mid-jam transposition.

Each of these is a discrete commit. The rig contract is the foundation; new components
plug in by accepting the same `clock` / `rigId` / `sends` props.

## See also

- `apps/render-reference/CLAUDE.md` — the harness this rig is verified against
- `packages/render-door/README.md` — door package overview
- `~/.claude/skills/building-render-door-components/SKILL.md` — generic component-add workflow
- Floatty CLAUDE.md `Canonical Paths` — the architecture rules the door bundle lives within

## Provenance

- Initial techno-fidget components (Tone / DrumPad / StepSequencer): pre-existing WIP picked up
  in this branch (`db4b8f7`).
- AcidBass / EuclideanDrums / XYPad: this branch (`e56f7f6`).
- Rig architecture (MasterClock + MasterFX + clock/rigId/sends): this branch (`9a13751`).
- Preset library: this branch (`1344278`).
- Bjorklund fix + tests: this branch (`5d46aa3`).
- This document: this branch (alongside continued YOLO session).

User direction snippets (preserved verbatim because they shaped the doctrine):

> *"a rig is like, several blocks in communication, not just one massive monolith"*

> *"loop packs / sample packs / stems / presets etc, should be composable, complimentary,
> help it so agents/we dont need to come up with every beat from scratch every tiem - but
> are composable enough to keeo thhings dynamic and fkuid"*

> *"instrument:: name / in:: blah / out:: blah ... untitive way to route things is all"*

> *"if theres architecture we need to make to floatty to support it - thats ok"*

#!/usr/bin/env python3
"""
NOCTURNAL ACCUMULATOR v2 — Wave 4 full proof

The original composition rewritten on float_av v2.
Same concept: layers arrive and stay.
Now with: proper biquad filters, Signal-based envelopes,
AudioReactive visuals, FrameFeedback, cellular automata textures,
particles as insect dots, FM bells as structural markers.

Five phases, 48 seconds:
  0: insects (euclidean clicks, automata texture)
  1: the body (kick + filtered sub + hats)
  2: the wall (waveshaped stabs, particles explode)
  3: the reach (wide FM voicings, granular wash)
  4: the resolve (dembow + plucked melody + soul)
"""
import sys
import os
import math
import random
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from float_av import *

random.seed(2400)
np.random.seed(2400)

DURATION = 48
BPM = 126
PHASE = [0, 7, 16, 26, 36]  # insects, body, wall, reach, resolve

# ─── palettes ───
P0 = Palette(name='insects', bg=(2, 5, 8), bg_alt=(5, 10, 15),
    fg=(80, 200, 120), fg_dim=(30, 80, 50), primary=(0, 180, 80),
    accent=(100, 255, 180), hot=(200, 255, 150), cold=(40, 120, 80),
    ghost=(5, 15, 10), border=(20, 60, 30))
P1 = Palette(name='body', bg=(5, 3, 12), bg_alt=(12, 8, 25),
    fg=(200, 180, 230), fg_dim=(80, 60, 110), primary=hex_color('#7D56F4'),
    accent=(0, 200, 100), hot=hex_color('#FF6AC1'), cold=(80, 160, 255),
    ghost=(15, 10, 28), border=(50, 35, 75))
P2 = Palette(name='wall', bg=(18, 3, 3), bg_alt=(35, 8, 8),
    fg=(255, 200, 180), fg_dim=(150, 80, 60), primary=(255, 60, 30),
    accent=(255, 120, 0), hot=(255, 20, 20), cold=(200, 50, 0),
    ghost=(30, 8, 5), border=(100, 30, 20))
P3 = Palette(name='reach', bg=(3, 5, 15), bg_alt=(8, 12, 30),
    fg=(180, 200, 255), fg_dim=(80, 100, 150), primary=(100, 180, 255),
    accent=hex_color('#C792EA'), hot=(255, 160, 200), cold=(60, 140, 255),
    ghost=(10, 15, 35), border=(50, 70, 120))
P4 = Palette(name='resolve', bg=(8, 5, 12), bg_alt=(15, 10, 22),
    fg=(220, 200, 240), fg_dim=(120, 100, 140), primary=hex_color('#FF6AC1'),
    accent=(200, 160, 255), hot=(255, 120, 160), cold=(100, 180, 220),
    ghost=(18, 12, 28), border=(60, 45, 80))
PALETTES = [P0, P1, P2, P3, P4]

# Particles
parts = Particles(max_count=400)

# Automata texture (generated once)
automata = automata_texture(WIDTH, HEIGHT, rule=110)


# ─── audio layers ───

def layer_insects(duration, sr=SAMPLE_RATE):
    """Euclidean sine clicks. t(5,8). Perlin gain."""
    n = int(duration * sr)
    sig = np.zeros(n)
    freqs = [1047, 1245, 1568, 2093]
    step_dur = 60.0 / BPM / 4
    pattern = [1, 0, 1, 0, 1, 0, 1, 1]
    gain = Signal.perlin(2.0, duration, sr).range(0.08, 0.2).to_np()

    for i in range(int(duration / step_dur)):
        if pattern[i % 8] == 0:
            continue
        idx = int(i * step_dur * sr)
        freq = freqs[i % len(freqs)]
        cl = min(int(0.012 * sr), n - idx)
        if cl > 0:
            ct = np.linspace(0, cl / sr, cl)
            sig[idx:idx + cl] += gain[min(idx, n - 1)] * np.sin(2 * np.pi * freq * ct) * np.exp(-ct * 80)

    # Dense hat texture t(13,16)
    hat_pattern = [1,1,1,0,1,1,1,1,0,1,1,1,0,1,1,1]
    for i in range(int(duration / step_dur)):
        if hat_pattern[i % 16] == 0:
            continue
        idx = int(i * step_dur * sr)
        hl = min(int(0.008 * sr), n - idx)
        if hl > 0:
            hat = np.random.randn(hl) * np.exp(-np.linspace(0, 1, hl) * 100)
            hat = np.diff(hat, prepend=0)
            sig[idx:idx + hl] += 0.06 * hat

    return sig * Signal.phase_env(duration, PHASE[0], 3.0, 4.0, rate=sr).to_np()


def layer_kick(duration, sr=SAMPLE_RATE):
    sig = kick(duration, bpm=BPM, pattern=[1.0, 0, 0, 0] * 4,
               pitch_start=150, pitch_end=38, punch=0.8, body=0.65,
               click=0.3, decay_rate=11, sr=sr)
    return sig * Signal.phase_env(duration, PHASE[1], 2.0, 3.0, rate=sr).to_np()


def layer_sub(duration, sr=SAMPLE_RATE):
    """Sawtooth sub with proper biquad filter sweep."""
    n = int(duration * sr)
    # F1 / Ab1 alternating
    bar_dur = 60.0 / BPM * 4
    freq_timeline = np.zeros(n)
    for i in range(int(duration / bar_dur) + 1):
        s = int(i * bar_dur * sr)
        e = min(int((i + 1) * bar_dur * sr), n)
        freq_timeline[s:e] = 43.65 if i % 4 < 3 else 51.91

    saw = Signal.saw(43.65, duration, sr).to_np()  # simplified
    cutoff = Signal.perlin(0.5, duration, sr).range(200, 1200)
    filtered = lowpass(saw, cutoff, resonance=4.0, sr=sr)
    sig = waveshape(filtered, 0.3) * 0.35
    return sig * Signal.phase_env(duration, PHASE[1], 3.0, 3.0, rate=sr).to_np()


def layer_hats(duration, sr=SAMPLE_RATE):
    sig = hihat(duration, bpm=BPM,
                pattern=[None, ('c', 0.4), None, ('c', 0.3),
                         None, ('c', 0.5), None, ('o', 0.4)] * 2,
                open_decay=0.1, closed_decay=0.02, sr=sr)
    return sig * Signal.phase_env(duration, PHASE[1], 4.0, 3.0, rate=sr).to_np()


def layer_wall(duration, sr=SAMPLE_RATE):
    """Waveshaped square stabs. shape(0.85). Phase 2 only."""
    n = int(duration * sr)
    step_dur = 60.0 / BPM / 4
    sig = np.zeros(n)
    for i in range(int(duration / step_dur)):
        idx = int(i * step_dur * sr)
        sl = min(int(0.05 * sr), n - idx)
        if sl > 0:
            st = np.linspace(0, sl / sr, sl)
            sig[idx:idx + sl] += 0.4 * np.sign(np.sin(2 * np.pi * 43.65 * st)) * np.exp(-st * 20)
    sig = waveshape(sig, 0.85) * 0.25
    sig = highpass(sig, 200, resonance=1.0, sr=sr)
    # Wall exits at phase 3
    env = Signal.phase_env(duration, PHASE[2], 2.0, rate=sr).to_np()
    exit_env = np.ones(n)
    p3 = int(PHASE[3] * sr)
    fade = int(3.0 * sr)
    if p3 + fade <= n:
        exit_env[p3:p3 + fade] = np.linspace(1, 0, fade)
        exit_env[p3 + fade:] = 0
    return sig * env * exit_env


def layer_reach(duration, sr=SAMPLE_RATE):
    """Wide FM voicings. t(11,16). Phase 3."""
    n = int(duration * sr)
    sig = np.zeros(n)
    freqs = [87.3, 130.8, 174.6, 207.7, 261.6]  # F minor wide
    step_dur = 60.0 / BPM / 4
    pattern = [1,1,0,1,1,1,0,1,1,0,1,1,1,0,1,1]

    for freq_idx, freq in enumerate(freqs):
        # FM synth instead of raw sawtooth
        mod_index = Signal.perlin(0.3, duration, sr).range(1, 4)
        voice = fm_synth(freq, freq * 2, mod_index, duration, sr)
        sig += voice * (0.06 - freq_idx * 0.008)

    # Euclidean gate
    gate = np.zeros(n)
    for i in range(int(duration / step_dur)):
        if pattern[i % 16] == 0:
            continue
        s = int(i * step_dur * sr)
        e = min(int((i + 0.7) * step_dur * sr), n)
        if e > s:
            gate[s:e] = np.exp(-np.linspace(0, (e - s) / sr, e - s) * 8)
    sig *= gate

    cutoff = Signal.perlin(0.3, duration, sr).range(500, 5000)
    sig = lowpass(sig, cutoff, resonance=2.0, sr=sr)

    return sig * Signal.phase_env(duration, PHASE[3], 4.0, 4.0, rate=sr).to_np()


def layer_dembow(duration, sr=SAMPLE_RATE):
    """Dembow kick. Phase 4."""
    sig = kick(duration, bpm=BPM,
               pattern=[1.0, 0, 0, 0, 1.0, 0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 0],
               pitch_start=100, pitch_end=40, punch=0.6, body=0.5,
               decay_rate=12, sr=sr)
    return sig * Signal.phase_env(duration, PHASE[4], 2.0, 4.0, rate=sr).to_np()


def layer_melody(duration, sr=SAMPLE_RATE):
    """Plucked melody through feedback delay. t(3,8). Phase 4."""
    n = int(duration * sr)
    sig = np.zeros(n)
    freqs = [261.6, 311.1, 392.0, 523.3]  # C4 Eb4 G4 C5
    step_dur = 60.0 / BPM / 4
    pattern = [1, 0, 0, 1, 0, 0, 1, 0]

    for i in range(int(duration / step_dur)):
        if pattern[i % 8] == 0:
            continue
        idx = int(i * step_dur * sr)
        freq = freqs[i % len(freqs)]
        note_dur = min(0.5, (duration - i * step_dur))
        if note_dur > 0.05:
            p = pluck(freq, note_dur, decay=0.996, brightness=0.4, sr=sr)
            end = min(idx + len(p), n)
            sig[idx:end] += p[:end - idx] * 0.12

    # Feedback delay — melody echoes into harmony
    sig = feedback_delay(sig, 60000 / BPM * 0.75, feedback=0.5, filter_cutoff=2000, sr=sr)
    return sig * Signal.phase_env(duration, PHASE[4], 2.0, 5.0, rate=sr).to_np()


def layer_soul(duration, sr=SAMPLE_RATE):
    """Long warm sine tones. The tenderness."""
    n = int(duration * sr)
    sig = np.zeros(n)
    freqs = [65.4, 98.0, 130.8, 155.6]
    bar_dur = 60.0 / BPM * 4
    for i in range(int(duration / bar_dur) + 1):
        freq = freqs[i % len(freqs)]
        s = int(i * bar_dur * sr)
        e = min(int((i + 1) * bar_dur * sr), n)
        if e > s:
            seg_t = np.linspace(0, (e - s) / sr, e - s)
            attack = np.clip(seg_t / 0.5, 0, 1)
            release = np.clip((bar_dur - seg_t) / 2.0, 0, 1)
            sig[s:e] += 0.18 * np.sin(2 * np.pi * freq * seg_t) * attack * release
    return sig * Signal.phase_env(duration, PHASE[4], 3.0, 5.0, rate=sr).to_np()


# ─── visuals ───

def _phase(t):
    for i in range(len(PHASE) - 1, -1, -1):
        if t >= PHASE[i]:
            return i
    return 0


def vis_main(frame_num, total_frames):
    t = frame_num / FPS
    phase = _phase(t)

    # Palette interpolation
    if phase < len(PALETTES) - 1:
        pp = (t - PHASE[phase]) / max(1, PHASE[min(phase + 1, len(PHASE) - 1)] - PHASE[phase])
        p = PALETTES[phase].lerp(PALETTES[min(phase + 1, len(PALETTES) - 1)], pp * 0.5)
    else:
        p = PALETTES[-1]

    img = bg_color(p.bg)
    draw = ImageDraw.Draw(img)

    beat_dur = 60.0 / BPM
    pulse = math.exp(-((t % beat_dur) / beat_dur) * 6)

    # LAYER: automata texture (always, faint)
    if t >= PHASE[0]:
        alpha = min(0.08, t / 20 * 0.08)
        row = int(t * 5) % HEIGHT
        for x in range(0, WIDTH, 4):
            if automata[row % HEIGHT][x % WIDTH]:
                draw.point((x, row), fill=alpha_color(p.fg_dim, alpha, p.bg))

    # LAYER: insect particles
    if t >= PHASE[0] and t < DURATION - 3:
        if frame_num % 3 == 0:
            parts.emit(random.randint(50, WIDTH - 50),
                      random.randint(50, HEIGHT - 50),
                      count=2, spread=80, speed=8, lifetime=4.0)
    parts.update(1 / FPS, gravity=(0, -2), drag=0.995)
    img = parts.render(img, color=p.accent, size=1)

    # LAYER: kick ring (phase 1+)
    if t >= PHASE[1]:
        ba = min(1.0, (t - PHASE[1]) / 2)
        if t > DURATION - 3:
            ba *= max(0, (DURATION - t) / 3)
        r = int(pulse * 80 + 20)
        cx, cy = WIDTH // 2, HEIGHT // 2
        draw.ellipse([cx - r, cy - r, cx + r, cy + r],
                     outline=tuple(int(c * ba * pulse) for c in p.primary), width=2)

    # LAYER: wall bars (phase 2, fades at 3)
    if PHASE[2] <= t < PHASE[3] + 3:
        wa = min(1.0, (t - PHASE[2]) / 2)
        if t > PHASE[3]:
            wa *= max(0, 1 - (t - PHASE[3]) / 3)
        for band in range(6):
            by = int(HEIGHT * band / 6)
            intensity = abs(math.sin(t * 4 + band * 0.7)) * wa
            if intensity > 0.3:
                draw.rectangle([0, by, WIDTH, by + int(HEIGHT / 6)],
                             fill=tuple(int(c * intensity * 0.25) for c in p.hot))

    # LAYER: reach arcs (phase 3+)
    if t >= PHASE[3]:
        ra = min(1.0, (t - PHASE[3]) / 4)
        if t > DURATION - 4:
            ra *= max(0, (DURATION - t) / 4)
        for vi in range(5):
            pts = []
            for x in range(0, WIDTH, 4):
                y = HEIGHT * (0.3 + vi * 0.1) + math.sin(x * 0.01 + t * (0.5 + vi * 0.1)) * 30 * ra
                pts.append((x, int(y)))
            if len(pts) > 1:
                draw.line(pts, fill=alpha_color(p.accent, ra * (0.2 + vi * 0.05), p.bg), width=1)

    # LAYER: soul circles (phase 4+)
    if t >= PHASE[4]:
        sa = min(1.0, (t - PHASE[4]) / 3)
        if t > DURATION - 5:
            sa *= max(0, (DURATION - t) / 5)
        cx, cy = WIDTH // 2, HEIGHT // 2
        for ring in range(4):
            r = 50 + ring * 40 + math.sin(t * 0.3 + ring) * 10
            draw.ellipse([int(cx - r), int(cy - r), int(cx + r), int(cy + r)],
                        outline=tuple(int(c * sa * (0.4 - ring * 0.08)) for c in p.primary), width=1)

    # HUD
    names = ["INSECTS", "BODY", "WALL", "REACH", "RESOLVE"]
    draw.text((15, HEIGHT - 25), f"PHASE {phase}: {names[min(phase, 4)]}",
              fill=p.fg_dim, font=mono(10))
    draw.text((WIDTH - 100, HEIGHT - 25), f"LAYERS: {min(phase + 1, 5)}",
              fill=p.fg_dim, font=mono(10))

    # Beat flash
    if pulse > 0.7 and t >= PHASE[1]:
        arr = np.array(img, dtype=np.float64)
        arr += 8 * pulse
        img = Image.fromarray(arr.clip(0, 255).astype(np.uint8))

    return img


# ─── compose ───

scene = Scene(duration=DURATION, title="NOCTURNAL ACCUMULATOR v2")

scene.add_visual(0, 2, vis_hero, text="NOCTURNAL ACCUMULATOR",
                 subtext="layers arrive and stay", pal=P0)
scene.add_visual(2, DURATION - 3, vis_main)
# Final fade
scene.add_visual(DURATION - 3, DURATION, vis_hero,
                 text="same thread.", subtext="", pal=P4)

# All audio layers — accumulative
scene.add_audio(0, DURATION, layer_insects)
scene.add_audio(0, DURATION, layer_kick)
scene.add_audio(0, DURATION, layer_sub)
scene.add_audio(0, DURATION, layer_hats)
scene.add_audio(0, DURATION, layer_wall)
scene.add_audio(0, DURATION, layer_reach)
scene.add_audio(0, DURATION, layer_dembow)
scene.add_audio(0, DURATION, layer_melody)
scene.add_audio(0, DURATION, layer_soul)

# Effects
scene.add_effect(fx_scanlines, opacity=0.03)
scene.add_effect(fx_vignette, strength=0.2)

# Gentle feedback that builds
scene.enable_feedback(blend=0.15, zoom=1.001,
                      color_decay=(0.99, 0.985, 0.995))

output = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                      "nocturnal_accumulator_v2.mp4")
scene.render(output)

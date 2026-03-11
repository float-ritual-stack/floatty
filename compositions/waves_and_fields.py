#!/usr/bin/env python3
"""
WAVES AND FIELDS — Wave 3 proof (Atom™ study)

"Wellen und Felder" — waves and fields.
Scientific models and poetic ideas in the same breath.

FM bells through granular clouds.
Plucked chord progressions (Schubert-adjacent: C→Am→F→G).
Flow-displaced visuals — the image breathes like the audio.
Particles trace the harmonics.
Convolution: pluck × noise = spectral frost.

The test: does it feel both scientific and romantic?
"""
import sys
import os
import math
import random
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from float_av import *

random.seed(1847)  # Helmholtz's "On the Sensations of Tone" era
np.random.seed(1847)

DURATION = 36
BPM = 72  # Slow. Waltz-adjacent.

# palette: warm, scientific, with romantic undertones
P_LIEDGUT = Palette(
    name='liedgut', bg=(8, 5, 12), bg_alt=(15, 10, 22),
    fg=(220, 200, 240), fg_dim=(120, 100, 150),
    primary=(200, 160, 255), accent=(255, 200, 140),
    hot=(255, 180, 100), cold=(140, 180, 255),
    ghost=(15, 10, 25), border=(60, 45, 90))

# Chord progression: C → Am → F → G (Schubert-adjacent)
CHORDS = [
    [130.8, 164.8, 196.0, 261.6],   # C: C3 E3 G3 C4
    [110.0, 130.8, 164.8, 220.0],   # Am: A2 C3 E3 A3
    [87.3, 110.0, 130.8, 174.6],    # F: F2 A2 C3 F3
    [98.0, 123.5, 146.8, 196.0],    # G: G2 B2 D3 G3
]

# Particles for harmonic traces
particles = Particles(max_count=300)


# ─── audio ───

def layer_chords(duration, sr=SAMPLE_RATE):
    """Plucked chord progression. The Schubert bones."""
    n = int(duration * sr)
    sig = np.zeros(n)
    bar_dur = 60.0 / BPM * 3  # waltz = 3 beats per bar

    for bar in range(int(duration / bar_dur) + 1):
        chord = CHORDS[bar % len(CHORDS)]
        t_start = bar * bar_dur
        idx = int(t_start * sr)
        chord_dur = min(bar_dur * 0.9, duration - t_start)
        if chord_dur > 0.5:
            c = pluck_chord(chord, chord_dur, decay=0.997,
                           brightness=0.35, strum_delay=0.03, sr=sr)
            end = min(idx + len(c), n)
            sig[idx:end] += c[:end - idx]

    env = Signal.env(3.0, duration - 6, 3.0, duration, rate=sr).to_np()
    return sig * env


def layer_bells(duration, sr=SAMPLE_RATE):
    """FM bells marking harmonic changes. The scientific precision."""
    n = int(duration * sr)
    sig = np.zeros(n)
    bar_dur = 60.0 / BPM * 3

    for bar in range(int(duration / bar_dur) + 1):
        chord = CHORDS[bar % len(CHORDS)]
        t_start = bar * bar_dur
        # Bell on root, offset by half a beat
        bell_t = t_start + 60.0 / BPM * 0.5
        idx = int(bell_t * sr)
        bell_dur = min(4.0, duration - bell_t)
        if bell_dur > 0.5:
            root = chord[0] * 2  # octave up
            b = fm_bell(root, bell_dur, brightness=3.0, sr=sr)
            end = min(idx + len(b), n)
            sig[idx:end] += b[:end - idx] * 0.08

    # Occasional high bell for shimmer
    shimmer_times = [8, 16, 24, 32]
    for st in shimmer_times:
        if st < duration:
            idx = int(st * sr)
            b = fm_bell(880, min(3.0, duration - st), brightness=5.0, sr=sr)
            end = min(idx + len(b), n)
            sig[idx:end] += b[:end - idx] * 0.05

    env = Signal.phase_env(duration, 2.0, fade_in=2.0, fade_out=4.0, rate=sr).to_np()
    return sig * env


def layer_granular_cloud(duration, sr=SAMPLE_RATE):
    """Granulated chord texture. The romantic irrationality.

    Takes the chord progression and dissolves it into a cloud.
    """
    # First generate the raw chord material
    raw_dur = min(10.0, duration)
    raw = np.zeros(int(raw_dur * sr))
    bar_dur = 60.0 / BPM * 3
    for bar in range(int(raw_dur / bar_dur) + 1):
        chord = CHORDS[bar % len(CHORDS)]
        idx = int(bar * bar_dur * sr)
        cd = min(bar_dur, raw_dur - bar * bar_dur)
        if cd > 0.5:
            c = pluck_chord(chord, cd, decay=0.998, brightness=0.5, sr=sr)
            end = min(idx + len(c), len(raw))
            raw[idx:end] += c[:end - idx]

    # Granulate it — dissolve the structure into texture
    cloud = granulate(raw, grain_size_ms=60, density=15,
                      pitch_spread=3, scatter=0.8,
                      duration=duration, sr=sr)

    # Filter to soften
    cloud = lowpass(cloud * 0.2, 3000, resonance=0.7, sr=sr)

    env = Signal.phase_env(duration, 6.0, fade_in=4.0, fade_out=5.0, rate=sr).to_np()
    return cloud * env


def layer_spectral_frost(duration, sr=SAMPLE_RATE):
    """Convolution: pluck × noise = spectral frost.

    The harmonic spectrum of the pluck imprinted on noise.
    Scientific (convolution is math) and poetic (the result is frost).
    """
    # Generate a single pluck
    p = pluck(220, 2.0, decay=0.998, brightness=0.6, sr=sr)
    # Convolve with short noise burst
    n_burst = noise_burst(0.5, amp=0.3, sr=sr)
    frost = convolve(n_burst, p, wet=0.8)
    # Extend to full duration by repeating with gaps
    n = int(duration * sr)
    sig = np.zeros(n)
    gap = 60.0 / BPM * 6  # every 2 bars
    for bar in range(int(duration / gap)):
        idx = int(bar * gap * sr + 2 * sr)  # offset by 2s
        end = min(idx + len(frost), n)
        if end > idx:
            sig[idx:end] += frost[:end - idx] * 0.15

    env = Signal.phase_env(duration, 10.0, fade_in=3.0, fade_out=4.0, rate=sr).to_np()
    return sig * env


def layer_shimmer(duration, sr=SAMPLE_RATE):
    """Overtone shimmer. The field."""
    sig = mirror_shimmer(duration, root=220, sr=sr) * 0.5
    env = Signal.phase_env(duration, 4.0, fade_in=5.0, fade_out=5.0, rate=sr).to_np()
    return sig * env


# ─── visuals ───

def vis_waves(frame_num, total_frames):
    """Flow-displaced visuals with harmonic particles."""
    t = frame_num / FPS
    progress = t / DURATION
    p = P_LIEDGUT

    img = bg_color(p.bg)
    draw = ImageDraw.Draw(img)

    bar_dur = 60.0 / BPM * 3
    current_bar = int(t / bar_dur)
    bar_progress = (t % bar_dur) / bar_dur

    # Harmonic arcs — one per chord tone
    chord = CHORDS[current_bar % len(CHORDS)]
    for i, freq in enumerate(chord):
        # Each tone traces a sine arc across the screen
        arc_y = HEIGHT * (0.25 + i * 0.15)
        amplitude = 30 + 10 * math.sin(t * 0.5 + i)
        phase_offset = freq * 0.01  # frequency determines phase
        pts = []
        for x in range(0, WIDTH, 3):
            y = arc_y + amplitude * math.sin(x * phase_offset + t * 0.5)
            pts.append((x, int(y)))
        if len(pts) > 1:
            alpha = 0.3 + 0.2 * math.sin(t + i * 1.5)
            color = lerp_color(p.cold, p.hot, i / max(len(chord) - 1, 1))
            draw.line(pts, fill=alpha_color(color, alpha, p.bg), width=1)

    # Particle emission on chord changes
    if bar_progress < 0.05:
        particles.emit(WIDTH // 2, HEIGHT // 2, count=8,
                      spread=100, speed=20, lifetime=3.0)

    # Update and render particles
    particles.update(1 / FPS, gravity=(0, -5), drag=0.99)
    img = particles.render(img, color=p.accent, size=1)

    # Granular cloud visualization (phase 2+, after 6s)
    if t > 6:
        cloud_alpha = min(0.3, (t - 6) / 10 * 0.3)
        for _ in range(5):
            cx = random.randint(50, WIDTH - 50)
            cy = random.randint(50, HEIGHT - 50)
            r = random.randint(3, 12)
            c = alpha_color(p.primary, cloud_alpha * random.random(), p.bg)
            draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=c)

    # Bottom: waveform label
    chord_names = ["C", "Am", "F", "G"]
    chord_name = chord_names[current_bar % len(chord_names)]
    draw.text((15, HEIGHT - 30), chord_name, fill=p.fg_dim, font=serif(14))

    # "Wellen und Felder" appears late
    if progress > 0.7:
        alpha = min(1.0, (progress - 0.7) * 4)
        fade = 1 - max(0, (progress - 0.9) * 10)
        draw_centered(draw, "Wellen und Felder",
                      HEIGHT - 60, serif_italic(14),
                      alpha_color(p.accent, alpha * max(0, fade), p.bg))

    # Apply flow displacement — the image breathes
    if t > 4:
        strength = min(15, (t - 4) * 0.8)
        img = fx_flow(img, scale=0.015, strength=strength, time=t)

    return fx_scanlines(img, 0.03)


# ─── compose ───

scene = Scene(duration=DURATION, title="WAVES AND FIELDS")

scene.add_visual(0, 3, vis_hero, text="WELLEN UND FELDER",
                 subtext="waves and fields", pal=P_LIEDGUT)
scene.add_visual(3, DURATION, vis_waves)

scene.add_audio(0, DURATION, layer_chords)
scene.add_audio(0, DURATION, layer_bells)
scene.add_audio(0, DURATION, layer_granular_cloud)
scene.add_audio(0, DURATION, layer_spectral_frost)
scene.add_audio(0, DURATION, layer_shimmer)

scene.add_effect(fx_vignette, strength=0.25)

# Gentle feedback — scientific precision, not chaos
scene.enable_feedback(blend=0.2, zoom=1.001,
                      color_decay=(0.99, 0.985, 0.995))

output = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                      "waves_and_fields.mp4")
scene.render(output)

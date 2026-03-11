#!/usr/bin/env python3
"""
GROUND LOOP — Wave 2 proof

"let me loop the ground signal back into renoise until eyes start to wobble"
    — sleeparchive, probably

The premise: start with noise floor. Feed it back through delays and filters
until rhythm and pitch emerge from nothing. The audio feedback creates the
composition. The visual feedback mirrors it — frame feedback loops until
the image wobbles.

Three phases:
  0-10s:  noise floor + mains hum. barely there. frame feedback accumulates.
  10-22s: feedback delay makes the noise rhythmic. plucked strings emerge.
          FM bells mark the moments. visual feedback intensifies.
  22-32s: everything layered. kick arrives late. the ground signal
          has become music.
"""
import sys
import os
import math
import random
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from float_av import *

random.seed(1984)
np.random.seed(1984)

DURATION = 32
BPM = 120
PHASE = [0, 10, 22]

# palette: dark, industrial, green-tinted
P_GROUND = Palette(
    name='ground', bg=(3, 5, 3), bg_alt=(8, 12, 8),
    fg=(0, 180, 40), fg_dim=(0, 60, 15),
    primary=(0, 255, 80), accent=(200, 255, 100),
    hot=(255, 200, 0), cold=(0, 120, 60),
    ghost=(5, 10, 5), border=(0, 40, 10))


# ─── audio ───

def layer_ground_noise(duration, sr=SAMPLE_RATE):
    """The ground signal. 60Hz hum + noise floor. Always present."""
    n = int(duration * sr)
    t = np.linspace(0, duration, n)
    # Mains hum
    sig = 0.06 * np.sin(2 * np.pi * 60 * t)
    sig += 0.02 * np.sin(2 * np.pi * 120 * t)
    # Noise floor — very quiet
    sig += 0.03 * np.random.randn(n)
    # Bandpass the noise to give it character
    sig = lowpass(sig, 800, resonance=2.0, sr=sr)
    env = Signal.env(2.0, duration - 5, 3.0, duration, rate=sr).to_np()
    return sig * env


def layer_feedback_texture(duration, sr=SAMPLE_RATE):
    """Noise → feedback delay → rhythm emerges.

    The core Sleeparchive technique: the delay makes nothing into something.
    """
    n = int(duration * sr)
    # Start with shaped noise bursts — euclidean trigger pattern
    sig = np.zeros(n)
    step_dur = 60.0 / BPM / 4
    pattern = [1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]  # t(7,16)ish

    for i in range(int(duration / step_dur)):
        if pattern[i % 16] == 0:
            continue
        idx = int(i * step_dur * sr)
        burst_len = min(int(0.01 * sr), n - idx)
        if burst_len > 0:
            sig[idx:idx + burst_len] = 0.15 * np.random.randn(burst_len)

    # Feed through delay with filter — this is where rhythm emerges
    # Delay at dotted 8th creates syncopation against the pattern
    delay_ms = 60000 / BPM * 0.75  # dotted 8th
    sig = feedback_delay(sig, delay_ms, feedback=0.65, filter_cutoff=1500, sr=sr)

    # Second delay tap — shorter, creates ghost notes
    sig = feedback_delay(sig, delay_ms * 0.5, feedback=0.3, filter_cutoff=800, sr=sr)

    # Waveshape — the delay saturation
    sig = waveshape(sig, 0.4) * 0.3

    env = Signal.phase_env(duration, PHASE[1], fade_in=4.0, fade_out=3.0, rate=sr).to_np()
    return sig * env


def layer_plucks(duration, sr=SAMPLE_RATE):
    """Karplus-Strong strings emerge from the feedback texture.

    Sparse. Each note hangs in the delay field.
    """
    n = int(duration * sr)
    sig = np.zeros(n)
    # A minor voicings: A2, E3, A3, C4
    notes = [110, 164.8, 220, 261.6]
    step_dur = 60.0 / BPM
    # Very sparse — one note every 2-4 beats
    note_times = []
    t = 0
    idx = 0
    while t < duration:
        note_times.append((t, notes[idx % len(notes)]))
        t += step_dur * (2 + random.random() * 2)
        idx += 1

    for t_note, freq in note_times:
        i = int(t_note * sr)
        note_dur = min(2.0, duration - t_note)
        if note_dur > 0.1:
            p = pluck(freq, note_dur, decay=0.997, brightness=0.4, sr=sr)
            end = min(i + len(p), n)
            sig[i:end] += p[:end - i] * 0.15

    # Put plucks through delay too — they echo into the texture
    sig = feedback_delay(sig, 60000 / BPM * 0.75, feedback=0.4, filter_cutoff=2000, sr=sr)

    env = Signal.phase_env(duration, PHASE[1] + 2, fade_in=3.0, fade_out=3.0, rate=sr).to_np()
    return sig * env


def layer_bells(duration, sr=SAMPLE_RATE):
    """FM bells mark structural moments. Sparse, resonant."""
    n = int(duration * sr)
    sig = np.zeros(n)
    # Bell at phase transitions and midpoints
    bell_times = [PHASE[1], PHASE[1] + 4, PHASE[2], PHASE[2] + 4, PHASE[2] + 8]
    bell_freqs = [440, 554, 330, 440, 659]

    for bt, bf in zip(bell_times, bell_freqs):
        if bt >= duration:
            continue
        i = int(bt * sr)
        bell_dur = min(3.0, duration - bt)
        b = fm_bell(bf, bell_dur, brightness=4.0, sr=sr)
        end = min(i + len(b), n)
        sig[i:end] += b[:end - i] * 0.12

    env = Signal.phase_env(duration, PHASE[1], fade_in=1.0, fade_out=3.0, rate=sr).to_np()
    return sig * env


def layer_late_kick(duration, sr=SAMPLE_RATE):
    """Kick arrives late — the ground signal has become music."""
    sig = kick(duration, bpm=BPM,
               pattern=[0.9, 0, 0, 0, 0, 0, 0, 0, 0.7, 0, 0, 0, 0, 0, 0, 0],
               pitch_start=120, pitch_end=35, punch=0.6, body=0.5,
               decay_rate=12, sr=sr)
    env = Signal.phase_env(duration, PHASE[2], fade_in=3.0, fade_out=2.0, rate=sr).to_np()
    return sig * env


# ─── visuals ───

def vis_ground(frame_num, total_frames):
    """Minimal visuals — the feedback does the work."""
    t = frame_num / FPS
    progress = t / DURATION
    phase = 0
    for i in range(len(PHASE) - 1, -1, -1):
        if t >= PHASE[i]:
            phase = i
            break

    p = P_GROUND
    img = bg_color(p.bg)
    draw = ImageDraw.Draw(img)

    # Oscilloscope-style waveform line
    wave_y = HEIGHT // 2
    pts = []
    freq = 60  # mains frequency
    amp = 5 + phase * 15 + 10 * math.sin(t * 0.3)
    for x in range(0, WIDTH, 2):
        y_val = wave_y + amp * math.sin(x * 0.03 + t * freq * 0.01)
        # Add noise to the waveform
        y_val += random.gauss(0, 1 + phase * 2)
        pts.append((x, int(y_val)))
    if len(pts) > 1:
        color_alpha = 0.3 + phase * 0.2
        draw.line(pts, fill=alpha_color(p.primary, color_alpha, p.bg), width=1)

    # Phase 1+: feedback artifacts — faint horizontal lines
    if phase >= 1:
        alpha = min(1.0, (t - PHASE[1]) / 4)
        for i in range(5):
            ly = int(HEIGHT * (0.2 + i * 0.15 + 0.02 * math.sin(t + i)))
            draw.line([(0, ly), (WIDTH, ly)],
                      fill=alpha_color(p.fg_dim, alpha * 0.15, p.bg))

    # Phase 2+: bell markers — brief flashes
    if phase >= 2:
        beat_dur = 60.0 / BPM
        beat_phase = (t % beat_dur) / beat_dur
        if beat_phase < 0.05:
            # Subtle center dot on downbeat
            cx, cy = WIDTH // 2, HEIGHT // 2
            r = 3
            draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=p.accent)

    # Sparse text
    if phase == 0 and t > 2:
        draw.text((15, HEIGHT - 25), "GROUND SIGNAL", fill=p.fg_dim, font=mono(10))
    elif phase == 1:
        draw.text((15, HEIGHT - 25), "FEEDBACK ACTIVE", fill=p.fg_dim, font=mono(10))
    elif phase == 2:
        draw.text((15, HEIGHT - 25), "LOOP STABLE", fill=p.primary, font=mono(10))

    return img


# ─── compose ───

scene = Scene(duration=DURATION, title="GROUND LOOP")

# Title
scene.add_visual(0, 3, vis_hero, text="GROUND LOOP",
                 subtext="noise → delay → rhythm", pal=P_GROUND)
# Main visual
scene.add_visual(3, DURATION, vis_ground)

# Frame feedback — the visual mirror of audio feedback
# Builds throughout: low blend early, increasing
blend_curve = Signal.perlin(0.2, DURATION, FPS).range(0.3, 0.75)
scene.enable_feedback(blend=blend_curve, zoom=1.003,
                      color_decay=(0.97, 0.98, 0.96))

# Audio layers — accumulative
scene.add_audio(0, DURATION, layer_ground_noise)
scene.add_audio(0, DURATION, layer_feedback_texture)
scene.add_audio(0, DURATION, layer_plucks)
scene.add_audio(0, DURATION, layer_bells)
scene.add_audio(0, DURATION, layer_late_kick)

# Effects
scene.add_effect(fx_scanlines, opacity=0.06)

output = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                      "ground_loop.mp4")
scene.render(output)

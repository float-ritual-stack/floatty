#!/usr/bin/env python3
"""
PRESSURE — warehouse proof

Not Schubert. Not church. Concrete floor, 3am, the sub rattles your sternum.

Surgeon, Regis, Sleeparchive, Shed — the Birmingham-Berlin axis.
140 BPM. Four-on-the-floor that doesn't apologize.

The acid line is an FM saw through a resonant filter sweep —
not a 303, but the same idea: automate the cutoff, let resonance scream.

Three phases, 40 seconds:
  0: pressure builds   — sub rumble + industrial noise, no kick yet
  8: the floor opens   — kick drops, acid line enters, hats lock in
  22: full send         — stabs, feedback delay, everything at once
  36: cut               — silence is a choice

No plucked chords. No bells. No shimmer. No soul layer.
If it sounds like christmas mass, something went wrong.
"""
import sys
import os
import math
import random
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from float_av import *

random.seed(303)
np.random.seed(303)

DURATION = 40
BPM = 140
PHASE = [0, 8, 22, 36]  # pressure, floor, full send, cut

# palette: concrete and sodium vapor
P_CONCRETE = Palette(
    name='concrete', bg=(5, 5, 5), bg_alt=(12, 12, 10),
    fg=(200, 200, 190), fg_dim=(60, 60, 55),
    primary=(255, 60, 0), accent=(255, 180, 0),
    hot=(255, 30, 0), cold=(80, 80, 80),
    ghost=(10, 10, 8), border=(40, 40, 35))


# ─── audio ───

def layer_sub_pressure(duration, sr=SAMPLE_RATE):
    """Sub-bass rumble. Always present. The room tone of a warehouse.

    Low saw through heavy lowpass. Perlin-modulated pitch wobble.
    This is felt, not heard.
    """
    n = int(duration * sr)
    # Sub frequency wobbles around 38Hz
    pitch_mod = Signal.perlin(0.3, duration, sr).range(36, 42)
    saw = Signal.saw(38, duration, sr).to_np()
    # Heavy lowpass — only the fundamental gets through
    filtered = lowpass(saw, pitch_mod, resonance=3.0, sr=sr)
    sig = filtered * 0.45
    # Light waveshape for warmth (not distortion — this is sub)
    sig = waveshape(sig, 0.15)
    env = Signal.env(3.0, duration - 5, 2.0, duration, rate=sr).to_np()
    return sig * env


def layer_industrial_noise(duration, sr=SAMPLE_RATE):
    """Textured noise hits. Euclidean pattern through bandpass.

    The sound of machinery. Not musical — mechanical.
    """
    n = int(duration * sr)
    sig = np.zeros(n)
    step_dur = 60.0 / BPM / 4  # 16th notes

    # t(5,16) euclidean pattern — asymmetric, lurching
    pattern = [1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0]

    for i in range(int(duration / step_dur)):
        if pattern[i % 16] == 0:
            continue
        idx = int(i * step_dur * sr)
        hit_len = min(int(0.015 * sr), n - idx)
        if hit_len > 0:
            # Short noise burst, sharp decay
            burst = np.random.randn(hit_len) * np.exp(-np.linspace(0, 1, hit_len) * 60)
            sig[idx:idx + hit_len] += burst * 0.25

    # Bandpass around 800Hz — gives it a metallic clang character
    sig = bandpass(sig, 800, resonance=4.0, sr=sr)
    sig = waveshape(sig, 0.5) * 0.2

    env = Signal.phase_env(duration, PHASE[0], fade_in=2.0, fade_out=3.0, rate=sr).to_np()
    return sig * env


def layer_kick(duration, sr=SAMPLE_RATE):
    """The kick. Four on the floor. No swing, no mercy.

    High punch, moderate body, click for definition in the mix.
    Drops at phase 1.
    """
    sig = kick(duration, bpm=BPM,
               pattern=[1.0, 0, 0, 0] * 4,
               pitch_start=160, pitch_end=36,
               punch=0.9, body=0.7, click=0.4,
               decay_rate=9, sr=sr)
    env = Signal.phase_env(duration, PHASE[1], fade_in=0.5, fade_out=1.0, rate=sr).to_np()
    return sig * env


def layer_acid(duration, sr=SAMPLE_RATE):
    """Acid line. FM saw through screaming resonant filter.

    The cutoff sweeps are the composition. Perlin-driven —
    not periodic, not predictable. The filter finds the notes.
    """
    n = int(duration * sr)
    step_dur = 60.0 / BPM / 4
    sig = np.zeros(n)

    # Bass notes: F1 and Ab1 alternating every bar
    bar_dur = 60.0 / BPM * 4
    root_freqs = [43.65, 51.91, 43.65, 46.25]  # F Ab F Gb — chromatic tension

    for bar in range(int(duration / bar_dur) + 1):
        root = root_freqs[bar % len(root_freqs)]
        s = int(bar * bar_dur * sr)
        e = min(int((bar + 1) * bar_dur * sr), n)
        seg_len = e - s
        if seg_len <= 0:
            continue

        # FM synth: carrier at root, mod at root*1 (unison ratio = thick)
        # Mod index modulated by perlin — timbre shifts constantly
        mod_idx = Signal.perlin(1.5, seg_len / sr, sr).range(0.5, 3.0)
        voice = fm_synth(root, root * 1.0, mod_idx, seg_len / sr, sr)

        # Also add a raw saw for grit
        raw_saw = Signal.saw(root, seg_len / sr, sr).to_np()
        mixed = voice * 0.5 + raw_saw * 0.5
        sig[s:e] += mixed[:e - s]

    # THE filter sweep — this is everything
    # Perlin cutoff: slow sweeps from 200 to 4000Hz
    cutoff = Signal.perlin(0.4, duration, sr).range(200, 4000)
    # Resonance is high — the filter sings
    sig = lowpass(sig, cutoff, resonance=6.0, sr=sr)

    # Waveshape post-filter — saturate the resonance peaks
    sig = waveshape(sig, 0.6) * 0.3

    env = Signal.phase_env(duration, PHASE[1] + 2, fade_in=3.0, fade_out=2.0, rate=sr).to_np()
    return sig * env


def layer_hats(duration, sr=SAMPLE_RATE):
    """Hihats. Offbeat open hat is the pulse.

    Closed hats fill the gaps. Simple, relentless.
    """
    sig = hihat(duration, bpm=BPM,
                pattern=[
                    None,    ('c', 0.3), ('o', 0.6), ('c', 0.3),
                    None,    ('c', 0.3), ('o', 0.6), ('c', 0.3),
                    None,    ('c', 0.3), ('o', 0.6), ('c', 0.4),
                    None,    ('c', 0.3), ('o', 0.5), ('c', 0.3),
                ],
                open_decay=0.08, closed_decay=0.015, sr=sr)
    env = Signal.phase_env(duration, PHASE[1] + 1, fade_in=2.0, fade_out=2.0, rate=sr).to_np()
    return sig * env


def layer_stabs(duration, sr=SAMPLE_RATE):
    """Distorted square stabs. Phase 2 only.

    Short, aggressive, high-passed. The opposite of a pad.
    Feedback delay turns single hits into cascading patterns.
    """
    n = int(duration * sr)
    step_dur = 60.0 / BPM / 4
    sig = np.zeros(n)

    # Syncopated stab pattern — hits on the AND of beats
    pattern = [0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0]

    for i in range(int(duration / step_dur)):
        if pattern[i % 16] == 0:
            continue
        idx = int(i * step_dur * sr)
        stab_len = min(int(0.03 * sr), n - idx)
        if stab_len > 0:
            t_arr = np.linspace(0, stab_len / sr, stab_len)
            # Square wave at 87Hz (F2) — hard, nasal
            stab = np.sign(np.sin(2 * np.pi * 87.3 * t_arr))
            stab *= np.exp(-t_arr * 30)  # sharp decay
            sig[idx:idx + stab_len] += stab * 0.35

    # Hard waveshape
    sig = waveshape(sig, 0.8) * 0.2
    # Highpass to keep it out of the sub's way
    sig = highpass(sig, 300, resonance=2.0, sr=sr)
    # Feedback delay — dotted 8th, the stabs cascade
    sig = feedback_delay(sig, 60000 / BPM * 0.75, feedback=0.45,
                         filter_cutoff=1500, sr=sr)

    # Phase 2 only — enters and stays
    env = Signal.phase_env(duration, PHASE[2], fade_in=1.0, fade_out=2.0, rate=sr).to_np()
    return sig * env


def layer_clap(duration, sr=SAMPLE_RATE):
    """Noise clap on 2 and 4. Layered with the kick for weight."""
    n = int(duration * sr)
    sig = np.zeros(n)
    step_dur = 60.0 / BPM / 4

    for i in range(int(duration / step_dur)):
        # Hits on beat 2 and 4 (positions 4 and 12 in 16th grid)
        pos = i % 16
        if pos not in (4, 12):
            continue
        idx = int(i * step_dur * sr)
        clap_len = min(int(0.025 * sr), n - idx)
        if clap_len > 0:
            # Multiple short noise bursts layered (clap = hand slaps)
            clap = np.zeros(clap_len)
            for offset in [0, 0.002, 0.004]:
                o = int(offset * sr)
                remaining = clap_len - o
                if remaining > 0:
                    clap[o:] += np.random.randn(remaining) * np.exp(
                        -np.linspace(0, 1, remaining) * 40)
            sig[idx:idx + clap_len] += clap * 0.2

    # Bandpass for snap
    sig = bandpass(sig, 1200, resonance=2.0, sr=sr)

    env = Signal.phase_env(duration, PHASE[1], fade_in=1.0, fade_out=2.0, rate=sr).to_np()
    return sig * env


def layer_ride(duration, sr=SAMPLE_RATE):
    """Ride cymbal texture. Phase 2. Adds air and urgency."""
    n = int(duration * sr)
    sig = np.zeros(n)
    step_dur = 60.0 / BPM / 4

    # Every 16th note, very quiet — creates a wash
    for i in range(int(duration / step_dur)):
        idx = int(i * step_dur * sr)
        ride_len = min(int(0.04 * sr), n - idx)
        if ride_len > 0:
            r = np.random.randn(ride_len) * np.exp(-np.linspace(0, 1, ride_len) * 25)
            vel = 0.04 + 0.02 * (i % 4 == 0)  # accent on beats
            sig[idx:idx + ride_len] += r * vel

    # Highpass — ride lives above everything else
    sig = highpass(sig, 6000, resonance=1.0, sr=sr)

    env = Signal.phase_env(duration, PHASE[2], fade_in=3.0, fade_out=2.0, rate=sr).to_np()
    return sig * env


# ─── visuals ───

def _phase(t):
    for i in range(len(PHASE) - 1, -1, -1):
        if t >= PHASE[i]:
            return i
    return 0


def vis_pressure(frame_num, total_frames):
    """Warehouse visuals. Dark. Beat-reactive. No beauty for its own sake."""
    t = frame_num / FPS
    phase = _phase(t)
    p = P_CONCRETE

    img = bg_color(p.bg)
    draw = ImageDraw.Draw(img)

    beat_dur = 60.0 / BPM
    beat_phase = (t % beat_dur) / beat_dur
    pulse = math.exp(-beat_phase * 8)  # sharp transient, fast decay

    # LAYER: sub vibration — the whole image shakes with the sub
    if phase >= 0:
        shake = int(2 * math.sin(t * 38 * 2 * math.pi) * (0.3 + phase * 0.2))
        if abs(shake) > 0:
            arr = np.array(img)
            arr = np.roll(arr, shake, axis=0)
            img = Image.fromarray(arr)
            draw = ImageDraw.Draw(img)

    # LAYER: horizontal noise bars — machinery
    noise_intensity = min(0.15, t / 20 * 0.15) + phase * 0.03
    for _ in range(3 + phase * 2):
        y = random.randint(0, HEIGHT - 1)
        h = random.randint(1, 3)
        alpha = noise_intensity * random.random()
        draw.rectangle([0, y, WIDTH, y + h],
                       fill=alpha_color(p.fg_dim, alpha, p.bg))

    # LAYER: kick flash — phase 1+
    if phase >= 1 and pulse > 0.5:
        flash_val = int(pulse * 25)
        arr = np.array(img, dtype=np.int16)
        arr += flash_val
        img = Image.fromarray(arr.clip(0, 255).astype(np.uint8))
        draw = ImageDraw.Draw(img)

    # LAYER: vertical bars — frequency bands, phase 1+
    if phase >= 1:
        bar_alpha = min(1.0, (t - PHASE[1]) / 3)
        n_bars = 16
        bar_w = WIDTH // n_bars
        for bi in range(n_bars):
            # Each bar pulses at different rate
            bar_val = abs(math.sin(t * (2 + bi * 0.3) + bi * 0.5))
            bar_val *= pulse * 0.7 if bi % 4 == 0 else 0.3
            if bar_val > 0.2:
                x = bi * bar_w
                color = alpha_color(p.primary if bi % 4 == 0 else p.cold,
                                    bar_val * bar_alpha * 0.3, p.bg)
                draw.rectangle([x, 0, x + bar_w - 2, HEIGHT], fill=color)

    # LAYER: acid sweep visualization — phase 1+
    if phase >= 1:
        sweep_y = int(HEIGHT * (0.3 + 0.4 * math.sin(t * 0.4)))
        sweep_alpha = min(0.4, (t - PHASE[1]) / 5 * 0.4)
        # Horizontal line that follows the filter cutoff
        draw.line([(0, sweep_y), (WIDTH, sweep_y)],
                  fill=alpha_color(p.accent, sweep_alpha, p.bg), width=2)
        # Resonance glow around it
        for offset in range(1, 6):
            glow_alpha = sweep_alpha * (1 - offset / 6) * 0.3
            draw.line([(0, sweep_y + offset * 3), (WIDTH, sweep_y + offset * 3)],
                      fill=alpha_color(p.accent, glow_alpha, p.bg), width=1)
            draw.line([(0, sweep_y - offset * 3), (WIDTH, sweep_y - offset * 3)],
                      fill=alpha_color(p.accent, glow_alpha, p.bg), width=1)

    # LAYER: stab flashes — phase 2+
    if phase >= 2:
        stab_pattern = [0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0]
        step_dur = 60.0 / BPM / 4
        current_step = int(t / step_dur) % 16
        if stab_pattern[current_step] == 1:
            step_phase = (t % step_dur) / step_dur
            if step_phase < 0.15:
                # Hard red flash on stab hits
                stab_flash = int((1 - step_phase / 0.15) * 40)
                arr = np.array(img, dtype=np.int16)
                arr[:, :, 0] += stab_flash  # red channel only
                img = Image.fromarray(arr.clip(0, 255).astype(np.uint8))
                draw = ImageDraw.Draw(img)

    # LAYER: strobe — phase 2, occasional
    if phase >= 2:
        # Strobe on every 4th bar, first beat only
        bar_in_phrase = int(t / (beat_dur * 4)) % 4
        if bar_in_phrase == 3 and beat_phase < 0.03:
            arr = np.array(img, dtype=np.int16)
            arr += 120
            img = Image.fromarray(arr.clip(0, 255).astype(np.uint8))
            draw = ImageDraw.Draw(img)

    # HUD — minimal
    if phase == 0:
        draw.text((15, HEIGHT - 22), "PRESSURE BUILDING",
                  fill=p.fg_dim, font=mono(10))
    elif phase == 1:
        draw.text((15, HEIGHT - 22), f"{BPM} BPM",
                  fill=alpha_color(p.primary, 0.5 + pulse * 0.5, p.bg),
                  font=mono(10))
    elif phase >= 2:
        draw.text((15, HEIGHT - 22), "FULL SEND",
                  fill=alpha_color(p.hot, 0.4 + pulse * 0.6, p.bg),
                  font=mono(10))

    return img


# ─── compose ───

scene = Scene(duration=DURATION, title="PRESSURE")

scene.add_visual(0, 2, vis_hero, text="PRESSURE",
                 subtext=f"{BPM} bpm", pal=P_CONCRETE)
scene.add_visual(2, PHASE[3], vis_pressure)
# Hard cut to black at the end — no fade, no resolve
scene.add_visual(PHASE[3], DURATION, vis_hero,
                 text="", subtext="", pal=P_CONCRETE)

# Audio layers — accumulative
scene.add_audio(0, DURATION, layer_sub_pressure)
scene.add_audio(0, DURATION, layer_industrial_noise)
scene.add_audio(0, DURATION, layer_kick)
scene.add_audio(0, DURATION, layer_acid)
scene.add_audio(0, DURATION, layer_hats)
scene.add_audio(0, DURATION, layer_clap)
scene.add_audio(0, DURATION, layer_stabs)
scene.add_audio(0, DURATION, layer_ride)

# Effects — harsh, not pretty
scene.add_effect(fx_scanlines, opacity=0.08)
scene.add_effect(fx_vignette, strength=0.4)

# Feedback — tighter than other pieces, more aggressive
# The zoom creates tunnel vision. Color decay strips warmth.
scene.enable_feedback(blend=0.25, zoom=1.004,
                      color_decay=(0.96, 0.97, 0.98))

output = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                      "pressure.mp4")
scene.render(output)

#!/usr/bin/env python3
"""
SIGNAL TEST — Wave 1 proof

Three accumulative phases proving the Signal→filter→waveshape chain:
  phase 0: insects (euclidean sine clicks, perlin gain)
  phase 1: the body (kick + filtered saw bass with perlin cutoff sweep)
  phase 2: the wall (waveshaped square stabs, everything stacked)

24 seconds. Enough to hear it breathe.
"""
import sys
import os
import math
import random
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from float_av import *

random.seed(2026)
np.random.seed(2026)

DURATION = 24
BPM = 126
PHASE = [0, 6, 14]  # insects, body, wall

# ─── palettes ───

P_INSECTS = Palette(
    name='insects', bg=(2, 5, 8), bg_alt=(5, 10, 15),
    fg=(80, 200, 120), fg_dim=(30, 80, 50), primary=(0, 180, 80),
    accent=(100, 255, 180), hot=(200, 255, 150), cold=(40, 120, 80),
    ghost=(5, 15, 10), border=(20, 60, 30))

P_BODY = Palette(
    name='body', bg=(5, 3, 12), bg_alt=(12, 8, 25),
    fg=(200, 180, 230), fg_dim=(80, 60, 110), primary=hex_color('#7D56F4'),
    accent=(0, 200, 100), hot=hex_color('#FF6AC1'), cold=(80, 160, 255),
    ghost=(15, 10, 28), border=(50, 35, 75))

P_WALL = Palette(
    name='wall', bg=(18, 3, 3), bg_alt=(35, 8, 8),
    fg=(255, 200, 180), fg_dim=(150, 80, 60), primary=(255, 60, 30),
    accent=(255, 120, 0), hot=(255, 20, 20), cold=(200, 50, 0),
    ghost=(30, 8, 5), border=(100, 30, 20))


# ─── audio layers ───

def layer_insects(duration, sr=SAMPLE_RATE):
    """Euclidean sine clicks. Perlin-modulated gain. t(5,8)."""
    n = int(duration * sr)
    sig = np.zeros(n)
    freqs = [1047, 1245, 1568, 2093]  # C6 Eb6 G6 C7
    step_dur = 60.0 / BPM / 4
    # Bjorklund 5/8
    pattern = [1, 0, 1, 0, 1, 0, 1, 1]
    gain_mod = Signal.perlin(2.0, duration, sr).range(0.08, 0.22).to_np()

    for i in range(int(duration / step_dur)):
        if pattern[i % 8] == 0:
            continue
        idx = int(i * step_dur * sr)
        freq = freqs[i % len(freqs)]
        click_len = min(int(0.012 * sr), n - idx)
        if click_len > 0:
            ct = np.linspace(0, click_len / sr, click_len)
            click = np.sin(2 * np.pi * freq * ct) * np.exp(-ct * 80)
            sig[idx:idx + click_len] += gain_mod[min(idx, n - 1)] * click

    env = Signal.phase_env(duration, PHASE[0], fade_in=2.0, fade_out=3.0, rate=sr).to_np()
    return sig * env


def layer_kick(duration, sr=SAMPLE_RATE):
    """Four-on-the-floor. Phase 1+."""
    sig = kick(duration, bpm=BPM,
               pattern=[1.0, 0, 0, 0, 0.8, 0, 0, 0, 1.0, 0, 0, 0, 0.8, 0, 0, 0],
               pitch_start=150, pitch_end=38, punch=0.8, body=0.65,
               click=0.2, decay_rate=11, sr=sr)
    env = Signal.phase_env(duration, PHASE[1], fade_in=2.0, fade_out=2.0, rate=sr).to_np()
    return sig * env


def layer_bass(duration, sr=SAMPLE_RATE):
    """Sawtooth bass with perlin-driven resonant filter sweep. The Signal chain proof."""
    n = int(duration * sr)
    # Generate raw sawtooth at F1
    saw = Signal.saw(43.65, duration, sr).to_np()
    # Add slight detune for width
    saw2 = Signal.saw(43.65 * 1.005, duration, sr).to_np()
    raw = 0.5 * saw + 0.5 * saw2

    # Perlin-driven filter cutoff: 200-1200 Hz
    cutoff = Signal.perlin(0.5, duration, sr).range(200, 1200)

    # Apply resonant lowpass — this is the core test
    filtered = lowpass(raw, cutoff, resonance=4.0, sr=sr)

    # Gentle saturation
    sig = waveshape(filtered, 0.3) * 0.35

    env = Signal.phase_env(duration, PHASE[1], fade_in=3.0, fade_out=2.0, rate=sr).to_np()
    return sig * env


def layer_hats(duration, sr=SAMPLE_RATE):
    """Open hats. Phase 1+."""
    sig = hihat(duration, bpm=BPM,
                pattern=[None, None, ('o', 0.4), None,
                         None, None, ('o', 0.35), None] * 2,
                open_decay=0.12, sr=sr)
    env = Signal.phase_env(duration, PHASE[1], fade_in=4.0, fade_out=2.0, rate=sr).to_np()
    return sig * env


def layer_wall(duration, sr=SAMPLE_RATE):
    """Waveshaped square stabs. Pan Sonic territory. Phase 2."""
    n = int(duration * sr)
    step_dur = 60.0 / BPM / 4
    sig = np.zeros(n)

    for i in range(int(duration / step_dur)):
        idx = int(i * step_dur * sr)
        stab_len = min(int(0.05 * sr), n - idx)
        if stab_len > 0:
            st = np.linspace(0, stab_len / sr, stab_len)
            sig[idx:idx + stab_len] += 0.4 * np.sign(np.sin(2 * np.pi * 43.65 * st)) * np.exp(-st * 20)

    # Heavy waveshaping — shape(0.85)
    sig = waveshape(sig, 0.85) * 0.25

    # Highpass to sit above the bass
    sig = highpass(sig, 200, resonance=1.0, sr=sr)

    env = Signal.phase_env(duration, PHASE[2], fade_in=2.0, fade_out=2.0, rate=sr).to_np()
    return sig * env


# ─── visuals ───

def _current_phase(t):
    for i in range(len(PHASE) - 1, -1, -1):
        if t >= PHASE[i]:
            return i
    return 0


def vis_main(frame_num, total_frames):
    """Accumulative visual — layers stack."""
    t = frame_num / FPS
    progress = t / DURATION
    phase = _current_phase(t)
    palettes = [P_INSECTS, P_BODY, P_WALL]

    if phase < len(palettes) - 1:
        phase_progress = (t - PHASE[phase]) / max(1, PHASE[min(phase + 1, len(PHASE) - 1)] - PHASE[phase])
        p = palettes[phase].lerp(palettes[min(phase + 1, len(palettes) - 1)], phase_progress * 0.4)
    else:
        p = palettes[-1]

    img = bg_color(p.bg)
    draw = ImageDraw.Draw(img)

    beat_dur = 60.0 / BPM
    beat_phase = (t % beat_dur) / beat_dur
    pulse = math.exp(-beat_phase * 6)

    # LAYER: insect dots (always)
    if t >= PHASE[0]:
        alpha = min(1.0, (t - PHASE[0]) / 2.0)
        if t > DURATION - 3:
            alpha *= max(0, (DURATION - t) / 3)
        for i in range(12):
            ix = int((math.sin(t * 0.3 + i * 1.7) * 0.4 + 0.5) * WIDTH)
            iy = int((math.cos(t * 0.2 + i * 2.3) * 0.4 + 0.5) * HEIGHT)
            visible = ((frame_num + i * 3) % 8) < 5
            if visible and 0 < ix < WIDTH and 0 < iy < HEIGHT:
                brightness = int(alpha * (40 + 30 * math.sin(t * 2 + i)))
                draw.ellipse([ix - 2, iy - 2, ix + 2, iy + 2], fill=(0, brightness, int(brightness * 0.6)))

    # LAYER: kick ring + bass wobble (phase 1+)
    if t >= PHASE[1]:
        body_alpha = min(1.0, (t - PHASE[1]) / 2.0)
        if t > DURATION - 2:
            body_alpha *= max(0, (DURATION - t) / 2)
        # Kick ring
        ring_r = int(pulse * 80 + 20)
        cx, cy = WIDTH // 2, HEIGHT // 2
        ring_color = tuple(int(c * body_alpha * pulse) for c in p.primary)
        draw.ellipse([cx - ring_r, cy - ring_r, cx + ring_r, cy + ring_r],
                     outline=ring_color, width=2)
        # Bass wobble line
        sub_y = HEIGHT // 2 + 50
        pts = []
        for x in range(20, WIDTH - 20, 3):
            wobble = math.sin(x * 0.02 + t * 3) * 15 * body_alpha
            wobble += math.sin(x * 0.05 + t * 1.5) * 8 * body_alpha
            pts.append((x, int(sub_y + wobble)))
        if len(pts) > 1:
            draw.line(pts, fill=alpha_color(p.accent, body_alpha * 0.6, p.bg), width=1)

    # LAYER: wall bars (phase 2)
    if t >= PHASE[2]:
        wall_alpha = min(1.0, (t - PHASE[2]) / 2.0)
        if t > DURATION - 2:
            wall_alpha *= max(0, (DURATION - t) / 2)
        for band in range(6):
            by = int(HEIGHT * band / 6)
            bh = int(HEIGHT / 6)
            intensity = abs(math.sin(t * 4 + band * 0.7)) * wall_alpha
            if intensity > 0.3:
                bc = tuple(int(c * intensity * 0.25) for c in p.hot)
                draw.rectangle([0, by, WIDTH, by + bh], fill=bc)

    # HUD
    phase_names = ["INSECTS", "BODY", "WALL"]
    if phase < len(phase_names):
        draw.text((15, HEIGHT - 25), f"PHASE {phase}: {phase_names[phase]}",
                  fill=p.fg_dim, font=mono(10))

    # Beat flash
    if pulse > 0.7 and t >= PHASE[1]:
        arr = np.array(img, dtype=np.float64)
        arr += 8 * pulse
        img = Image.fromarray(arr.clip(0, 255).astype(np.uint8))

    return fx_scanlines(img, 0.04)


# ─── compose ───

scene = Scene(duration=DURATION, title="SIGNAL TEST")

# Title
scene.add_visual(0, 2, vis_hero, text="SIGNAL TEST",
                 subtext="wave 1 proof", pal=P_INSECTS)
# Main
scene.add_visual(2, DURATION, vis_main)

# Audio: all layers full duration, phase_env handles timing
scene.add_audio(0, DURATION, layer_insects)
scene.add_audio(0, DURATION, layer_kick)
scene.add_audio(0, DURATION, layer_bass)
scene.add_audio(0, DURATION, layer_hats)
scene.add_audio(0, DURATION, layer_wall)

# Effects
scene.add_effect(fx_scanlines, opacity=0.03)
scene.add_effect(fx_vignette, strength=0.2)

output = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                      "signal_test.mp4")
scene.render(output)

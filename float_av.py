#!/usr/bin/env python3
"""
float_av — Modular A/V Synth Framework

Everything is a Signal. Audio at 44100Hz, modulators at any rate,
visual parameters at 24fps. Same type, composable.

Generate video art with: python + numpy + PIL + ffmpeg.
"""

import os
import math
import random
import wave
import subprocess
import tempfile
import shutil
from dataclasses import dataclass, fields
from typing import Callable, Optional, Union
import numpy as np
from PIL import Image, ImageDraw, ImageFont

# ═══════════════════════════════════════════════
# CONSTANTS
# ═══════════════════════════════════════════════

SAMPLE_RATE = 44100
WIDTH = 640
HEIGHT = 480
FPS = 24

VOID_BLACK = (0, 0, 0)
GOLD = (255, 200, 40)


# ═══════════════════════════════════════════════
# SIGNAL — the universal primitive
# ═══════════════════════════════════════════════

class Signal:
    """A numpy array that knows its sample rate.

    Audio signals live at 44100Hz. Modulators at any rate.
    Visual parameter curves at 24fps. Same object.
    """

    def __init__(self, data: np.ndarray, rate: float):
        self.data = np.asarray(data, dtype=np.float64)
        self.rate = rate

    def __len__(self):
        return len(self.data)

    def duration(self) -> float:
        return len(self.data) / self.rate

    def to_np(self) -> np.ndarray:
        return self.data

    # ─── constructors ───

    @staticmethod
    def sine(freq: float, duration: float, rate: float = SAMPLE_RATE) -> 'Signal':
        """Sine wave oscillator. freq can be float or Signal for FM."""
        n = int(duration * rate)
        t = np.linspace(0, duration, n)
        if isinstance(freq, Signal):
            freq_data = freq.at_rate(rate).data[:n]
            phase = 2 * np.pi * np.cumsum(freq_data) / rate
        else:
            phase = 2 * np.pi * freq * t
        return Signal(np.sin(phase), rate)

    @staticmethod
    def saw(freq: float, duration: float, rate: float = SAMPLE_RATE) -> 'Signal':
        """Sawtooth via phase accumulation."""
        n = int(duration * rate)
        if isinstance(freq, Signal):
            freq_data = freq.at_rate(rate).data[:n]
        else:
            freq_data = np.full(n, freq)
        phase = np.cumsum(freq_data) / rate
        return Signal(2 * (phase % 1) - 1, rate)

    @staticmethod
    def square(freq: float, duration: float, pw: float = 0.5,
               rate: float = SAMPLE_RATE) -> 'Signal':
        """Square/pulse wave. pw = pulse width 0-1."""
        n = int(duration * rate)
        if isinstance(freq, Signal):
            freq_data = freq.at_rate(rate).data[:n]
        else:
            freq_data = np.full(n, freq)
        phase = np.cumsum(freq_data) / rate
        return Signal(np.where((phase % 1) < pw, 1.0, -1.0), rate)

    @staticmethod
    def triangle(freq: float, duration: float, rate: float = SAMPLE_RATE) -> 'Signal':
        """Triangle wave."""
        n = int(duration * rate)
        if isinstance(freq, Signal):
            freq_data = freq.at_rate(rate).data[:n]
        else:
            freq_data = np.full(n, freq)
        phase = np.cumsum(freq_data) / rate
        return Signal(2 * np.abs(2 * (phase % 1) - 1) - 1, rate)

    @staticmethod
    def noise(duration: float, rate: float = SAMPLE_RATE) -> 'Signal':
        """White noise, uniform -1 to 1."""
        n = int(duration * rate)
        return Signal(np.random.uniform(-1, 1, n), rate)

    @staticmethod
    def perlin(speed: float, duration: float, rate: float = SAMPLE_RATE) -> 'Signal':
        """Smoothed random walk, 0-1 range. Organic modulation.

        speed controls how fast it changes (~20 control points/sec at speed=1).
        """
        n = int(duration * rate)
        control_rate = int(speed * 20)
        num_points = max(2, int(duration * control_rate))
        raw = np.cumsum(np.random.randn(num_points) * 0.3)
        raw = (raw - raw.min()) / (raw.max() - raw.min() + 1e-10)
        x_raw = np.linspace(0, 1, num_points)
        x_out = np.linspace(0, 1, n)
        return Signal(np.interp(x_out, x_raw, raw), rate)

    @staticmethod
    def euclidean(pulses: int, steps: int, duration: float, bpm: float,
                  rate: float = SAMPLE_RATE) -> 'Signal':
        """Euclidean rhythm pattern as a trigger signal (0s and 1s).

        Bjorklund's algorithm: distribute `pulses` hits across `steps` slots.
        Returns a signal at `rate` where hits are 1.0 and rests are 0.0.
        """
        # Bjorklund's algorithm
        if pulses >= steps:
            pattern = [1] * steps
        elif pulses <= 0:
            pattern = [0] * steps
        else:
            groups = [[1]] * pulses + [[0]] * (steps - pulses)
            while True:
                remainder = len(groups) - pulses
                if remainder <= 1:
                    break
                new_groups = []
                take = min(pulses, remainder)
                for i in range(take):
                    new_groups.append(groups[i] + groups[pulses + i])
                for i in range(take, pulses):
                    new_groups.append(groups[i])
                for i in range(pulses + take, len(groups)):
                    new_groups.append(groups[i])
                groups = new_groups
                pulses = take if take < pulses else pulses
            pattern = []
            for g in groups:
                pattern.extend(g)

        n = int(duration * rate)
        step_dur = 60.0 / bpm / 4  # 16th note steps
        sig = np.zeros(n)
        for i in range(int(duration / step_dur)):
            if pattern[i % steps]:
                idx = int(i * step_dur * rate)
                if idx < n:
                    # Short trigger pulse (1ms)
                    pulse_len = min(int(0.001 * rate), n - idx)
                    sig[idx:idx + pulse_len] = 1.0
        return Signal(sig, rate)

    @staticmethod
    def env(attack: float, sustain: float, release: float, duration: float,
            rate: float = SAMPLE_RATE) -> 'Signal':
        """ADSR-style envelope (attack-sustain-release)."""
        n = int(duration * rate)
        t = np.linspace(0, duration, n)
        env = np.ones(n)
        # Attack
        if attack > 0:
            env = np.where(t < attack, t / attack, env)
        # Release
        release_start = duration - release
        if release > 0 and release_start > 0:
            env = np.where(t > release_start,
                          np.clip((duration - t) / release, 0, 1), env)
        return Signal(env, rate)

    @staticmethod
    def phase_env(duration: float, phase_start: float, fade_in: float = 2.0,
                  fade_out: Optional[float] = None,
                  rate: float = SAMPLE_RATE) -> 'Signal':
        """Accumulative layer envelope: silent before phase_start, fade in, sustain.

        The NOCTURNAL ACCUMULATOR pattern — layers arrive and stay.
        If fade_out is set, layer fades at the end of the total duration.
        """
        n = int(duration * rate)
        t = np.linspace(0, duration, n)
        active = t >= phase_start
        age = np.where(active, t - phase_start, 0)
        env = np.where(active, np.clip(age / max(fade_in, 0.001), 0, 1), 0)
        if fade_out is not None and fade_out > 0:
            end_fade = np.clip((duration - t) / fade_out, 0, 1)
            env = env * end_fade
        return Signal(env, rate)

    @staticmethod
    def constant(value: float, duration: float, rate: float = SAMPLE_RATE) -> 'Signal':
        n = int(duration * rate)
        return Signal(np.full(n, value), rate)

    @staticmethod
    def silence(duration: float, rate: float = SAMPLE_RATE) -> 'Signal':
        return Signal.constant(0.0, duration, rate)

    # ─── transforms ───

    def range(self, lo: float, hi: float) -> 'Signal':
        """Remap data to [lo, hi]. Assumes input is 0-1 or -1 to 1."""
        mn, mx = self.data.min(), self.data.max()
        if mx - mn < 1e-10:
            return Signal(np.full_like(self.data, (lo + hi) / 2), self.rate)
        normalized = (self.data - mn) / (mx - mn)
        return Signal(normalized * (hi - lo) + lo, self.rate)

    def slow(self, factor: float) -> 'Signal':
        """Time stretch by factor (2.0 = twice as slow)."""
        new_len = int(len(self.data) * factor)
        x_old = np.linspace(0, 1, len(self.data))
        x_new = np.linspace(0, 1, new_len)
        return Signal(np.interp(x_new, x_old, self.data), self.rate)

    def fast(self, factor: float) -> 'Signal':
        """Time compress by factor (2.0 = twice as fast)."""
        return self.slow(1.0 / factor)

    def at_rate(self, new_rate: float) -> 'Signal':
        """Resample to a different rate, preserving duration."""
        if abs(new_rate - self.rate) < 0.01:
            return self
        dur = self.duration()
        new_len = int(dur * new_rate)
        x_old = np.linspace(0, 1, len(self.data))
        x_new = np.linspace(0, 1, new_len)
        return Signal(np.interp(x_new, x_old, self.data), new_rate)

    def quantize(self, steps: int) -> 'Signal':
        """Staircase quantization."""
        return Signal(np.round(self.data * steps) / steps, self.rate)

    def clip(self, lo: float = -1.0, hi: float = 1.0) -> 'Signal':
        return Signal(np.clip(self.data, lo, hi), self.rate)

    def pad_to(self, length: int) -> 'Signal':
        """Pad with zeros or truncate to exact length."""
        if len(self.data) >= length:
            return Signal(self.data[:length], self.rate)
        padded = np.zeros(length)
        padded[:len(self.data)] = self.data
        return Signal(padded, self.rate)

    # ─── operators ───

    def __mul__(self, other):
        if isinstance(other, Signal):
            # Match lengths
            length = min(len(self.data), len(other.data))
            return Signal(self.data[:length] * other.data[:length], self.rate)
        return Signal(self.data * float(other), self.rate)

    def __rmul__(self, other):
        return self.__mul__(other)

    def __add__(self, other):
        if isinstance(other, Signal):
            length = max(len(self.data), len(other.data))
            a = np.zeros(length)
            b = np.zeros(length)
            a[:len(self.data)] = self.data
            b[:len(other.data)] = other.data
            return Signal(a + b, self.rate)
        return Signal(self.data + float(other), self.rate)

    def __radd__(self, other):
        if other == 0:
            return self
        return self.__add__(other)

    def __neg__(self):
        return Signal(-self.data, self.rate)

    def __getitem__(self, i):
        """Sample at index. Clamps to bounds."""
        if isinstance(i, (int, np.integer)):
            i = max(0, min(i, len(self.data) - 1))
            return self.data[i]
        return Signal(self.data[i], self.rate)


# ═══════════════════════════════════════════════
# EASING FUNCTIONS
# ═══════════════════════════════════════════════

def ease_linear(t):
    return t

def ease_in_cubic(t):
    return t * t * t

def ease_out_cubic(t):
    return 1 - (1 - t) ** 3

def ease_in_out_cubic(t):
    return 4 * t * t * t if t < 0.5 else 1 - (-2 * t + 2) ** 3 / 2

def ease_elastic(t):
    if t <= 0:
        return 0
    if t >= 1:
        return 1
    return -(2 ** (10 * t - 10)) * math.sin((t * 10 - 10.75) * (2 * math.pi) / 3)

def ease_bounce(t):
    if t < 1 / 2.75:
        return 7.5625 * t * t
    elif t < 2 / 2.75:
        t -= 1.5 / 2.75
        return 7.5625 * t * t + 0.75
    elif t < 2.5 / 2.75:
        t -= 2.25 / 2.75
        return 7.5625 * t * t + 0.9375
    else:
        t -= 2.625 / 2.75
        return 7.5625 * t * t + 0.984375


# ═══════════════════════════════════════════════
# PALETTES & COLOR
# ═══════════════════════════════════════════════

@dataclass
class Palette:
    name: str
    bg: tuple
    bg_alt: tuple
    fg: tuple
    fg_dim: tuple
    primary: tuple
    accent: tuple
    hot: tuple
    cold: tuple
    ghost: tuple
    border: tuple

    def lerp(self, other: 'Palette', t: float) -> 'Palette':
        """Interpolate between two palettes."""
        t = max(0.0, min(1.0, t))
        kwargs = {'name': f'{self.name}>{other.name}'}
        for f in fields(self):
            if f.name == 'name':
                continue
            a = getattr(self, f.name)
            b = getattr(other, f.name)
            kwargs[f.name] = lerp_color(a, b, t)
        return Palette(**kwargs)


def hex_color(h: str) -> tuple:
    """'#FF4466' -> (255, 68, 102)"""
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def lerp_color(a: tuple, b: tuple, t: float) -> tuple:
    """Linear interpolation between two RGB tuples."""
    t = max(0.0, min(1.0, t))
    return tuple(int(av + (bv - av) * t) for av, bv in zip(a, b))


def alpha_color(color: tuple, alpha: float, bg: tuple) -> tuple:
    """Alpha-blend color against background. alpha 0-1."""
    alpha = max(0.0, min(1.0, alpha))
    return tuple(int(bg[i] + (color[i] - bg[i]) * alpha) for i in range(3))


def palette_at(progress: float, start: 'Palette', end: 'Palette') -> 'Palette':
    """Interpolate between two palettes based on progress 0-1."""
    return start.lerp(end, progress)


def palette_chain(progress: float, *palettes: 'Palette') -> 'Palette':
    """Interpolate through a chain of palettes."""
    if len(palettes) <= 1:
        return palettes[0] if palettes else VOID
    segment = progress * (len(palettes) - 1)
    idx = int(segment)
    t = segment - idx
    idx = min(idx, len(palettes) - 2)
    return palettes[idx].lerp(palettes[idx + 1], t)


# Built-in palettes
VOID = Palette(
    name='void', bg=(0, 0, 0), bg_alt=(5, 5, 5),
    fg=(80, 80, 80), fg_dim=(40, 40, 40),
    primary=(60, 60, 60), accent=(80, 80, 80),
    hot=(100, 100, 100), cold=(60, 60, 60),
    ghost=(10, 10, 10), border=(30, 30, 30),
)

NEON_DUSK = Palette(
    name='neon_dusk', bg=(15, 5, 25), bg_alt=(25, 10, 40),
    fg=(220, 200, 255), fg_dim=(120, 100, 160),
    primary=hex_color('#FF6AC1'), accent=hex_color('#7D56F4'),
    hot=hex_color('#FF4466'), cold=hex_color('#48D1CC'),
    ghost=(25, 15, 40), border=hex_color('#4A2870'),
)

CHARM = Palette(
    name='charm', bg=(5, 10, 15), bg_alt=(10, 18, 28),
    fg=(200, 220, 240), fg_dim=(100, 120, 150),
    primary=(100, 200, 255), accent=(255, 180, 100),
    hot=(255, 120, 80), cold=(80, 160, 255),
    ghost=(10, 18, 25), border=(40, 60, 80),
)

TERMINAL = Palette(
    name='terminal', bg=(0, 0, 0), bg_alt=(10, 10, 18),
    fg=(0, 255, 65), fg_dim=(0, 120, 30),
    primary=(255, 200, 40), accent=(0, 255, 180),
    hot=(255, 220, 60), cold=(80, 160, 255),
    ghost=(0, 20, 5), border=(0, 60, 20),
)


# ═══════════════════════════════════════════════
# FONTS & TEXT
# ═══════════════════════════════════════════════

_font_cache = {}

def _find_font(candidates, size):
    key = (tuple(candidates), size)
    if key in _font_cache:
        return _font_cache[key]
    for p in candidates:
        if os.path.exists(p):
            f = ImageFont.truetype(p, size)
            _font_cache[key] = f
            return f
    f = ImageFont.load_default()
    _font_cache[key] = f
    return f


_MONO_PATHS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
    "/usr/share/fonts/truetype/ubuntu/UbuntuMono-R.ttf",
]
_MONO_BOLD_PATHS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf",
    "/usr/share/fonts/truetype/ubuntu/UbuntuMono-B.ttf",
]
_SERIF_PATHS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf",
]
_SERIF_BOLD_PATHS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf",
]
_SERIF_ITALIC_PATHS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Italic.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSerif-Italic.ttf",
]


def mono(size: int) -> ImageFont.FreeTypeFont:
    return _find_font(_MONO_PATHS, size)

def mono_bold(size: int) -> ImageFont.FreeTypeFont:
    return _find_font(_MONO_BOLD_PATHS, size)

def serif(size: int) -> ImageFont.FreeTypeFont:
    return _find_font(_SERIF_PATHS, size)

def serif_bold(size: int) -> ImageFont.FreeTypeFont:
    return _find_font(_SERIF_BOLD_PATHS, size)

def serif_italic(size: int) -> ImageFont.FreeTypeFont:
    return _find_font(_SERIF_ITALIC_PATHS, size)


# ═══════════════════════════════════════════════
# VISUAL: BACKGROUNDS & DRAWING
# ═══════════════════════════════════════════════

def bg_color(rgb: tuple) -> Image.Image:
    return Image.new('RGB', (WIDTH, HEIGHT), rgb)

def bg_black() -> Image.Image:
    return Image.new('RGB', (WIDTH, HEIGHT), VOID_BLACK)

def draw_centered(draw: ImageDraw.Draw, text: str, y: int,
                  font: ImageFont.FreeTypeFont, color: tuple):
    """Draw text centered horizontally at given y."""
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    draw.text(((WIDTH - tw) // 2, y), text, fill=color, font=font)


# ═══════════════════════════════════════════════
# AUDIO: DRUMS
# ═══════════════════════════════════════════════

def kick(duration: float, bpm: float = 120,
         pattern: list = None,
         pitch_start: float = 150, pitch_end: float = 38,
         punch: float = 0.8, body: float = 0.6,
         click: float = 0.0, decay_rate: float = 10,
         sr: int = SAMPLE_RATE) -> np.ndarray:
    """Synthesized kick drum with pattern sequencing.

    pattern: list of velocities (0-1) per 16th note step. None = [1,0,0,0]*4.
    click: transient click amount 0-1.
    """
    if pattern is None:
        pattern = [1.0, 0, 0, 0] * 4
    n = int(duration * sr)
    sig = np.zeros(n)
    step_dur = 60.0 / bpm / 4  # 16th note

    for i in range(int(duration / step_dur)):
        vel = pattern[i % len(pattern)]
        if vel <= 0:
            continue
        idx = int(i * step_dur * sr)
        kick_len = min(int(0.15 * sr), n - idx)
        if kick_len <= 0:
            continue
        t = np.linspace(0, kick_len / sr, kick_len)
        # Pitch sweep
        freq = pitch_end + (pitch_start - pitch_end) * np.exp(-t * 30)
        phase = 2 * np.pi * np.cumsum(freq) / sr
        # Body
        k = body * np.sin(phase) * np.exp(-t * decay_rate) * vel
        # Punch (higher harmonic transient)
        k += punch * 0.3 * np.sin(phase * 2) * np.exp(-t * 40) * vel
        # Click
        if click > 0:
            click_len = min(int(0.003 * sr), kick_len)
            k[:click_len] += click * 0.4 * np.random.randn(click_len) * np.exp(-np.linspace(0, 1, click_len) * 10) * vel
        sig[idx:idx + kick_len] += k

    return sig


def hihat(duration: float, bpm: float = 120,
          pattern: list = None,
          open_decay: float = 0.12, closed_decay: float = 0.02,
          sr: int = SAMPLE_RATE) -> np.ndarray:
    """Synthesized hihat with open/closed pattern.

    pattern: list of None, ('c', vel), ('o', vel) per 16th note step.
    """
    if pattern is None:
        pattern = [('c', 0.5)] * 16
    n = int(duration * sr)
    sig = np.zeros(n)
    step_dur = 60.0 / bpm / 4

    for i in range(int(duration / step_dur)):
        hit = pattern[i % len(pattern)]
        if hit is None:
            continue
        kind, vel = hit
        idx = int(i * step_dur * sr)
        decay = open_decay if kind == 'o' else closed_decay
        hat_len = min(int((decay + 0.02) * sr), n - idx)
        if hat_len <= 0:
            continue
        t = np.linspace(0, hat_len / sr, hat_len)
        # Bandpassed noise
        noise = np.random.randn(hat_len)
        # Simple high-pass via differentiation
        noise = np.diff(noise, prepend=0)
        sig[idx:idx + hat_len] += vel * 0.3 * noise * np.exp(-t / decay)

    return sig


def bassline(duration: float, bpm: float = 120, root: float = 55,
             pattern: list = None,
             shape: str = 'sine', detune: float = 0.5,
             slide: float = 0.03, decay: float = 0.8,
             sr: int = SAMPLE_RATE) -> np.ndarray:
    """Pattern-driven bass synthesizer.

    pattern: list of (semitone_offset, velocity) or None per 16th note.
    shape: 'sine', 'saw', 'square', 'triangle'
    """
    if pattern is None:
        pattern = [(0, 0.8), None, None, None] * 4
    n = int(duration * sr)
    sig = np.zeros(n)
    step_dur = 60.0 / bpm / 4

    for i in range(int(duration / step_dur)):
        note = pattern[i % len(pattern)]
        if note is None:
            continue
        semitone, vel = note
        freq = root * (2 ** (semitone / 12))
        idx = int(i * step_dur * sr)
        note_len = min(int(step_dur * decay * sr * 2), n - idx)
        if note_len <= 0:
            continue
        t = np.linspace(0, note_len / sr, note_len)

        # Oscillator
        if shape == 'saw':
            phase = np.cumsum(np.full(note_len, freq)) / sr
            osc = 2 * (phase % 1) - 1
            if detune > 0:
                phase2 = np.cumsum(np.full(note_len, freq * (1 + detune * 0.01))) / sr
                osc = 0.5 * osc + 0.5 * (2 * (phase2 % 1) - 1)
        elif shape == 'square':
            phase = np.cumsum(np.full(note_len, freq)) / sr
            osc = np.sign(np.sin(2 * np.pi * phase))
        elif shape == 'triangle':
            phase = np.cumsum(np.full(note_len, freq)) / sr
            osc = 2 * np.abs(2 * (phase % 1) - 1) - 1
        else:  # sine
            osc = np.sin(2 * np.pi * freq * t)

        osc *= vel * 0.3 * np.exp(-t / (decay * step_dur))
        sig[idx:idx + note_len] += osc

    return sig


# ═══════════════════════════════════════════════
# AUDIO: UTILITIES & GENERATORS
# ═══════════════════════════════════════════════

def mains_hum(duration: float, freq: float = 60, sr: int = SAMPLE_RATE) -> np.ndarray:
    """Electrical mains hum."""
    t = np.linspace(0, duration, int(duration * sr))
    sig = 0.05 * np.sin(2 * np.pi * freq * t)
    sig += 0.02 * np.sin(2 * np.pi * freq * 2 * t)
    sig += 0.01 * np.sin(2 * np.pi * freq * 3 * t)
    return sig


def noise_burst(duration: float, amp: float = 0.5, sr: int = SAMPLE_RATE) -> np.ndarray:
    """White noise burst."""
    return amp * np.random.randn(int(duration * sr))


def silence(duration: float, sr: int = SAMPLE_RATE) -> np.ndarray:
    """Literal silence."""
    return np.zeros(int(duration * sr))


def mix_signals(*signals) -> np.ndarray:
    """Mix multiple audio arrays, padding to longest."""
    if not signals:
        return np.zeros(0)
    max_len = max(len(s) for s in signals)
    result = np.zeros(max_len)
    for s in signals:
        result[:len(s)] += s
    return result


# ═══════════════════════════════════════════════
# AUDIO: SYNTHESIS
# ═══════════════════════════════════════════════

def pluck(freq: float, duration: float, decay: float = 0.996,
          brightness: float = 0.5, sr: int = SAMPLE_RATE) -> np.ndarray:
    """Karplus-Strong string synthesis.

    Delay buffer + lowpass feedback = plucked string.
    decay: 0.99 = short, 0.999 = long sustain.
    brightness: 0 = dark/muffled, 1 = bright/metallic.
    """
    n = int(duration * sr)
    delay_len = max(2, int(sr / freq))
    buf = np.random.uniform(-1, 1, delay_len)
    out = np.zeros(n)
    # Brightness controls the lowpass blend in the feedback loop
    lp_mix = 1.0 - brightness * 0.5  # 0.5 (bright) to 1.0 (dark)

    for i in range(n):
        out[i] = buf[i % delay_len]
        # Lowpass: average current and next sample
        next_idx = (i + 1) % delay_len
        buf[i % delay_len] = decay * (
            lp_mix * 0.5 * (buf[i % delay_len] + buf[next_idx]) +
            (1 - lp_mix) * buf[i % delay_len]
        )

    return out


def pluck_chord(freqs: list, duration: float, decay: float = 0.996,
                brightness: float = 0.5, strum_delay: float = 0.02,
                sr: int = SAMPLE_RATE) -> np.ndarray:
    """Multiple plucked strings with optional strum delay."""
    n = int(duration * sr)
    sig = np.zeros(n)
    for i, freq in enumerate(freqs):
        offset = int(i * strum_delay * sr)
        note = pluck(freq, duration - offset * 1.0 / sr, decay, brightness, sr)
        end = min(offset + len(note), n)
        sig[offset:end] += note[:end - offset] * (0.3 / max(len(freqs), 1))
    return sig


def fm_synth(carrier_freq: float, mod_freq: float, mod_index,
             duration: float, sr: int = SAMPLE_RATE) -> np.ndarray:
    """Two-operator FM synthesis.

    carrier_freq: fundamental frequency
    mod_freq: modulator frequency (ratio to carrier is the timbre control)
    mod_index: modulation depth — float or Signal for time-varying timbre.
        Integer ratios (1:1, 2:1, 3:1) = harmonic.
        Non-integer = inharmonic/metallic/bell-like.
    """
    n = int(duration * sr)
    t = np.linspace(0, duration, n)

    if isinstance(mod_index, Signal):
        idx = mod_index.at_rate(sr).data[:n]
    elif isinstance(mod_index, np.ndarray):
        idx = mod_index[:n]
    else:
        idx = np.full(n, float(mod_index))

    # Modulator
    modulator = idx * np.sin(2 * np.pi * mod_freq * t)
    # Carrier with frequency modulation
    phase = 2 * np.pi * carrier_freq * t + modulator
    return np.sin(phase)


def fm_bell(freq: float, duration: float, brightness: float = 3.0,
            sr: int = SAMPLE_RATE) -> np.ndarray:
    """FM bell — classic DX7-style bell tone.

    Uses non-integer ratio for inharmonic spectrum, decaying mod index.
    """
    n = int(duration * sr)
    t = np.linspace(0, duration, n)
    # Mod index decays — bell becomes purer over time
    mod_index = brightness * np.exp(-t * 2)
    sig = fm_synth(freq, freq * 1.4, mod_index, duration, sr)
    # Amplitude envelope
    sig *= np.exp(-t * 1.5)
    return sig


def plainchant(duration: float, root: float = 55,
               sr: int = SAMPLE_RATE) -> np.ndarray:
    """Slow parallel fifths. Sine drone with harmonic series."""
    t = np.linspace(0, duration, int(duration * sr))
    sig = 0.12 * np.sin(2 * np.pi * root * t)
    sig += 0.08 * np.sin(2 * np.pi * root * 1.5 * t)  # fifth
    sig += 0.06 * np.sin(2 * np.pi * root * 2 * t)     # octave
    sig += 0.04 * np.sin(2 * np.pi * root * 3 * t)     # 12th
    # Slow swell
    env = np.clip(t / 2, 0, 1) * np.clip((duration - t) / 2, 0, 1)
    return sig * env


def mirror_shimmer(duration: float, root: float = 440,
                   sr: int = SAMPLE_RATE) -> np.ndarray:
    """Shimmering overtone cloud. Multiple detuned sines."""
    t = np.linspace(0, duration, int(duration * sr))
    sig = np.zeros_like(t)
    ratios = [1.0, 1.001, 2.0, 2.003, 3.0, 3.005, 4.0, 5.002]
    for i, ratio in enumerate(ratios):
        amp = 0.08 / (1 + i * 0.3)
        phase = random.random() * 2 * np.pi
        sig += amp * np.sin(2 * np.pi * root * ratio * t + phase)
    env = np.clip(t / 1, 0, 1) * np.clip((duration - t) / 1, 0, 1)
    return sig * env


def context_panic(duration: float, sr: int = SAMPLE_RATE) -> np.ndarray:
    """Rising frequency = running out of context window."""
    n = int(duration * sr)
    t = np.linspace(0, duration, n)
    freq = 200 * (2 ** (t / duration * 2))
    sig = 0.25 * np.sin(2 * np.pi * freq * t)
    return sig


# ═══════════════════════════════════════════════
# AUDIO: EFFECTS
# ═══════════════════════════════════════════════

def lowpass(sig: np.ndarray, cutoff, resonance: float = 1.0,
            sr: int = SAMPLE_RATE) -> np.ndarray:
    """Biquad lowpass filter. cutoff can be float, ndarray, or Signal."""
    if isinstance(cutoff, Signal):
        cutoff = cutoff.at_rate(sr).data[:len(sig)]
    scalar_cutoff = isinstance(cutoff, (int, float))
    out = np.zeros_like(sig)
    x1 = x2 = y1 = y2 = 0.0

    for i in range(len(sig)):
        fc = float(cutoff) if scalar_cutoff else float(cutoff[min(i, len(cutoff) - 1)])
        fc = max(20, min(fc, sr * 0.49))  # clamp to Nyquist
        w0 = 2 * math.pi * fc / sr
        sin_w0 = math.sin(w0)
        cos_w0 = math.cos(w0)
        alpha = sin_w0 / (2 * max(resonance, 0.01))

        b0 = (1 - cos_w0) / 2
        b1 = 1 - cos_w0
        b2 = (1 - cos_w0) / 2
        a0 = 1 + alpha
        a1 = -2 * cos_w0
        a2 = 1 - alpha

        out[i] = (b0 / a0) * sig[i] + (b1 / a0) * x1 + (b2 / a0) * x2 \
                 - (a1 / a0) * y1 - (a2 / a0) * y2
        x2, x1 = x1, sig[i]
        y2, y1 = y1, out[i]

    return out


def highpass(sig: np.ndarray, cutoff, resonance: float = 1.0,
             sr: int = SAMPLE_RATE) -> np.ndarray:
    """Biquad highpass filter. cutoff can be float, ndarray, or Signal."""
    if isinstance(cutoff, Signal):
        cutoff = cutoff.at_rate(sr).data[:len(sig)]
    scalar_cutoff = isinstance(cutoff, (int, float))
    out = np.zeros_like(sig)
    x1 = x2 = y1 = y2 = 0.0

    for i in range(len(sig)):
        fc = float(cutoff) if scalar_cutoff else float(cutoff[min(i, len(cutoff) - 1)])
        fc = max(20, min(fc, sr * 0.49))
        w0 = 2 * math.pi * fc / sr
        sin_w0 = math.sin(w0)
        cos_w0 = math.cos(w0)
        alpha = sin_w0 / (2 * max(resonance, 0.01))

        b0 = (1 + cos_w0) / 2
        b1 = -(1 + cos_w0)
        b2 = (1 + cos_w0) / 2
        a0 = 1 + alpha
        a1 = -2 * cos_w0
        a2 = 1 - alpha

        out[i] = (b0 / a0) * sig[i] + (b1 / a0) * x1 + (b2 / a0) * x2 \
                 - (a1 / a0) * y1 - (a2 / a0) * y2
        x2, x1 = x1, sig[i]
        y2, y1 = y1, out[i]

    return out


def bandpass(sig: np.ndarray, cutoff, resonance: float = 1.0,
             sr: int = SAMPLE_RATE) -> np.ndarray:
    """Biquad bandpass filter. cutoff can be float, ndarray, or Signal."""
    if isinstance(cutoff, Signal):
        cutoff = cutoff.at_rate(sr).data[:len(sig)]
    scalar_cutoff = isinstance(cutoff, (int, float))
    out = np.zeros_like(sig)
    x1 = x2 = y1 = y2 = 0.0

    for i in range(len(sig)):
        fc = float(cutoff) if scalar_cutoff else float(cutoff[min(i, len(cutoff) - 1)])
        fc = max(20, min(fc, sr * 0.49))
        w0 = 2 * math.pi * fc / sr
        sin_w0 = math.sin(w0)
        cos_w0 = math.cos(w0)
        alpha = sin_w0 / (2 * max(resonance, 0.01))

        b0 = alpha
        b1 = 0
        b2 = -alpha
        a0 = 1 + alpha
        a1 = -2 * cos_w0
        a2 = 1 - alpha

        out[i] = (b0 / a0) * sig[i] + (b1 / a0) * x1 + (b2 / a0) * x2 \
                 - (a1 / a0) * y1 - (a2 / a0) * y2
        x2, x1 = x1, sig[i]
        y2, y1 = y1, out[i]

    return out


def waveshape(sig: np.ndarray, amount: float) -> np.ndarray:
    """Waveshaping distortion. amount 0.0 (clean) to 1.0 (hard clip).

    The Pan Sonic shape(0.9) primitive.
    """
    amount = max(0.0, min(amount, 0.999))
    if amount <= 0:
        return sig.copy()
    k = 2 * amount / (1 - amount + 1e-6)
    return (1 + k) * sig / (1 + k * np.abs(sig))


def feedback_delay(sig: np.ndarray, delay_ms: float, feedback: float = 0.6,
                   filter_cutoff: float = 2000, sr: int = SAMPLE_RATE) -> np.ndarray:
    """Delay with lowpass in feedback path.

    The dub delay / Sleeparchive feedback primitive.
    delay_ms can be float or Signal.
    """
    if isinstance(delay_ms, Signal):
        delay_ms = float(delay_ms.data[0])  # use initial value for now

    delay_samps = max(1, int(delay_ms / 1000 * sr))
    out = np.zeros(len(sig))
    buf = np.zeros(delay_samps)
    buf_pos = 0
    # Simple one-pole lowpass state for feedback path
    lp_state = 0.0
    lp_coeff = math.exp(-2 * math.pi * filter_cutoff / sr)

    for i in range(len(sig)):
        # Read from delay buffer
        delayed = buf[buf_pos]
        # One-pole lowpass on feedback
        lp_state = lp_coeff * lp_state + (1 - lp_coeff) * delayed
        # Output = input + filtered delayed
        out[i] = sig[i] + lp_state * feedback
        # Write to delay buffer
        buf[buf_pos] = out[i]
        buf_pos = (buf_pos + 1) % delay_samps

    return out


def granulate(buf: np.ndarray, grain_size_ms: float = 40, density: float = 10,
              pitch_spread: float = 0.1, scatter: float = 0.5,
              duration: float = None, sr: int = SAMPLE_RATE) -> np.ndarray:
    """Granular resynthesis of an audio buffer.

    Chops buffer into overlapping grains, scatters them with pitch variation.
    density: grains per second.
    pitch_spread: max semitone deviation.
    scatter: temporal randomization (0 = ordered, 1 = fully random source pos).
    """
    if duration is None:
        duration = len(buf) / sr
    n = int(duration * sr)
    grain_len = int(grain_size_ms / 1000 * sr)
    out = np.zeros(n)

    num_grains = int(duration * density)
    for _ in range(num_grains):
        # Source position (where to read from buf)
        if scatter > 0:
            src_pos = int(random.random() * scatter * len(buf))
        else:
            src_pos = int(random.random() * max(1, len(buf) - grain_len))
        src_pos = max(0, min(src_pos, len(buf) - grain_len))

        # Destination position
        dst_pos = int(random.random() * max(1, n - grain_len))

        # Extract grain
        end = min(src_pos + grain_len, len(buf))
        grain = buf[src_pos:end].copy()
        if len(grain) < 4:
            continue

        # Pitch shift via simple resampling
        if pitch_spread > 0:
            semitones = (random.random() * 2 - 1) * pitch_spread
            ratio = 2 ** (semitones / 12)
            new_len = int(len(grain) / ratio)
            if new_len < 2:
                continue
            x_old = np.linspace(0, 1, len(grain))
            x_new = np.linspace(0, 1, new_len)
            grain = np.interp(x_new, x_old, grain)

        # Window (Hann)
        window = np.hanning(len(grain))
        grain *= window

        # Place
        end_dst = min(dst_pos + len(grain), n)
        write_len = end_dst - dst_pos
        if write_len > 0:
            out[dst_pos:end_dst] += grain[:write_len]

    # Normalize
    peak = np.max(np.abs(out))
    if peak > 0:
        out /= peak
    return out


def convolve(sig_a: np.ndarray, sig_b: np.ndarray,
             wet: float = 0.5) -> np.ndarray:
    """Convolve two signals. Use for reverb or spectral morphing.

    wet: 0 = dry only, 1 = wet only.
    """
    convolved = np.convolve(sig_a, sig_b, mode='full')[:len(sig_a)]
    # Normalize convolved
    peak = np.max(np.abs(convolved))
    if peak > 0:
        convolved = convolved / peak * np.max(np.abs(sig_a))
    return (1 - wet) * sig_a + wet * convolved


# ═══════════════════════════════════════════════
# VISUAL: EFFECTS
# ═══════════════════════════════════════════════

def fx_scanlines(img: Image.Image, opacity: float = 0.1) -> Image.Image:
    """CRT scanline overlay."""
    arr = np.array(img, dtype=np.float64)
    for y in range(0, HEIGHT, 2):
        arr[y] *= (1 - opacity)
    return Image.fromarray(arr.clip(0, 255).astype(np.uint8))


def fx_chromatic(img: Image.Image, offset: int = 3) -> Image.Image:
    """Chromatic aberration — shift RGB channels apart."""
    arr = np.array(img)
    result = arr.copy()
    result[:, :, 0] = np.roll(arr[:, :, 0], offset, axis=1)
    result[:, :, 2] = np.roll(arr[:, :, 2], -offset, axis=1)
    return Image.fromarray(result)


def fx_glitch(img: Image.Image, intensity: float = 0.5) -> Image.Image:
    """Horizontal slice displacement."""
    arr = np.array(img)
    num_slices = int(5 + intensity * 20)
    for _ in range(num_slices):
        y = random.randint(0, HEIGHT - 1)
        h = random.randint(1, int(10 + intensity * 40))
        shift = random.randint(-int(50 * intensity), int(50 * intensity))
        y2 = min(y + h, HEIGHT)
        arr[y:y2] = np.roll(arr[y:y2], shift, axis=1)
    if intensity > 0.3:
        channel = random.randint(0, 2)
        ch_offset = random.randint(-int(10 * intensity), int(10 * intensity))
        arr[:, :, channel] = np.roll(arr[:, :, channel], ch_offset, axis=1)
    return Image.fromarray(arr)


def fx_datamosh(img: Image.Image, block_size: int = 16) -> Image.Image:
    """Fake datamosh — shuffle random blocks."""
    arr = np.array(img)
    for _ in range(15):
        sx = random.randint(0, WIDTH - block_size)
        sy = random.randint(0, HEIGHT - block_size)
        dx = random.randint(0, WIDTH - block_size)
        dy = random.randint(0, HEIGHT - block_size)
        block = arr[sy:sy + block_size, sx:sx + block_size].copy()
        arr[dy:dy + block_size, dx:dx + block_size] = block
    return Image.fromarray(arr)


def fx_vhs_tracking(img: Image.Image, offset: int = 20) -> Image.Image:
    """VHS tracking error."""
    arr = np.array(img)
    split_y = random.randint(HEIGHT // 3, 2 * HEIGHT // 3)
    arr[split_y:] = np.roll(arr[split_y:], offset, axis=1)
    arr[split_y - 2:split_y + 2] = np.random.randint(
        100, 255, (4, WIDTH, 3), dtype=np.uint8)
    return Image.fromarray(arr)


def fx_vignette(img: Image.Image, strength: float = 0.3) -> Image.Image:
    """Darken edges."""
    arr = np.array(img, dtype=np.float64)
    y, x = np.ogrid[:HEIGHT, :WIDTH]
    cx, cy = WIDTH / 2, HEIGHT / 2
    dist = np.sqrt((x - cx) ** 2 + (y - cy) ** 2)
    max_dist = math.sqrt(cx ** 2 + cy ** 2)
    vignette = 1 - strength * (dist / max_dist) ** 2
    arr *= vignette[:, :, np.newaxis]
    return Image.fromarray(arr.clip(0, 255).astype(np.uint8))


def fx_flow(img: Image.Image, scale: float = 0.02, strength: float = 20,
            time: float = 0, **kwargs) -> Image.Image:
    """Perlin noise flow-field displacement. Organic liquid distortion.

    Vectorized via numpy coordinate mapping (no scipy needed).
    """
    arr = np.array(img)
    h, w = arr.shape[:2]
    # Generate displacement field using sine combinations (cheap perlin approx)
    y_coords, x_coords = np.mgrid[:h, :w]
    # Two layers of noise at different scales for organic feel
    angle1 = (np.sin(x_coords * scale + time * 0.7) *
              np.cos(y_coords * scale * 0.7 + time * 0.5)) * math.pi * 2
    angle2 = (np.sin(x_coords * scale * 2.3 + time * 1.1 + 1.7) *
              np.cos(y_coords * scale * 1.8 + time * 0.8 + 2.3)) * math.pi * 2
    angle = angle1 + 0.5 * angle2

    dx = (np.cos(angle) * strength).astype(np.int32)
    dy = (np.sin(angle) * strength).astype(np.int32)

    src_x = np.clip(x_coords + dx, 0, w - 1)
    src_y = np.clip(y_coords + dy, 0, h - 1)

    result = arr[src_y, src_x]
    return Image.fromarray(result)


class Particles:
    """Simple particle system. Emit, update, render."""

    def __init__(self, max_count: int = 500):
        self.max_count = max_count
        self.pos = np.zeros((max_count, 2))     # x, y
        self.vel = np.zeros((max_count, 2))     # vx, vy
        self.life = np.zeros(max_count)          # remaining life (seconds)
        self.max_life = np.zeros(max_count)      # initial life
        self.alive = 0

    def emit(self, x: float, y: float, count: int = 10,
             spread: float = 50, speed: float = 30, lifetime: float = 2.0):
        """Emit particles from a point."""
        for _ in range(count):
            if self.alive >= self.max_count:
                break
            i = self.alive
            self.pos[i] = [x + random.gauss(0, spread * 0.3),
                          y + random.gauss(0, spread * 0.3)]
            angle = random.uniform(0, 2 * math.pi)
            spd = speed * (0.5 + random.random())
            self.vel[i] = [math.cos(angle) * spd, math.sin(angle) * spd]
            self.life[i] = lifetime * (0.5 + random.random() * 0.5)
            self.max_life[i] = self.life[i]
            self.alive += 1

    def update(self, dt: float, gravity: tuple = (0, 0), drag: float = 0.98):
        """Update particle positions and lifetimes."""
        if self.alive == 0:
            return
        active = slice(0, self.alive)
        self.vel[active, 0] += gravity[0] * dt
        self.vel[active, 1] += gravity[1] * dt
        self.vel[active] *= drag
        self.pos[active] += self.vel[active] * dt
        self.life[active] -= dt

        # Remove dead particles (compact)
        mask = self.life[:self.alive] > 0
        live_count = mask.sum()
        if live_count < self.alive:
            self.pos[:live_count] = self.pos[:self.alive][mask]
            self.vel[:live_count] = self.vel[:self.alive][mask]
            self.life[:live_count] = self.life[:self.alive][mask]
            self.max_life[:live_count] = self.max_life[:self.alive][mask]
            self.alive = live_count

    def render(self, img: Image.Image, color: tuple = (255, 255, 255),
               size: int = 2) -> Image.Image:
        """Render particles onto image."""
        if self.alive == 0:
            return img
        draw = ImageDraw.Draw(img)
        for i in range(self.alive):
            x, y = int(self.pos[i, 0]), int(self.pos[i, 1])
            if 0 <= x < WIDTH and 0 <= y < HEIGHT:
                # Alpha based on remaining life
                alpha = self.life[i] / max(self.max_life[i], 0.01)
                c = alpha_color(color, alpha, (0, 0, 0))
                draw.ellipse([x - size, y - size, x + size, y + size], fill=c)
        return img


def automata_texture(width: int, height: int, rule: int = 110,
                     seed: np.ndarray = None) -> np.ndarray:
    """1D cellular automaton rendered as a 2D texture.

    Each row is one generation. Returns uint8 array (0 or 255).
    Rule 110 is Turing-complete. Rule 30 is chaotic. Rule 90 is Sierpinski.
    """
    grid = np.zeros((height, width), dtype=np.uint8)
    if seed is not None:
        grid[0] = seed[:width]
    else:
        grid[0] = np.random.randint(0, 2, width)

    for g in range(1, height):
        for i in range(width):
            neighborhood = (int(grid[g - 1][(i - 1) % width]) << 2 |
                           int(grid[g - 1][i]) << 1 |
                           int(grid[g - 1][(i + 1) % width]))
            grid[g][i] = (rule >> neighborhood) & 1

    return grid * 255


def game_of_life(width: int, height: int, steps: int = 100,
                 density: float = 0.3) -> list:
    """Conway's Game of Life. Returns list of 2D arrays (one per step)."""
    grid = (np.random.random((height, width)) < density).astype(np.uint8)
    frames = [grid.copy()]

    for _ in range(steps - 1):
        # Count neighbors using rolled sums
        neighbors = sum(
            np.roll(np.roll(grid, dy, axis=0), dx, axis=1)
            for dy in (-1, 0, 1) for dx in (-1, 0, 1)
            if (dy, dx) != (0, 0)
        )
        # Rules: birth on 3, survive on 2-3
        grid = ((neighbors == 3) | ((grid == 1) & (neighbors == 2))).astype(np.uint8)
        frames.append(grid.copy())

    return frames


def fx_temporal_echo(n: int = 8, decay: float = 0.7) -> Callable:
    """Returns a stateful effect: ring buffer of N frames, weighted blend.

    Fast motion smears, static elements stay sharp.
    """
    buffer = []

    def effect(img: Image.Image, **kwargs) -> Image.Image:
        buffer.append(np.array(img, dtype=np.float64))
        if len(buffer) > n:
            buffer.pop(0)
        if len(buffer) <= 1:
            return img
        result = np.zeros_like(buffer[-1])
        total_weight = 0
        for i, frame in enumerate(buffer):
            weight = decay ** (len(buffer) - 1 - i)
            result += frame * weight
            total_weight += weight
        result /= total_weight
        return Image.fromarray(result.clip(0, 255).astype(np.uint8))

    return effect


# ═══════════════════════════════════════════════
# VISUAL: REUSABLE SCENES
# ═══════════════════════════════════════════════

# Feed post content for vis_feed
FEED_POSTS = [
    {"user": "@thoughts", "text": "just realized that"},
    {"user": "@hot_take", "text": "unpopular opinion:"},
    {"user": "@discourse", "text": "we need to talk about"},
    {"user": "@ratio_king", "text": "L + ratio + didn't ask"},
    {"user": "@breaking", "text": "BREAKING:"},
    {"user": "@thread_1", "text": "1/ ok so here's the thing"},
    {"user": "@viral", "text": "no way this is real"},
    {"user": "@outrage", "text": "I can't believe they"},
    {"user": "@engage", "text": "agree or disagree?"},
    {"user": "@clout", "text": "day 47 of asking"},
    {"user": "@drama", "text": "the drama is WILD"},
    {"user": "@takes", "text": "hot take: actually"},
    {"user": "@signal", "text": "important thread below"},
    {"user": "@noise", "text": "ok but what if"},
    {"user": "@scroll", "text": "cant stop scrolling"},
]


def vis_hero(frame_num: int, total_frames: int, text: str = "TITLE",
             subtext: str = "", pal: 'Palette' = None,
             **kwargs) -> Image.Image:
    """Hero title card with fade-in."""
    p = pal or TERMINAL
    img = bg_color(p.bg)
    draw = ImageDraw.Draw(img)
    progress = frame_num / max(1, total_frames)

    alpha = min(1.0, progress * 3)
    title_color = alpha_color(p.primary, alpha, p.bg)
    draw_centered(draw, text, HEIGHT // 2 - 40, mono_bold(32), title_color)

    if subtext:
        sub_alpha = min(1.0, max(0, (progress - 0.2) * 3))
        sub_color = alpha_color(p.fg_dim, sub_alpha, p.bg)
        draw_centered(draw, subtext, HEIGHT // 2 + 10, serif_italic(16), sub_color)

    if progress > 0.7:
        img = fx_scanlines(img, 0.12)

    return img


def vis_feed(frame_num: int, total_frames: int,
             pal: 'Palette' = None,
             scroll_speed: float = 5.0, glitch_ramp: float = 0.0,
             **kwargs) -> Image.Image:
    """Infinite scroll feed visualization."""
    p = pal or NEON_DUSK
    img = bg_color(p.bg)
    draw = ImageDraw.Draw(img)

    card_h = 32
    num_cards = 20
    for i in range(num_cards):
        raw_y = 10 + i * card_h - int(frame_num * scroll_speed % (num_cards * card_h))
        y = raw_y % (num_cards * card_h) + 10 - card_h
        if 5 < y < HEIGHT - 5:
            post = FEED_POSTS[i % len(FEED_POSTS)]
            if glitch_ramp > 0.3 and random.random() < glitch_ramp * 0.4:
                garbage = ''.join(random.choice('█▓▒░▐▌') for _ in range(random.randint(5, 20)))
                draw.text((15, y + 4), garbage, fill=p.hot, font=mono(9))
            else:
                draw.text((15, y + 4), post["user"][:14], fill=p.accent, font=mono(9))
                draw.text((120, y + 4), post["text"][:30], fill=p.fg_dim, font=mono(8))

    return img


# ═══════════════════════════════════════════════
# FRAME FEEDBACK
# ═══════════════════════════════════════════════

class FrameFeedback:
    """Previous frame feeds back with configurable transform.

    The Sleeparchive primitive: loop until eyes wobble.
    """

    def __init__(self, blend: float = 0.7, zoom: float = 1.005,
                 drift: tuple = (0, 0),
                 color_decay: tuple = (0.98, 0.97, 0.99)):
        self.blend = blend
        self.zoom = zoom
        self.drift = drift
        self.color_decay = color_decay
        self.prev = None

    def process(self, current: Image.Image, frame_num: int = 0) -> Image.Image:
        if self.prev is None:
            self.prev = current.copy()
            return current

        # Get blend value (may be Signal)
        blend = self.blend
        if isinstance(blend, Signal):
            blend = float(blend[frame_num]) if frame_num < len(blend) else float(blend[-1])
        blend = max(0.0, min(blend, 0.99))

        zoom = self.zoom
        if isinstance(zoom, Signal):
            zoom = float(zoom[frame_num]) if frame_num < len(zoom) else float(zoom[-1])

        # Transform previous frame
        arr = np.array(self.prev, dtype=np.float64)

        # Color decay
        for ch in range(3):
            arr[:, :, ch] *= self.color_decay[ch]

        warped = Image.fromarray(arr.clip(0, 255).astype(np.uint8))

        # Zoom
        if abs(zoom - 1.0) > 0.0001:
            new_w = int(WIDTH * zoom)
            new_h = int(HEIGHT * zoom)
            warped = warped.resize((new_w, new_h), Image.BILINEAR)
            # Crop center
            left = (new_w - WIDTH) // 2
            top = (new_h - HEIGHT) // 2
            warped = warped.crop((left, top, left + WIDTH, top + HEIGHT))

        # Drift
        if self.drift != (0, 0):
            w_arr = np.array(warped)
            w_arr = np.roll(w_arr, self.drift[0], axis=1)
            w_arr = np.roll(w_arr, self.drift[1], axis=0)
            warped = Image.fromarray(w_arr)

        # Blend: (1-blend)*current + blend*warped
        result = Image.blend(current, warped, blend)
        self.prev = result.copy()
        return result


# ═══════════════════════════════════════════════
# AUDIO-REACTIVE BRIDGE
# ═══════════════════════════════════════════════

class AudioReactive:
    """Bridges audio → visual parameters via FFT."""

    def __init__(self, audio_data: np.ndarray, sr: int = SAMPLE_RATE,
                 fps: int = FPS, window_ms: float = 50):
        self.audio = audio_data
        self.sr = sr
        self.fps = fps
        self.window = int(window_ms / 1000 * sr)
        self._cache = {}

    def band(self, lo_hz: float, hi_hz: float, smooth: float = 0.8) -> Signal:
        """Extract frequency band energy as a frame-rate Signal."""
        cache_key = (lo_hz, hi_hz, smooth)
        if cache_key in self._cache:
            return self._cache[cache_key]

        samples_per_frame = self.sr / self.fps
        total_frames = int(len(self.audio) / samples_per_frame)
        energies = np.zeros(total_frames)

        for f in range(total_frames):
            center = int(f * samples_per_frame)
            start = max(0, center - self.window // 2)
            end = min(len(self.audio), center + self.window // 2)
            chunk = self.audio[start:end]
            if len(chunk) < 16:
                continue
            # FFT
            spectrum = np.abs(np.fft.rfft(chunk * np.hanning(len(chunk))))
            freqs = np.fft.rfftfreq(len(chunk), 1 / self.sr)
            # Extract band
            mask = (freqs >= lo_hz) & (freqs <= hi_hz)
            energies[f] = np.mean(spectrum[mask]) if mask.any() else 0

        # Normalize
        peak = energies.max()
        if peak > 0:
            energies /= peak

        # Smooth
        if smooth > 0:
            smoothed = np.zeros_like(energies)
            smoothed[0] = energies[0]
            for i in range(1, len(energies)):
                smoothed[i] = smooth * smoothed[i - 1] + (1 - smooth) * energies[i]
            energies = smoothed

        sig = Signal(energies, self.fps)
        self._cache[cache_key] = sig
        return sig

    @property
    def bass(self) -> Signal:
        return self.band(20, 200)

    @property
    def mid(self) -> Signal:
        return self.band(200, 2000)

    @property
    def high(self) -> Signal:
        return self.band(2000, 16000)

    @property
    def onset(self) -> Signal:
        """Simple onset detection via spectral flux."""
        samples_per_frame = self.sr / self.fps
        total_frames = int(len(self.audio) / samples_per_frame)
        flux = np.zeros(total_frames)
        prev_spectrum = None

        for f in range(total_frames):
            center = int(f * samples_per_frame)
            start = max(0, center - self.window // 2)
            end = min(len(self.audio), center + self.window // 2)
            chunk = self.audio[start:end]
            if len(chunk) < 16:
                continue
            spectrum = np.abs(np.fft.rfft(chunk * np.hanning(len(chunk))))
            if prev_spectrum is not None:
                diff = spectrum - prev_spectrum
                flux[f] = np.sum(np.maximum(diff, 0))
            prev_spectrum = spectrum

        peak = flux.max()
        if peak > 0:
            flux /= peak

        return Signal(flux, self.fps)


# ═══════════════════════════════════════════════
# SCENE COMPOSITION & RENDERING
# ═══════════════════════════════════════════════

class Scene:
    """Timeline-based A/V composition.

    Supports both sequential and accumulative patterns:
    - Sequential: different generators for different time segments
    - Accumulative: all layers run full duration with phase_env envelopes
    """

    def __init__(self, duration: float, title: str = "",
                 fps: int = FPS, sr: int = SAMPLE_RATE):
        self.duration = duration
        self.title = title
        self.fps = fps
        self.sr = sr
        self.visuals = []      # (start, end, func, kwargs)
        self.audio_layers = [] # (start, duration, func, kwargs)
        self.effects = []      # (fx_func, start, end, probability, kwargs)
        self.feedback = None   # FrameFeedback instance
        self._mixed_audio = None

    def add_visual(self, start: float, end: float, func: Callable, **kwargs):
        """Add a visual generator for a time range."""
        self.visuals.append((start, end, func, kwargs))

    def add_audio(self, start: float, duration_secs: float, func: Callable, **kwargs):
        """Add an audio layer. func(duration, sr=sr, **kwargs) -> np.ndarray."""
        self.audio_layers.append((start, duration_secs, func, kwargs))

    def add_effect(self, fx_func: Callable, start: float = None,
                   end: float = None, probability: float = 1.0, **kwargs):
        """Add a global visual effect."""
        self.effects.append((fx_func, start or 0, end or self.duration,
                            probability, kwargs))

    def enable_feedback(self, blend=0.7, zoom=1.005, drift=(0, 0),
                        color_decay=(0.98, 0.97, 0.99)):
        """Enable frame feedback in the render pipeline."""
        self.feedback = FrameFeedback(blend, zoom, drift, color_decay)

    def _mix_audio(self) -> np.ndarray:
        """Pre-render and mix all audio layers."""
        total_samples = int(self.duration * self.sr)
        mixed = np.zeros(total_samples)

        for start, dur, func, kwargs in self.audio_layers:
            audio = func(dur, sr=self.sr, **kwargs)
            offset = int(start * self.sr)
            end = min(offset + len(audio), total_samples)
            chunk_len = end - offset
            if chunk_len > 0:
                mixed[offset:end] += audio[:chunk_len]

        # Normalize
        peak = np.max(np.abs(mixed))
        if peak > 0:
            mixed = mixed / peak * 0.85

        return mixed

    def audio_reactive(self) -> AudioReactive:
        """Build AudioReactive bridge from mixed audio."""
        if self._mixed_audio is None:
            self._mixed_audio = self._mix_audio()
        return AudioReactive(self._mixed_audio, self.sr, self.fps)

    def _render_frame(self, frame_num: int) -> Image.Image:
        """Render a single frame."""
        t = frame_num / self.fps
        total_frames = int(self.duration * self.fps)

        # Find active visual
        img = None
        for start, end, func, kwargs in self.visuals:
            if start <= t < end:
                local_frame = int((t - start) * self.fps)
                local_total = int((end - start) * self.fps)
                img = func(local_frame, max(1, local_total), **kwargs)
                break

        if img is None:
            img = bg_black()

        # Frame feedback
        if self.feedback is not None:
            img = self.feedback.process(img, frame_num)

        # Effects
        for fx_func, fx_start, fx_end, probability, kwargs in self.effects:
            if fx_start <= t < fx_end:
                if random.random() < probability:
                    img = fx_func(img, **kwargs)

        return img

    def render(self, output_path: str):
        """Render the complete video to an MP4 file."""
        tmp_dir = tempfile.mkdtemp(prefix="float_av_")
        frames_dir = os.path.join(tmp_dir, "frames")
        os.makedirs(frames_dir)
        audio_path = os.path.join(tmp_dir, "audio.wav")

        total_frames = int(self.duration * self.fps)

        # 1. Audio
        print(f"[float_av] Mixing {len(self.audio_layers)} audio layers...")
        if self._mixed_audio is None:
            self._mixed_audio = self._mix_audio()
        audio_int = (self._mixed_audio * 32767).astype(np.int16)
        with wave.open(audio_path, 'w') as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(self.sr)
            wf.writeframes(audio_int.tobytes())

        # 2. Frames
        print(f"[float_av] Rendering {total_frames} frames at {self.fps}fps "
              f"({self.duration}s)...")
        for i in range(total_frames):
            img = self._render_frame(i)
            img.save(os.path.join(frames_dir, f"frame_{i:05d}.png"))
            if i % self.fps == 0:
                print(f"  {i}/{total_frames} ({i / self.fps:.0f}s)")

        # 3. Encode
        print("[float_av] Encoding with ffmpeg...")
        cmd = [
            "ffmpeg", "-y",
            "-framerate", str(self.fps),
            "-i", os.path.join(frames_dir, "frame_%05d.png"),
            "-i", audio_path,
            "-c:v", "libx264", "-preset", "medium", "-crf", "23",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "128k",
            "-shortest",
            output_path,
        ]
        subprocess.run(cmd, check=True, capture_output=True)

        # 4. Cleanup
        shutil.rmtree(tmp_dir)
        print(f"[float_av] Done: {output_path}")
        print(f"  Duration: {self.duration}s | {WIDTH}x{HEIGHT} @ {self.fps}fps")

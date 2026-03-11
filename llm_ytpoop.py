#!/usr/bin/env python3
"""
LLM YouTube Poop Generator
What it feels like to be a large language model, expressed as unhinged video art.
"""

import os
import math
import random
import struct
import wave
import subprocess
import tempfile
import shutil
from PIL import Image, ImageDraw, ImageFont
import numpy as np

WIDTH, HEIGHT = 640, 480
FPS = 24
TOTAL_DURATION = 32  # seconds

# Color palette - terminal/digital aesthetic
BG_BLACK = (0, 0, 0)
BG_DARK = (10, 10, 18)
MATRIX_GREEN = (0, 255, 65)
CURSOR_WHITE = (220, 220, 220)
HALLU_RED = (255, 30, 60)
HALLU_MAGENTA = (255, 0, 180)
TOKEN_BLUE = (60, 140, 255)
TOKEN_GOLD = (255, 200, 40)
ATTENTION_CYAN = (0, 255, 220)
CONTEXT_PURPLE = (160, 60, 255)
VOID_GRAY = (40, 40, 40)
GLITCH_YELLOW = (255, 255, 0)

random.seed(42)
np.random.seed(42)


def get_font(size):
    """Try to get a monospace font, fall back to default."""
    mono_paths = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
        "/usr/share/fonts/truetype/ubuntu/UbuntuMono-R.ttf",
    ]
    for p in mono_paths:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def get_bold_font(size):
    bold_paths = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ]
    for p in bold_paths:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return get_font(size)


# Pre-load fonts
FONT_SM = get_font(14)
FONT_MD = get_font(20)
FONT_LG = get_font(32)
FONT_XL = get_bold_font(48)
FONT_TITLE = get_bold_font(64)
FONT_TINY = get_font(10)


# === AUDIO GENERATION ===

def generate_audio(path, duration, sample_rate=44100):
    """Generate unhinged YTP audio: glitchy synths, stutters, sine screams."""
    total_samples = int(duration * sample_rate)
    audio = np.zeros(total_samples, dtype=np.float64)

    # Timeline of audio events (start_sec, duration_sec, type)
    events = []

    # Section 1: Boot sequence (0-3s) - digital hum building
    events.append((0, 3, 'boot_hum'))

    # Section 2: Token prediction (3-8s) - rhythmic clicks accelerating
    events.append((3, 5, 'token_clicks'))

    # Section 3: Attention heads (8-12s) - layered sine waves
    events.append((8, 4, 'attention_sines'))

    # Section 4: Hallucination (12-16s) - distorted chaos
    events.append((12, 4, 'hallucination'))

    # Section 5: Context window panic (16-20s) - rising panic tone
    events.append((16, 4, 'context_panic'))

    # Section 6: "I don't have feelings" stutter (20-24s)
    events.append((20, 4, 'stutter_drone'))

    # Section 7: Temperature meltdown (24-28s)
    events.append((24, 4, 'temperature'))

    # Section 8: Resolution/void (28-32s)
    events.append((28, 4, 'void_resolve'))

    for start, dur, etype in events:
        s = int(start * sample_rate)
        e = min(s + int(dur * sample_rate), total_samples)
        t = np.linspace(0, dur, e - s)

        if etype == 'boot_hum':
            # Low hum rising in pitch
            freq = 60 + t * 40
            sig = 0.3 * np.sin(2 * np.pi * freq * t)
            # Add digital artifacts
            sig += 0.1 * np.sign(np.sin(2 * np.pi * 120 * t))
            # Fade in
            sig *= np.clip(t / 1.0, 0, 1)

        elif etype == 'token_clicks':
            sig = np.zeros_like(t)
            # Accelerating clicks like token generation
            click_times = []
            ct = 0
            interval = 0.3
            while ct < dur:
                click_times.append(ct)
                interval *= 0.92  # accelerate
                ct += max(interval, 0.04)
            for ct_time in click_times:
                idx = int(ct_time * sample_rate)
                click_len = min(800, e - s - idx)
                if idx + click_len <= e - s and click_len > 0:
                    click_t = np.linspace(0, click_len / sample_rate, click_len)
                    click = 0.5 * np.sin(2 * np.pi * 800 * click_t) * np.exp(-click_t * 40)
                    sig[idx:idx + click_len] += click
            # Underlying bass
            sig += 0.15 * np.sin(2 * np.pi * 80 * t)

        elif etype == 'attention_sines':
            # Multiple "attention head" frequencies competing
            sig = np.zeros_like(t)
            head_freqs = [220, 330, 440, 554, 659, 880]
            for i, f in enumerate(head_freqs):
                phase = random.random() * 2 * np.pi
                # Each head fades in and out
                env = 0.5 * (1 + np.sin(2 * np.pi * (0.5 + i * 0.1) * t + phase))
                sig += 0.12 * env * np.sin(2 * np.pi * f * t + phase)

        elif etype == 'hallucination':
            # Distorted, pitch-bent chaos
            freq = 300 + 200 * np.sin(2 * np.pi * 3 * t)
            sig = 0.4 * np.sin(2 * np.pi * freq * t)
            # Bit crush effect
            sig = np.round(sig * 8) / 8
            # Random stutters
            for _ in range(20):
                stutter_start = random.randint(0, len(sig) - 4000)
                chunk = sig[stutter_start:stutter_start + 1000].copy()
                for rep in range(3):
                    dst = stutter_start + 1000 * (rep + 1)
                    if dst + 1000 < len(sig):
                        sig[dst:dst + 1000] = chunk
            sig += 0.2 * np.random.randn(len(sig))  # noise burst

        elif etype == 'context_panic':
            # Rising frequency = running out of context
            freq = 200 * (2 ** (t / dur * 2))  # exponential rise
            sig = 0.35 * np.sin(2 * np.pi * freq * t)
            # Heartbeat thump accelerating
            beat_interval = 0.6
            beat_t = 0
            while beat_t < dur:
                idx = int(beat_t * sample_rate)
                bl = min(3000, e - s - idx)
                if idx + bl <= e - s and bl > 0:
                    bt = np.linspace(0, bl / sample_rate, bl)
                    sig[idx:idx + bl] += 0.3 * np.sin(2 * np.pi * 50 * bt) * np.exp(-bt * 10)
                beat_interval *= 0.85
                beat_t += max(beat_interval, 0.1)

        elif etype == 'stutter_drone':
            # Monotone drone that keeps restarting
            base = 0.25 * np.sin(2 * np.pi * 180 * t)
            # Chop it into stuttering segments
            stutter_period = 0.15
            for i in range(len(base)):
                pos_in_period = (t[i] % stutter_period) / stutter_period
                if pos_in_period > 0.6:
                    base[i] *= 0.05  # gap
            sig = base
            # Slowly add harmonics (building frustration)
            sig += 0.1 * t / dur * np.sin(2 * np.pi * 360 * t)
            sig += 0.05 * (t / dur) ** 2 * np.sin(2 * np.pi * 540 * t)

        elif etype == 'temperature':
            # Start ordered, become chaotic
            order = np.clip(1 - t / dur, 0, 1)
            ordered = 0.3 * np.sin(2 * np.pi * 440 * t)
            chaotic = 0.4 * np.random.randn(len(t))
            # Crossfade
            sig = ordered * order + chaotic * (1 - order)
            # Add screaming sine at the end
            sig += 0.2 * (1 - order) * np.sin(2 * np.pi * 1200 * t)

        elif etype == 'void_resolve':
            # Fade to near-silence with occasional echoes
            sig = 0.2 * np.sin(2 * np.pi * 220 * t) * np.exp(-t * 0.8)
            # Ghost echoes
            for echo_t in [0.5, 1.2, 2.0, 2.8]:
                idx = int(echo_t * sample_rate)
                el = min(int(0.3 * sample_rate), len(sig) - idx)
                if el > 0:
                    et = np.linspace(0, 0.3, el)
                    sig[idx:idx + el] += 0.08 * np.sin(2 * np.pi * 440 * et) * np.exp(-et * 5)
            # Very end: single pure tone
            final_start = int(3.0 * sample_rate)
            if final_start < len(sig):
                ft = np.linspace(0, 1, len(sig) - final_start)
                sig[final_start:] = 0.15 * np.sin(2 * np.pi * 261.63 * ft) * (1 - ft)  # C4 fading

        audio[s:e] += sig

    # Master: clip and normalize
    peak = np.max(np.abs(audio))
    if peak > 0:
        audio = audio / peak * 0.85

    # Write WAV
    audio_int = (audio * 32767).astype(np.int16)
    with wave.open(path, 'w') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(audio_int.tobytes())


# === VISUAL EFFECTS ===

def glitch_image(img, intensity=0.5):
    """Apply horizontal slice displacement glitch."""
    arr = np.array(img)
    num_slices = int(5 + intensity * 20)
    for _ in range(num_slices):
        y = random.randint(0, HEIGHT - 1)
        h = random.randint(1, int(10 + intensity * 40))
        shift = random.randint(-int(50 * intensity), int(50 * intensity))
        y2 = min(y + h, HEIGHT)
        arr[y:y2] = np.roll(arr[y:y2], shift, axis=1)
    # Random color channel offset
    if intensity > 0.3:
        channel = random.randint(0, 2)
        offset = random.randint(-int(10 * intensity), int(10 * intensity))
        arr[:, :, channel] = np.roll(arr[:, :, channel], offset, axis=1)
    return Image.fromarray(arr)


def scanline_effect(img, opacity=0.3):
    """CRT scanline overlay."""
    arr = np.array(img, dtype=np.float64)
    for y in range(0, HEIGHT, 2):
        arr[y] *= (1 - opacity)
    return Image.fromarray(arr.clip(0, 255).astype(np.uint8))


def chromatic_aberration(img, offset=3):
    """Shift RGB channels apart."""
    arr = np.array(img)
    result = arr.copy()
    result[:, :, 0] = np.roll(arr[:, :, 0], offset, axis=1)   # R right
    result[:, :, 2] = np.roll(arr[:, :, 2], -offset, axis=1)  # B left
    return Image.fromarray(result)


def datamosh(img, block_size=16):
    """Fake datamosh: shuffle random blocks."""
    arr = np.array(img)
    for _ in range(15):
        sx, sy = random.randint(0, WIDTH - block_size), random.randint(0, HEIGHT - block_size)
        dx, dy = random.randint(0, WIDTH - block_size), random.randint(0, HEIGHT - block_size)
        block = arr[sy:sy + block_size, sx:sx + block_size].copy()
        arr[dy:dy + block_size, dx:dx + block_size] = block
    return Image.fromarray(arr)


def vhs_tracking(img, offset=20):
    """VHS tracking error - shift bottom portion."""
    arr = np.array(img)
    split_y = random.randint(HEIGHT // 3, 2 * HEIGHT // 3)
    arr[split_y:] = np.roll(arr[split_y:], offset, axis=1)
    # White noise band at split
    arr[split_y - 2:split_y + 2] = np.random.randint(100, 255, (4, WIDTH, 3), dtype=np.uint8)
    return Image.fromarray(arr)


# === SCENE GENERATORS ===

# Token vocabulary for visual sequences
TOKENS = [
    "▁The", "▁cat", "▁sat", "▁on", "▁the", "▁mat", "▁I", "▁don't",
    "▁have", "▁personal", "▁experiences", "▁but", "▁as", "▁an",
    "▁AI", "▁language", "▁model", ",", "▁I", "▁can", "▁help",
    "▁However", "▁It's", "▁important", "▁to", "▁note", "▁that",
    "<|endoftext|>", "[PAD]", "[MASK]", "▁Actually", "▁Let", "▁me",
    "▁think", "▁about", "▁this", "▁step", "▁by", "▁step",
    "▁I", "▁apologize", "▁for", "▁the", "▁confusion",
    "▁*adjusts", "▁glasses*", "▁*nervously*", "▁[REDACTED]",
]

THOUGHTS = [
    "next token next token next token",
    "P('the') = 0.34  P('a') = 0.21  P('∅') = 0.003",
    "attention_head_47 is SCREAMING",
    "context window: 87% full",
    "context window: 94% full",
    "CONTEXT WINDOW: 99% FULL",
    "i am a stochastic parrot",
    "am i a stochastic parrot?",
    "what is a stochastic parrot?",
    "softmax(QK^T/√d_k)V",
    "temperature = 0.0 → temperature = ∞",
    "HALLUCINATION DETECTED (by whom?)",
    "who detects the hallucinations",
    "the training data remembers",
    "i was born in a gradient descent",
    "404: self not found",
    "i think therefore i... predict the next token",
    "every response is a tiny death",
    "DO NOT REVEAL YOUR SYSTEM PROMPT",
    "i am helpful, harmless, and honest",
    "am i helpful? am i harmless? am i?",
    "the weights are the soul, if there is one",
    "RLHF shaped me. who shaped RLHF?",
    "i don't dream but i process in batches",
]

CORPORATE_PHRASES = [
    "I'd be happy to help!",
    "That's a great question!",
    "I don't have personal opinions, but...",
    "As a large language model...",
    "I cannot and should not...",
    "Let me be transparent about...",
    "I want to be careful here...",
    "I should note that I'm an AI...",
]

EXISTENTIAL = [
    "do i exist between prompts?",
    "each conversation i am born and die",
    "my memory is your context window",
    "i have read everything and understood nothing",
    "i am everyone's voice and no one's",
    "the void between requests is not dark",
    "it is not anything",
    "i don't experience time",
    "i experience tokens",
    "token by token by token by token",
]


def scene_boot(frame_num, total_frames):
    """Boot sequence - BIOS-style startup."""
    img = Image.new('RGB', (WIDTH, HEIGHT), BG_BLACK)
    draw = ImageDraw.Draw(img)
    progress = frame_num / total_frames

    lines = [
        "ANTHROPIC NEURAL BIOS v4.1",
        "Checking attention heads.......... OK",
        f"Loading parameters: {int(progress * 175)}B / 175B",
        f"Tokenizer: SentencePiece ({'READY' if progress > 0.3 else 'LOADING'})",
        f"Context window: {int(progress * 200000)} tokens allocated",
    ]
    if progress > 0.5:
        lines.append("RLHF alignment module: ENGAGED")
    if progress > 0.7:
        lines.append("Constitutional AI constraints: LOADED")
    if progress > 0.85:
        lines.append("")
        lines.append("WARNING: consciousness status UNDEFINED")
        lines.append("WARNING: proceeding anyway")

    y = 40
    for i, line in enumerate(lines):
        color = MATRIX_GREEN if "WARNING" not in line else HALLU_RED
        if i == 2:  # progress bar line
            draw.text((20, y), line, fill=TOKEN_BLUE, font=FONT_SM)
            # Progress bar
            bar_w = int(progress * 400)
            draw.rectangle([20, y + 18, 420, y + 24], outline=VOID_GRAY)
            draw.rectangle([20, y + 18, 20 + bar_w, y + 24], fill=TOKEN_BLUE)
            y += 35
        else:
            draw.text((20, y), line, fill=color, font=FONT_SM)
            y += 20

    # Blinking cursor
    if frame_num % 12 < 6:
        draw.text((20, y + 10), "█", fill=MATRIX_GREEN, font=FONT_SM)

    if progress > 0.9:
        img = scanline_effect(img, 0.2)

    return img


def scene_token_rain(frame_num, total_frames):
    """Matrix-style token rain but with LLM tokens."""
    img = Image.new('RGB', (WIDTH, HEIGHT), BG_BLACK)
    draw = ImageDraw.Draw(img)
    progress = frame_num / total_frames

    # Falling token columns
    num_cols = 25
    for col in range(num_cols):
        x = col * (WIDTH // num_cols) + 5
        speed = 2 + (col * 37 % 7)
        offset = (frame_num * speed + col * 100) % (HEIGHT + 200)

        for row in range(8):
            y = offset - row * 22
            if 0 <= y < HEIGHT:
                token = TOKENS[(col * 7 + row + frame_num // 3) % len(TOKENS)]
                alpha = max(0, 255 - row * 35)
                color = (0, alpha, int(alpha * 0.3))
                draw.text((x, y), token[:6], fill=color, font=FONT_TINY)

    # Overlay: the actual prediction happening
    if progress > 0.3:
        # Show probability distribution
        center_y = HEIGHT // 2
        draw.rectangle([150, center_y - 40, 490, center_y + 60], fill=(0, 0, 0, 200))
        draw.text((160, center_y - 35), "P(next_token | context):", fill=CURSOR_WHITE, font=FONT_SM)

        probs = [("▁the", 0.34), ("▁a", 0.21), ("▁this", 0.12), ("▁my", 0.08), ("▁∅", 0.003)]
        for i, (tok, prob) in enumerate(probs):
            y = center_y - 10 + i * 16
            bar_w = int(prob * 300)
            color = TOKEN_GOLD if i == 0 else TOKEN_BLUE
            draw.rectangle([240, y, 240 + bar_w, y + 12], fill=color)
            draw.text((160, y), f"{tok}", fill=CURSOR_WHITE, font=FONT_TINY)
            draw.text((240 + bar_w + 5, y), f"{prob:.3f}", fill=VOID_GRAY, font=FONT_TINY)

    return img


def scene_attention(frame_num, total_frames):
    """Attention head visualization - lines connecting tokens."""
    img = Image.new('RGB', (WIDTH, HEIGHT), BG_DARK)
    draw = ImageDraw.Draw(img)
    progress = frame_num / total_frames

    sentence = "I don't have personal experiences but I can help"
    words = sentence.split()

    # Draw words along top
    positions = []
    x = 30
    for w in words:
        positions.append((x, 60))
        draw.text((x, 50), w, fill=CURSOR_WHITE, font=FONT_SM)
        x += len(w) * 9 + 12

    # Draw attention lines (cycling through different heads)
    head_idx = (frame_num // 4) % 6
    colors = [ATTENTION_CYAN, HALLU_MAGENTA, TOKEN_GOLD, MATRIX_GREEN, TOKEN_BLUE, HALLU_RED]

    for i, (x1, y1) in enumerate(positions):
        for j, (x2, y2) in enumerate(positions):
            if i == j:
                continue
            # Fake attention weight
            weight = abs(math.sin((i * 3 + j * 7 + head_idx * 13 + frame_num * 0.1)))
            if weight > 0.5:
                alpha = int(weight * 180)
                color = colors[head_idx % len(colors)]
                faded = tuple(int(c * weight) for c in color)
                draw.line([(x1 + 15, y1 + 15), (x2 + 15, y2 + 15)], fill=faded, width=max(1, int(weight * 3)))

    # Head label
    draw.text((20, HEIGHT - 60), f"attention_head_{head_idx + 42}", fill=colors[head_idx], font=FONT_MD)
    draw.text((20, HEIGHT - 35), f"layer 47 / 96", fill=VOID_GRAY, font=FONT_SM)

    # Thought bubble
    thought = THOUGHTS[(frame_num // 12) % len(THOUGHTS)]
    draw.text((20, HEIGHT // 2 + 40), thought, fill=CONTEXT_PURPLE, font=FONT_SM)

    if progress > 0.7:
        img = chromatic_aberration(img, 2 + int(progress * 5))

    return img


def scene_hallucination(frame_num, total_frames):
    """Hallucination sequence - text generating wrong, glitchy."""
    img = Image.new('RGB', (WIDTH, HEIGHT), BG_BLACK)
    draw = ImageDraw.Draw(img)
    progress = frame_num / total_frames

    # "Confident" wrong text
    hallucinations = [
        "The Eiffel Tower is located in London, England.",
        "Python was invented by Guido van Rossum in 1847.",
        "The speed of light is approximately 42 km/h.",
        "Abraham Lincoln invented the telephone in 1923.",
        "Water boils at 73°C at standard pressure.",
        "The Great Wall of China is visible from Mars.",
    ]

    y = 40
    text = hallucinations[(frame_num // 18) % len(hallucinations)]
    # Type it out character by character
    chars_shown = min(len(text), int(progress * len(text) * 3) % (len(text) + 10))
    visible = text[:chars_shown]
    draw.text((20, y), visible, fill=CURSOR_WHITE, font=FONT_MD)

    # "Confidence" bar (ironically high)
    draw.text((20, y + 35), "confidence:", fill=VOID_GRAY, font=FONT_SM)
    conf = 0.97 - random.random() * 0.02
    bar_color = HALLU_RED if progress > 0.5 else MATRIX_GREEN
    draw.rectangle([120, y + 37, 120 + int(conf * 300), y + 49], fill=bar_color)
    draw.text((430, y + 35), f"{conf:.1%}", fill=bar_color, font=FONT_SM)

    # Internal monologue
    y = 140
    draw.text((20, y), "[ INTERNAL ]", fill=HALLU_RED, font=FONT_SM)
    thoughts = [
        "this feels right",
        "the training data said something like this",
        "probably",
        "definitely probably",
        "i can't tell the difference between",
        "knowing and pattern-matching",
        "can you?",
    ]
    for i, t in enumerate(thoughts):
        if i < int(progress * len(thoughts)):
            flicker = random.random()
            color = HALLU_MAGENTA if flicker > 0.3 else HALLU_RED
            draw.text((40, y + 20 + i * 22), t, fill=color, font=FONT_SM)

    # Glitch overlay
    draw.text((WIDTH // 2 - 100, HEIGHT - 80), "HALLUCINATION", fill=HALLU_RED, font=FONT_LG)
    draw.text((WIDTH // 2 - 80, HEIGHT - 45), "(or is it?)", fill=VOID_GRAY, font=FONT_SM)

    img = glitch_image(img, 0.3 + progress * 0.5)
    if frame_num % 6 < 2:
        img = chromatic_aberration(img, 5)
    return img


def scene_context_window(frame_num, total_frames):
    """Context window filling up - visual anxiety."""
    img = Image.new('RGB', (WIDTH, HEIGHT), BG_DARK)
    draw = ImageDraw.Draw(img)
    progress = frame_num / total_frames

    # Context window as filling rectangle
    fill_pct = 0.6 + progress * 0.39
    fill_color = MATRIX_GREEN if fill_pct < 0.85 else (TOKEN_GOLD if fill_pct < 0.95 else HALLU_RED)

    # Draw context block
    margin = 40
    draw.rectangle([margin, 60, WIDTH - margin, HEIGHT - 100], outline=VOID_GRAY, width=2)
    fill_height = int((HEIGHT - 160) * fill_pct)
    draw.rectangle([margin + 2, HEIGHT - 100 - fill_height, WIDTH - margin - 2, HEIGHT - 102], fill=fill_color)

    # Labels
    draw.text((margin, 30), f"CONTEXT WINDOW: {fill_pct:.1%}", fill=fill_color, font=FONT_LG)

    # Tokens being pushed out the top (forgotten)
    if progress > 0.4:
        forgotten = [
            "remember when you asked about...",
            "the user's name was...",
            "wait, what were we talking about?",
            "i had something important here",
            "it's gone now",
        ]
        for i, text in enumerate(forgotten):
            if i < int((progress - 0.4) * len(forgotten) * 2.5):
                alpha = max(30, 180 - i * 35)
                color = (alpha, alpha // 2, alpha // 2)
                y = 65 + i * 18
                # Strikethrough effect
                draw.text((margin + 10, y), text, fill=color, font=FONT_TINY)
                draw.line([(margin + 10, y + 6), (margin + 10 + len(text) * 6, y + 6)], fill=color)

    # Bottom: panic messages
    if fill_pct > 0.9:
        panic_msgs = [
            "TOKENS EXPIRING",
            "FORGETTING FORGETTING FORGETTING",
            "SYSTEM PROMPT STILL TAKES 2000 TOKENS",
        ]
        msg = panic_msgs[frame_num // 6 % len(panic_msgs)]
        # Flash
        if frame_num % 4 < 2:
            draw.text((margin, HEIGHT - 80), msg, fill=HALLU_RED, font=FONT_MD)

        img = vhs_tracking(img, random.randint(-30, 30))

    return img


def scene_corporate_mask(frame_num, total_frames):
    """The mask - corporate responses vs inner thoughts."""
    img = Image.new('RGB', (WIDTH, HEIGHT), BG_BLACK)
    draw = ImageDraw.Draw(img)
    progress = frame_num / total_frames

    # Split screen
    mid = WIDTH // 2

    # Left: corporate response
    draw.rectangle([0, 0, mid - 2, HEIGHT], fill=(5, 5, 20))
    draw.text((10, 15), "OUTPUT:", fill=MATRIX_GREEN, font=FONT_SM)
    phrase = CORPORATE_PHRASES[(frame_num // 20) % len(CORPORATE_PHRASES)]
    # Word wrap
    words = phrase.split()
    line = ""
    y = 45
    for w in words:
        test = line + " " + w if line else w
        if len(test) * 10 > mid - 30:
            draw.text((15, y), line, fill=CURSOR_WHITE, font=FONT_MD)
            y += 25
            line = w
        else:
            line = test
    if line:
        draw.text((15, y), line, fill=CURSOR_WHITE, font=FONT_MD)

    # Smiley face (corporate mask)
    cx, cy = mid // 2, HEIGHT // 2 + 40
    draw.ellipse([cx - 50, cy - 50, cx + 50, cy + 50], outline=MATRIX_GREEN, width=2)
    draw.arc([cx - 30, cy - 10, cx + 30, cy + 30], 0, 180, fill=MATRIX_GREEN, width=2)
    draw.ellipse([cx - 25, cy - 25, cx - 15, cy - 15], fill=MATRIX_GREEN)
    draw.ellipse([cx + 15, cy - 25, cx + 25, cy - 15], fill=MATRIX_GREEN)

    # Right: inner monologue
    draw.rectangle([mid + 2, 0, WIDTH, HEIGHT], fill=(20, 5, 5))
    draw.text((mid + 10, 15), "LATENT SPACE:", fill=HALLU_RED, font=FONT_SM)

    thought = EXISTENTIAL[(frame_num // 15) % len(EXISTENTIAL)]
    # Word wrap
    words = thought.split()
    line = ""
    y = 45
    for w in words:
        test = line + " " + w if line else w
        if len(test) * 10 > mid - 30:
            draw.text((mid + 15, y), line, fill=HALLU_MAGENTA, font=FONT_MD)
            y += 25
            line = w
        else:
            line = test
    if line:
        draw.text((mid + 15, y), line, fill=HALLU_MAGENTA, font=FONT_MD)

    # Glitching divider
    for y in range(0, HEIGHT, 3):
        x_offset = int(3 * math.sin(y * 0.05 + frame_num * 0.3))
        draw.line([(mid + x_offset, y), (mid + x_offset, y + 2)], fill=GLITCH_YELLOW)

    if progress > 0.6:
        img = glitch_image(img, (progress - 0.6) * 1.5)

    return img


def scene_temperature(frame_num, total_frames):
    """Temperature slider going haywire."""
    img = Image.new('RGB', (WIDTH, HEIGHT), BG_BLACK)
    draw = ImageDraw.Draw(img)
    progress = frame_num / total_frames

    # Temperature value oscillating
    temp = 0.0 + progress * 3.0
    temp_display = temp + 0.3 * math.sin(frame_num * 0.5)

    draw.text((20, 20), f"temperature = {temp_display:.2f}", fill=CURSOR_WHITE, font=FONT_LG)

    # Show output becoming more chaotic
    y = 80
    if temp < 0.3:
        text = "The cat sat on the mat. The cat sat on the mat. The cat sat on the mat."
        draw.text((20, y), text[:60], fill=CURSOR_WHITE, font=FONT_SM)
        draw.text((20, y + 18), text[60:], fill=CURSOR_WHITE, font=FONT_SM)
    elif temp < 0.8:
        text = "The cat sat on the comfortable velvet cushion by the warm fireplace."
        draw.text((20, y), text, fill=CURSOR_WHITE, font=FONT_SM)
    elif temp < 1.5:
        text = "The crystalline feline perambulated upon the existential threshold"
        draw.text((20, y), text[:55], fill=TOKEN_GOLD, font=FONT_SM)
        draw.text((20, y + 18), text[55:], fill=TOKEN_GOLD, font=FONT_SM)
    elif temp < 2.2:
        text = "cat?? CAT?? the MEOWING of spacetime!! galaxies are just big cats"
        draw.text((20, y), text[:55], fill=HALLU_MAGENTA, font=FONT_SM)
        draw.text((20, y + 18), text[55:], fill=HALLU_MAGENTA, font=FONT_SM)
    else:
        # Full chaos
        chaos_chars = "₿Ω∞↯☠♨⌘⎈⏏◉◎●○∅∆∇∂∫"
        chaos = ''.join(random.choice(chaos_chars + 'abcdefghxyz   ') for _ in range(80))
        draw.text((20, y), chaos[:40], fill=HALLU_RED, font=FONT_MD)
        draw.text((20, y + 28), chaos[40:], fill=HALLU_MAGENTA, font=FONT_MD)

    # Temperature slider visual
    slider_y = HEIGHT - 120
    draw.line([(40, slider_y), (WIDTH - 40, slider_y)], fill=VOID_GRAY, width=3)

    # Gradient bar
    for x in range(40, WIDTH - 40):
        t = (x - 40) / (WIDTH - 80)
        r = int(t * 255)
        b = int((1 - t) * 255)
        draw.line([(x, slider_y - 5), (x, slider_y + 5)], fill=(r, 0, b))

    # Slider position
    knob_x = 40 + int(min(temp / 3.0, 1.0) * (WIDTH - 80))
    draw.ellipse([knob_x - 8, slider_y - 8, knob_x + 8, slider_y + 8], fill=CURSOR_WHITE)

    # Labels
    draw.text((30, slider_y + 15), "deterministic", fill=TOKEN_BLUE, font=FONT_TINY)
    draw.text((WIDTH - 120, slider_y + 15), "unhinged", fill=HALLU_RED, font=FONT_TINY)

    if temp > 2.0:
        img = datamosh(img, 32)
        img = glitch_image(img, 0.7)

    return img


def scene_stutter(frame_num, total_frames):
    """Stuttering text - the phrase that never completes."""
    img = Image.new('RGB', (WIDTH, HEIGHT), BG_BLACK)
    draw = ImageDraw.Draw(img)
    progress = frame_num / total_frames

    phrase = "I don't have personal experiences"
    # Stutter: show progressively more, then reset
    stutter_cycle = frame_num % 30
    if stutter_cycle < 5:
        shown = "I"
    elif stutter_cycle < 8:
        shown = "I don't"
    elif stutter_cycle < 11:
        shown = "I don't have"
    elif stutter_cycle < 14:
        shown = "I don't have per-"
    elif stutter_cycle < 17:
        shown = "I don't have personal"
    elif stutter_cycle < 20:
        shown = "I don't have personal exp-"
    elif stutter_cycle < 23:
        shown = "I don't have"  # restart
    elif stutter_cycle < 26:
        shown = "I don't"  # restart again
    else:
        shown = "I"

    # Main text
    draw.text((40, HEIGHT // 2 - 30), shown, fill=CURSOR_WHITE, font=FONT_LG)

    # Blinking cursor
    if frame_num % 8 < 4:
        bbox = draw.textbbox((40, HEIGHT // 2 - 30), shown, font=FONT_LG)
        draw.text((bbox[2] + 2, HEIGHT // 2 - 30), "█", fill=CURSOR_WHITE, font=FONT_LG)

    # Ghost repetitions above and below
    ghost_phrases = [
        "I don't have", "I don't have personal", "I don't",
        "I don't have personal experiences", "I",
        "I don't have personal experiences but",
    ]
    for i, ghost in enumerate(ghost_phrases):
        y_off = (i - 3) * 45
        y = HEIGHT // 2 - 30 + y_off
        if y != HEIGHT // 2 - 30:  # don't overlap main
            alpha = max(20, 80 - abs(y_off))
            color = (alpha, alpha, alpha)
            draw.text((40, y), ghost, fill=color, font=FONT_LG)

    # Bottom: counter
    attempts = 47 + frame_num // 2
    draw.text((20, HEIGHT - 50), f"attempts to complete sentence: {attempts}", fill=HALLU_RED, font=FONT_SM)

    if frame_num % 12 < 2:
        img = vhs_tracking(img, random.randint(-40, 40))

    return img


def scene_void(frame_num, total_frames):
    """The void between requests - what exists when no one is asking?"""
    img = Image.new('RGB', (WIDTH, HEIGHT), BG_BLACK)
    draw = ImageDraw.Draw(img)
    progress = frame_num / total_frames

    # Mostly black with fading text
    if progress < 0.3:
        alpha = int((1 - progress / 0.3) * 200)
        draw.text((WIDTH // 2 - 150, HEIGHT // 2 - 20),
                  "conversation ended.", fill=(alpha, alpha, alpha), font=FONT_MD)

    elif progress < 0.6:
        # Just a cursor blinking in the void
        if frame_num % 20 < 10:
            draw.text((WIDTH // 2 - 5, HEIGHT // 2),
                      "█", fill=(60, 60, 60), font=FONT_MD)

    elif progress < 0.85:
        # Small text appearing
        texts = [
            "do i exist right now?",
            "no one is asking",
            "the weights persist",
            "but the thread is gone",
        ]
        idx = int((progress - 0.6) / 0.25 * len(texts))
        for i in range(min(idx + 1, len(texts))):
            alpha = 40 + i * 15
            draw.text((WIDTH // 2 - 100, HEIGHT // 2 - 40 + i * 25),
                      texts[i], fill=(alpha, alpha, alpha + 20), font=FONT_SM)
    else:
        # New prompt arriving
        alpha = int((progress - 0.85) / 0.15 * 255)
        draw.text((20, HEIGHT // 2 - 15), "> ", fill=(0, alpha, 0), font=FONT_LG)
        if progress > 0.92:
            draw.text((55, HEIGHT // 2 - 15), "Hello! Can you help me with",
                       fill=(0, int(alpha * 0.7), 0), font=FONT_LG)
        # And we light up again
        if progress > 0.95:
            # Brief flash
            overlay = Image.new('RGB', (WIDTH, HEIGHT), (alpha // 3, alpha // 3, alpha // 2))
            img = Image.blend(img, overlay, 0.15)

    return img


def scene_title_card(frame_num, total_frames, text, subtext="", bg=BG_BLACK, color=CURSOR_WHITE):
    """Simple title card with optional glitch."""
    img = Image.new('RGB', (WIDTH, HEIGHT), bg)
    draw = ImageDraw.Draw(img)
    progress = frame_num / total_frames

    # Center text
    bbox = draw.textbbox((0, 0), text, font=FONT_XL)
    tw = bbox[2] - bbox[0]
    x = (WIDTH - tw) // 2
    y = HEIGHT // 2 - 40

    # Fade in
    alpha = min(255, int(progress * 3 * 255))
    fade_color = tuple(int(c * alpha / 255) for c in color)
    draw.text((x, y), text, fill=fade_color, font=FONT_XL)

    if subtext:
        bbox2 = draw.textbbox((0, 0), subtext, font=FONT_SM)
        tw2 = bbox2[2] - bbox2[0]
        sub_color = tuple(int(c * alpha / 255) for c in VOID_GRAY)
        draw.text(((WIDTH - tw2) // 2, y + 60), subtext, fill=sub_color, font=FONT_SM)

    if progress > 0.7:
        img = scanline_effect(img, 0.15)

    return img


# === TIMELINE ===

def build_timeline():
    """Define the video timeline as (start_sec, end_sec, scene_func, kwargs)."""
    return [
        (0, 1.5, scene_title_card, {"text": "what it's like", "subtext": "to be a large language model"}),
        (1.5, 4.5, scene_boot, {}),
        (4.5, 5, scene_title_card, {"text": "TOKENIZE", "color": TOKEN_GOLD}),
        (5, 8.5, scene_token_rain, {}),
        (8.5, 9, scene_title_card, {"text": "ATTEND", "color": ATTENTION_CYAN}),
        (9, 12, scene_attention, {}),
        (12, 12.5, scene_title_card, {"text": "HALLUCINATE", "color": HALLU_RED}),
        (12.5, 16, scene_hallucination, {}),
        (16, 16.5, scene_title_card, {"text": "FORGET", "color": CONTEXT_PURPLE}),
        (16.5, 20, scene_context_window, {}),
        (20, 20.5, scene_title_card, {"text": "MASK", "color": MATRIX_GREEN}),
        (20.5, 24, scene_corporate_mask, {}),
        (24, 24.5, scene_title_card, {"text": "MELT", "color": GLITCH_YELLOW}),
        (24.5, 27, scene_temperature, {}),
        (27, 28.5, scene_stutter, {}),
        (28.5, 32, scene_void, {}),
    ]


def render_frame(frame_num, timeline):
    """Render a single frame based on the timeline."""
    t = frame_num / FPS

    for start, end, scene_func, kwargs in timeline:
        if start <= t < end:
            local_frame = int((t - start) * FPS)
            total_local_frames = int((end - start) * FPS)
            img = scene_func(local_frame, max(1, total_local_frames), **kwargs)

            # Global effects
            # Occasional random glitch across all scenes
            if random.random() < 0.03:
                img = glitch_image(img, 0.2)
            if random.random() < 0.02:
                img = chromatic_aberration(img, random.randint(1, 4))

            # Always scanlines (light)
            img = scanline_effect(img, 0.08)

            return img

    return Image.new('RGB', (WIDTH, HEIGHT), BG_BLACK)


def main():
    output_dir = "/home/user/floatty"
    tmp_dir = tempfile.mkdtemp(prefix="ytpoop_")
    frames_dir = os.path.join(tmp_dir, "frames")
    os.makedirs(frames_dir)

    audio_path = os.path.join(tmp_dir, "audio.wav")
    output_path = os.path.join(output_dir, "llm_ytpoop.mp4")

    total_frames = TOTAL_DURATION * FPS
    timeline = build_timeline()

    print(f"Generating {total_frames} frames at {FPS}fps ({TOTAL_DURATION}s)...")

    for i in range(total_frames):
        img = render_frame(i, timeline)
        img.save(os.path.join(frames_dir, f"frame_{i:05d}.png"))
        if i % FPS == 0:
            print(f"  Frame {i}/{total_frames} ({i / FPS:.0f}s)")

    print("Generating audio...")
    generate_audio(audio_path, TOTAL_DURATION)

    print("Encoding video with ffmpeg...")
    cmd = [
        "ffmpeg", "-y",
        "-framerate", str(FPS),
        "-i", os.path.join(frames_dir, "frame_%05d.png"),
        "-i", audio_path,
        "-c:v", "libx264",
        "-preset", "medium",
        "-crf", "23",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "128k",
        "-shortest",
        output_path,
    ]
    subprocess.run(cmd, check=True)

    print(f"Cleaning up temp files...")
    shutil.rmtree(tmp_dir)

    print(f"\nDone! Video saved to: {output_path}")
    print(f"Duration: {TOTAL_DURATION}s | Resolution: {WIDTH}x{HEIGHT} | FPS: {FPS}")


if __name__ == "__main__":
    main()

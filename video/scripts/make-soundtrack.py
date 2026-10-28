"""Synthesise the calm ambient music bed (no external samples) and mix in the
voiceover from public/narration, ducking the music under the voice.

Writes public/soundtrack.wav. Timing comes from src/timeline.json and
src/narration.json (run make-narration.py first).
Run: python3 scripts/make-soundtrack.py
"""
import json
import subprocess
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
TIMELINE = json.loads((ROOT / "src" / "timeline.json").read_text())
NARRATION = json.loads((ROOT / "src" / "narration.json").read_text())

SR = 44100
FPS = TIMELINE["fps"]
SCENES = [s["duration"] for s in TIMELINE["scenes"]]
SCENE_IDS = [s["id"] for s in TIMELINE["scenes"]]
TRANSITION = TIMELINE["transition"]
TOTAL_FRAMES = sum(SCENES) - TRANSITION * (len(SCENES) - 1)
DUR = TOTAL_FRAMES / FPS
N = int(DUR * SR)
t = np.arange(N) / SR
rng = np.random.default_rng(7)


def hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


def lowpass(x, cutoff):
    # One-pole low-pass, applied forward and backward for a softer slope.
    a = np.exp(-2 * np.pi * cutoff / SR)
    y = np.empty_like(x)
    acc = 0.0
    for i in range(len(x)):
        acc = (1 - a) * x[i] + a * acc
        y[i] = acc
    return y


BPM = 84
BEAT = 60 / BPM
BAR = BEAT * 4
# D major-ish, calm and confident: Dmaj9, Bm9, Gmaj7(#11), A6sus
CHORDS = [
    [50, 57, 61, 64, 66],
    [47, 54, 57, 61, 62],
    [43, 50, 54, 57, 61],
    [45, 52, 57, 59, 64],
]

out = np.zeros(N)

# Pad: detuned sines with slow swell per chord (2 bars each)
chord_len = BAR * 2
n_chords = int(np.ceil(DUR / chord_len)) + 1
pad = np.zeros(N)
for c in range(n_chords):
    start = c * chord_len
    s0 = int(start * SR)
    s1 = min(N, int((start + chord_len + 1.2) * SR))
    if s0 >= N:
        break
    seg_t = t[s0:s1] - start
    env = np.minimum(1, seg_t / 1.4) * np.clip((chord_len + 1.2 - seg_t) / 1.6, 0, 1)
    notes = CHORDS[c % len(CHORDS)]
    for m in notes:
        for det in (-0.12, 0.0, 0.12):
            f = hz(m + det)
            pad[s0:s1] += env * (np.sin(2 * np.pi * f * seg_t) + 0.25 * np.sin(4 * np.pi * f * seg_t)) / len(notes)
out += 0.16 * pad

# Bass: soft sine on the root, each bar
for b in range(int(DUR / BAR) + 1):
    start = b * BAR
    s0 = int(start * SR)
    if s0 >= N:
        break
    s1 = min(N, int((start + BAR) * SR))
    seg_t = t[s0:s1] - start
    root = CHORDS[(b // 2) % len(CHORDS)][0] - 12
    env = (1 - np.exp(-seg_t * 30)) * np.exp(-seg_t * 0.9)
    out[s0:s1] += 0.22 * env * np.sin(2 * np.pi * hz(root) * seg_t)

# Plucked arpeggio (bell-like), 8th notes, enters after the intro
arp_start = 102 / FPS
pattern = [2, 3, 4, 3, 1, 3, 4, 2]
step = BEAT / 2
k = 0
time = arp_start
while time < DUR - 4:
    chord = CHORDS[int(time // chord_len) % len(CHORDS)]
    m = chord[pattern[k % len(pattern)]] + 12
    s0 = int(time * SR)
    s1 = min(N, s0 + int(1.6 * SR))
    seg_t = t[s0:s1] - time
    f = hz(m)
    env = np.exp(-seg_t * 3.2) * (1 - np.exp(-seg_t * 400))
    tone = np.sin(2 * np.pi * f * seg_t) + 0.3 * np.sin(2 * np.pi * 2 * f * seg_t) * np.exp(-seg_t * 6)
    vel = 0.75 + 0.25 * ((k % 4) == 0)
    out[s0:s1] += 0.07 * vel * env * tone
    k += 1
    time += step

# Soft whooshes at each scene transition
starts = np.cumsum([0] + [d - TRANSITION for d in SCENES[:-1]])
noise = rng.standard_normal(N)
whoosh = np.zeros(N)
for st in starts[1:]:
    centre = (st + TRANSITION / 2) / FPS
    s0 = int((centre - 0.6) * SR)
    s1 = int((centre + 0.5) * SR)
    seg_t = t[s0:s1] - (centre - 0.6)
    env = np.sin(np.pi * np.clip(seg_t / 1.1, 0, 1)) ** 3
    whoosh[s0:s1] += env * noise[s0:s1]
out += 0.05 * lowpass(whoosh, 1800)

# Low impact under the logo reveal and final call to action
for sec in (0.15, starts[-1] / FPS + 0.3):
    s0 = int(sec * SR)
    s1 = min(N, s0 + int(2.5 * SR))
    seg_t = t[s0:s1] - sec
    out[s0:s1] += 0.25 * np.exp(-seg_t * 2.2) * np.sin(2 * np.pi * (55 + 30 * np.exp(-seg_t * 8)) * seg_t)

# Gentle overall low-pass for warmth, master fade in/out
out = lowpass(out, 6000)
fade = np.minimum(1, t / 1.0) * np.clip((DUR - t) / 2.5, 0, 1)
out *= fade
out /= np.max(np.abs(out)) + 1e-9
music = out * 0.32

# Voiceover, placed at each scene's start + offset
voice = np.zeros(N)
duck = np.zeros(N)
for line in NARRATION:
    idx = SCENE_IDS.index(line["scene"])
    at = starts[idx] / FPS + line["offset"]
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(ROOT / "public" / "narration" / f"{line['scene']}.wav"),
         "-ar", str(SR), "-ac", "1", "-f", "f32le", "-"],
        check=True, capture_output=True,
    ).stdout
    clip = np.frombuffer(raw, dtype=np.float32).astype(np.float64)
    s0 = int(at * SR)
    s1 = min(N, s0 + len(clip))
    voice[s0:s1] += clip[: s1 - s0]
    d0 = max(0, s0 - int(0.25 * SR))
    d1 = min(N, s1 + int(0.4 * SR))
    duck[d0:d1] = 1
duck = lowpass(duck, 2.0)
voice /= np.max(np.abs(voice)) + 1e-9
out = music * (1 - 0.45 * duck) + voice * 0.9
out /= max(1.0, np.max(np.abs(out)) / 0.95)

music_r = np.roll(music * (1 - 0.45 * duck), 220)
stereo = np.stack([out, out - music * (1 - 0.45 * duck) + music_r], axis=1)
pcm = (stereo * 32767).astype(np.int16)
path = ROOT / "public" / "soundtrack.wav"
with wave.open(str(path), "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())
subprocess.run(
    ["ffmpeg", "-v", "error", "-y", "-i", str(path), "-b:a", "192k", str(path.with_suffix(".mp3"))],
    check=True,
)
print(f"wrote {path} and .mp3 ({DUR:.1f}s)")

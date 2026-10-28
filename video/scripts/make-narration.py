"""Generate the voiceover clips with Kokoro (open-weight TTS, runs locally).

Model files (from github.com/thewh1teagle/kokoro-onnx releases, model-files-v1.0):
  kokoro-v1.0.onnx, voices-v1.0.bin  -> pass their folder as argv[1].
Writes public/narration/<Scene>.wav and src/narration.json (durations).
Run: python3 scripts/make-narration.py /path/to/model-folder [voice]
"""
import json
import sys
from pathlib import Path

import soundfile as sf
from kokoro_onnx import Kokoro

ROOT = Path(__file__).resolve().parent.parent
model_dir = Path(sys.argv[1])
voice = sys.argv[2] if len(sys.argv) > 2 else "af_heart"
kokoro = Kokoro(str(model_dir / "kokoro-v1.0.onnx"), str(model_dir / "voices-v1.0.bin"))

lines = json.loads((ROOT / "scripts" / "narration.json").read_text())
out = []
for line in lines:
    samples, sr = kokoro.create(line["text"], voice=voice, speed=line.get("speed", 0.98), lang="en-us")
    path = ROOT / "public" / "narration" / f"{line['scene']}.wav"
    sf.write(path, samples, sr)
    dur = len(samples) / sr
    out.append({"scene": line["scene"], "offset": line["offset"], "duration": round(dur, 3), "text": line["text"]})
    print(f"{line['scene']:<14} {dur:5.2f}s")

(ROOT / "src" / "narration.json").write_text(json.dumps(out, indent=2) + "\n")

#!/usr/bin/env python3
"""Generate a bilingual speech fixture and known timing windows without user media."""

from array import array
import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import wave


ROOT = Path(__file__).resolve().parents[1] / "tests/fixtures/generated"
RATE = 16000
PARTS = [
    ("割胶", "cmn"),
    ("哪里有这样，马来西亚的嘛。", "cmn"),
    ("Fashion", "en-us"),
    ("lah", "en-us"),
    ("That is the new look.", "en-us"),
]


def generate(tool, where, text, voice, name):
    output = where / (name + ".wav")
    subprocess.run([tool, "-v", voice, "-s", "160", "-w", output, text], check=True)
    pcm = subprocess.check_output([
        "ffmpeg", "-v", "error", "-nostdin", "-i", output,
        "-ac", "1", "-ar", str(RATE), "-f", "s16le", "-",
    ])
    samples = array("h")
    samples.frombytes(pcm)
    if sys.byteorder == "big":
        samples.byteswap()
    voiced = [i for i, sample in enumerate(samples) if abs(sample) >= 65]
    if not voiced:
        raise RuntimeError("eSpeak NG generated no audible waveform for " + text)
    return samples[voiced[0]:voiced[-1] + 1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--espeak", default="espeak-ng")
    args = parser.parse_args()
    if ROOT.is_symlink():
        parser.error("The generated fixture directory must not be a symlink.")
    ROOT.mkdir(parents=True, exist_ok=True)
    out = Path(tempfile.mkdtemp(prefix="speech-bilingual-", dir=ROOT))
    gap = [0] * int(RATE * 0.12)
    samples = array("h", [0] * RATE)
    reference = []
    with tempfile.TemporaryDirectory(dir=out) as scratch:
        for i, (text, voice) in enumerate(PARTS):
            part = generate(args.espeak, Path(scratch), text, voice, str(i))
            start = len(samples) / RATE
            samples.extend(part)
            reference.append({"text": text, "start": start, "end": len(samples) / RATE})
            samples.extend(gap)
        background = generate(args.espeak, Path(scratch), "I think it starts soon.", "en-us", "background")
        offset = int(RATE * 1.4)
        for i, sample in enumerate(background[:len(samples) - offset]):
            samples[offset + i] = max(-32768, min(32767, samples[offset + i] + int(sample * 0.06)))
    selected = {"start": 1, "end": len(samples) / RATE}
    samples.extend([0] * (RATE // 2))
    audio = out / "bilingual.wav"
    with wave.open(str(audio), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(RATE)
        if sys.byteorder == "big":
            samples.byteswap()
        wav.writeframes(samples.tobytes())
    data = {
        "source": str(audio),
        "interval": selected,
        "text": "割胶哪里有这样，马来西亚的嘛。 Fashion, lah. That is the new look.",
        "anchors": reference,
    }
    print(json.dumps(data, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

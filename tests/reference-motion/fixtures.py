"""Prepare the shared source media under the ignored generated fixture root."""

import hashlib
import json
import math
import shutil
import struct
import sys
import subprocess
import urllib.request
import wave
from array import array
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "tests/fixtures/generated/reference-motion/assets"
INPUTS = {
    "address.webm": (
        "https://upload.wikimedia.org/wikipedia/commons/d/dd/"
        "2016-08-20_President_Obama%27s_Weekly_Address.webm",
        "0bf110faacaacde1dc6fcc2ae2559c1256998205251669728ea1fe742a90aad9",
    ),
    "frazil.webm": (
        "https://upload.wikimedia.org/wikipedia/commons/d/da/"
        "Yosemite_Nature_Notes_9_-_Frazil_Ice_%28no_audio%29.webm",
        "c6cc2eab648169f3f8cef00360256ba86f66c838dab42cca146629d94bb1cee1",
    ),
}


def sha256(file):
    with file.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def download(name, url, digest):
    target = OUT / name
    if not target.exists():
        partial = target.with_suffix(".download")
        request = urllib.request.Request(
            url, headers={"User-Agent": "OpenCut-Fixtures (local media compatibility test)"}
        )
        try:
            with urllib.request.urlopen(request, timeout=120) as response, partial.open("xb") as handle:
                shutil.copyfileobj(response, handle)
            if sha256(partial) != digest:
                raise ValueError(f"Unexpected bytes for {name}")
            partial.rename(target)
        finally:
            partial.unlink(missing_ok=True)
    if sha256(target) != digest:
        raise ValueError(f"Unexpected bytes for {target}")


def encode(name, *args):
    if not (OUT / name).exists():
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-n", *args, str(OUT / name)],
            check=True,
        )


def audio(name, seconds, signal):
    rate = 48000
    samples = array("h", (
        round(max(-1, min(1, signal(i, rate))) * 32767)
        for i in range(rate * seconds)
    ))
    if struct.pack("H", 1) != struct.pack("<H", 1):
        samples.byteswap()
    with (OUT / name).open("xb") as file, wave.open(file, "wb") as target:
        target.setparams((1, 2, rate, 0, "NONE", "not compressed"))
        target.writeframes(samples.tobytes())


def signal(frequency, index, rate):
    time = index / rate
    offset = min(abs(index - marker * rate) for marker in (2, 5, 9))
    return 0.18 * math.sin(math.tau * time * frequency) + 0.7 * max(0, 1 - offset / 36)


def score(index, rate):
    time = index / rate
    block = math.floor(time / 2.4)
    roots = [146.83, 130.81, 174.61, 110]
    fraction = time % 2.4
    amplitude = min(1, fraction * 6, (2.4 - fraction) * 4)
    return 0.065 * amplitude * sum(
        math.sin(math.tau * time * roots[block % len(roots)] * ratio) / (voice + 2)
        for voice, ratio in enumerate((1, 1.5, 2, 2.52))
    )


def lottie():
    def fixed(value):
        return {"a": 0, "k": value}

    def key(frame, xy, next_xy=None):
        entry = {"t": frame, "s": xy}
        if next_xy:
            entry.update(e=next_xy, i={"x": 0.72, "y": 0.98}, o={"x": 0.22, "y": 0.02})
        return entry

    route = [[165, 345, 0], [470, 145, 0], [985, 240, 0], [740, 490, 0], [165, 345, 0]]
    animated = [
        key(12 + i * 72, point, route[i + 1] if i < len(route) - 1 else None)
        for i, point in enumerate(route)
    ]
    transform = {"ty": "tr", "p": fixed([0, 0]), "a": fixed([0, 0]),
                 "s": fixed([100, 100]), "r": fixed(0), "o": fixed(100),
                 "sk": fixed(0), "sa": fixed(0)}
    groups = [
        {"ty": "gr", "nm": "Beacon", "it": [
            {"ty": "el", "d": 1, "p": fixed([0, 0]), "s": fixed([60, 60])},
            {"ty": "fl", "c": fixed([0.15, 0.92, 0.81, 1]), "o": fixed(100), "r": 1},
            transform,
        ]},
        {"ty": "gr", "nm": "Ring", "it": [
            {"ty": "el", "d": 1, "p": fixed([0, 0]), "s": fixed([108, 108])},
            {"ty": "st", "c": fixed([0.85, 1, 0.98, 1]), "o": fixed(75), "w": fixed(3), "lc": 2, "lj": 2},
            transform,
        ]},
    ]
    return {
        "v": "5.13.0", "nm": "Relay", "fr": 24, "ip": 12, "op": 300, "w": 1152, "h": 648,
        "ddd": 0, "assets": [], "layers": [
            {"ddd": 0, "ind": 1, "ty": 4, "nm": "Mobile beacon", "sr": 1, "ip": 12,
             "op": 300, "st": 0, "bm": 0,
             "ks": {"o": fixed(100), "r": fixed(0), "p": {"a": 1, "k": animated},
                    "a": fixed([0, 0, 0]), "s": fixed([100, 100, 100])},
             "shapes": groups}
        ],
    }


def glb():
    # Shared indexed box geometry. Each face has its own normal for hard edges.
    positions, normals, indices = [], [], []
    faces = [
        ((1, 0, 0), (0, 1, 0), (0, 0, 1)),
        ((-1, 0, 0), (0, 0, 1), (0, 1, 0)),
        ((0, 1, 0), (0, 0, 1), (1, 0, 0)),
        ((0, -1, 0), (1, 0, 0), (0, 0, 1)),
        ((0, 0, 1), (1, 0, 0), (0, 1, 0)),
        ((0, 0, -1), (0, 1, 0), (1, 0, 0)),
    ]
    for normal, u, v in faces:
        start = len(positions) // 3
        for offset_u, offset_v in [(-1, -1), (1, -1), (1, 1), (-1, 1)]:
            positions.extend(
                (normal[i] + offset_u * u[i] + offset_v * v[i]) / 2 for i in range(3)
            )
            normals.extend(normal)
        indices.extend(start + i for i in (0, 1, 2, 0, 2, 3))
    chunks = [
        struct.pack("<72f", *positions),
        struct.pack("<72f", *normals),
        struct.pack("<36H", *indices),
    ]
    box = {"attributes": {"POSITION": 0, "NORMAL": 1}, "indices": 2}
    config = {
        "asset": {"version": "2.0", "generator": "OpenCut Parallax fixture"},
        "scene": 0, "scenes": [{"nodes": [0, 1, 2]}],
        "nodes": [
            {"mesh": 0, "translation": [-0.65, 0.12, -0.7], "scale": [1, 1.85, 0.5]},
            {"mesh": 1, "translation": [0.42, -0.17, 0.35], "scale": [1.05, 1.25, 0.48]},
            {"mesh": 2, "translation": [0.0, -0.91, 0], "scale": [2.8, 0.12, 1.95]},
        ],
        "meshes": [{"primitives": [{**box, "material": i}]} for i in range(3)],
        "materials": [
            {"pbrMetallicRoughness": {"baseColorFactor": color, "metallicFactor": 0.24,
                                      "roughnessFactor": 0.35}}
            for color in ([0.16, 0.83, 0.80, 1], [0.99, 0.5, 0.18, 1], [0.15, 0.21, 0.27, 1])
        ],
        "buffers": [{"byteLength": sum(len(chunk) for chunk in chunks)}],
        "bufferViews": [
            {"buffer": 0, "byteOffset": sum(len(chunk) for chunk in chunks[:i]),
             "byteLength": len(data), "target": 34962 if i < 2 else 34963}
            for i, data in enumerate(chunks)
        ],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": 24, "type": "VEC3",
             "min": [-0.5, -0.5, -0.5], "max": [0.5, 0.5, 0.5]},
            {"bufferView": 1, "componentType": 5126, "count": 24, "type": "VEC3"},
            {"bufferView": 2, "componentType": 5123, "count": 36, "type": "SCALAR"},
        ],
    }
    json_bytes = json.dumps(config, separators=(",", ":")).encode()
    json_bytes += b" " * (-len(json_bytes) % 4)
    binary = b"".join(chunks)
    body = struct.pack("<I4s", len(json_bytes), b"JSON") + json_bytes
    body += struct.pack("<I4s", len(binary), b"BIN\0") + binary
    return struct.pack("<4sII", b"glTF", 2, len(body) + 12) + body


def prepare_adapters():
    fixtures = {
        "relay.json": (json.dumps(lottie(), indent=2) + "\n").encode(),
        "parallax.glb": glb(),
    }
    for name, payload in fixtures.items():
        target = OUT / name
        if not target.exists():
            target.write_bytes(payload)
        if target.read_bytes() != payload:
            raise ValueError(f"{target} differs from the fixed source fixture")

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    prepare_adapters()
    if sys.argv[1:] == ["--adapters-only"]:
        return
    if sys.argv[1:]:
        raise SystemExit("Use fixtures.py [--adapters-only]")
    for name, (url, digest) in INPUTS.items():
        download(name, url, digest)
    encode("speaker.mp4", "-i", str(OUT / "address.webm"), "-t", "40", "-vf", "fps=30",
           "-c:v", "libx264", "-threads", "4", "-preset", "fast", "-crf", "16",
           "-pix_fmt", "yuv420p", "-an")
    encode("speech.wav", "-i", str(OUT / "address.webm"), "-t", "40", "-ar", "48000",
           "-ac", "1", "-vn", "-c:a", "pcm_s16le")
    encode("speech-padded.wav", "-i", str(OUT / "speech.wav"), "-af", "apad=whole_dur=40",
           "-t", "40", "-c:a", "pcm_s16le")
    encode("water.mp4", "-ss", "28", "-i", str(OUT / "frazil.webm"), "-t", "25", "-vf",
           "fps=30", "-c:v", "libx264", "-threads", "4", "-preset", "fast", "-crf", "16",
           "-pix_fmt", "yuv420p", "-an")
    font = OUT / "font.ttf"
    if not font.exists():
        shutil.copyfile(REPO / "packages/media/fonts/NotoSansSC.ttf", font)
    for pitch in (220, 880):
        name = f"signal-{pitch}.wav"
        if not (OUT / name).exists():
            audio(name, 17, lambda index, rate: signal(pitch, index, rate))
    if not (OUT / "score.wav").exists():
        audio("score.wav", 32, score)
    for file in sorted(OUT.iterdir()):
        print(sha256(file), file.name)


if __name__ == "__main__":
    main()

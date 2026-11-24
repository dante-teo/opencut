"""Run the optional local Qwen3 recognizer or forced aligner."""

from contextlib import redirect_stdout
from importlib import metadata, util
import json
import os
from pathlib import Path
import sys
import wave


ASR = "OPENCUT_QWEN_ASR_MODEL"
ALIGNER = "OPENCUT_QWEN_ALIGNER_MODEL"
ALIGN_LANGUAGES = (
    "Chinese", "English", "Cantonese", "French", "German", "Italian",
    "Japanese", "Korean", "Portuguese", "Russian", "Spanish",
)


def installed(key):
    root = os.environ.get(key)
    if not root or not Path(root, "config.json").is_file():
        return False
    return any(Path(root).glob("*.safetensors"))


def status():
    available = util.find_spec("qwen_asr") is not None
    return {
        "runtime": metadata.version("qwen-asr") if available else None,
        "asrModel": installed(ASR),
        "alignerModel": installed(ALIGNER),
        "alignmentLanguages": ALIGN_LANGUAGES,
    }


def word_rows(items):
    return [
        {"text": item.text, "start": item.start_time, "end": item.end_time}
        for item in items or []
    ]


def run(request):
    if not installed(ASR) and request["operation"] == "transcribe":
        raise ValueError(f"Set {ASR} to a local Qwen3-ASR weights directory.")
    if not installed(ALIGNER) and request["operation"] == "align":
        raise ValueError(f"Set {ALIGNER} to a local Qwen3-ForcedAligner weights directory.")
    import numpy as np
    import torch
    from qwen_asr import Qwen3ASRModel, Qwen3ForcedAligner

    torch.set_num_threads(min(4, os.cpu_count() or 1))
    controls = {"device_map": "cpu", "dtype": torch.float32, "local_files_only": True}
    recognize = request["operation"] == "transcribe"
    if recognize:
        recognizer = Qwen3ASRModel.from_pretrained(
            os.environ[ASR], max_inference_batch_size=1, max_new_tokens=512, **controls,
        )
        language = request["language"]
        if language and language not in recognizer.get_supported_languages():
            raise ValueError("Unsupported transcription language. Use auto or one of: " +
                             ", ".join(recognizer.get_supported_languages()))
    use_alignment = installed(ALIGNER)
    if use_alignment:
        aligner = Qwen3ForcedAligner.from_pretrained(os.environ[ALIGNER], **controls)

    rows = []
    with wave.open(request["audio"], "rb") as wav:
        if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or wav.getframerate() != 16000:
            raise ValueError("Expected mono 16 kHz PCM prepared by OpenCut.")
        for segment in request["segments"]:
            a = min(wav.getnframes(), round(segment["start"] * 16000))
            b = min(wav.getnframes(), round(segment["end"] * 16000))
            wav.setpos(a)
            audio = (np.frombuffer(wav.readframes(b - a), dtype="<i2").astype(np.float32) / 32768, 16000)
            language = segment.get("language") or request["language"]
            text = segment.get("text", "")
            if recognize and b > a:
                found = recognizer.transcribe(audio=audio, language=language)[0]
                text, language = found.text, found.language or language
            words = []
            reason = None
            if not text.strip():
                reason = "No speech text in this interval."
            elif b == a:
                reason = "No audio samples in this interval."
            elif not use_alignment:
                reason = "ForcedAligner weights are unavailable."
            elif language not in ALIGN_LANGUAGES:
                reason = "No ForcedAligner support for this segment language."
            else:
                words = word_rows(aligner.align(audio=audio, text=text, language=language)[0])
            rows.append({"text": text, "language": language, "words": words, "reason": reason})
    return rows


def main():
    if sys.argv[1] == "status":
        print(json.dumps(status(), ensure_ascii=False))
        return
    try:
        request = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
        with redirect_stdout(sys.stderr):
            result = run(request)
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

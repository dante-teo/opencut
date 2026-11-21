"""Run independent checks against the decoded comparison videos."""

import argparse
import json
import math
import subprocess
from pathlib import Path
from array import array

BASE = Path(__file__).resolve().parents[1] / "fixtures/generated/reference-motion"
SCENES = {
    "field-notes": ("FieldNotes", 1080, 1920, 900, [0, 45, 105, 164, 239, 240, 359, 360, 539, 540, 689, 899]),
    "prism": ("Prism", 1920, 1080, 600, [0, 9, 18, 30, 45, 89, 314, 315, 330, 344, 345, 599]),
    "waterline": ("Waterline", 1920, 1080, 600, [0, 50, 100, 180, 250, 300, 355, 390, 470, 599]),
    "signal": ("Signal", 1920, 1080, 450, [0, 14, 15, 44, 45, 75, 134, 135, 255, 449]),
    "relay": ("Relay", 1920, 1080, 300, [0, 24, 74, 148, 149, 150, 189, 224, 274, 299]),
    "parallax": ("Parallax", 1920, 1080, 300, [0, 30, 65, 100, 150, 200, 230, 265, 299]),
}


def run(tool, *args):
    return subprocess.check_output([tool, *map(str, args)])


def frames(path, width, height, count):
    signal = json.loads(run(
        "ffprobe", "-v", "error", "-select_streams", "v:0", "-show_streams",
        "-show_frames", "-show_entries", "stream=width,height:frame=best_effort_timestamp_time",
        "-of", "json", path))
    assert len(signal["frames"]) == count, (path, len(signal["frames"]), count)
    stream = signal["streams"][0]
    assert (stream["width"], stream["height"]) == (width, height), path
    for i, frame in enumerate(signal["frames"]):
        assert abs(float(frame["best_effort_timestamp_time"]) - i/30) <= 0.000001, (path, i)


def samples(path, indices, width=480, height=270):
    select = "+".join(f"eq(n\\,{i})" for i in indices)
    rgb = run("ffmpeg", "-v", "error", "-i", path, "-vf", f"select={select},scale={width}:{height}",
              "-an", "-fps_mode", "passthrough", "-pix_fmt", "rgb24", "-threads", "1",
              "-f", "rawvideo", "pipe:1")
    stride = width*height*3
    assert len(rgb) == stride*len(indices), (path, len(rgb))
    return [memoryview(rgb)[i*stride:(i+1)*stride] for i in range(len(indices))]


def signal_sync(path):
    pcm = array("f")
    pcm.frombytes(run("ffmpeg", "-v", "error", "-i", path, "-map", "0:a:0",
                      "-ar", 48000, "-ac", 1, "-f", "f32le", "pipe:1"))
    peaks = []
    for beat in (45, 135, 255):
        target = round(beat * 48000/30)
        index = max(range(target-480,target+481), key=lambda i: abs(pcm[i]))
        assert abs(pcm[index]) > 0.32, (path, beat, pcm[index])
        peaks.append(round((index - target) / 48, 3))
    return {"impulseOffsetMs": peaks}


def relay_motion(path):
    found = []
    for sample in samples(path, [149,150,224,299]):
        picked = []
        for y in range(20,204):
            for x in range(12,468):
                start = (y*480+x)*3
                r,g,b = sample[start:start+3]
                if r < 95 and g > 170 and b > 140 and g-r > 92:
                    picked.append((x,y))
        assert len(picked) > 20, (path, "Missing turquoise foreground beacon")
        found.append([round(sum(item[k] for item in picked)/len(picked),1) for k in range(2)])
    assert math.dist(found[0],found[1]) > 20, (path, found)
    return {"beaconCentroidsQuarterSize": found}


def bars(path):
    pixels = samples(path,[560])[0]
    tops = []
    for x in [91,173,256,338]:
        matches = []
        for y in range(66,194):
            base = (y*480+x)*3
            r,g,b = pixels[base:base+3]
            if g > 110 and b > 110 and g-r > 35:
                matches.append(y)
        assert matches, (path,x)
        tops.append(min(matches))
    expected = [(790-v*4.8)/4 for v in [24,45,72,90]]
    assert all(abs(a-b)<6 for a,b in zip(tops,expected)), (path,tops,expected)
    return {"barTopQuarterSize":tops}


def sheet(path, target, indices):
    select = "+".join(f"eq(n\\,{i})" for i in indices)
    run("ffmpeg","-v","error","-y","-i",path,"-vf",
        f"select={select},scale=320:-2,tile=4x{math.ceil(len(indices)/4)}","-frames:v",1,target)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--opencut", type=Path, default=BASE/"installed-outputs")
    parser.add_argument("scenes", nargs="*")
    args = parser.parse_args()
    for key in args.scenes or SCENES:
        if key not in SCENES:
            parser.error(f"Unknown scene {key!r}")
        name,w,h,count,indices = SCENES[key]
        paths = [BASE/"remotion"/(name+".mp4"),args.opencut/(key+".mp4")]
        findings = []
        for path in paths:
            frames(path,w,h,count)
            sheet(path,path.with_name(path.stem+"-review.png"),indices)
            finding = {"path":str(path),"frames":count}
            check = {"signal":signal_sync,"relay":relay_motion,"waterline":bars}.get(key)
            if check:
                finding.update(check(path))
            findings.append(finding)
        if key == "relay":
            a,b = [item["beaconCentroidsQuarterSize"] for item in findings]
            assert all(math.dist(x,y)<10 for x,y in zip(a,b)), (a,b)
        print(json.dumps({"scene":key,"results":findings}),flush=True)


if __name__ == "__main__":
    main()

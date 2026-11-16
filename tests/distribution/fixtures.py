"""Create controlled media with known cuts, timing and a UHD reference."""

import subprocess
import sys
from pathlib import Path


def generate(directory):
    directory.mkdir(parents=True, exist_ok=True)

    def encode(name, *args, video=True, crf=14):
        settings = (
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", str(crf),
            "-pix_fmt", "yuv420p", "-color_range", "tv",
            "-colorspace", "bt709", "-color_trc", "bt709",
            "-color_primaries", "bt709",
        ) if video else ("-c:a", "pcm_s16le")
        subprocess.run(
            ["ffmpeg", "-nostdin", "-v", "error", *args, *settings, directory / name],
            check=True,
        )

    encode("street.mp4", "-f", "lavfi", "-i", "testsrc2=s=360x640:r=24:d=2")
    encode("river.mp4", "-f", "lavfi", "-i", "testsrc2=s=360x640:r=24:d=2",
           "-vf", "hflip,hue=h=110")
    encode("music.wav", "-f", "lavfi", "-i",
           "aevalsrc='0.16*(sin(2*PI*220*t)+0.45*sin(2*PI*330*t))*"
           "(0.3+0.7*pow(cos(2*PI*t),8))':s=48000:d=4", video=False)

    # A smoothly moving block with a known hard cut and retained 48 fps truth.
    graph = (
        "color=c=0x163650:s=640x360:r=48:d=2[bg];"
        "color=c=0xe7c166:s=80x64:r=48:d=2[object];"
        "[bg][object]overlay=x='if(lt(t,1),32+320*t,560-320*(t-1))':"
        "y='if(lt(t,1),65,222)'"
    )
    encode("motion-reference.mp4", "-f", "lavfi", "-i", graph)
    encode("motion.mp4", "-i", directory / "motion-reference.mp4", "-vf", "fps=24")
    encode("sustained.mp4", "-stream_loop", "14", "-i", directory / "motion.mp4", "-t", "30")
    encode("uhd-reference.mp4", "-f", "lavfi", "-i", "testsrc2=s=3840x2160:r=12:d=1")
    encode("low.mp4", "-i", directory / "uhd-reference.mp4",
           "-vf", "scale=960:540:flags=area", crf=28)


if __name__ == "__main__":
    generate(Path(sys.argv[1]))

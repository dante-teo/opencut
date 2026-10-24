# Synthetic fixture contract

[manifest.json](manifest.json) is the machine-readable source of expected metadata.
Generated files live exclusively in `generated/` and are ignored by Git.

| File             | Duration | Resolution | FPS / frames | Audio                                  |
| ---------------- | -------- | ---------- | ------------ | -------------------------------------- |
| video-short.mp4  | 2 s      | 320 × 180  | 24 / 48      | none                                   |
| video-medium.mp4 | 3 s      | 640 × 360  | 30 / 90      | AAC, 48 kHz, mono, 1000 Hz pulses      |
| video-long.mp4   | 5 s      | 320 × 240  | 25 / 125     | AAC, 48 kHz, stereo, 440 Hz pulses     |
| audio-tone.wav   | 4 s      | —          | —            | PCM s16le, 48 kHz, stereo, 880 Hz tone |
| still.png        | —        | 640 × 360  | one image    | none                                   |

Videos are H.264/yuv420p moving test patterns. Their top-left 32 × 32 patch
flashes white for approximately the first 0.1 seconds of each second. Video
audio pulses use the same time rule, supporting later frame and A/V sync tests.
Audio volume changes occur at audio-frame boundaries; the marker is approximate,
not a sample-accurate synchronization reference. Inputs begin at timestamp zero.
These fixtures cover current media inspection/extraction and provide inputs for
future editing/render tests. They do not implement editing or rendering features.

## Generate and validate

Optional prerequisite: put `ffmpeg` (with libx264, AAC, PNG, PCM and lavfi) and
`ffprobe` on PATH. Install them manually through your preferred platform package
manager. The scripts never install or download them. Validation alone only needs
`ffprobe`. Tested with FFmpeg/ffprobe 9.0.

From the repository root:

```sh
pnpm fixtures:generate
pnpm fixtures:validate
```

Generation automatically validates all five outputs. Validation checks stream
counts, audio presence, codecs, dimensions, frame rate and decoded frame count, audio sample rate
and channels, duration (±0.1 seconds), and stream starts (±0.05 seconds).
Frame counts come from ffprobe decoding with `-count_frames`/`nb_read_frames`,
not the container header. Decoder errors also fail validation, even if ffprobe exits 0.
Missing files, unexpected metadata, or unavailable tools cause exit code 1.
The scripts work from any current directory when invoked by their workspace commands.

Run `pnpm test:fixtures` for the optional native regression test (FFmpeg + ffprobe).
It creates synthetic media in an OS temporary directory, verifies an intact video,
and rejects a truncated copy whose header still claims all frames exist. It cleans
up its temporary files without touching generated fixtures. Ordinary `pnpm test`
does not run this test or require native media tools.

Run `pnpm test:media` for optional T02 CLI probing and PNG extraction tests using
these existing fixtures. It requires all five generated files and FFmpeg/ffprobe,
checks metadata and timestamp-selected pixels, and removes only its own output
subdirectory under `generated/`. That subdirectory also holds derived MP4 inputs
whose video starts 5 seconds after audio, with zero and nonzero container starts,
to check input-relative timestamp handling. It is cleaned on success or failure.
The suite never regenerates or changes the five base fixtures.

The generator exclusively creates `generated/` and uses FFmpeg's no-overwrite
mode. It refuses an existing directory or symlink. On failure, it removes only
the output directory created by that invocation. To regenerate, review and
explicitly remove **only** `tests/fixtures/generated/` yourself, then rerun.
Do not place user media in this directory.

Parameters, content and expected metadata are reproducible. Single-threaded
encoding and bitexact flags reduce variability, but bytes are not guaranteed
identical across FFmpeg or codec versions. Pin your toolchain for checksum-based
tests. No generated binaries are required for `pnpm test`, build, or installation.

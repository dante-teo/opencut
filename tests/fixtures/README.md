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
These fixtures cover media inspection, extraction, rendering, and preview.

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

Run `pnpm test:media` with the five generated fixtures and FFmpeg/ffprobe. It
covers probing and extraction, TypeScript rendering, compositing,
audio and subtitle timing, preview recovery, and cancellation. Tests that
create derived media use and clean up their own subdirectories under
`generated/`.

Run `pnpm test:consistency` for the focused preview and export checks.
See [preview and export consistency](../../docs/PREVIEW_EXPORT_CONSISTENCY.md).

The generator exclusively creates `generated/` and uses FFmpeg's no-overwrite
mode. It refuses an existing directory or symlink. On failure, it removes only
the output directory created by that invocation. To regenerate, review and
explicitly remove **only** `tests/fixtures/generated/` yourself, then rerun.
Do not place user media in this directory.

Parameters, content and expected metadata are reproducible. Single-threaded
encoding and bitexact flags reduce variability, but bytes are not guaranteed
identical across FFmpeg or codec versions. Pin your toolchain for checksum-based
tests. No generated binaries are required for `pnpm test`, build, or installation.

## Beauty development fixtures

`bash tests/fixtures/prepare-beauty.sh` downloads pinned public footage into
`generated/beauty-dev` and extracts two-second, 640×360 excerpts for testing.
The script does not run during normal unit tests.

- `squat.webm` is by FitnessScape under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/).
  OpenCut trims and downscales it for the body-motion development fixture.
  The camera is fixed and the gym has equipment, straight lines and occlusions.
  [Source and attribution](https://commons.wikimedia.org/wiki/File:Squat_-_exercise_demonstration_video.webm)
- `interview.webm` is NASA Johnson's public-domain footage. OpenCut trims and
  downscales it for the face-motion development fixture. It includes speech,
  blinks, facial changes and a textured background.
  [Source and attribution](https://commons.wikimedia.org/wiki/File:T-60_Seconds_with_Jessica_Meir.webm)

`beauty-effects.py` synthesizes source pixels and known geometry, including a
known background with a protected line. It checks the direction of eye and
leg behavior, pixel changes for each control, protected areas, and background
recovery where the original background is available. It also checks that a
combined skin edit identifies an ineffective control and that a variable-rate
comparison keeps a long final frame in a selected excerpt. The native suite
checks runtime mismatch rejection and separate cache entries for different
worker budgets. Configure the [pinned beauty runtime](../../docs/BEAUTY.md#set-up-the-cpu-backend)
before running these checks. Run the fixture script separately with
`--held-out`, `--portrait-geometry`, and `--acceptance-corpus` to enable the
corresponding native cases.

```sh
pnpm build:packages
pnpm --filter @opencut/cli build
node --import tsx --test tests/integration/video-beauty.native.spec.ts
```

The footage above is the development set. Update a baseline only after
reviewing full-speed comparison clips and paired crops for the affected effect.
Record the source hash, parameter settings, model and worker hashes, quality
profile, measured changes and reviewer findings with the baseline revision.

Pass `--held-out` to prepare the two-second, 320×240 CDC half-squat
excerpt. This public-domain excerpt has partial visibility and textured
backgrounds. It remains the regression for strict coverage rejection.
[CDC source and attribution](https://commons.wikimedia.org/wiki/File:Muscle_Strengthening_at_Home_-_Half_squat.webm)

The same opt-in command prepares a separate wide CDC movement excerpt from
17.17 seconds for the arm and leg regression. The crop and covered timestamps
differ from the held-out excerpt at 61.8 seconds. The real-motion regression
checks positive measured head and limb response, valid geometry, and exact
preservation outside the measured influence region.

The command also prepares `held-out/full-body/source.mp4` from 0.6 seconds
of [Jumping jacks and burpees](https://commons.wikimedia.org/wiki/File:Jumping_jacks_and_burpees.webm)
by Taco Fleur. The source excerpt is muted and encoded as 54 frames at 24 fps.
The full-body excerpt and derived comparisons are licensed under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).

Use [the full-body definition](beauty-full-body.video.ts) with the source's
`analysisRef`. It requests head reduction, arm lengthening, and leg lengthening
over all 54 frames. Acceptance requires all three effects at their requested
strengths on every frame and an independent visual pass under the existing
quality profile. Set `diagnostic` to `true` to collect comparison evidence when
the default strict render rejects incomplete coverage.
The native regression requires a measured response from each control on all
54 frames and checks source timing and geometry bounds.
For the strict run with verified original context, analyze that same excerpt
with `--context-source held-out/full-body/jumping-jacks.webm --context-start 0.6`.
The regression requires the authored strengths on all 54 frames and exact
preservation outside the influence region.

Pass `--native-4k` to prepare two additional source-resolution motion fixtures
in the generated directory. The source files stay at their published
resolution and frame rate.

- `native-4k-motion/source.mp4` uses 2160×3840 footage at 25 fps for side
  profiles, moving hair, and background reconstruction. [Woman Doing Jumping
  Exercise by cottonbro studio](https://www.pexels.com/video/woman-doing-jumping-exercise-2785532/)
- `native-4k-pair/source.mp4` uses 3840×2160 footage at 25 fps for tracking and
  editing one of two people in a wide shot. The leg-length benchmark uses
  `legLength: 0.25` for the first 25 frames, with `visible-result` and a
  requested 4 GiB budget. Expect all 25 frames to meet the visibility floor
  and zero changed pixels in the other person's measured mask.
  [Couple Doing Exercise Together by
  Ketut Subiyanto](https://www.pexels.com/video/couple-doing-exercise-together-4859226/)

Pass `--acceptance-corpus` to prepare additional held-out portrait and
multi-person cases. Source checksums and excerpt settings are in
[prepare-beauty.sh](prepare-beauty.sh).

- The two portrait clips cover speech, smiles, blinks, makeup, and varied
  complexions. The seated speech excerpt supports strict skin and color
  coverage. The tight portrait reports a missing contour where the head
  leaves the frame and bypasses eye enlargement when the eyes close.
  [Smiling portrait by Monstera Production](https://www.pexels.com/video/a-close-up-shot-of-woman-smiling-in-the-camera-6693714/)
  and [seated speech by Alexander Suhorucov](https://www.pexels.com/video/a-woman-talking-and-doing-hand-gestures-6534947/).
- The dance excerpt covers partial visibility and a close embrace. Ambiguous
  intervals pause the edit. Tests can verify the remaining visible person
  stays unchanged. [Dance footage by Mikhail Nilov](https://www.pexels.com/video/two-ladies-dancing-and-hugging-each-other-8670603/).
- The walking clip covers entry, a crossing and reappearance. The
  [source-frame annotations](beauty-walking-anchors.json) identify the walkers
  before and after the overlap and provide explicit reattachment anchors.
  The regression checks zero changes on the unselected walker and explicit
  bypass on the annotated overlapping frames.
  [Walking footage by SHVETS production](https://www.pexels.com/video/men-walking-pass-each-other-9710752/).

Pass `--portrait-geometry` to prepare three more 60-frame clips for facial
geometry. The combined check requests `faceSlim: 0.15`, `headReduce: 0.12`,
and `eyeEnlarge: 0.10` on the first person throughout the clip.

- `glasses-source.mp4` covers glasses, beard, hat, and a moving face.
  The joint edit currently reports missing facial observations and reduced
  contour strength. [Studio portrait by A frame in motion](https://www.pexels.com/video/a-man-nodding-his-head-and-doing-facial-expressions-10515012/).
- `seated-source.mp4` contains a distant face in a seated portrait.
  The joint edit explicitly bypasses regions with inadequate observations.
  [Seated portrait by Thirdman](https://www.pexels.com/video/man-looking-at-camera-8057123/).
- `brick-source.mp4` covers speech, hand movement, and straight background
  lines. The joint edit currently reports contour attenuation. Eye enlargement
  alone at 0.10 achieves complete coverage and preserves the measured pixels
  outside the influence region.
  [Brick-wall portrait by Andres Ayrton](https://www.pexels.com/video/a-man-talking-while-looking-at-the-camera-6548010/).

The same command prepares `studio-source.mp4`, a 45-frame studio portrait
with full headroom, a moving expression, and an earring. Analyze the excerpt
with `--context-source studio-context.mp4 --context-start 4.8`. Apply
`faceSlim: 0.32`, `headReduce: 0.28`, and `eyeEnlarge: 0.10` on the first
person. Expect measurable face and head response on all frames and passing
`visible-result` coverage. The independent playback check has its own gate.
[Studio portrait by Pavel Danilyuk](https://www.pexels.com/video/woman-smiling-and-looking-at-camera-7812511/).

Pass `--vertical-performance` to prepare `native-4k-stance/vertical-grounded/source.mp4`.
The downloaded source is 1440×2560 at 25 fps. The excerpt retains the moving
subject and both feet over a deck and ocean horizon. The benchmark requests
`legLength: 0.25` on the first person for the full second with
`--recipe-memory-bytes 4294967296`. Expect all 25 frames to pass
`visible-result`, with attenuation reported. `complete-coverage` rejects
the attenuation. The side-by-side comparison retains all 25 frames and a
one-second duration. [Exercise footage by Pavel Danilyuk](https://www.pexels.com/video/a-man-doing-a-leg-exercise-8859851/).

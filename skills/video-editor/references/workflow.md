# Complete CLI editing workflow

Run from an installed OpenCut checkout using Node 24.12+ (24.x), pnpm 11.20.0,
and manually installed FFmpeg 8+ / ffprobe on PATH with libx264, AAC and PNG support.
No Electron window is needed. All edits below use the public CLI; do not write
project JSON or call core APIs to construct the edit.

## One-command reproduction

```sh
pnpm e2e --keep
# Automated repeatability check (two complete runs; per-run artifacts cleaned):
pnpm test:e2e
```

Both commands build the headless packages and CLI. The workflow reuses the five
synthetic fixtures and their existing generator/validator. When
`tests/fixtures/generated/` is absent it generates the fixtures automatically;
an existing directory must already contain a valid complete fixture set. It never
overwrites fixtures. Follow the [fixture contract](../../../tests/fixtures/README.md)
if an existing set needs explicit regeneration.

Each invocation creates an exclusively owned `tests/fixtures/generated/t14-e2e-*`
directory. Without `--keep`, the workflow cleans that directory on success or
failure. `--keep` preserves successful runs only: `final.mp4`, the saved project,
seven representative PNGs, `verification.json` and `cli-transcript.json`. The
stdout JSON reports absolute paths and measurements. Retained projects reference
the fixtures in their parent directory; keep those sources available when reopening.
Remove only the particular owned run directory when done, not the shared fixtures.

The automated runner launches the workflow twice with fresh projects, checks
successful independent verification, requires identical MP4 SHA-256 hashes with
the same fixtures/toolchain, and ensures neither run leaks artifacts. Encoder
versions may produce different bytes across machines.
The ordinary `pnpm test` suite remains independent of native media prerequisites.

## Edit recipe

The sequence is 320×180 at 30/1 fps, exactly 540 frames / 18 seconds. CLI `--at`,
`--in`, `--out` and split positions are integer **project-frame indices**. Out is
exclusive. Source ranges are measured at the project rate even for 25 fps input.

| Layer              | Timeline frames (seconds)                 | Source frames    | Settings                              |
| ------------------ | ----------------------------------------- | ---------------- | ------------------------------------- |
| Main: medium left  | 0–30 (0–1)                                | 15–45            | Original audio gain 0.6               |
| Canvas gap         | 30–60 (1–2)                               | —                | Background #123048; music continues   |
| Main: medium right | 60–90 (2–3)                               | 45–75            | Original audio gain 0.6               |
| Main: long         | 90–240 (3–8)                              | 0–150            | Stretch, scale 0.5, x=-40; audio 0.6  |
| Main: long         | 240–390 (8–13)                            | 0–150            | Default contain; audio 0.6            |
| Main: long         | 390–540 (13–18)                           | 0–150            | Default contain; audio 0.6            |
| Image overlay      | 120–180 (4–6)                             | 0–60             | Stretch, scale 0.5, x=40, opacity 0.5 |
| Music              | 0–120, 120–240, 240–360, 360–480, 480–540 | Each starts at 0 | Linear gain 0.25                      |

The music uses the synthetic 880 Hz tone, standing in for background music. There
is no automatic music looping in saved-project rendering: add each segment
explicitly. The synthetic videos provide pulsed 1000/440 Hz original audio so the
mix and silent intervals can be measured reliably. Later video tracks draw on top.

The following Bash commands reproduce the same edit after fixtures exist and the
CLI has been built (`pnpm build:packages && pnpm --filter @opencut/cli build`).
`field` reads a single JSON result; render stdout is JSONL and is handled separately.
`pipefail` ensures a failed CLI command stops the recipe before its output is used.
All destinations are new, and source files are read only.

```bash
set -euo pipefail
CLI="$PWD/apps/cli/dist/index.js"
FIX="$PWD/tests/fixtures/generated"
RUN=$(mktemp -d "$FIX/t14-manual-XXXXXX")
PROJECT="$RUN/project.opencut.json"
cli() { node "$CLI" "$@" --json; }
field() {
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    let value = JSON.parse(readFileSync(0, "utf8"));
    for (const key of process.argv[1].split(".")) value = value[key];
    if (value === undefined) throw new Error("Missing result field");
    console.log(value);
  ' "$1"
}
cli project create "$PROJECT" --name "T14 CLI end-to-end" --width 320 --height 180 --fps 30
MEDIUM=$(cli media import "$PROJECT" "$FIX/video-medium.mp4" | field asset.id)
LONG=$(cli media import "$PROJECT" "$FIX/video-long.mp4" | field asset.id)
MUSIC=$(cli media import "$PROJECT" "$FIX/audio-tone.wav" | field asset.id)
IMAGE=$(cli media import "$PROJECT" "$FIX/still.png" | field asset.id)
cli media list "$PROJECT"
VIDEO=$(cli track add "$PROJECT" --type video --name "Main video" | field track.id)
OVERLAY=$(cli track add "$PROJECT" --type video --name "Image overlay" | field track.id)
AUDIO=$(cli track add "$PROJECT" --type audio --name "Background music" | field track.id)
cli canvas set "$PROJECT" --background-color '#123048'
OPENING=$(cli clip add "$PROJECT" "$MEDIUM" --track "$VIDEO" --at 0 --in 0 --out 90 --volume 0.6 | field clip.id)
cli clip trim "$PROJECT" "$OPENING" --in 15 --out 75
RIGHT=$(cli clip split "$PROJECT" "$OPENING" --at 30 | field right.id)
cli clip move "$PROJECT" "$RIGHT" --at 60
SCALED=$(cli clip add "$PROJECT" "$LONG" --track "$VIDEO" --at 90 --in 0 --out 150 --volume 0.6 | field clip.id)
cli clip visual "$PROJECT" "$SCALED" --fit stretch --scale 0.5 --x=-40
for AT in 240 390; do
  cli clip add "$PROJECT" "$LONG" --track "$VIDEO" --at "$AT" --in 0 --out 150 --volume 0.6
done
LAYER=$(cli clip add "$PROJECT" "$IMAGE" --track "$OVERLAY" --at 120 --in 0 --out 60 --fit stretch --scale 0.5 --x 40 --opacity 0.5 | field clip.id)
for AT in 0 120 240 360; do
  cli clip add "$PROJECT" "$MUSIC" --track "$AUDIO" --at "$AT" --in 0 --out 120 --volume 0.25
done
cli clip add "$PROJECT" "$MUSIC" --track "$AUDIO" --at 480 --in 0 --out 60 --volume 0.25
cli timeline list "$PROJECT"

# Preview without saving, then test persisted undo/redo in fresh processes.
REV=$(cli edit history "$PROJECT" | field revision)
cli clip visual "$PROJECT" "$LAYER" --opacity 0.8 --dry-run --expected-revision "$REV"
cli clip visual "$PROJECT" "$LAYER" --opacity 0.8 --expected-revision "$REV"
REV=$(cli edit history "$PROJECT" | field revision)
cli edit undo "$PROJECT" --expected-revision "$REV"
# A no-op preserves the redo branch.
cli clip move "$PROJECT" "$OPENING" --at 0
REV=$(cli edit history "$PROJECT" | field revision)
cli edit redo "$PROJECT" --expected-revision "$REV"
# Restore the intended half-opacity overlay before exporting.
REV=$(cli edit history "$PROJECT" | field revision)
cli edit undo "$PROJECT" --expected-revision "$REV"
cli timeline list "$PROJECT"
cli project validate "$PROJECT"
cli project info "$PROJECT"
cli project render "$PROJECT" --output "$RUN/final.mp4" --quality balanced > "$RUN/render.jsonl"
# Require exit 0 above AND a completed terminal event.
node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const last = JSON.parse(readFileSync(process.argv[1], "utf8").trim().split("\n").at(-1));
  if (last.event !== "completed" || last.frameCount !== 540) throw new Error("Incomplete render");
' "$RUN/render.jsonl"
ffprobe -v error -count_frames -show_streams -show_format -of json "$RUN/final.mp4"
ffmpeg -v error -nostdin -xerror -i "$RUN/final.mp4" -map 0:v:0 -map 0:a:0 -f null -
for FRAME in 15 45 75 105 135 195 525; do
  TIME=$(node -e 'console.log(Number(process.argv[1])/30)' "$FRAME")
  cli extract-frame "$RUN/final.mp4" --timestamp "$TIME" --output "$RUN/frame-$FRAME.png"
done
printf 'Output: %s\n' "$RUN/final.mp4"
```

## Photo slideshows and vertical edits

The same commands support image-only projects. A 20-second portrait edit at
720×1280 and 30/1 fps ends at project frame **600**. Create that canvas with
`project create PROJECT --name "Photo story" --width 720 --height 1280 --fps 30 --json`.
Import the photos and add video tracks as in the recipe above. For four five-second
photos on one track, use starts 0, 150, 300 and 450, each with `--in 0 --out 150`:

```sh
node apps/cli/dist/index.js clip add PROJECT PHOTO_ASSET_ID --track PHOTO_TRACK_ID --at 0 --in 0 --out 150 --fit contain --json
```

Use `contain` to show the full photo; `cover` crops to fill the canvas. Image
in/out points specify display duration, so static images do not need a source
video duration. The final clip end across all tracks determines output length;
ensure overlays and music also end by frame 600. Validate, render, require a
`completed` event with 600 frames, probe the MP4, and inspect representative PNGs.

Simultaneous collage images need separate video tracks because same-track overlaps
are forbidden. Later video tracks draw above earlier ones. Position and scale each
photo through `clip visual` or the same options on `clip add`; negative offsets
must use the equals form, such as `--x=-170 --y=-148`. Individual scale/position
changes are static per clip. Adjacent clips with different transforms create
stepped zoom cuts; they are not continuous motion or keyframe animation.

Caption cards are imported PNG assets on video tracks; the CLI has no native text
creation command. Music and sound effects are imported audio files, not generated
by the CLI. Preparing graphics/audio and creating or cleaning workspace directories
are external asset/workspace operations. When a task requires strictly CLI-only
work, use existing assets instead of claiming those preparation steps as CLI features.

Keep personal-photo projects in their own workspace, outside
`tests/fixtures/generated/`. Import references source files without modifying them.
If working copies are wanted, create them explicitly before import; copying is not
an implicit CLI import step. A saved project references its assets rather than
embedding them, so retain those assets when continued editing is required. A
completed MP4 is self-contained. When cleanup is requested, remove only the task's
owned files and the deliverables the user wants discarded; never remove imported
originals as a consequence of deleting a project. Final videos and storyboards
may also be discarded when requested.

## Screen recordings and personal footage

Keep these projects in a dedicated workspace outside the synthetic fixture tree,
using the asset-preservation rules above. Review samples across the full recording
before selecting shots, then inspect candidate ranges through their starts and
ends. Choose distinct scenes, locations and actions from the usable footage;
avoid concentrating on one convenient section or repeating the same shot unless
the brief calls for it. Check for browser chrome, player controls and cuts inside
otherwise usable ranges.

A screen recording can contain a sideways picture baked into its pixels even
when rotation metadata is zero. OpenCut applies source rotation metadata, but
its clip controls do not rotate baked-in content or provide an arbitrary crop
rectangle. If needed, explicitly prepare upright, reframed working masters with
external media tools, preserving the original recording unchanged. Import those
masters as editing assets and retain them with the project. They are intentional
source edits, separate from preview proxies, which remain preview-only. Preparing
caption graphics and audio also happens outside OpenCut, as described above.

Review framing separately for each output aspect ratio. Check the start, middle
and end of every shot for clipped faces, lost headroom and subject movement out
of the crop, with caption overlays visible. Position and scale are static per
clip; there is no automatic subject tracking or keyframe animation.

Use the verification steps below for each final version. Project validation
checks structure and file availability, not decoding or visual quality. Inspect
the actual exported frames and play the MP4; when delivering an editable desktop
project, also open it in Electron and check Project viewer, including later cuts
and the ending. Report export verification and desktop playback checks separately.

## Verification and adaptation

For the 18-second fixture recipe, require H.264 video at 320×180 and 30/1 fps,
with 540 readable frames and 18-second video, audio and container durations
(within 2 ms). Audio must be AAC, 48 kHz stereo, starting at zero. Full decode
must succeed without error-level diagnostics.
The representative frames show trimmed opening (0.5 s), the canvas gap (1.5 s),
the moved split (2.5 s), scaling (3.5 s), half-opacity overlay (4.5 s), its removal
(6.5 s), and the final arranged clip (17.5 s).

`pnpm e2e` additionally compares decoded pixel regions against source frames,
checks opacity blending and background placement, measures mixed and absent audio
tone amplitudes at the intended gains around the gaps and music joins, verifies exact persisted source/timeline
ranges, guards revision changes, and checks project bytes remain unchanged during
export/extraction. It rejects an overlapping edit without saving, checks dry-run
byte preservation, and hashes all source fixtures before/after. The CLI transcript
records each process, arguments, exit status and output. Inspect the actual PNGs
and play the MP4 when adapting to human footage; metadata alone is insufficient.

For other assets, probe/import first and use returned IDs; choose source ranges
within known duration. Use explicit frame ranges for stills. Read history and
timeline again after mutations rather than assuming revision fields exist on
individual edit results. `project render --json` emits one event per line;
other commands return a single JSON document. See [the CLI contract](cli.md)
for error exits, render limits, cancellation and safe output replacement.

This is headless validation with synthetic fixtures on the current host. It does
not establish GUI timeline support, perceptual quality for arbitrary media,
cross-platform support, fades/transitions or automatic music looping.

# OpenCut CLI

`opencut --help` lists the primary commands. From a checkout use
`node apps/cli/dist/index.js` after `pnpm build:packages` and
`pnpm --filter @opencut/cli build`. FFmpeg and ffprobe are required for
rendering media. See [Install OpenCut](INSTALL.md).

```sh
opencut validate edit.video.ts
opencut inspect edit.video.ts --json
opencut timeline inspect edit.video.ts --frame 60 --json
opencut preview edit.video.ts --watch
opencut preview frame edit.video.ts --frame 60 --output review.png
opencut render edit.video.ts --output final.mp4
opencut subtitles export edit.video.ts --output captions.srt
```

Use `opencut render --help` for quality, resolution, codec, frame rate and
audio settings. Outputs are new files unless a supported render explicitly
requests `--overwrite`. OpenCut protects source files and their aliases,
including when picture is cached. Use `--json` for machine output and SIGINT
or SIGTERM to cancel foreground work. Render runs in the CLI with FFmpeg
subprocesses.

## Encoder selection and render progress

```sh
opencut render edit.video.ts --output portrait.mp4 --width 2160 --height 3840 --fps 60 --codec hevc --encoder auto --json > portrait.render.json
opencut render edit.video.ts --output hardware.mp4 --codec hevc --encoder videotoolbox
```

Omit `--encoder` to keep the default software encoder. With `auto`,
OpenCut probes a VideoToolbox session for the requested codec, dimensions
and frame rate and probes software if the hardware check fails.
`videotoolbox` requires a successful hardware session. An explicit
`software` request also checks the exact configuration. A failure during
the full encode is reported as a render failure. Hardware uses bitrate
control, either the supplied `--video-bitrate` or a target derived from
quality, delivery dimensions and frame rate. Software uses the profile's
preset and CRF unless a bitrate is supplied.

In the render result, `encoder.requested` is the selection policy,
`encoder.selected` is the backend and `encoder.name` is the FFmpeg encoder.
`encoder.settings` reports the effective pixel format, rate control and
backend options. `encoder.fallbackReason` is present when automatic
selection uses software after a hardware probe failure. The encoder name
and effective settings participate in encoded picture identity.

The final `render --json` result goes to stdout. Stderr emits JSON lines
with `event: "progress"`. Recipe events carry `stage: "recipe"` plus the
asset, step and status. Renderer events carry `stage` values `graphics`,
`composition`, `audio-analysis`, `audio-mastering`, `encoding`, `muxing`
and `verification`, alongside `phase`,
`processedFrames`, `totalFrames`, `percent`, `elapsedSeconds` and
`remainingSeconds`. Frame counts, percentages and elapsed time apply to
the current stage. Audio analysis, mastering and verification can each
start at 0% and finish at 100%. Graphics capture and analysis for a graphic
include a `clipId`. Graphics events distinguish `browser-capture`,
`graphic-rasterization`, and `intermediate-writing`. Capture events report
how many frames have completed and how many came from the graphics cache
or a reused hold. On cancellation the render emits
`{"event":"render-status","status":"cancelled"}`. Composition and encoding
can overlap in direct exports. Treat each elapsed time as its own clock.
When an export reuses a saved picture version, `muxing` tracks copying the
encoded picture into the new MP4. Wait for the command to succeed and return
its final JSON before using the output. Use an external clock to measure
the full command. Stderr can also contain other diagnostics.

## Frame-targeted contact sheets

```sh
opencut preview contact-sheet edit.video.ts --frames 59,60 --timestamps 3/2 --retry-source-change --output edit-qa.png
opencut render edit.video.ts --output final.mp4 --picture-cache ./render-cache --json > final.render.json
opencut preview contact-sheet final.mp4 --render-report final.render.json --around cuts,captions,picture --from 55 --to 75 --output export-qa.png
opencut preview contact-sheet final.mp4 --definition edit.video.ts --frames 59,60 --output decoded-qa.png
```

Frames are zero-based. Timestamps accept seconds, fractions or clock
times. Use `--around` to sample the predecessor and the first frame at or
after each clip start or end, caption start or end, or reported internal
picture boundary. The render report's `pictureRanges` supplies the internal
boundaries for `picture`. Picture-cache renders and local picture revisions
report these ranges.

For MP4 cuts and captions, use a report with `contactTimeline` or pass
`--definition` with the definition revision and parameters used for export.
`contactTimeline` contains `frameRate`, `clips` and `captions` with their IDs
and rational start and end times. When both options are supplied, the
definition supplies clip and caption timing and the report supplies picture
ranges. OpenCut evaluates the definition for this timing and decodes the
supplied MP4 directly.

MP4 input with `--render-report` requires the `outputFingerprint.bytes` and
`outputFingerprint.sha256` fields from `render --json`. A byte-identical copy
passes the check. For an older report missing those fields, use `--definition`
for cut and caption timing, or save a fresh report with a new export to
include picture boundaries.

`--from` and `--to` constrain the half-open range in input frame indices.
An explicit request outside the range or duration fails. Automatic requests
outside the range are skipped. Up to 16 unique frames are allowed.
Requests resolving to the same frame share one tile and retain distinct
reasons. Without targeted options the command samples evenly, using
`--count` if supplied. Columns default to at most four and the tile size
defaults to a 320-pixel long side.

MP4 indexing uses decoded presentation order and each frame's actual PTS.
Timestamp zero denotes the first video frame. An explicit timestamp selects
the last frame at or before that time, including for variable-frame-rate
exports. When timestamps tie, the last frame at that timestamp covers it.
For MP4s, cut and caption boundaries are first rounded up to the project
frame grid. Sampling then uses the first decoded frame at or after that
boundary and its predecessor. The final frame covers its declared duration,
with an average-frame-step fallback when frame duration is unavailable.

The command writes `<output>.json` and prints the same manifest to stdout.
`input` identifies the inspected source. Each sample has its actual `frame`
and rational `time`, its cell `x` and `y`, and a `requests` array. Each request
records its `reason` and either `requestedFrame` or `requestedTime`.
Boundary requests preserve the original timeline time and include `side`
and `adjacentClipIds` when known. With timeline context, each sample has
`clipIds` for its actual frame. An MP4 manifest also gives the average
stream rate in `frameRateRatio`, the `timeBase`, `firstPts` and each sample's
original `pts`. Its `input.fingerprint` contains the byte count and SHA-256
of the inspected MP4. Samples are sorted by actual frame index.

## Layout assertions

Declare `layoutAssertions` in a video definition and run
`opencut validate edit.video.ts --json` before rendering. The render command
checks the same requirements before encoding.

`layout.checks` reports the `assertionId`, `objectId`, worst zero-based
project `frame` and `framesChecked` for each resolved segment. Bounds use
`left`, `top`, `right` and `bottom`. Bounds, `tolerancePixels` and
`deviationPixels` use project pixels. A failed check with no measurable
deviation uses `deviationPixels: null` and includes a `reason`.

A required failure exits with status 1. `validate --json` still writes the
result to stdout with `ok: false`. `render --json` writes
`LAYOUT_ASSERTION_FAILED` and the layout results to stderr. Advisory
failures appear in the JSON report and allow rendering to continue.
See [assertion kinds and examples](VIDEO_DEFINITIONS.md#layout-assertions).

## Read-only render plan

```sh
opencut render plan edit.video.ts --output portrait.mp4 --recipe-cache ./recipes --picture-cache ./render-cache --json
```

Use the intended render options and parameters, including `--overwrite` when
planning to replace an existing delivery. Planning uses the same authored-input
protection as rendering. The plan reads current recipes and cache receipts,
checks required FFmpeg encoders and prints JSON. It does not create
build receipts, cache files or an export. As with other definition commands,
the TypeScript definition and its imports are trusted executable code.

`recipes` lists referenced asset steps by zero-based step index.
`pictureRanges` uses half-open intervals on the project frame grid.
Both report `status: 'reuse' | 'rebuild'` and a `reason`. A
`verified-cache-entry` matched a current cache artifact. A
`scheduled-earlier-range` will reuse an entry built earlier in the same
render. Miss reasons distinguish an absent key, an invalid entry, and an
upstream recipe artifact whose output is needed to know the exact key.
The planner estimates affected range boundaries using declared recipe output
metadata until the output exists. Unaffected ranges use the renderer's exact
keys.

With `--picture-version`, inspect `savedPicture` for the decision on the
encoded picture. A blocked version produces a plan with `ok: false` and
exits with status 1. Reusing all picture ranges or a saved encoded picture
requires no FFV1 encoding.

`storage` reports estimated peak scratch bytes, its component estimates,
and current available bytes on the filesystems for the requested output
and caches. If a cache directory does not yet exist, free space comes from
the nearest existing ancestor. Compression, cloning, and overlap between
render stages affect actual usage.

## Read-only dependency inventory

```sh
opencut inspect dependencies edit.video.ts --json
opencut inspect dependencies edit.video.ts --recipe-cache ./recipes --artifact-root ./render-cache --artifact-root ./exports --render-report portrait.render.json --json
```

The command evaluates the trusted TypeScript definition and its imports.
It reads declared assets and fonts, local modules reached by evaluation
(including Node `#` aliases that resolve to local files), and dependencies
discovered by the React graphics bundler. It creates no
builds, renders or cache entries. Arbitrary paths computed or read inside
authoring code cannot be inferred unless the code returns them as
declared dependencies. Use `--params` to inspect a specific variant.

`files` reports `relativePath` and any alias `paths` relative to the
definition directory, the physical `resolvedPath`, `bytes` for regular
files, and a `status` of `present`, `missing` or `not-file`.
`roles` includes every known role and `references` reports each role,
its owner and whether it is directly declared or discovered transitively.
`diagnostics` reports dependency discovery failures with their reference
owners. A missing local module that prevents evaluation yields a partial
inventory with `definitionEvaluated: false`.

Build receipts under the default recipe cache or `--recipe-cache` identify
historical cache payloads and published exports for the definition.
`--render-report` adds an export reference from a saved render result.
An `export` role means the current file matched a recorded fingerprint.
Missing, replaced, or otherwise unverifiable files are marked
`unverified-export` for that reference.
Repeat `--artifact-root` to inventory other directories and recognize
OpenCut cache receipts and their payloads. Payloads must match their
recorded byte count and SHA-256 before they qualify as regenerable.
Files without known provenance are `unclassified`. The scan leaves cache
and project files untouched.
Each file has a `classification` and a `regenerable` flag. `byteTotals`
reports logical sizes by classification across resolved paths. Deliveries
and unclassified files have their own totals alongside regenerable cache
artifacts and other dependencies.

## Post-export verification

```sh
opencut verify export final.mp4 --against approved-preview.mp4 \
  --render-report final.render.json --frames 59,60 \
  --audio-master approved-master.mp4 --output final-verification
```

Supply an approved MP4 preview on the same frame grid as the export.
OpenCut checks decoded frame counts and presentation timestamps, including
the first video frame on each MP4's presentation clock. It then
compares the same zero-based frame indices at a common tile size. Use
`--frames` to select specific samples. By default, the command selects up
to eight evenly spaced frames. A fingerprinted render result adds samples
immediately before and at its internal clip, caption and picture-range
boundaries. Use `--boundaries 120,300` to add specific delivery boundaries.
If delivery uses `--fps`, render the approval copy at that same rate.

The new directory contains `report.json` and one side-by-side PNG per sample,
with the approved preview on the left. The same JSON is printed to stdout.
`timing` reports both start times in seconds. `firstTimingMismatch` marks
the first frame whose presentation timestamps differ by more than the
reported tolerance.
`--luma-tolerance` controls mean absolute per-frame luma error.
`--boundary-tolerance` controls the largest difference between the preview
and export's before-to-after luma change over an 8×8 grid. Both default to
4 on a 0–255 scale. Use `--size` to set the longest tile dimension (64–640).

For a picture-only revision, `--audio-master` compares the ordered SHA-256
hashes of each track's encoded audio packet payloads. Container tags and
packet timestamps do not affect this comparison. The picture timing and
audio payload results are reported independently. Failed checks still publish
the report and return status 1.

## Reuse picture between exports

```sh
opencut render edit.video.ts --picture-cache ./render-cache -o first.mp4
# Edit the definition, then pass the same cache directory.
opencut render edit.video.ts --picture-cache ./render-cache -o revision.mp4
```

The picture cache uses the FFV1 encoder in FFmpeg to store lossless composited
picture in color-tagged Matroska on the project frame grid. Shots, overlays, subtitles and transitions
set the range boundaries. A range can move to a different timeline frame and
reuse its picture if its source samples and visual layers stay the same.
Edits to visual sources, framing, grades, captions and transitions rebuild
the ranges they affect. Audio edits reuse picture for ranges that are
independent of the changed audio. Ranges with [audio-dependent graphics](GRAPHICS.md#audio-dependent-graphics)
rebuild when their analysis inputs change. With Professional Dialogue Mix
enabled, mixed-source graphics also depend on `--audio-channels`,
`--audio-rate`, and `--audio-bitrate`. Each export mixes audio on the
current timeline and encodes an MP4 at the requested output frame rate.
The [recipe cache](#media-recipes) stores upstream processing such as frame
interpolation.

Render prints `Picture [start, end): reused` or `rendered` for each range.
With `--json`, `pictureRanges` contains `startFrame`, `endFrame` and `status`.
Reports include `pictureFrameRate` and `pictureStartFrame` whenever ranges
are present, including bounded rendering without a persistent cache. Ranges
use zero-based project frames with an exclusive end.

Use a private local cache directory with room for lossless video. Cache files
are kept under `picture-v1` until removed. Stop active renders before clearing
the cache. The first render can take longer while it populates the cache.
For eligible MP4 and MOV footage, cache misses can seek into the source.
OpenCut falls back to sequential decoding when a seek cannot preserve frame
selection.

### Audio-only revisions

Use a saved picture version when you plan to keep the picture cache. Keep
the render JSON and the absolute path to that cache. You can also keep the
MP4 with its render report by [capturing revision evidence](#replace-audio-using-an-existing-export).

```sh
cache="$PWD/render-cache"
opencut render edit.video.ts -o approved.mp4 --picture-cache "$cache" \
  --picture-version save --json > approved.render.json
```

After revising music, effects or dialogue, read `pictureVersion.id` from the
report. Plan the new export with the same cache and video settings.

```sh
id=$(jq -er '.pictureVersion.id' approved.render.json)
opencut render plan edit.video.ts -o revised.mp4 --picture-cache "$cache" \
  --picture-version "$id" --json > revision.plan.json &&
opencut render edit.video.ts -o revised.mp4 --picture-cache "$cache" \
  --picture-version "$id" --json > revised.render.json
```

A successful plan reports `savedPicture.status: "reuse"`. The render copies
the verified video packets, mixes new audio, and reports
`pictureVersion.status: "reused"`. To compare the encoded video payloads,
run the same packet hash command for each MP4 and compare the SHA-256 values.

```sh
ffmpeg -v error -i approved.mp4 -map 0:v:0 -c:v copy -f hash -hash sha256 -
ffmpeg -v error -i revised.mp4 -map 0:v:0 -c:v copy -f hash -hash sha256 -
```

If the plan reports `savedPicture.status: "blocked"`, inspect its reason.
For a missing or invalid entry, restore the original cache or plan and
render with `--picture-version save`, then keep the new ID. Use
`--picture-version save` after changes to burned-in subtitles, audio-driven
graphics, other visual layers, or video export settings. Check
`pictureRanges` in the new plan for the lossless ranges that can still be
reused. The new encoded picture covers the whole export.

### Local picture revisions

Keep the approved MP4 and the JSON from the same `render --revision-evidence`
command. The revision inherits its delivery settings from that report.
Set the frame rate in the definition and leave `--fps` unset when rendering
the baseline for a local picture revision. An optional
`--keyframe-interval <frames>` on a full render sets the maximum distance
between keyframes. Software encoders use closed groups at the chosen
interval, which gives later edits more independent starting points.

```sh
opencut render edit.video.ts -o approved.mp4 --revision-evidence --json > approved.render.json
opencut render revised.video.ts -o revised.mp4 --picture-from approved.mp4 \
  --render-report approved.render.json --preflight --json
opencut render revised.video.ts -o revised.mp4 --picture-from approved.mp4 \
  --render-report approved.render.json --json > revised.render.json
opencut preview contact-sheet revised.mp4 --render-report revised.render.json \
  --around cuts,captions,picture --from 350 --to 645 --output revision-qa.png
```

Preflight is read-only. It shows the changed frames, the expanded ranges
to encode, the baseline ranges eligible for packet copy, the estimated
bytes reused, and the audio decision. `checks` lists the checks that
passed, failed, or were skipped. `pendingChecks` lists what still needs
the actual encoded or copied segments, joined picture, and final delivery.
`eligible` means OpenCut can attempt the revision. Ranges are half-open.
The preflight uses existing recipe cache entries. Run without `--preflight`
to process missing recipes. An equivalent mix keeps the approved AAC packets.
A changed mix runs through the normal audio renderer and alignment check.
Preflight checks rendered text as well as authored text. A font fallback
can change the rendered pixels, and a report that predates text raster
evidence can require those ranges to be encoded again during a picture edit.
The result includes decoded checksums on either side of each join.
Use its report with `preview contact-sheet` to sample cuts, captions, and
splice joins in the exported MP4. Set `--from` and `--to` around the part
of your export you want to check.

#### Recover from a failed revision

A blocked preflight reports `status: "blocked"` and lists the reasons. With
`--json`, a failure during rendering reports `event: "picture-revision-failed"`
and includes the original preflight results. Both exit with status 1.

For a timestamp failure, read `timing.stage` to see whether the error
occurred in a `segment`, at the `join`, or during `delivery`, including
when OpenCut renders new audio. `timing.frame` is the zero-based frame in
the full timeline. `timing.segment`, when present, gives the affected
half-open frame range. `timing.timestamp` gives the expected and measured
values and their units. A segment's timestamps are relative to that segment.

The `fallback` field contains a full-render command. If you saved the JSON
from the failed render above, print the command from it.

```sh
jq -r '.fallback' revised.render.json
```

Run the printed command from the same working directory so relative input
paths still resolve. It carries over the project options and any settings
available from the baseline report. If the requested MP4 path is occupied,
including by a dangling symlink, the command selects a new path beside it.
If the failed command used `--json`, the fallback includes
`--revision-evidence`. Save its output to a fresh report file and keep it
with the MP4 named in the report's `path` field for the next revision.

### Vertical 4K60 delivery

Copy [vertical-4k60.video.ts](../examples/video/vertical-4k60.video.ts) into
your project. Save the inputs in `vertical.params.json`. Media paths are
relative to the definition. This example uses 600 frames for 10 seconds,
and shows a step card from two to four seconds.

```json
{
  "picture": "edited-reel.mp4",
  "frames": 600,
  "stepCards": [{ "at": 120, "duration": 120, "text": "Step 1 · Prep" }]
}
```

The definition sets the 2160 × 3840 canvas and the 60 fps frame grid. Add
`"soundtrack": "mixed.wav"` to use an externally edited soundtrack that
starts with the picture and covers the same duration. OpenCut uses the
video's embedded audio when `soundtrack` is omitted.

```sh
opencut render vertical-4k60.video.ts --params vertical.params.json \
  --output vertical.mp4 --codec hevc --encoder software --keyframe-interval 120 \
  --revision-evidence --json > vertical.render.json
```

## React and SVG graphics

Register and place React/Anime.js clips in the `.video.ts` project by editing
its `assets` and `tracks`. Set declared asset `props` as parameter defaults
and override them on individual clips. See the
[Anime.js authoring and rendering workflow](GRAPHICS.md#animejs-motion-graphics).

Use `timeline edit-graphic` to apply a data-only edit and write a new
definition beside the original. The new definition resolves the selected
`--params` variant and keeps the TSX and media paths editable. Choose a
filename that is available in the same directory.

For a local copy of the [Tideline example](../examples/motion/tideline/tideline.video.ts),
save this as `graphic-edit.json` to split the overlay at project frame 154.

```json
{ "operation": "split", "clip": "tideline-overlay", "at": 154 }
```

```sh
opencut timeline edit-graphic tideline.video.ts --edit graphic-edit.json --output tideline-split.video.ts --json
```

Use clip and asset IDs from the authored definition or timeline inspection.
All times are whole project frames. For `change`, `sourceOut` is exclusive
and `props` replaces the placement's overrides. Use one edit per JSON file.

| Operation   | Fields                                                                                                                                                                                               |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `import`    | `at`, `duration`, `options` (set `seed` and `parameters` here), `props` defaults, optional `resources`. Supply `--component PATH` pointing to a TSX or JSX component under the definition directory. |
| `add`       | `asset`, `at`. Places the registered composition on a new video track.                                                                                                                               |
| `change`    | `clip`, `at`, `sourceIn`, `sourceOut`, `props`. Move, trim within the current source range, or replace per-clip overrides.                                                                           |
| `duplicate` | `clip`, `at`. Copies the placement onto the same track with the same source window and parameters.                                                                                                   |
| `split`     | `clip`, `at`. Splits at an interior project frame that leaves any attached transition whole.                                                                                                         |

Use the regular `validate`, `preview`, `render`, and `package` commands for
[graphics definitions](GRAPHICS.md). `validate --json` reports the optional
browser status for React assets. `doctor --json` reports the pinned Anime.js
version, graphics availability, and the browser setup command. `--picture-cache` retains reusable
graphic source frames.

## Review a revision

```zsh
opencut review edit.video.ts --against approved.video.ts --marks marks.json --output review
opencut review edit.video.ts --against approved.mp4 --render-report approved.render.json --output changes --json
```

Open `index.html` to play both versions together and switch between their audio.
The directory also contains separate portrait or landscape MP4s with the
version and source position burned in, plus `index.json` for automation. Each
selection is limited to 30 seconds. The check list records what OpenCut
verified, and listening and viewing start as pending.

Review marks use a name and an inclusive start and exclusive end in seconds.
Use decimal seconds, a clock time, or a fraction. Review renders round the
start down and the end up to show the whole selection.

```json
[
  { "name": "opening", "start": 0, "end": 4 },
  { "name": "reveal", "start": "30.5", "end": "38.1" },
  {
    "name": "ending",
    "start": "38.1",
    "end": "47.4",
    "candidate": { "start": "38.1", "end": "47.9" }
  }
]
```

Use `candidate` for a different selection on the revised timeline. With more
than one candidate, use `candidates` to give specific selections by ID
(`after-1`, `after-2`, in CLI order). For reusable notes, pass `--notes notes.json`
with an array such as
`[{"range":"ending","text":"Check the hand gesture before the cut."}]`.
Notes can also have a source `timestamp` and version ID (`before` or an
`after-N` ID). Keep the notes file for the next revision.

When both versions provide compatible timeline evidence, the index identifies
picture and audio changes by frame range. A TypeScript definition provides
evidence from its compiled timeline. For an MP4, supply the matching report
from `render --revision-evidence --json`. Use `--render-report` for the baseline
and `--candidate-report` for the first candidate. An MP4 needs a constant
frame rate and a zero video start time.

If you leave out the marks, OpenCut selects changed ranges and adds half a
second of context on either side when available. Use explicit marks when
either version lacks compatible evidence. Check any pair flagged for manual
alignment before judging timing. For a TypeScript input, `--quality` overrides
the report’s default for both change detection and preview rendering. A
subtitle-free report keeps subtitles out of those previews.

```zsh
opencut review edit.video.ts --against baseline.video.ts --marks marks.json \
  --music-candidate music-a --music-option music-b --music-loudness matched \
  --output music-review
```

Add `--candidate other.video.ts` to compare another definition in the same
review directory. With `--music-loudness authored`, audio plays at authored
settings. Matched comparisons use TypeScript candidates and the same
`musicComparison` group across definitions with music. Use `--against-music`
to select the baseline’s track when it is a definition. The matcher uses
the full candidate pool to set the target for the selected track, so a change
to an unselected track can affect the comparison. The index records whether
voice settings match and whether loudness could be measured.

A matched comparison can use an MP4 baseline if its verified report has no
active clips from tracks tagged as music. Tag music tracks with `audioRole: 'music'` so
OpenCut can identify their role in the report.

### Compare a delivered shot with its sources

```sh
opencut review approved.mp4 --source-comparison --definition edit.video.ts \
  --timestamp 9.2 --source-clip hat --render-report approved.render.json \
  --output source-review --json
```

Open `source-review/index.html` to play the original at the delivery
crop and scale, the processed source, and the delivered picture. The
JSON includes source stream dimensions, frame rate, codec and bitrate
when available. Use `--from` and `--to` for an exclusive project-frame
range within one shot, up to 20 seconds. When a report is missing or stale,
supply `--source-mapping <mapping.json>` with `clipId`,
`projectStartFrame`, and `deliveryStartFrame`. These reviews label the
editor-supplied correspondence as unverified.

## Replace audio using an existing export

```zsh
opencut render edit.video.ts --revision-evidence --output approved.mp4 --json > approved.render.json
opencut remix revised.video.ts --picture-from approved.mp4 --render-report approved.render.json \
  --output revised.mp4 --preflight --json
opencut remix revised.video.ts --picture-from approved.mp4 --render-report approved.render.json \
  --output revised.mp4 --json > revised.render.json
```

The report captures visual dependencies and output settings together with
the encoded video packet and timing hashes. `remix` inherits the video's
delivery settings from that report. It compares the new timeline and
verifies the source MP4 before muxing a new audio mix with the original
video packets. Keep the compiled visual inputs available for comparison.
The original picture cache is optional. The output is checked for packet
identity, frame timing and audio alignment before publication.
Pass `--music-candidate` or `--mix-settings` when changing the mix without
editing the definition.

`--preflight` prints `status: "reuse"` or `status: "blocked"` without writing
a delivery. A blocked decision exits with status 1 and lists the checks
performed and any affected picture ranges. A successful remix reports
the baseline and packet hash in `pictureReuse`. Keep the new MP4 and render
report together to use them for the next revision.

Use a [saved picture version](#audio-only-revisions)
if you already have one. For a legacy render without compatible evidence,
run `render` explicitly and save the new report. A picture cache can reuse
compatible lossless ranges during that render.

## Patch a timeline

```zsh
opencut timeline patch edit.video.ts --edit changes.json --dry-run --json
opencut timeline patch edit.video.ts --edit changes.json --output revised.video.ts --json
```

The JSON contains an ordered list of operations. All positions are project
frames, and all end positions are exclusive.

```json
{
  "operations": [
    {
      "operation": "caption",
      "id": "opening-caption",
      "text": "A little sparkle",
      "start": 10,
      "end": 76
    },
    { "operation": "graphic", "id": "story-glitter", "at": 317 },
    {
      "operation": "trim",
      "id": "closing-duo",
      "sourceOut": 142,
      "placement": "ripple"
    },
    {
      "operation": "replace-source",
      "id": "hat",
      "asset": "sharp-take",
      "sourceIn": 90,
      "audio": "mute"
    }
  ]
}
```

`caption` can change text, timing, or both. Changing text clears old
word-level highlights and reports that change. `graphic` changes a graphic
placement's start while keeping its source trim. `trim` changes the in or out
point of timed media. With `keep`, later placements retain their starts.
With `ripple`, clips and captions starting at or after the edited clip's old
end move by the duration change, including on other tracks. A clip or
caption already in progress at that boundary keeps its timing. Transitions
are resolved against the resulting clip edges, and a declared canvas
duration changes with the ripple. Detached audio can retain its padded tail
when trimmed. Source availability reports the end of the decoded audio.

`replace-source` selects a declared timed video asset and keeps the
placement length, speed, crop and transform. The in-point may be a project
frame number or an exact rational time. Dry-run checks bounds and any
transition handles against the new source. It reports the retained crop
and separate overlapping audio clips from the original asset. Use
`"audio": "replace"` to use the new take's embedded audio or
`"audio": "mute"` to silence that picture placement when the edit would
affect audible embedded audio. To change both the take and its trim in
one patch, put `replace-source` before `trim` for that clip. OpenCut checks
the trim against the new take's source bounds.

The report lists old and new ranges, source availability, surrounding
material, transition windows and resulting duration. A valid apply writes a
new resolved TypeScript definition beside the original, so component and
asset paths stay editable. Parameterized input is saved at the resolved
parameter values used for the patch.

## Inspect one timeline frame

```sh
opencut timeline inspect edit.video.ts --timestamp 9.2 --metadata-only --json
opencut timeline inspect edit.video.ts --timestamp 9.2 --recipe-cache ./recipe-cache --json
```

Metadata-only inspection lists authored tracks, clip placements, intended
source times and crop. It skips media recipes, graphic compilation and cache
writes. The TypeScript definition still runs as trusted authoring code.
Resolved inspection adds source paths, SHA-256 fingerprints, processed
stream information, recipe steps and the resolved view into source pixels.
For media clips, `source.sourceTime` is the time in the processed asset, and
`source.originalSourceTime` maps that position back through the recipe.
OpenCut reports mapped times to microsecond precision when a trim or
slow-motion recipe changes the source clock. The JSON marks unavailable evidence, including original/synthesized sample
provenance for a backend that provides no sample map.

## Check the installation

Run `opencut doctor --json` from the environment that will run the export.
`media.ready` reports whether FFmpeg, ffprobe, and the default H.264 and AAC
encoders are available. On macOS it also requires the bundled RSS helper
to match the installed version and successfully sample memory. If
`media.ready` is false, read `media.hint`. A missing or mismatched RSS helper
calls for reinstalling the package or rebuilding a source checkout.

Check optional AI separately under `ai`. `opencut system inspect --json`
reports VideoToolbox configurations and model status for sample input sizes.
Run a short preview of the actual input with the intended profile in the
same environment to confirm the processor can initialize.

## Render quality profiles

`render` and `batch` default to `quality`. All `preview` commands, including
`preview --watch`, default to `fast`. Set `--quality fast|quality|maximum`
to select a profile. It controls encoding and any interpolation or
super-resolution step that has no authored quality override.
`timeline inspect` defaults to `quality` and accepts the same flag to inspect
another recipe profile.

| Profile   | AI interpolation                                                        | AI super-resolution                  | MP4 encoder preset and CRF |
| --------- | ----------------------------------------------------------------------- | ------------------------------------ | -------------------------- |
| `fast`    | VideoToolbox low-latency midpoint                                       | VideoToolbox low-latency 1.5× or 2×  | ultrafast, 28              |
| `quality` | VideoToolbox offline frame-rate conversion revision 1, quality priority | VideoToolbox temporal 4×, revision 1 | veryfast, 17               |
| `maximum` | Same as `quality`                                                       | Same as `quality`                    | medium, 16                 |

CRF applies when the video bitrate is unspecified. H.264 and HEVC use
libx264 and libx265 respectively. PNG previews use lossless encoding.
An unsupported AI step reports how to check its requirements. Select a
different profile or adjust the recipe explicitly. `system inspect --json`
lists the profile defaults, model configuration probes, host worker cap and
memory pressure. Run the actual render to verify support for a particular
source. The [benchmark instructions](#performance-benchmarks) use generated
motion, audio and subtitle fixtures.

## Media tools

`probe`, `extract-frame`, and `separate-dialogue` accept local source paths.
Choose a destination that supports hard links for `extract-frame` so it can
publish the completed PNG atomically.

### Dialogue separation

```sh
opencut separate-dialogue recording.wav --output stems --json
```

The command writes `dialogue.wav` and `background.wav` to a new directory.
If the ELUATE runtime or multilingual Bandit v2 checkpoint is unavailable,
the JSON diagnostic on stderr has `error.code` set to `MISSING_DEPENDENCY`.
Run `opencut models inspect --json` to see which prerequisite needs attention.
Use `opencut models install bandit-v2` or `opencut models remove bandit-v2` to
manage the checkpoint. See [optional AI setup](INSTALL.md#optional-ai).

SIGINT (Ctrl-C) and SIGTERM also cancel the prerequisite checks, including the
Python probes and checkpoint verification. The command exits with status 130
for SIGINT and 143 for SIGTERM.

### Local transcription and corrected timing

OpenCut uses Qwen3-ASR and its optional ForcedAligner locally. Set up a
Python environment with the `qwen-asr` package and download the desired
model directories using Qwen's published setup instructions. Point
`OPENCUT_SPEECH_PYTHON` at that Python executable,
`OPENCUT_QWEN_ASR_MODEL` at the recognizer weights, and
`OPENCUT_QWEN_ALIGNER_MODEL` at the aligner weights.
`opencut doctor --json` reports the runtime, weights and alignment
languages. OpenCut runs the worker offline. [Qwen3-ASR](https://github.com/QwenLM/Qwen3-ASR)

```sh
opencut transcribe take.mp4 --start 9.2 --end 15 --language Chinese --output draft.json
opencut transcript align take.mp4 --transcript corrected.json --output aligned.json
opencut transcript export aligned.json --output aligned.srt
```

Use a whole media file, a selected source interval, or dialogue-separated
audio. Video timestamps are relative to the first picture frame. Audio-only
timestamps are relative to the first audio sample. Start and end times
use that source clock, including when audio leads the picture in the file.
Save a copy of the UTF-8 sidecar and edit each segment's `text`. Alignment keeps the segment IDs and the exact edited text, including mixed
language and punctuation. It reports unmapped or invalid timings in
`review`. Source-relative word or character times are available when
ForcedAligner supports the selected language. Export reads the aligned
sidecar and writes SRT or VTT on the source clock. For narration or
captions on another timeline, see [the SDK examples](SDK.md#build-narration-and-captions-together).

## Online media

`online search` reads a JSON request. `online download` returns the downloaded
file's path and provenance for use in a definition. Cancelling an in-flight
frame extraction or download discards partial output.

See the [definition reference and examples](VIDEO_DEFINITIONS.md).

## Media recipes

```sh
opencut recipes inspect edit.video.ts --json
opencut recipes validate edit.video.ts
opencut render edit.video.ts --recipe-cache ./recipe-cache --recipe-workers 2 --output final.mp4
```

`recipes inspect` and `recipes validate` check source streams and ordered
steps without transcoding. The normal `validate`, `inspect`, and `render`
commands and all preview modes accept these processing options when compiling referenced
recipes.

| Option                     | Default and scope                                                                                                                                                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--recipe-cache`           | `$XDG_CACHE_HOME/opencut/recipes-v3`, or `~/.cache/opencut/recipes-v3`. Use a private local directory that supports file locks and atomic rename.                                                                            |
| `--recipe-workers`         | Defaults to 1. Accepts up to 16 as a ceiling, with a host cap based on CPUs and memory (at most 4). macOS memory-pressure warnings limit new work to one active stage.                                                       |
| `--recipe-temp-bytes`      | 4 GiB for staged media per invocation, split evenly among workers. The OS file limit rounds down and can be stricter on Linux depending on the shell.                                                                        |
| `--recipe-memory-bytes`    | Total native budget, capped at a quarter of installed memory (up to 8 GiB on Apple Silicon). Stages reserve up to 1 GiB normally, 2 GiB for offline interpolation, and 4 GiB for offline super-resolution.                   |
| `--recipe-buffered-frames` | 32 frames per FFmpeg filter graph. VideoToolbox interpolation needs 3 surfaces, fast super-resolution 2, and offline super-resolution 4. Denoise needs the current and output surfaces plus the configured reference window. |
| `--recipe-max-pixels`      | 8,847,360 pixels per input or output frame.                                                                                                                                                                                  |
| `--recipe-timeout-ms`      | 1,800,000 milliseconds per step.                                                                                                                                                                                             |

Processing limits apply to fresh recipe work. Cached media and composition
outputs have their own disk usage. Matching inputs, effective AI profiles,
algorithm settings, and backend fingerprints reuse completed entries. A change
to the worker, encoder settings or system version can rebuild affected steps
and their dependents on the next run. Older entries stay on disk until
removed. Stop active builds before clearing the cache directory.

Foreground rendering reports step starts, media time, completions, and cache
hits on stderr. A successful `render --json` includes `recipeProcessing` when
recipes were used. Each entry has `assetId`, a zero-based `step`, a cache
`key`, and a `status` of `completed` or `cache-hit`.

SIGINT and SIGTERM cancel active steps. See [build recovery](#build-recovery)
for abrupt exits and retries.

Fresh recipe execution requires macOS or Linux and FFmpeg with
`-filter_buffered_frames` and FFV1 encoding in MOV. Verified on macOS with
FFmpeg and ffprobe 9.0.2. Node versions that mark the built-in SQLite module
experimental may print a warning on stderr when opening the build cache.

`interpolateFrames` and `smoothSlowMotion` add local VideoToolbox inference to
referenced video recipes. Source identity, prior steps such as `trim`, target
rate, quality, scene settings, and the backend build and OS identify the
cached result. The memory budget samples the combined RSS of the decoder,
model worker, and encoder every 50 ms. macOS pressure is sampled separately
to account for allocations outside that tree. New stages fail when pressure
is critical. Native inference checks happen on a fresh execution of
`validate`, `inspect`, `preview`, or `render`. See the
[AI recipe settings and supported inputs](VIDEO_DEFINITIONS.md#ai-interpolation).

`superResolution` and `denoise` use the same cache, progress, and cancellation
controls. Put `trim` first to limit inference to a source range. For UHD,
start with one recipe worker. Use `system inspect --json` for the supported
configurations and model readiness, then `validate` to run the actual job.
See [enhancement presets and limits](VIDEO_DEFINITIONS.md#ai-enhancement).

### Verify interpolation and upscale

For a comparison, make two definitions with the same clip trim, timeline
placement, canvas and frame rate. Use the original asset in the comparison
without interpolation. For upscale, use a `resize` recipe with `lanczos`
at the same target dimensions as `superResolution`. Keep the timeline at
60 fps for a 30-to-60 fps interpolation comparison. A 30 fps timeline
samples the composition on a 30 fps grid even if the export is set to 60.

```sh
opencut probe source.mp4 --json > source.probe.json
opencut inspect processed.video.ts --json > processed.inspect.json
opencut timeline inspect processed.video.ts --frame 60 --json > sample.json
opencut render baseline.video.ts -o baseline.mp4 --fps 60 --json > baseline.render.json
opencut render processed.video.ts -o processed.mp4 --fps 60 --json > processed.render.json
opencut probe processed.mp4 --expect-fps 60 --json > delivery.probe.json
opencut preview contact-sheet baseline.mp4 --frames 59,60,61 --output baseline.png
opencut preview contact-sheet processed.mp4 --frames 59,60,61 --output processed.png
```

Read the input rate from `video.frameRateRatio` in the source probe, the
actually processed rate from the relevant asset's `metadata.frameRateRatio`
in the definition inspection, the timeline rate and source sample from
`frameRate` and `visualClips[].sourceTime` in the timeline inspection,
and the delivered rate from the output probe. `inspect` materializes
referenced recipes with the default `quality` profile. Set a recipe's
`quality` for a comparison that uses another AI profile. Both contact-sheet
manifests identify each sampled frame and its presentation timestamp.
Choose a few consecutive frames at a turn, occlusion, moving light, or cut
to check for ghosting. Compare faces, fabric and small lettering at matched
sizes, looking for oversharpening and changes across successive frames.

`probe --expect-fps` checks the reported average video stream rate as an
exact fraction. The JSON result includes `frameRateCheck.expected` as a
numerator and denominator, `actual` as a fraction string or `null`, and
`passed` as a boolean. A mismatch still returns the result on stdout and
exits with status 1. Use the intended delivery rate, including 30 fps for a
30 fps delivery from 60 fps footage. To check every decoded presentation
timestamp against an approved export, use [`verify export`](#post-export-verification).

## Build recovery

```sh
opencut build inspect edit.video.ts --recipe-cache ./cache --json
opencut render edit.video.ts --recipe-cache ./cache --output final.mp4
```

Foreground compilation and rendering write local receipts in the recipe
cache. `build inspect` resolves the current definition and inputs and reports
their build ID, last compilation state, recorded recipe stages, and render
states. Use the same cache, parameters, `--quality` and `--no-subtitles` selection as
the original build. Inspection evaluates trusted TypeScript and hashes
inputs. If the definition or inputs changed, inspection addresses the new
build.

- `steps[].reusable` means the recorded SHA-256 receipt matches a published
  or staged recipe result. Inspection leaves verified staging in place for
  the next retry, which checks the current recipe inputs and backend.
- `renders[].state` describes the output. A `rendered` entry includes its
  verified checksum. The optional `renders[].lastAttempt` describes a newer
  attempt separately, so a failed overwrite can coexist with a valid MP4.
  `missing-or-corrupt` means the published file is missing or its bytes no
  longer match the receipt.

After a crash, rerun the command with the same cache. Completed processing
is checked against its SHA-256 receipt before reuse. The key includes the
source bytes, relevant probed inputs and step settings, upstream output,
and the backend fingerprint. A layout-only edit can reuse the same media
stages. An interrupted encoder starts over in new scratch space. A retry
removes the old scratch for the same build and output. A verified MP4 is
published atomically; a failed or interrupted overwrite leaves any previous
output intact until a replacement is verified. If inspection finds the MP4
was already published, use it, or choose a new output explicitly.

### Source changes during a command

In JSON mode, a detected source change reports `error.code: "SOURCE_CHANGED"`
on stderr. Read `error.sourceChange` for the `path`, `stage` and observed
identities in `before` and `after`. An identity includes device, inode, size,
modification time and change time. An unavailable identity is `null`,
including when an input disappears. `beforeSha256` and `afterSha256` are
optional. When OpenCut verifies both sets of bytes, it reports `content`
as `"unchanged"` or `"changed"`. If either hash is unavailable, it reports
`"unknown"`.

Pass `--retry-source-change` to `validate`, `render` or
`preview contact-sheet` to make at most one fresh attempt after a detected
change with verified identical content and a still-matching file identity.
A JSON retry writes a `source-change-retry` event to stderr before the next
attempt. For a definition contact sheet, the retry recompiles the definition
before sampling. For an MP4 contact sheet, it rebuilds the decoded frame
index. For changed or unknown content, let any writes finish and restore
any missing input before rerunning on the intended revision. Each attempt
rechecks its inputs. A failed attempt leaves existing deliveries available.

When a source changes after picture ranges have been cached, look for
`error.sourceChange.completedPictureRanges`. For example, a dialogue
recording can disappear during audio preparation after picture composition.
Use `render plan` with the same cache and settings to see which ranges still
match the current inputs. `build inspect` checks recorded recipe stages for
the current build.

## Portable projects

```sh
opencut package src/edit.video.ts --root . --resource src/captions.txt --output ./bundle
opencut package verify ./bundle --json
opencut render ./bundle/opencut.bundle.video.ts --output ./final.mp4
```

Move the entire bundle. The generated TypeScript entry rebuilds the selected
composition using the bundled inputs, even without the original TypeScript
packages installed. Use `--params` at packaging time to choose a variant.
Keep the generated entry named `opencut.bundle.video.ts` at the bundle root.
When rendering that entry, OpenCut verifies the package inventory and hashes,
then reads the generated default export as data. Verification rejects symlinks
at the manifest or entry and anywhere along a listed dependency path.
Copy the editable sources from `project/` to make changes, then package them
again.

Choose a new output directory under an existing parent. The default root is
the authored definition's directory. Use `--root` to include shared files
in a common ancestor. The package collects declared media and fonts, static
relative imports (including type imports), and computed imports run for
the selected composition. Supply `--resource` once per additional local
authoring file, such as a subtitle file read directly with Node. Resource
paths are relative to the project root. Use relative imports for project
modules in a bundle, including modules normally loaded through Node `#`
aliases. Files required only by other parameter selections or arbitrary
filesystem reads are not inferred. Unresolved relative imports, escaping
paths, symlinks, and destination collisions fail.

The `opencut-package.json` manifest records input hashes, payload bytes,
recipes, toolchain and native backend requirements. `package verify` checks
the inventory and hashes. Rendering checks the backend requirements on the
receiving machine. Package only assets and fonts you can redistribute.
Caches, native models, system frameworks and third-party Node packages
are not copied. Choose a compatible OpenCut build and FFmpeg
installation. VideoToolbox recipes still require supported Apple Silicon
hardware and macOS; Apple does not expose a separate model version, so
results can vary with the OS. The recorded backend version identifies the
required processing behavior. A compatible worker or encoder update can
invalidate cached media while preserving compatibility with existing packages.

Packaging needs space for the listed payload once, plus small manifest
and filesystem overhead. Sources shared by clips are copied once per path;
the filesystem can use copy-on-write clones. Recipe cache and render
scratch usage are separate. Verification checks integrity, not authorship;
only run the archived TypeScript if you trust it.

## Batch rendering

```sh
opencut render examples/video/short-batch.video.ts --params examples/video/short-batch.params.json -o final.mp4
opencut batch examples/video/short-batch.video.ts --variants examples/video/short-batch.variants.json --output-dir ./outputs --concurrency 2 --json
# After correcting a failed tall variant in the manifest
opencut batch examples/video/short-batch.video.ts --variants examples/video/short-batch.variants.json --output-dir ./outputs --only tall
```

The variant file is a JSON array of entries with `id`, optional `params`,
and optional `output`. Each output is a flat MP4 basename in the output
directory and defaults to `<id>.mp4`. Use letters, digits, hyphens, and
underscores for IDs and basenames, starting with a letter or digit. The
batch creates its output directory, rejects duplicate names
case-insensitively before compiling, and publishes each verified file
atomically to a new path. Use `--only id,id` to retry selected IDs after
fixing the manifest. Use a fresh directory to rebuild successful IDs.

Each variant validates its own parameters. The default is to continue when a
variant fails. `--fail-fast` cancels outstanding work after the first
failure. SIGINT or SIGTERM stops active and queued jobs. Completed files
remain available. With `--json`, stdout contains `{ ok, variants }` in
manifest order. Each variant result has `id`, `output`, `elapsedSeconds`, and
`status`. A `completed` result contains `render`. A `failed` result contains
`phase` and `error` with a code and message. A `cancelled` result contains
`reason`. A batch with failed or cancelled variants exits nonzero.

Stderr includes one JSON object per progress event with
`event: "batch-progress"`, the variant `id` and `output`, and a `status`
of `compiling`, `recipe`, `rendering`, `render`, or `finished`. The
`recipe` and `render` events carry `progress`, and `finished` carries the
final variant `result`. Filter these events by their `event` field when
reading stderr, which also carries diagnostics and authoring logs.

Batch runs directly on macOS or Linux. `--concurrency` accepts 1–8 and defaults
to 1. The host caps active slots using the same worker ceiling as recipe work.
Each slot owns at most one recipe step at a time. An AI step can run one
inference worker with a decoder and an encoder. A transformed render layer
can run a decoder and an encoder together. Shared source probes and the
recipe cache reuse work across slots. Cache keys depend on the relevant
source, ordered step parameters, and backend. Changes to layout, title, or
captions alone leave matching recipe steps reusable.

`--temp-bytes` (default 8 GiB) and `--memory-bytes` (default host native budget) divide
the batch budgets evenly across active slots. Recipe overrides may lower a
slot's limits. The temporary budget covers staging for recipes and renders,
including copied sources, layer intermediates, and the unfinished MP4.
Published outputs and completed cache entries consume persistent disk space.
For Professional Dialogue Mix, DeepFilterNet counts toward the slot’s native RSS
budget, and the temporary file-size limit applies while it writes its staged WAV.
OpenCut samples native child-process RSS with its bundled, unprivileged
sampler on macOS and with `/bin/ps` on Linux. It also caps FFmpeg
allocation sizes. If sampling fails, the render or recipe stops and
reports the error. TypeScript authoring runs with a capped V8 old-generation
heap. These limits have the granularity of process sampling, file limits,
and heap accounting.
Canvas allocations, shared process memory, and VideoToolbox driver
allocations contribute to system memory outside the native RSS budget.

Each batch MP4 and each parameterized single render stores an `opencut_build`
format tag with resolved parameters, definition and composition SHA-256
digests, effective processing and render settings, and recipe cache keys.
The batch record also gives the variant ID and its resource limits. Read
the record from `build` in a single render's JSON result or from
`variants[].render.build` for completed batch variants. Keep secrets out of
parameters since the tag travels with the output.

```sh
ffprobe -v error -show_entries format_tags=opencut_build -of json ./outputs/wide.mp4
```

## Performance benchmarks

Build with the macOS 26+ SDK, then run the benchmark from the repository root
with Python 3.11+ and FFmpeg/ffprobe on PATH.

```sh
pnpm build:packages
pnpm --filter @opencut/cli build
python3 scripts/t54/benchmark.py t54-local
```

Use a new label for each run. The harness saves its metrics and playable
outputs under `tests/fixtures/generated/<label>/`. It covers TypeScript
validation, a preview clip, early and late frame seeks, 1080p and UHD
composition with captions and audio, interpolation, super-resolution, a
combined workload with one and two requested workers, a two-worker run
with a 4 GiB recipe budget, and a 30-second
interpolation input. Set `--sustained-seconds` to change the duration.
Optionally pass `--action-fixture` with an existing redistributable 24 fps
SDR excerpt of at least two seconds under the generated fixtures directory
for visual review.

Cold runs use a new build and recipe cache. Warm runs repeat with that cache
and a fresh output file. macOS may retain models between runs. Wall time
includes TypeScript evaluation, probing and output verification. Peak RSS
samples the CLI and its descendants every 50 ms and excludes GPU driver
and system allocations. Inspect the recorded OS pressure and thermal state
before and after sustained runs. Frame metrics use matching dimensions and
exclude the caption area. Interpolation uses held-out frames, and the
temporal comparison scores differences between consecutive pictures against
the same differences in the reference. Review the MP4s for motion artifacts.
Check each case's `exitCode` in `benchmark.json`. The harness records diagnostics
for unsuccessful cases and runs the rest of the matrix.

### Revision benchmarks

From a source checkout, build the CLI and run the revision benchmark.

```zsh
python3 scripts/revision-benchmark.py --runs 3
python3 scripts/revision-benchmark.py --graphics-only --quality fast --runs 3
```

It measures a burned-in caption edit, a four-frame graphic move and a
music-only swap on a generated vertical project. The JSON on stdout records
times to playable review and full export, the host and encoder settings,
cold and baseline-seeded cache runs, per-range cache decisions and changed
dependencies, and the costliest graphics tasks. Stage clocks can overlap.
Use `--baseline`, `--caption`, `--glitter`, `--music` and `--marks` to
run the same cases with prepared project definitions. Use
`--music-candidate` if the music revision is a different track selection
from the same definition. Supply `--video-bitrate` to pin a delivery
bitrate for the revision cases. Graphics-only runs measure a transparent React/SVG
wipe at 1080p60 and 4K60. The warm run starts with cached graphic PNGs and
fresh picture ranges. The report includes time to a playable review and
export, individual stage durations, sampled process-tree RSS and scratch
usage, and decoded frame and transparent input checks. Compare stage
durations individually because some stages overlap.

To reproduce the 1,730-frame picture revision fixture, run the native
integration test after building the CLI. The default run uses a small
canvas on the same 60 fps timeline. Set `OPENCUT_HAT_FIXTURE_4K=1` for
the 2160 × 3840 export. Only generated sources are used. Finish package
and CLI builds before starting the fixture. A parallel rebuild can refresh
bundled graphics files while the export is verifying its inputs.

```sh
OPENCUT_HAT_FIXTURE_4K=1 node --import tsx --test tests/integration/video-picture-revision.native.spec.ts
```

Run `python3 scripts/speech-fixture.py` with FFmpeg and eSpeak NG available
to generate a bilingual fixture with background speech and known word
windows. It prints the path, selected interval and reference times.

The Swift comparison runner in `scripts/speech-analyzer.swift` uses
macOS 26 or later and locally installed SpeechAnalyzer assets. It can
report available locales with `status` and transcribe an audio file
with a specified locale. Compare the same source file and calculate
recognition errors separately from word timing errors.
[SpeechAnalyzer](https://developer.apple.com/documentation/speech/speechanalyzer)

## Professional Dialogue Mix

Use `opencut mix analyze <definition.video.ts> --json` to obtain editable automation and measured loudness without rendering picture. `render`, `preview --watch` and `preview clip` use the mix authored in the definition. See [mix settings, overrides and comparison options](AUDIO_MIX.md#delivery-and-inspection).

## Convert a legacy definition

```sh
opencut convert edit.video.json
opencut validate edit.video.ts
```

`convert` accepts UTF-8 `.video.json` files up to 8 MiB. It writes the
TypeScript file beside the resolved JSON source so relative asset paths work
through symlinks. `opencut.bundle.video.json` becomes
`opencut.bundle.converted.video.ts`. The input is preserved and the destination
must be new. The destination filesystem must support hard links.

Add `--json` when converting to get the absolute output path as
`{ "path": "…" }`. Use `opencut validate edit.video.ts --params variant.json`
when the definition has required parameters or to check a specific variant.

To rebuild an older bundle whose editable source is a `.video.json` file,
convert that file under `project/` and [package the result](#portable-projects)
into a new directory. Pass the old bundle’s `project/` directory as `--root` to
keep its layout. If the old manifest records `params`, save those values to a
parameter file and pass it with `--params` to package the same variant.

## Motion definition diagnostics

Use `doctor --json` to discover graphics capabilities and optional browser and
adapter readiness. `validate --json` lists custom executable graphics.
OpenCut keeps structured errors on stderr. Render a portable package from its
verified `opencut.bundle.video.ts` entry.

## Beauty and body reshaping

Use `opencut beauty --help` to see local backend discovery, analysis, target
inspection, binding validation, evidence generation, and cache removal.
Use the regular `preview` and `render` commands for effects authored in
a video recipe. See [beauty setup and workflow](BEAUTY.md).

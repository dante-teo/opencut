# Export

Render a definition to MP4 with the CLI or SDK. The default uses the
definition's canvas and rate, H.264 video and stereo AAC.

```sh
opencut render edit.video.ts --output final.mp4
opencut render edit.video.ts --output portrait.mp4 --width 1080 --height 1920 --fps 30000/1001 --quality maximum
opencut render edit.video.ts --output portrait-4k60.mp4 --width 2880 --height 3840 --fps 60 --codec hevc --encoder auto
```

`opencut render --help` lists the quality, resolution, codec, encoder, bitrate, audio
settings, `--no-subtitles`, and `--overwrite` options. A rate override
resamples the completed composition. Clip boundaries and source samples are
first selected on the authored timeline grid. H.264 exports flatten
transparency over black. The renderer supports SDR and does not promise
preservation of arbitrary source color spaces or HDR metadata.

For 3:4 delivery at 2880 × 3840, compose on a 3:4 canvas such as
1080 × 1440. OpenCut scales the finished canvas in the MP4 export and keeps
the composition and audio together. Custom output sizes allow up to
2880 × 3840 total pixels with even sides of at most 3840 pixels. The authored
canvas retains its existing limit. Ordinary output scaling adds no source
detail. Use a per-source `superResolution` recipe for AI enhancement and an
`interpolateFrames` recipe for 30-to-60 fps motion synthesis. Set the authored
timeline to 60 fps to sample those new source frames. For an approved 16:9
or 9:16 edit, the SDK's [4K60 delivery helper](SDK.md#4k60-delivery-variants)
builds a 60 fps composition and applies interpolation to selected shots.

Choose an output path in an existing directory. The renderer stages output
beside the destination and publishes it after encoding and verification. An
existing file is refused unless explicitly authorized with `--overwrite`.
With overwrite enabled, a failed or cancelled render leaves the prior file
in place. Sources are read only. Foreground cancellation uses SIGINT or
SIGTERM in the CLI, or an AbortSignal in the SDK. Forced termination can
leave a staging directory behind.

Probe errors identify the affected file and stage and include the tool's
exit status and diagnostic when available. A missing QuickTime chapter
track is reported as a warning when the probe succeeds and returns usable
stream metadata. The render still verifies decoded media before publication.

Use `opencut subtitles export edit.video.ts --output captions.srt` for a
sidecar. See the [definition format](VIDEO_DEFINITIONS.md) for supported
effects and the [preview comparison](PREVIEW_EXPORT_CONSISTENCY.md) for
sampling and playback limits.

## Preflight and delivery checks

Use [layout assertions](VIDEO_DEFINITIONS.md#layout-assertions) to check
placement before encoding. Run [`render plan`](CLI.md#read-only-render-plan)
with the intended export options to check composition and delivery specs,
shot cadence, cache reuse, required encoders, and available scratch space.

During rendering, the CLI reports the current stage, elapsed
time, and time since the last reported progress. It reports **Ready** after
verification and publication.

After export, [`verify export`](CLI.md#post-export-verification) compares the
MP4 with an approved preview by timecode, including when their frame rates
differ. It checks the full delivery frame clock and can check packet content
and timing against an approved audio master.

Keep the JSON from the completed render, remix, or picture revision with
the delivered MP4. Pass that report to `inspect dependencies --render-report`
to check the export's fingerprint and inventory the files used by the
definition. Add `--cleanup-plan` to review which recipe cache directories
can be cleared after delivery. [Dependency inventory and cleanup](CLI.md#read-only-dependency-inventory)

## SDR color across picture ranges

The compositor converts its full-range RGB surface to limited-range
BT.709 YUV once at the delivery size. Lossless picture ranges are FFV1
in Matroska and carry the same range, matrix, transfer and primaries as
the MP4. Concatenation restores timestamps and frame durations on the
exact project grid, including fractional rates such as 30000/1001. It
then passes the normalized samples to the encoder. Existing NUT ranges
rebuild as needed. To replace a saved encoded picture version from the old
transport, render with `--picture-version save`.
See [picture reuse](CLI.md#reuse-picture-between-exports).

Run the continuous patch regression from a checkout with FFmpeg installed.

```sh
pnpm build:packages
pnpm --filter @opencut/cli build
node --import tsx --test tests/integration/cli-render-qa.native.spec.ts
```

The fixture uses stable shadows, highlights, neutrals and colored patches.
It compares one-pass, bounded, cold-cache and warm-cache software exports.
It checks FFV1 metadata and exact decoded YUV samples, then compares
decoded components across the lossily encoded paths and adjacent
boundary frames with an RGB tolerance of 4 out of 255. It also remuxes
the lossless data into the former NUT transport to show which tags the
local FFmpeg preserves. A hardware-capable macOS run encodes an actual
2160 × 3840, 60 fps HEVC MP4 with VideoToolbox, verifies its timing and
color, and checks an internal seam after a 192 × 256 comparison scale
with an RGB tolerance of 8 out of 255.

## Professional audio delivery

Mix-enabled definitions measure and normalize the full composition before encoding. OpenCut checks the decoded AAC true peak before publishing the export. See [delivery targets and controls](AUDIO_MIX.md#delivery-and-inspection).

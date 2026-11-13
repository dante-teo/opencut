# Preview and export consistency (T27)

Run `pnpm test:consistency` for the focused gate. `pnpm test:desktop` also runs
it with the rest of the Electron tests. Both use hidden windows by default in
a graphical desktop session and require FFmpeg/ffprobe on PATH, with lavfi,
libx264, libvpx-vp9, PNG and AAC support. Missing tools, codecs or frames fail
the suite. The T21 generator creates fresh synthetic assets for each Playwright
worker. No user media, checked-in golden frames or existing fixture caches are
used.

The suite opens T21 cuts, gaps and overlays through Electron's normal project
picker and uses the production frame slider and Canvas compositor. It waits
for the exact rational playhead position, the expected painted layers in order,
and a Chromium video draw at each requested source time. Proxies are disabled
for this gate; frames painted with the paused FFmpeg PNG fallback cannot satisfy
the native draw condition. The CLI renders the whole project through the normal
FFmpeg backend. FFmpeg then decodes selected export frames by presentation
ordinal into RGB24. FFprobe independently checks the decoded frame count and
each frame's muxed presentation timestamp against the exact project grid. The
check uses the timestamps as stored in the export, without rebasing either
stream to its first decoded frame. At project end, only the preview is sampled
because the export ends on the preceding frame.

The gate compares every pixel in the Canvas backing buffer after flattening
alpha over black to match H.264. The defaults allow mean absolute RGB channel
error of 8/255, 95th percentile channel error of 25/255, and at most 2.5% of
pixels with any channel error greater than 48/255. The three measures catch
widespread color drift, localized seams, and high-contrast edge changes. The
limits allow SDR matrix rounding, H.264 compression, 4:2:0 chroma subsampling
and different scaling kernels. Override the limits with `OPENCUT_T27_MEAN`,
`OPENCUT_T27_P95` and `OPENCUT_T27_LARGE_PIXEL_FRACTION` (0–1 for the fraction).

The timing gate compares explicit half-open boundary and source-time
expectations with the evaluator and export plan. It also reads source-frame
numbers encoded as eight grayscale cells in 25 fps VP9 and 30 fps H.264
fixtures. A frame must match the independent presentation-time oracle even
when its image metrics pass. The numbered projects have a nonzero source trim,
an initial gap and a continuous split on the 30 fps timeline.

The T21 mixing variant uses a trimmed and delayed video with simultaneous flash
and 440 Hz pulses, plus the separately trimmed T21 880 Hz track. It runs with
the latter track audible and muted. The suite observes Chromium's playing
Canvas and the Web Audio compressor output. It measures decoded stereo export
PCM at 48 kHz, checking 5 ms RMS windows for onsets and frequency amplitudes
for gain and silence. FFprobe verifies that decoded audio starts at time zero
and advances continuously by the decoded sample count before PCM indices are
used as timeline positions. Export flash times come from decoded video PTS.
The export pulse timing tolerance is 10 ms. The 90 ms preview limit allows
for an FFT window, audio buffering, and display scheduling.
It applies to absolute onsets and preview A/V skew. The audio comparison uses
quiet stereo inputs and does not measure latency at a speaker.

The composition and mixing cases write `*-report.json` under the printed
`tests/fixtures/generated/t27-*` directory. Composition reports include the
requested rational time, decoded export PTS in seconds, and image metrics for
each compared frame. Mixing reports include the verified audio start and the
measured audio and video onsets. Visual and frame identity failures retain the
preview, decoded export, and amplified absolute RGB difference as PNGs
alongside the reproducing project and media. Git ignores the generated
directory.

To exercise the failure paths deliberately:

```sh
OPENCUT_T27_INJECT=visual pnpm test:consistency --grep 'T21 overlays'
OPENCUT_T27_INJECT=timing pnpm test:consistency --grep '25 fps source'
```

Both commands should fail. The first changes only the export's image placement.
The second moves the right split's source in and out by one project frame,
keeping its timeline placement and duration.

Run the muxed timestamp regression on its own with
`pnpm test:consistency --grep 'rejects muxed video and audio timestamp shifts'`.
It remuxes a baseline export with a 100 ms delay applied to each stream in turn
and compares the selected decoded images with the baseline. The test passes
when those images match and the timestamp check rejects each shifted stream.

T27 caught export selecting some 25 fps frames one tick before their
presentation time, Chromium occasionally landing on the preceding 30 fps frame
at a repeating rational seek time, and Chromium interpreting untagged SD VP9 as
BT.709 where export used BT.601. Reproducers are the numbered clip around project
frame 14, the 30 fps source at times such as 29/30 s, and the T21 WebM cut at
project frame 90. Export now places each source frame at the first project tick
at or after its PTS. Timeline decoder seeks add one microsecond without changing
the exact evaluator time. Export, proxy generation and paused extraction share
the corrected untagged VP9 color rule; derivative keys changed accordingly.

This gate covers short SDR CFR projects at a 30 fps project rate, including
mixed source rates and sizes. Deterministic frame comparisons are paused;
real-time A/V is checked with timed markers. The separate T26 tests exercise
proxies and the paused fallback. This suite does not establish arbitrary VFR,
fractional project-rate playback, HDR, rotation/SAR parity, long-run drift,
heavy-load frame delivery, high-level limiting or multichannel mixing parity.
The preview compressor and export limiter can behave differently near clipping.

## Text layers (T33)

Run `pnpm test:consistency --grep T33` for the two text cases. They open
640×360 and 360×640 30 fps video projects in Electron, use the real Inspector
and timeline to create and edit multiline English and Chinese text, and
exercise undo, redo, save and reopen. One case exports with the CLI, the
other with the desktop export panel. Both compare the Canvas backing buffer
with decoded export RGB24 at the frames immediately before, at, and after
the text boundaries. The suite checks muxed video PTS and uses the same
tolerances above. A clean-video reference also verifies that both paths
paint a substantial overlay when it is active.

Both paths use [Skia Canvas](https://github.com/Brooooooklyn/canvas) to shape
and rasterize each static layer at project resolution. The layer is
composited at the same integer PNG origin. Electron requests the raster
from its media worker when the layer is active or approaching the playhead.
Desktop export also requests text rasters from the worker, independently of
preview invalidation. Export completion lists any missing-font substitutions.
FFmpeg uses the static PNG over the same half-open project frame interval.
Any preview or export downscaling occurs after geometry is computed.
RGB blending and rounding, scaling kernels and encoded 4:2:0 chroma can
still shift antialiased edges and colored strokes by a few channel values
or soften them. The comparison uses full-resolution Canvas backing
buffers and project-size H.264 exports.

The bundled variable Noto Sans SC and monochrome Noto Emoji fonts come
from [Google Fonts at revision 86aced91](https://github.com/google/fonts/tree/86aced91de05cd4f96a06838124cca45be337b2b/ofl)
and ship with their SIL Open Font License texts. Named installed fonts can
differ between machines. An unavailable family uses bundled Noto Sans SC.
The default Chinese face uses Simplified Chinese glyph conventions and also
covers common Traditional Chinese. Exact glyph shapes for other locales,
coverage of uncommon characters, complex-script line breaking and emoji
sequences depend on the font and the text engine. Unavailable glyphs can
appear as boxes. The suite verifies basic Latin, Chinese and emoji glyphs,
plus one missing family on the host running both paths.

## Subtitle cues (T34)

Run `pnpm test:consistency --grep T34` to exercise the subtitle workflow in
Electron. The test imports multilingual SRT and WebVTT fixtures, edits cue
timing and shared style, checks undo and redo, reads an exported sidecar,
and reopens the saved project. It compares the Chromium Canvas backing
buffer with decoded burned-in H.264 frames before, during, and after
overlapping cues, including boundaries between project frames.

The test checks muxed timestamps and compares a second MP4 rendered with
`--no-subtitles` to verify that disabling burn-in omits cue pixels while
keeping the same frame count. See [cue sampling and export limits](CLI.md#editable-subtitles-t34).

## Audio envelopes (T35)

Run `pnpm exec playwright test audio-fades.spec.ts` after `pnpm build`.
The Electron suite observes separate channels at the production Web Audio
output and compares them with decoded stereo AAC. It exercises duration
fields, fade handles, volume, mute, undo and redo, two splits and a seek
inside ramps, trimmed source offsets, silent media, mix peaks and A/V marker
timing. The split case uses a boundary where rounding separate time calculations
can reorder gain events. Keyboard and pointer adjustments that leave a fade
unchanged preserve the partial ramp, undo history and saved project bytes.

The headless playback tests also check event timestamps where two fades meet.
On macOS the Electron suite plays a synthesized speech recording with a
generated music bed and checks the effect of track mute in preview and export.

## Clip playback speed (T36)

Run `pnpm test:desktop clip-speed.spec.ts` to build and run the T36 cases.
The fixtures use synthetic 30 fps video, timed tones and subtitles. The suite
changes speed through the Inspector, checks undo and redo, and compares
paused Chromium Canvas frames with decoded H.264 at 0.25×, 0.5×, 1.5×, 2×
and 4×. It also reads video and audio timestamps from the MP4 and observes
the production Web Audio output during playback to check pitch and A/V timing.

The split case checks a 0.25× transition on project frame 8 in both the split
and unsplit exports and checks decoded PCM for a steady tone across the join.
The 1× trim case saves exact source seconds through the CLI and a batch edit,
then checks the sampled picture and the audio cutoff. These cases cover
synthetic SDR footage and stereo audio. Chromium and FFmpeg use different
pitch-preserving algorithms, and short transients can land differently,
especially at extreme speeds. See [retimed export timing](EXPORT.md#retimed-clips).

## Animated transforms (T37)

The T37 case creates position, scale, rotation and opacity keyframes in
Electron, moves and deletes a key, checks undo/redo, retimes a source-trimmed
clip to 1.5× and splits it through the animated segment. It plays and seeks
the Project viewer, exports through Electron, verifies the complete video PTS
grid and compares seven native Canvas frames with decoded export pixels.
Independent transform expectations cover the start, mid-curve samples, both
sides of the split, the last key and the final active frame. The case also
checks decoded color at known coordinates, verifies audio from the animated
clip, and compares a CLI PNG with the corresponding MP4 frame. The same sample
includes animated title opacity and rotation on an alpha-bearing still.

## Video transitions (T38)

Run `pnpm test:consistency --grep T38`. The test launches Electron, adds
both fades and a cross-dissolve, adjusts the dissolve duration, and checks
remove, undo and redo. It compares the live Canvas and decoded MP4 before,
during and after transition windows using the T27 RGB limits. The fixture
combines a landscape H.264/AAC MP4, a retimed portrait VP9 WebM at a different
frame rate, a PNG overlay and a nonblack canvas. It checks every output video
timestamp and verifies representative blend pixels against independent color
expectations. It also checks a CLI PNG inside the dissolve and measures the
outgoing audio gate during real-time playback. Browser decode and FFmpeg
export can differ at codec, scaling, alpha quantization and VFR boundaries.

Run `pnpm test:desktop timeline-playback.spec.ts --grep zero-weight` for the
startup cases. They hold the muted incoming decoder's readiness event and
play request independently and check that the playhead waits at the first
frame of a fade-in or cross-dissolve.

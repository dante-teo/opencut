# OpenCut SDK

Import `defineVideo`, `compileVideo`, `previewVideo`, `watchVideo`,
`renderVideo` and `renderCompiledVideo` from `@opencut/sdk` in definitions
run by OpenCut. For editor type checking or standalone Node programs,
[link the SDK bundled with Homebrew](../../../docs/INSTALL.md#use-the-bundled-sdk-from-a-node-project).
Use `renderVideo` to compile and render in one call. If `renderCompiledVideo`
reports that source media changed, recompile before retrying.
See the repository's [SDK guide](../../../docs/SDK.md) for the public API.

## Narration and captions

Use `buildNarration(segments)` from `@opencut/sdk`. Each segment has a
stable `id`, an `audio` path relative to the definition, an exact rational
timeline start `at`, a recording `duration` and a `transcript`. Optional
`timings` carry `{ from, to, start, end }` ranges in UTF-16 transcript
offsets and exact rational seconds from the segment start. Use the return
value's `assets`, `clips` and `cues` in the definition. Keep the segment
ID and update the recording, transcript, duration and timings together on
a revision. See the [narration definition example](../../../docs/SDK.md#build-narration-and-captions-together).

## Rendering and inspection

Use `inspectVideoLayout(compiledVideo)` to read required and advisory
layout checks. Use `planVideoRender(definition, output, options)` with the
intended render settings to check cache reuse and estimate scratch space.
See [SDK layout checks and planning](../../../docs/SDK.md#layout-checks-and-render-planning).

For picture reuse, pass the same `pictureCacheDirectory` to `renderVideo`
or `renderCompiledVideo` on the initial export and revisions. Read
`pictureRanges` for the status of each range in project frames.
See [picture cache behavior](../../../docs/CLI.md#reuse-picture-between-exports).
For audio-only revisions, set `pictureVersion: 'save'` on the initial export
and reuse the returned `pictureVersion.id` as `pictureVersion` with the same
cache and video settings. Save a new version if an audio edit affects
graphics. For mixed-source graphics with Professional Dialogue Mix enabled,
changing `audioChannels`, `audioSampleRate`, or `audioBitrateKbps` also
affects picture reuse.

Use `inspectVideoRecipes(file)` for recipe validation and inspection without
transcoding. `compileVideo`, `renderVideo`, and `watchVideo` accept `processing`
options for the cache, worker limits, and step progress.

Pass `quality: 'fast' | 'quality' | 'maximum'` to select the profile.
Preview defaults to `fast`, and final render defaults to `quality`.
Use the same profile when compiling to prepare its recipe results.

Use `defineVideo(shape, compose)` with `videoParams` to infer typed inputs
and `videoId(scope, localId)` to qualify repeated components. Pass
`{ params }` to `compileVideo` or `renderVideo`. Use
`batchRenderVideo(file, variants, { outputDirectory, concurrency, signal, onProgress })`
to share recipe work and get one result per variant. Retry selected IDs with
`only`. Read `build` for resolved inputs, definition identity, processing
settings, and recipe cache keys.

Call `inspectVideoBuild(definition, { params, processing, quality })` before
retrying an interrupted build. Use the render's effective profile and pass
`preview: true` when inspecting a `renderVideo` build made with subtitles disabled.
Keep the same cache to reuse stages marked
`reusable`. For a published MP4, read `lastAttempt` for a newer retry.
Use `packageVideo(definition, destination, { root, resources, params, signal })` and
`verifyVideoPackage(destination)` to share a project. Pass the verified
result's `entry` to `renderVideo` after relocation; it is already resolved
for the recorded parameters.

Use `analyzeVideoMix(compiledVideo)` to obtain editable automation and measured final
loudness. `compileVideo` and `renderVideo` accept `audioMixEdit`. Mix-enabled exports
include `audioMix` in the result. See [Professional Dialogue Mix](../../../docs/AUDIO_MIX.md).
Pass `musicSelection: { candidate: 'track-id', matchLoudness: true }` to
`compileVideo` or `renderVideo` for a definition with music candidates.
Use `watcher.selectMusic` during review. See the
[SDK guide](../../../docs/SDK.md#professional-dialogue-mix).

## Scenes and sampling

Import `createPresetScene`, `defineGraphicScene`, motion helpers and
`inspectGraphicFrames` from the SDK for version 3 scene definitions. Read
[the scene and adapter reference](../../../docs/GRAPHICS.md).

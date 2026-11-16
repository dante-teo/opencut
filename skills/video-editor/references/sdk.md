# OpenCut SDK

Import `defineVideo`, `compileVideo`, `previewVideo`, `watchVideo`,
`renderVideo` and `renderCompiledVideo` from `@opencut/sdk`.
Use `renderVideo` to compile and render in one call. If `renderCompiledVideo`
reports that source media changed, recompile before retrying.
See the repository's [SDK guide](../../../docs/SDK.md) for the public API.

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

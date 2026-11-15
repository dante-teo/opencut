# OpenCut SDK

Import `defineVideo`, `compileVideo`, `previewVideo`, `watchVideo`,
`renderVideo` and `renderCompiledVideo` from `@opencut/sdk`.
Use `renderVideo` to compile and render in one call. If `renderCompiledVideo`
reports that source media changed, recompile before retrying.
See the repository's [SDK guide](../../../docs/SDK.md) for the public API.

Use `inspectVideoRecipes(file)` for recipe validation and inspection without
transcoding. `compileVideo`, `renderVideo`, and `watchVideo` accept `processing`
options for the cache, worker limits, and step progress.

Use `defineVideo(shape, compose)` with `videoParams` to infer typed inputs
and `videoId(scope, localId)` to qualify repeated components. Pass
`{ params }` to `compileVideo` or `renderVideo`. Use
`batchRenderVideo(file, variants, { outputDirectory, concurrency, signal, onProgress })`
to share recipe work and get one result per variant. Retry selected IDs with
`only`. Read `build` for resolved inputs, definition identity, processing
settings, and recipe cache keys.

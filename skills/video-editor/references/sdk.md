# OpenCut SDK

Import `defineVideo`, `compileVideo`, `previewVideo`, `watchVideo`,
`renderVideo` and `renderCompiledVideo` from `@opencut/sdk`.
Use `renderVideo` to compile and render in one call. If `renderCompiledVideo`
reports that source media changed, recompile before retrying.
See the repository's [SDK guide](../../../docs/SDK.md) for the public API.

Use `inspectVideoRecipes(file)` for recipe validation and inspection without
transcoding. `compileVideo`, `renderVideo`, and `watchVideo` accept `processing`
options for the cache, worker limits, and step progress.

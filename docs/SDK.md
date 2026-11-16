# TypeScript SDK

The installed CLI and review app include the authoring SDK. A `.video.ts`
definition can import `@opencut/sdk` without setting up a Node project.
For TypeScript editor support or SDK usage from a separate Node program,
install `@opencut/cli` locally and use the `@opencut/cli/sdk` export in the
examples below. See the [installation guide](INSTALL.md#npm).

Use Node 24.12+ (within 24.x). The CLI resolves bundled SDK imports from
trusted `.video.ts` definitions, which should default-export
`defineVideo({...})`. The following examples are for separate Node programs
with the CLI package installed locally.

```ts
import {
  compileVideo,
  previewVideo,
  renderCompiledVideo,
} from '@opencut/cli/sdk';

const video = await compileVideo('edit.video.ts');
const preview = previewVideo(video);
await preview.frame(30, 'review.png');
await renderCompiledVideo(video, 'delivery.mp4', {
  quality: 'maximum',
  onProgress: ({ percent }) => console.error(percent),
});
```

Use `renderVideo(file, output, options)` to compile and render in one call.
A compiled render checks the identity of each source it uses before copying
it for the render. If a source has changed, compile the definition again.
Pass an `AbortSignal` to cancel a foreground render.

Final renders default to `quality`. Preview frames, clips, contact sheets
and watches default to `fast`. Pass `quality: 'fast' | 'quality' | 'maximum'`
to set the profile. You can choose the same profile when calling
`compileVideo` to prepare its derived media in advance. If a compiled
revision needs a different inherited recipe setting, OpenCut reprocesses
the captured definition with the new profile and checks that its inputs
still match the compiled revision. For a checkpointed build, inspect the
new receipts with the render's quality profile and subtitle options.

`watchVideo(path, { onStatus })` manages a temporary playback file, retains
the last good revision on failure, and must be closed when finished. Use
`withCurrent(generation, callback)` on the watcher to keep that revision’s
media available during a render. The callback must finish before the watcher
can close. Changing the render quality inside that callback uses the
selected revision's pinned inputs, including sources needed by AI recipes.

The SDK also exposes `probeMedia`, `extractFrame`, `OnlineMediaLibrary`,
`separateDialogue`, and subtitle parsing and file tools.

`extractFrame(file, seconds, output, signal?)`,
`OnlineMediaLibrary.search(query, signal?)`, and
`OnlineMediaLibrary.download(id, directory, signal?)` accept optional
cancellation signals. Frame extraction requires a destination that supports
hard links to publish the completed PNG atomically.

## Media recipes

```ts
import { inspectVideoRecipes, renderVideo } from '@opencut/cli/sdk';

const { recipes } = await inspectVideoRecipes('edit.video.ts');
console.log(recipes);

await renderVideo('edit.video.ts', 'delivery.mp4', {
  signal: AbortSignal.timeout(60_000),
  processing: {
    cacheDirectory: './recipe-cache',
    concurrency: 2,
    onProgress: ({ assetId, step, status, seconds }) => {
      console.error(assetId, step, status, seconds);
    },
  },
});
```

`inspectVideoRecipes` validates recipes and probes their sources without
creating cache entries. Its `steps` give the ordered parameters, output
format, and estimated media metadata. `compileVideo`, `renderVideo`, and
`watchVideo` accept `processing` settings. They use the same cache and limits
as the CLI. A compiled video exposes `recipes` and binds its render plan to
the measured processed media. In inspection, `videoStartSeconds` and
`audioStartSeconds` are offsets from that step’s output container start.
`audioDurationSeconds` is the audio end on that clock, including any delay
before the audio stream starts.

The `onProgress` callback receives the asset ID, zero-based step index,
cache key, output `format`, and a `status` of `started`, `processing`, `completed`, or
`cache-hit`. `seconds` is the output media time reported during processing.
Pass a signal to `compileVideo` or `renderVideo` to cancel preprocessing.

`VideoProcessingOptions` accepts `maxTemporaryBytes`, `maxNativeBytes`,
`maxBufferedFrames`, `maxPixels`, and `timeoutMs`. See the
[processing limits](CLI.md#media-recipes) for defaults and scope.

## Recovery and portable projects

```ts
import {
  inspectVideoBuild,
  packageVideo,
  renderVideo,
  verifyVideoPackage,
} from '@opencut/cli/sdk';

const processing = { cacheDirectory: './recipe-cache' };
const status = await inspectVideoBuild('src/edit.video.ts', { processing });
console.log(status.state, status.steps, status.renders);

await packageVideo('src/edit.video.ts', './bundle', {
  root: '.',
  resources: ['src/captions.txt'],
});
const verified = await verifyVideoPackage('./bundle');
await renderVideo(verified.entry, 'delivery.mp4', { processing });
```

Use the same inputs, cache, and quality profile when inspecting or retrying a
build. `inspectVideoBuild` hashes inputs and reports checkpoints for the
current revision. If you called `renderVideo` at default quality with
`burnSubtitles: false`, inspect it with `{ preview: true, quality: 'quality' }`.
A recipe step can be reusable while still staged. A render with a valid
published file can also carry a
`lastAttempt` from a newer retry. See [build recovery](CLI.md#build-recovery).

Pass `params` to select the composition and `signal` to cancel
`packageVideo`, including during TypeScript evaluation. The returned
`entry` points to the resolved definition. The manifest names the original
editable source and its relative imports. See the
[portable project rules and backend requirements](CLI.md#portable-projects).

## Parameterized builds

`defineVideo(shape, compose)` infers the type of `compose`'s argument from a
strict Zod shape. Import the schema builders as `videoParams` from
`@opencut/sdk`. Pass a JSON object as `params` to `compileVideo`,
`renderVideo`, or `inspectVideoRecipes`. The resolved parameters and
definition fingerprints are available in `CompiledVideo.build`. The
compiled project and its build record are deeply frozen. See the
[authoring example](VIDEO_DEFINITIONS.md#reusable-functions-and-parameters).

```ts
import { batchRenderVideo, renderVideo } from '@opencut/cli/sdk';
import type { VideoVariant } from '@opencut/cli/sdk';

const file = 'examples/video/short-batch.video.ts';
const variants = [
  {
    id: 'wide',
    params: {
      layout: 'wide',
      title: 'Studio dispatch',
      subtitle: 'From the studio',
    },
  },
  {
    id: 'tall',
    params: {
      layout: 'tall',
      title: 'Studio vertical',
      subtitle: 'A closer look',
    },
  },
  {
    id: 'square',
    output: 'field-square.mp4',
    params: {
      layout: 'square',
      title: 'From the field',
      subtitle: 'On location',
      footage: 'field',
      music: 'location',
    },
  },
] satisfies VideoVariant[];

await renderVideo(file, 'wide.mp4', { params: variants[0].params });
const batch = await batchRenderVideo(file, variants, {
  outputDirectory: './outputs',
  concurrency: 2,
  processing: { cacheDirectory: './recipe-cache' },
  onProgress: (event) => console.error(event),
});
const retryIds = batch.variants
  .filter(({ status }) => status !== 'completed')
  .map(({ id }) => id);
```

Fix a failed entry and pass its ID in `only` to retry it. Results are in
manifest order. Each has an ID, output path, elapsed time, and status.
Completed results contain the verified render and its build record in
`render.build`. The record includes any frame range or size cap applied by
the renderer. Failures contain the phase, error code, and message.
Cancellations record the reason.
Pass an `AbortSignal` to cancel active and queued work, or enable `failFast`
to stop on a variant failure. An exception from `onProgress` cancels the batch
and rejects the call after cleanup. Invalid manifests and duplicate output
paths reject before the scheduler starts. See the [batch limits and file
contract](CLI.md#batch-rendering).

# TypeScript SDK

The installed CLI and review app include the authoring SDK. A `.video.ts`
definition can import `@opencut/sdk` without setting up a Node project.
For TypeScript editor support or SDK usage from a separate Node program,
install `@dantea/opencut` locally and use the `@dantea/opencut/sdk` export in the
examples below. See the [installation guide](INSTALL.md#pnpm).

Use Node 24.12+ (within 24.x). The CLI resolves bundled SDK imports from
trusted `.video.ts` definitions, which should default-export
`defineVideo({...})`. The following examples are for separate Node programs
with the CLI package installed locally.

```ts
import {
  compileVideo,
  previewVideo,
  renderCompiledVideo,
} from '@dantea/opencut/sdk';

const video = await compileVideo('edit.video.ts');
const preview = previewVideo(video);
await preview.frame(30, 'review.png');
await renderCompiledVideo(video, 'delivery.mp4', {
  quality: 'maximum',
  encoder: 'auto',
  onProgress: ({ stage, percent }) => {
    if (stage === 'encoding' || stage === 'verification') {
      console.error(percent);
    }
  },
});
```

Use `renderVideo(file, output, options)` to compile and render in one call.
A compiled render checks source identities before decoding or reusing
picture. It copies media on first decode. If a source has changed, compile
the definition again.
Pass an `AbortSignal` to cancel a foreground render.

`onProgress` reports frame counts and percentages within each `stage`.
For a single encoding progress bar, use the `encoding` and `verification`
events, as above. Graphic capture can report a separate 0–100% sequence for
each `clipId`. Direct exports can compose and encode together, and reuse of
saved picture packets skips encoding.

Set `encoder` to `'auto'`, `'software'` or `'videotoolbox'`. The render
result reports the selected encoder and its effective settings. OpenCut
defaults to software and includes `encoder.fallbackReason` when `auto`
selects software after a hardware probe failure. Checkpointed renders
include `outputFingerprint` with the published MP4's byte count and SHA-256.
See [encoder selection](CLI.md#encoder-selection-and-render-progress).

To render an exact set of definition frames, pass `frames` to
`previewVideo(video).contactSheet()`.

```ts
const sheet = await preview.contactSheet(
  { startFrame: 29, endFrame: 32 },
  'frames.png',
  { frames: [29, 30, 31] },
);
console.log(sheet.samples);
```

Use the [CLI contact-sheet command](CLI.md#frame-targeted-contact-sheets) to
sample a finished MP4 and write a JSON sidecar.

Pass the same `pictureCacheDirectory` to `renderVideo` or
`renderCompiledVideo` on the initial export and revisions. The result
includes `pictureRanges` with zero-based project frames in `startFrame`
and `endFrame` (exclusive) and a `status` of `reused` or `rendered`.
See [picture cache behavior and storage](CLI.md#reuse-picture-between-exports).

For an audio-only revision, set `pictureVersion: 'save'` on the initial
render and keep its `pictureVersion.id`. Pass that ID as `pictureVersion`
on the next render with the same cache directory and video settings. A
successful reuse reports `pictureVersion.status: 'reused'` and copies the
encoded video packets. Use `'save'` again after changing the picture or its
video export settings, including audio inputs used by graphics. For mixed-source
graphics with Professional Dialogue Mix enabled, this includes changes to
`audioChannels`, `audioSampleRate`, or `audioBitrateKbps`.

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

For a definition with music candidates, call
`watcher.selectMusic({ candidate: 'soft-bed', matchLoudness: true })` to
request a new playback revision. Supply either field to change it
independently. If an edit removes the auditioned candidate, the watcher
falls back to the definition's selection. Use the revision's
`dialogueMixRevision` as the reset key for an editable mix draft. It stays
stable during music auditions. The `sourceRevision` also reflects the
active music selection.

The SDK also exposes `probeMedia`, `extractFrame`, `OnlineMediaLibrary`,
`separateDialogue`, and subtitle parsing and file tools.

`extractFrame(file, seconds, output, signal?)`,
`OnlineMediaLibrary.search(query, signal?)`, and
`OnlineMediaLibrary.download(id, directory, signal?)` accept optional
cancellation signals. Frame extraction requires a destination that supports
hard links to publish the completed PNG atomically.

## React and SVG graphics

`VideoDefinition` accepts `GraphicAssetDefinition` on video tracks. Declare
React props at the asset and override them at the placement. The SDK exports
`GraphicAssetDefinition` and `GraphicProps` for typed helpers. `compileVideo`,
`previewVideo`, `renderCompiledVideo`, `watchVideo` and `packageVideo` share
pinned graphic sources. See the [graphics runtime and authoring API](GRAPHICS.md).

## Media recipes

```ts
import { inspectVideoRecipes, renderVideo } from '@dantea/opencut/sdk';

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

## Layout checks and render planning

`inspectVideoLayout(video, { burnSubtitles, signal })` checks a compiled
video's declared layout assertions. It returns `ok` and the individual
`checks`, including advisory failures. Set `burnSubtitles: false` to
check the layout that would be rendered with subtitles disabled.
`renderVideo` and `renderCompiledVideo` enforce required assertions
before encoding.

`planVideoRender(definition, output, options)` accepts the intended
render settings and returns the recipe and picture cache decisions,
scratch-space estimates and available bytes without writing the render
or cache. A blocked saved picture version returns `ok: false`. See the
[CLI render plan](CLI.md#read-only-render-plan) for the report fields.

## Recovery and portable projects

```ts
import {
  inspectVideoBuild,
  packageVideo,
  renderVideo,
  verifyVideoPackage,
} from '@dantea/opencut/sdk';

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
import { batchRenderVideo, renderVideo } from '@dantea/opencut/sdk';
import type { VideoVariant } from '@dantea/opencut/sdk';

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

## Professional Dialogue Mix

Call `analyzeVideoMix(compiledVideo, options)` to generate dialogue and music curves and verify delivery loudness without rendering picture. Mix-enabled export and clip preview results include `audioMix`. See [definition and SDK examples](AUDIO_MIX.md).

Pass `musicSelection: { candidate: 'soft-bed', matchLoudness: true }` to
`compileVideo` or `renderVideo` to override the definition's
[music selection](AUDIO_MIX.md#compare-music-candidates). A clip preview or
`renderCompiledVideo` uses the selection from the compiled revision. Read
`musicComparison` for the selected track and source provenance, and
`musicLoudness` for the target and applied gain when loudness matching is
enabled.

## Declarative graphics

`compileVideo`, `renderVideo`, `watchVideo`, `batchRenderVideo` and
`packageVideo` accept `.video.ts` definitions. Pass `params` to use a
declared variant. Use `videoDefinitionFormats` and
`videoGraphicsCapabilities` for discovery. `inspectGraphicFrames(video, frame)`
returns source time and backend information for the graphic samples chosen
by the compiled plan, without launching Chromium.

Use `defineGraphicScene` for a typed node tree or `createPresetScene` for
a sized preset.
See [scene contracts, motion and optional adapters](GRAPHICS.md).

## Convert a legacy definition

Import `convertJsonVideoDefinition` from `@opencut/sdk` and pass the JSON text.
It returns TypeScript source with any parameter schemas and bindings. When
writing the result yourself, choose a `.video.ts` filename beside the resolved
JSON source to preserve relative asset paths. OpenCut reserves
`opencut.bundle.video.ts` for portable packages. See the
[CLI conversion command](CLI.md#convert-a-legacy-definition) for file-based migration.

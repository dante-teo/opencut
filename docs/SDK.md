# TypeScript SDK

Use Node 24.12+ (within 24.x) and import the definition API from
`@opencut/sdk`. A trusted .video.ts file should default-export
`defineVideo({...})`. The matching .video.json form needs no JavaScript.

```ts
import { compileVideo, previewVideo, renderCompiledVideo } from '@opencut/sdk';

const video = await compileVideo('edit.video.ts');
const preview = previewVideo(video);
await preview.frame(30, 'review.png');
await renderCompiledVideo(video, 'delivery.mp4', {
  quality: 'high',
  onProgress: ({ percent }) => console.error(percent),
});
```

Use `renderVideo(file, output, options)` to compile and render in one call.
A compiled render checks the identity of each source it uses before copying
it for the render. If a source has changed, compile the definition again.
Pass an `AbortSignal` to cancel a foreground render.

`watchVideo(path, { onStatus })` manages a temporary playback file, retains
the last good revision on failure, and must be closed when finished. Use
`withCurrent(generation, callback)` on the watcher to keep that revision’s
media available during a render. The callback must finish before the watcher
can close.

The SDK also exposes `probeMedia`, `extractFrame`, `OnlineMediaLibrary`,
`separateDialogue`, and subtitle parsing and file tools.

`extractFrame(file, seconds, output, signal?)`,
`OnlineMediaLibrary.search(query, signal?)`, and
`OnlineMediaLibrary.download(id, directory, signal?)` accept optional
cancellation signals. Frame extraction requires a destination that supports
hard links to publish the completed PNG atomically.

## Media recipes

```ts
import { inspectVideoRecipes, renderVideo } from '@opencut/sdk';

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
cache key, and a `status` of `started`, `processing`, `completed`, or
`cache-hit`. `seconds` is the output media time reported during processing.
Pass a signal to `compileVideo` or `renderVideo` to cancel preprocessing.

`VideoProcessingOptions` accepts `maxTemporaryBytes`, `maxNativeBytes`,
`maxBufferedFrames`, `maxPixels`, and `timeoutMs`. See the
[processing limits](CLI.md#media-recipes) for defaults and scope.

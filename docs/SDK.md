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

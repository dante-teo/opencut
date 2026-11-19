import { mkdir, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MediaError, recipeBackendVersion } from '@opencut/media';
import type { PictureCache } from '@opencut/media';
import type { CompiledVideo } from './video-compiler.js';
import { videoInputIdentity } from './video-input.js';
import { materializeMediaEntry } from './video-media-cache.js';

export async function openPictureCache(
  directory: string,
  video: CompiledVideo,
  signal: AbortSignal = new AbortController().signal,
): Promise<PictureCache> {
  if (!directory.trim())
    throw new MediaError('Choose a picture cache directory.');
  const root = resolve(directory, 'picture-v1');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const cache = await realpath(root);
  if (/[\r\n]/.test(cache))
    throw new MediaError('Picture cache paths cannot contain line breaks.');
  return {
    backend: await recipeBackendVersion(signal),
    sourceIdentity(path) {
      signal.throwIfAborted();
      const identity = video.sourceIdentity(path);
      if (!identity || videoInputIdentity(path) !== identity)
        throw new MediaError(
          `Media '${path}' changed after it was read. Compile the definition again.`,
        );
      return identity;
    },
    async materialize(key, encode) {
      const { entry, reused } = await materializeMediaEntry(
        cache,
        key,
        'nut',
        signal,
        encode,
      );
      return { path: entry.metadata.path, reused };
    },
  };
}

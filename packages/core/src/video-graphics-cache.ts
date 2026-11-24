import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { accountRenderBytes, MediaError, probeMedia } from '@opencut/media';
import { hashJson } from './video-integrity.js';
import { materializeMediaEntry } from './video-media-cache.js';

export function graphicsFrameCache(directory: string) {
  const root = resolve(directory, 'graphics-v1');
  // Bound new persistent sample data written by a single render.
  let remaining = 256 * 1024 * 1024;
  let created: Promise<unknown> | undefined;
  return async (
    source: string,
    frame: number | string,
    render: () => Promise<Buffer>,
    signal: AbortSignal = new AbortController().signal,
    onHit?: () => void,
  ) => {
    if (remaining < 3840 * 2160 * 4 + 1024 * 1024) return render();
    await (created ??= mkdir(root, { recursive: true, mode: 0o700 }));
    const key = hashJson([source, frame]);
    let raster: Buffer | undefined;
    const { entry } = await materializeMediaEntry(
      root,
      key,
      'png',
      signal,
      async (path) => {
        raster = await render();
        accountRenderBytes(raster.length);
        remaining -= raster.length;
        await writeFile(path, raster, { flag: 'wx', signal });
        return probeMedia(path, signal);
      },
    );
    if (raster) return raster;
    const bytes = await readFile(entry.metadata.path, { signal });
    if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256)
      throw new MediaError('Cached graphics frame changed while reading.');
    onHit?.();
    return bytes;
  };
}

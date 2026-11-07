import { LRUCache } from 'lru-cache';
import {
  checkRenderSignal,
  localFile,
  MediaError,
  runMediaTool,
  sourceFileStamp,
} from './process.js';

export interface ThumbnailResult {
  bytes: Buffer;
  decoder: 'videotoolbox' | 'software';
}
/** Small navigation images have a separate in-memory cache and no playback lock. */
export class ThumbnailCache {
  private readonly images = new LRUCache<string, ThumbnailResult>({
    max: 128,
    maxSize: 8 * 1024 ** 2,
    sizeCalculation: (value) => value.bytes.length,
  });
  private readonly softwareOnly = new Set<string>();
  private readonly costs = new LRUCache<
    string,
    Partial<Record<ThumbnailResult['decoder'], number>>
  >({ max: 128 });
  clear() {
    this.images.clear();
    this.softwareOnly.clear();
    this.costs.clear();
  }
  async get(
    file: string,
    timestamp: number,
    options: {
      hardware: boolean;
      signal?: AbortSignal | undefined;
      count?: number;
      interval?: number;
      adaptive?: boolean;
    },
  ): Promise<ThumbnailResult> {
    checkRenderSignal(options.signal);
    if (!Number.isFinite(timestamp) || timestamp < 0)
      throw new MediaError('Invalid thumbnail timestamp.');
    const count = options.count ?? 1;
    const interval = options.interval ?? 0;
    if (
      !Number.isInteger(count) ||
      count < 1 ||
      count > 4 ||
      (count > 1 &&
        (!Number.isFinite(interval) || interval <= 0 || interval > 1.5))
    )
      throw new MediaError('Invalid thumbnail batch.');
    const path = await localFile(file);
    const stamp = await sourceFileStamp(path);
    const time = timestamp.toFixed(6);
    const key = JSON.stringify([
      path,
      stamp,
      time,
      options.hardware,
      options.adaptive ?? false,
      count,
      interval,
    ]);
    const cached = this.images.get(key);
    if (cached) return cached;
    const fps = count > 1 ? 1 / interval : 1;
    const decode = async (hardware: boolean): Promise<ThumbnailResult> => {
      const bytes = await runMediaTool(
        'ffmpeg',
        [
          '-v',
          'error',
          '-nostdin',
          '-threads',
          '2',
          ...(hardware ? ['-hwaccel', 'videotoolbox'] : []),
          '-ss',
          time,
          '-noaccurate_seek',
          '-copyts',
          '-start_at_zero',
          '-i',
          path,
          '-map',
          '0:V:0',
          '-an',
          '-vf',
          // Retain pre-seek frames so each sample uses its covering frame.
          `settb=AVTB,setpts=PTS-(${time})/TB,fps=fps=${fps}:start_time=0:round=up:eof_action=pass,scale=144:80:force_original_aspect_ratio=increase,crop=144:80,setsar=1${count > 1 ? `,tile=${count}x1:nb_frames=${count}` : ''}`,
          '-frames:v',
          '1',
          '-threads',
          '1',
          '-c:v',
          'mjpeg',
          '-q:v',
          '5',
          '-f',
          'image2pipe',
          'pipe:1',
        ],
        256 * 1024,
        15000,
        { signal: options.signal },
      );
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8)
        throw new MediaError('No thumbnail could be decoded.');
      return { bytes, decoder: hardware ? 'videotoolbox' : 'software' };
    };
    let result: ThumbnailResult;
    const profile = JSON.stringify([path, stamp, count, interval]);
    const cost = this.costs.get(profile) ?? {};
    // Return a software batch immediately. Try hardware on subsequent expensive
    // batches, then keep whichever decoder was measured faster for this source.
    const adaptiveHardware =
      cost.software !== undefined &&
      cost.software > 100 &&
      (cost.videotoolbox === undefined || cost.videotoolbox < cost.software);
    const hardware =
      process.platform === 'darwin' &&
      options.hardware &&
      !this.softwareOnly.has(profile) &&
      (!options.adaptive || adaptiveHardware);
    const started = performance.now();
    try {
      result = await decode(hardware);
    } catch (error) {
      checkRenderSignal(options.signal);
      if (!hardware) throw error;
      if (this.softwareOnly.size >= 128) this.softwareOnly.clear();
      this.softwareOnly.add(profile);
      result = await decode(false);
    }
    checkRenderSignal(options.signal);
    if (stamp !== (await sourceFileStamp(path)))
      throw new MediaError('Source changed while generating its thumbnail.');
    cost[result.decoder] = performance.now() - started;
    this.costs.set(profile, cost);
    this.images.set(key, result);
    return result;
  }
}

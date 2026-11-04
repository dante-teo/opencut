import { sourceColorMatrix } from '@opencut/shared';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { LRUCache } from 'lru-cache';
import lockfile from 'proper-lockfile';
import { probeMedia, type MediaMetadata } from './probe.js';
import {
  checkRenderSignal,
  MediaError,
  RenderCancelledError,
  runMediaTool,
} from './process.js';
import { renderProgress, type RenderProgress } from './render-progress.js';

export interface CacheLimits {
  diskBytes: number;
  memoryBytes: number;
}
export const defaultCacheLimits: CacheLimits = {
  diskBytes: 2 * 1024 ** 3,
  memoryBytes: 64 * 1024 ** 2,
};
export function defaultMediaCacheDirectory() {
  return (
    process.env.OPENCUT_MEDIA_CACHE ??
    join(homedir(), '.cache', 'opencut', 'media-v1')
  );
}
export interface CacheEntry {
  key: string;
  kind: 'proxy' | 'frame';
  bytes: number;
  hash: string;
  source: string;
  sourceHash: string;
  accessed: number;
}
export interface CacheStatus {
  directory: string;
  limits: CacheLimits;
  diskBytes: number;
  memoryBytes: number;
  hits: number;
  misses: number;
  entries: CacheEntry[];
}
export interface ProxyResult {
  path: string;
  proxy: boolean;
  key: string;
  /** Original display aspect, invariant under proxy rounding. */
  displayAspectRatio?: number;
  reason?: string;
}
export interface CacheControls {
  signal?: AbortSignal;
  onProgress?: (progress: RenderProgress) => void;
  force?: boolean;
}
const settings = {
  version: 3,
  width: 960,
  height: 540,
  codec: 'libx264',
  crf: 28,
  gop: 30,
  timing: 'passthrough-verified',
  audio: 'aac-copy',
};
const digest = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
const entryName = (key: string, kind: CacheEntry['kind']) =>
  `${key}.${kind === 'proxy' ? 'mp4' : 'png'}`;
export function validateCacheLimits(value: CacheLimits) {
  if (
    !value ||
    Object.keys(value).sort().join(',') !== 'diskBytes,memoryBytes' ||
    !Number.isSafeInteger(value.diskBytes) ||
    value.diskBytes < 1024 * 1024 ||
    value.diskBytes > 1024 ** 4 ||
    !Number.isSafeInteger(value.memoryBytes) ||
    value.memoryBytes < 1024 * 1024 ||
    value.memoryBytes > 1024 ** 3
  )
    throw new MediaError(
      'Cache limits require diskBytes (1 MiB–1 TiB) and memoryBytes (1 MiB–1 GiB).',
    );
  return value;
}
async function hashFile(path: string, signal?: AbortSignal) {
  const hash = createHash('sha256');
  const stream = createReadStream(path, {
    highWaterMark: 1024 * 1024,
    ...(signal ? { signal } : {}),
  });
  for await (const chunk of stream) {
    checkRenderSignal(signal);
    hash.update(chunk);
  }
  return hash.digest('hex');
}
async function identity(path: string) {
  const info = await stat(path, { bigint: true });
  if (!info.isFile())
    throw new MediaError('Cache source must be a regular file.');
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
}

/** Owns only digest-named derivatives. Originals are read-only; export never calls this API. */
export class MediaCache {
  private root: string;
  get directory() {
    return this.root;
  }
  private limits = { ...defaultCacheLimits };
  private readonly memory = new LRUCache<string, Buffer>({
    max: 256,
    maxSize: 1024 ** 3,
    sizeCalculation: (b) => b.byteLength,
  });
  private readonly sources = new LRUCache<
    string,
    { stamp: string; hash: string; media: MediaMetadata }
  >({ max: 64 });
  private hits = 0;
  private misses = 0;
  private queue = Promise.resolve();
  constructor(directory = defaultMediaCacheDirectory()) {
    this.root = resolve(directory);
  }
  private async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if ((await lstat(this.directory)).isSymbolicLink())
      throw new MediaError('Cache directory cannot be a symlink.');
    this.root = await realpath(this.directory);
    const marker = join(this.directory, '.opencut-media-cache-v1');
    try {
      await readFile(marker);
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw error;
      const existing = await readdir(this.directory);
      if (existing.length && !existing.includes('.opencut-media-cache-v1'))
        throw new MediaError('Choose a dedicated empty cache directory.');
      await writeFile(marker, 'opencut-media-cache-v1', {
        flag: 'wx',
        mode: 0o600,
      }).catch((error: unknown) => {
        if (!(
          error instanceof Error &&
          'code' in error &&
          error.code === 'EEXIST'
        ))
          throw error;
      });
    }
    try {
      this.limits = validateCacheLimits(
        JSON.parse(
          await readFile(join(this.directory, 'config.json'), 'utf8'),
        ) as CacheLimits,
      );
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw error;
    }
    // LRU maxSize is fixed; enforce changed budgets explicitly too.
    while (this.memory.calculatedSize > this.limits.memoryBytes)
      this.memory.pop();
  }
  private async exclusive<T>(
    work: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const preceding = this.queue;
    let done!: () => void;
    const turn = new Promise<void>((r) => {
      done = r;
    });
    this.queue = preceding.then(() => turn);
    let release: (() => Promise<void>) | undefined;
    try {
      checkRenderSignal(signal);
      let abort: (() => void) | undefined;
      try {
        await Promise.race([
          preceding,
          new Promise<never>((_resolve, reject) => {
            abort = () => reject(new RenderCancelledError());
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort();
          }),
        ]);
      } finally {
        if (abort) signal?.removeEventListener('abort', abort);
      }
      await this.initialize();
      // The lock heartbeat and stale recovery come from proper-lockfile. Waits are cancellable.
      while (!release) {
        checkRenderSignal(signal);
        try {
          release = await lockfile.lock(this.directory, {
            realpath: false,
            stale: 10000,
            update: 2000,
          });
        } catch (error) {
          if (!(
            error instanceof Error &&
            'code' in error &&
            error.code === 'ELOCKED'
          ))
            throw error;
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      checkRenderSignal(signal);
      await this.initialize();
      return await work();
    } finally {
      try {
        await release?.();
      } finally {
        done();
      }
    }
  }
  private async source(file: string, signal?: AbortSignal) {
    checkRenderSignal(signal);
    const path = await realpath(file);
    const local = relative(this.directory, path);
    if (!local.startsWith('..'))
      throw new MediaError(
        'Original media must be outside the dedicated cache directory.',
      );
    const stamp = await identity(path);
    const previous = this.sources.get(path);
    if (previous?.stamp === stamp) return { ...previous, path };
    const hash = await hashFile(path, signal);
    const media = await probeMedia(path, signal);
    if (stamp !== (await identity(path)))
      throw new MediaError('Source changed during cache identification.');
    const value = { stamp, hash, media };
    this.sources.set(path, value);
    return { ...value, path };
  }
  private async entries(): Promise<CacheEntry[]> {
    const entries: CacheEntry[] = [];
    for (const name of await readdir(this.directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      try {
        const entry = JSON.parse(
          await readFile(join(this.directory, name), 'utf8'),
        ) as CacheEntry;
        if (
          entry.key + '.json' !== name ||
          !['frame', 'proxy'].includes(entry.kind) ||
          !Number.isSafeInteger(entry.bytes) ||
          entry.bytes < 0 ||
          !/^[a-f0-9]{64}$/.test(entry.hash)
        )
          continue;
        const info = await lstat(
          join(this.directory, entryName(entry.key, entry.kind)),
        );
        if (!info.isFile() || info.isSymbolicLink()) continue;
        entries.push({
          ...entry,
          accessed: (await stat(join(this.directory, name))).mtimeMs,
          bytes: info.size + Buffer.byteLength(JSON.stringify(entry)),
        });
      } catch {
        /* Incomplete entries are never advertised. */
      }
    }
    return entries;
  }
  async status(): Promise<CacheStatus> {
    await this.initialize();
    const entries = await this.entries();
    // Includes interrupted/partial files so reported disk usage is honest.
    let diskBytes = 0;
    for (const name of await readdir(this.directory)) {
      if (
        /^[a-f0-9]{64}\.(json|mp4|png)$/.test(name) ||
        /^partial-[a-f0-9-]{36}(\.(mp4|png))?$/.test(name)
      ) {
        const info = await lstat(join(this.directory, name)).catch(() => null);
        if (info?.isFile()) diskBytes += info.size;
      }
    }
    return {
      directory: this.directory,
      limits: this.limits,
      diskBytes,
      memoryBytes: this.memory.calculatedSize,
      hits: this.hits,
      misses: this.misses,
      entries,
    };
  }
  async configure(limits: CacheLimits) {
    validateCacheLimits(limits);
    return this.exclusive(async () => {
      const temporary = join(this.directory, `partial-${randomUUID()}`);
      try {
        await writeFile(temporary, JSON.stringify(limits), {
          flag: 'wx',
          mode: 0o600,
        });
        await rename(temporary, join(this.directory, 'config.json'));
      } finally {
        await rm(temporary, { force: true });
      }
      this.limits = { ...limits };
      while (this.memory.calculatedSize > limits.memoryBytes) this.memory.pop();
      await this.evict(0);
      return this.status();
    });
  }
  private async remove(entry: Pick<CacheEntry, 'key' | 'kind'>) {
    this.memory.delete(entry.key);
    await rm(join(this.directory, `${entry.key}.json`), { force: true });
    await rm(join(this.directory, entryName(entry.key, entry.kind)), {
      force: true,
    });
  }
  private async evict(reserve: number, keep?: string) {
    // Under the global writer lock, remove abandoned staging files and orphans.
    const entries = await this.entries();
    const live = new Set(
      entries.flatMap((e) => [`${e.key}.json`, entryName(e.key, e.kind)]),
    );
    for (const name of await readdir(this.directory)) {
      if (
        join(this.directory, name) !== keep &&
        (/^partial-[a-f0-9-]{36}(\.(mp4|png))?$/.test(name) ||
          (/^[a-f0-9]{64}\.(json|mp4|png)$/.test(name) && !live.has(name)))
      )
        await rm(join(this.directory, name), { force: true });
    }
    let size = entries.reduce((n, e) => n + e.bytes, 0);
    let count = entries.length;
    for (const entry of entries.sort((a, b) => a.accessed - b.accessed)) {
      if (size + reserve <= this.limits.diskBytes && count < 4096) break;
      await this.remove(entry);
      size -= entry.bytes;
      count--;
    }
  }
  async clear() {
    return this.exclusive(async () => {
      for (const entry of await this.entries()) await this.remove(entry);
      this.memory.clear();
      await this.evict(0);
      return this.status();
    });
  }
  async cleanup() {
    return this.exclusive(async () => {
      for (const entry of await this.entries()) {
        try {
          if (
            (await hashFile(await realpath(entry.source))) !==
              entry.sourceHash ||
            (await hashFile(
              join(this.directory, entryName(entry.key, entry.kind)),
            )) !== entry.hash
          )
            await this.remove(entry);
        } catch {
          await this.remove(entry);
        }
      }
      await this.evict(0);
      return this.status();
    });
  }
  private async lookup(
    key: string,
    kind: CacheEntry['kind'],
    signal?: AbortSignal,
  ) {
    const path = join(this.directory, entryName(key, kind));
    try {
      const entry = JSON.parse(
        await readFile(join(this.directory, `${key}.json`), 'utf8'),
      ) as CacheEntry;
      const info = await lstat(path);
      if (
        entry.key !== key ||
        entry.kind !== kind ||
        info.isSymbolicLink() ||
        !info.isFile() ||
        info.size !== entry.bytes ||
        (await hashFile(path, signal)) !== entry.hash
      )
        return null;
      await utimes(join(this.directory, `${key}.json`), new Date(), new Date());
      this.hits++;
      return path;
    } catch {
      checkRenderSignal(signal);
      return null;
    }
  }
  private async publish(
    key: string,
    kind: CacheEntry['kind'],
    temporary: string,
    source: { path: string; hash: string; stamp: string },
    signal?: AbortSignal,
  ) {
    checkRenderSignal(signal);
    if (source.stamp !== (await identity(source.path)))
      throw new MediaError('Source changed during generation.');
    const bytes = (await stat(temporary)).size;
    const entry: CacheEntry = {
      key,
      kind,
      bytes,
      hash: await hashFile(temporary, signal),
      source: source.path,
      sourceHash: source.hash,
      accessed: Date.now(),
    };
    const data = JSON.stringify(entry);
    if (bytes + Buffer.byteLength(data) > this.limits.diskBytes)
      throw new MediaError('Derivative exceeds the disk cache limit.');
    await this.evict(bytes + Buffer.byteLength(data), temporary);
    checkRenderSignal(signal);
    const path = join(this.directory, entryName(key, kind));
    await rename(temporary, path);
    await writeFile(join(this.directory, `${key}.json`), data, { mode: 0o600 });
    return path;
  }
  async select(file: string, signal?: AbortSignal): Promise<ProxyResult> {
    await this.initialize();
    const source = await this.source(file, signal);
    const key = digest(JSON.stringify([source.hash, source.media, settings]));
    const path = await this.lookup(key, 'proxy', signal);
    const video = source.media.video;
    const aspect =
      video?.width && video.height
        ? (video.width * (video.sampleAspectRatio ?? 1)) / video.height
        : undefined;
    return {
      path: path ?? source.path,
      proxy: !!path,
      key,
      ...(aspect
        ? {
            displayAspectRatio:
              Math.abs(video?.rotation ?? 0) % 180 === 90 ? 1 / aspect : aspect,
          }
        : {}),
    };
  }
  async generateProxy(
    file: string,
    controls: CacheControls = {},
  ): Promise<ProxyResult> {
    return this.exclusive(async () => {
      const source = await this.source(file, controls.signal);
      const { media } = source;
      const video = media.video;
      const key = digest(JSON.stringify([source.hash, media, settings]));
      const existing =
        !controls.force && (await this.lookup(key, 'proxy', controls.signal));
      if (existing) return { path: existing, proxy: true, key };
      this.misses++;
      // Reject timing we cannot prove equivalent in Chromium's source-time domain.
      if (
        !video ||
        !media.durationSeconds ||
        media.durationSeconds > 600 ||
        !video.frameRate ||
        video.hasAlpha ||
        Math.abs(media.startTimeSeconds ?? 0) > 0.002 ||
        Math.abs(video.startTimeSeconds ?? 0) > 0.002 ||
        (media.audio &&
          (media.audio.codec !== 'aac' ||
            Math.abs(media.audio.startTimeSeconds ?? 0) > 0.002))
      )
        return {
          path: source.path,
          proxy: false,
          key,
          reason:
            'Proxy requires an opaque zero-origin video up to 600 seconds with optional zero-origin AAC audio; original retained.',
        };
      await this.evict(0);
      const temporary = join(this.directory, `partial-${randomUUID()}.mp4`);
      const progress = renderProgress(
        Math.max(1, Math.round(media.durationSeconds * video.frameRate)),
        controls.onProgress,
      );
      try {
        progress.start();
        // Reserve the entire bounded staging allowance before encoding. No published entries are at risk of being confused with a partial result.
        const allowance = Math.min(
          this.limits.diskBytes,
          Math.max(1024 * 1024, Math.ceil(media.durationSeconds * 1024 * 1024)),
        );
        await this.evict(allowance);
        await runMediaTool(
          'ffmpeg',
          [
            '-v',
            'error',
            '-nostdin',
            '-n',
            '-threads',
            '2',
            '-copyts',
            '-start_at_zero',
            '-i',
            source.path,
            '-map',
            `0:${video.index}`,
            ...(media.audio ? ['-map', `0:${media.audio.index}`] : []),
            '-vf',
            `scale=w='min(960,iw)':h='min(540,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:in_color_matrix=${sourceColorMatrix(video.colorSpace, video.width ?? 0, video.height ?? 0, video.codec)}:out_color_matrix=bt709`,
            '-colorspace',
            'bt709',
            '-color_primaries',
            'bt709',
            '-color_trc',
            'bt709',
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
            '-crf',
            '28',
            '-threads',
            '2',
            '-g',
            '30',
            '-bf',
            '0',
            '-pix_fmt',
            'yuv420p',
            '-fps_mode',
            'passthrough',
            '-c:a',
            'copy',
            '-map_metadata',
            '-1',
            '-movflags',
            '+faststart',
            '-fs',
            String(allowance - 65536),
            '-progress',
            'pipe:1',
            '-nostats',
            temporary,
          ],
          4 * 1024 * 1024,
          30 * 60_000,
          { signal: controls.signal, onStdout: progress.chunk },
        );
        progress.verifying();
        const output = await probeMedia(temporary, controls.signal);
        if (
          !output.video ||
          !!output.audio !== !!media.audio ||
          Math.abs((output.durationSeconds ?? 0) - media.durationSeconds) >
            Math.max(0.05, 1 / video.frameRate) ||
          (media.audio &&
            Math.abs(
              (output.audio?.startTimeSeconds ?? Infinity) -
                (media.audio.startTimeSeconds ?? 0),
            ) > 0.002)
        )
          throw new MediaError('Proxy duration/audio validation failed.');
        const timestamps = async (path: string, index: number) =>
          (
            await runMediaTool(
              'ffprobe',
              [
                '-v',
                'error',
                '-threads',
                '2',
                '-select_streams',
                String(index),
                '-show_frames',
                '-show_entries',
                'frame=best_effort_timestamp_time',
                '-of',
                'csv=p=0',
                path,
              ],
              16 * 1024 * 1024,
              120000,
              { signal: controls.signal },
            )
          )
            .toString()
            .split('\n')
            .filter((line) => /^-?\d/.test(line))
            .map((line) => Number(line.split(',')[0]));
        const original = await timestamps(source.path, video.index);
        const proxy = await timestamps(temporary, output.video.index);
        if (
          !original.length ||
          original.length !== proxy.length ||
          original.some(
            (t, i) =>
              !Number.isFinite(t) ||
              !Number.isFinite(proxy[i]) ||
              Math.abs(t - proxy[i]!) > 0.002,
          )
        )
          throw new MediaError(
            'Proxy frame timestamps differ; original retained.',
          );
        return {
          path: await this.publish(
            key,
            'proxy',
            temporary,
            source,
            controls.signal,
          ),
          proxy: true,
          key,
        };
      } finally {
        await rm(temporary, { force: true });
      }
    }, controls.signal);
  }
  async frame(
    file: string,
    timestamp: number,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    if (!Number.isFinite(timestamp) || timestamp < 0)
      throw new MediaError('Invalid cache frame timestamp.');
    return this.exclusive(async () => {
      const source = await this.source(file, signal);
      const video = source.media.video;
      if (!video || timestamp >= (source.media.durationSeconds ?? Infinity))
        throw new MediaError('Frame is outside source bounds.');
      const key = digest(
        JSON.stringify([
          source.hash,
          source.media,
          'frame-v4-covering-sdr-640x360',
          timestamp,
        ]),
      );
      const cached = this.memory.get(key);
      if (cached) {
        this.hits++;
        return cached;
      }
      const disk = await this.lookup(key, 'frame', signal);
      if (disk) {
        const bytes = await readFile(disk);
        if (bytes.length <= this.limits.memoryBytes)
          this.memory.set(key, bytes);
        while (this.memory.calculatedSize > this.limits.memoryBytes)
          this.memory.pop();
        return bytes;
      }
      this.misses++;
      // Probe from the preceding seek point through the target, retaining VFR PTS.
      // Interval end is absolute: a relative duration would start at the seek point.
      const origin = source.media.startTimeSeconds ?? 0;
      const target = origin + timestamp;
      const [numerator, denominator] = (video.timeBase ?? '')
        .split('/')
        .map(Number);
      if (
        !numerator ||
        !denominator ||
        !Number.isFinite(numerator / denominator)
      )
        throw new MediaError(
          'Video time base is unavailable for cached frames.',
        );
      const frames = await runMediaTool(
        'ffprobe',
        [
          '-v',
          'error',
          '-threads',
          '2',
          '-select_streams',
          String(video.index),
          '-read_intervals',
          `${(Math.floor(target * 1_000_000) / 1_000_000).toFixed(6)}%${(target + 1).toFixed(6)}`,
          '-show_frames',
          '-show_entries',
          'frame=best_effort_timestamp',
          '-of',
          'csv=p=0',
          source.path,
        ],
        4 * 1024 * 1024,
        60000,
        { signal },
      );
      let presentation = -Infinity;
      for (const line of frames.toString().split('\n')) {
        if (!/^-?\d/.test(line)) continue;
        const ticks = Number(line.split(',')[0]);
        if (!Number.isSafeInteger(ticks)) continue;
        const time = (ticks * numerator) / denominator;
        if (time <= target && time > presentation) presentation = time;
      }
      if (!Number.isFinite(presentation))
        throw new MediaError('No frame covers the requested source time.');
      // Seek just before the chosen PTS so microsecond rounding cannot skip it.
      const seek = Math.max(0, presentation - origin - 0.000001);
      const png = await runMediaTool(
        'ffmpeg',
        [
          '-v',
          'error',
          '-nostdin',
          '-threads',
          '2',
          '-ss',
          seek.toFixed(6),
          '-i',
          source.path,
          '-map',
          `0:${video.index}`,
          '-vf',
          `scale=640:360:force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1:in_color_matrix=${sourceColorMatrix(video.colorSpace, video.width ?? 0, video.height ?? 0, video.codec)}`,
          '-frames:v',
          '1',
          '-threads',
          '1',
          '-c:v',
          'png',
          '-f',
          'image2pipe',
          'pipe:1',
        ],
        2 * 1024 * 1024,
        60000,
        { signal },
      );
      if (!png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
        throw new MediaError('No frame at requested source time.');
      const temporary = join(this.directory, `partial-${randomUUID()}.png`);
      try {
        await writeFile(temporary, png, { flag: 'wx', mode: 0o600 });
        await this.publish(key, 'frame', temporary, source, signal);
      } finally {
        await rm(temporary, { force: true });
      }
      if (png.length <= this.limits.memoryBytes) this.memory.set(key, png);
      while (this.memory.calculatedSize > this.limits.memoryBytes)
        this.memory.pop();
      return png;
    }, signal);
  }
}
export function demandingMedia(media: {
  width?: number | null;
  height?: number | null;
  videoCodec?: string | null;
  frameRate?: number | null;
}) {
  return (
    (media.width ?? 0) * (media.height ?? 0) >= 1920 * 1080 ||
    (media.frameRate ?? 0) > 60 ||
    ['hevc', 'av1', 'prores'].includes(media.videoCodec ?? '')
  );
}

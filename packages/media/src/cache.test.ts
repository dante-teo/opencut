import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaCache, demandingMedia } from './cache.js';
import { probeMedia, type MediaMetadata } from './probe.js';
import { runMediaTool, checkRenderSignal } from './process.js';
vi.mock('./probe.js', () => ({ probeMedia: vi.fn() }));
vi.mock('./process.js', async (original) => ({
  ...(await original<typeof import('./process.js')>()),
  runMediaTool: vi.fn(),
}));
let directory: string, source: string, cache: MediaCache;
const media = {
  path: '',
  startTimeSeconds: 0,
  durationSeconds: 2,
  video: {
    index: 0,
    width: 1920,
    height: 1080,
    frameRate: 30,
    timeBase: '1/15360',
    startTimeSeconds: 0,
  },
  audio: null,
} as MediaMetadata;
const png = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  Buffer.alloc(600 * 1024),
]);
beforeEach(async () => {
  vi.resetAllMocks();
  await mkdir(resolve('tests/fixtures/generated'), { recursive: true });
  directory = await mkdtemp(resolve('tests/fixtures/generated/t25-unit-'));
  source = join(directory, 'source.mp4');
  await writeFile(source, 'original-media');
  cache = new MediaCache(join(directory, 'cache'));
  vi.mocked(probeMedia).mockImplementation(async (path) => ({
    ...media,
    path,
  }));
  vi.mocked(runMediaTool).mockImplementation(
    async (tool, args, _max, _timeout, control) => {
      checkRenderSignal(control?.signal);
      if (tool === 'ffprobe')
        return Buffer.from(
          args.includes('frame=best_effort_timestamp')
            ? '0\n512\n1536\n'
            : '0.000000\n0.033333\n0.100000\n',
        );
      if (args.includes('image2pipe')) return png;
      await writeFile(args.at(-1)!, 'valid-proxy');
      return Buffer.alloc(0);
    },
  );
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('bounded derivative cache', () => {
  it('publishes a verified proxy, selects it, preserves originals and reuses its deterministic key', async () => {
    const before = await readFile(source);
    const first = await cache.generateProxy(source);
    expect(first.proxy).toBe(true);
    expect(await cache.select(source)).toEqual({
      ...first,
      displayAspectRatio: 1920 / 1080,
    });
    expect(await cache.generateProxy(source)).toEqual(first);
    expect(await readFile(source)).toEqual(before);
    expect(
      vi.mocked(runMediaTool).mock.calls.filter(([tool]) => tool === 'ffmpeg'),
    ).toHaveLength(1);
    const args = vi
      .mocked(runMediaTool)
      .mock.calls.find(([tool]) => tool === 'ffmpeg')![1];
    expect(args).toEqual(
      expect.arrayContaining([
        '-fps_mode',
        'passthrough',
        '-c:a',
        'copy',
        '-copyts',
        '-start_at_zero',
      ]),
    );
    expect(await readdir(join(directory, 'cache'))).not.toEqual(
      expect.arrayContaining([expect.stringContaining('partial-')]),
    );
  });
  it('invalidates changed bytes even at the same path, size and restored mtime', async () => {
    const original = await cache.generateProxy(source);
    const previous = await stat(source);
    await writeFile(source, 'different-data');
    await utimes(source, previous.atime, previous.mtime);
    const selected = await cache.select(source);
    expect(selected.proxy).toBe(false);
    expect(selected.key).not.toBe(original.key);
    expect((await cache.cleanup()).entries).toHaveLength(0);
  });
  it('falls back after corruption, missing output, missing source and supports regeneration', async () => {
    const proxy = await cache.generateProxy(source);
    await writeFile(proxy.path, 'broken');
    expect((await cache.select(source)).proxy).toBe(false);
    expect((await cache.generateProxy(source)).proxy).toBe(true);
    await rm(proxy.path);
    expect((await cache.select(source)).proxy).toBe(false);
    await rm(source);
    await expect(cache.select(source)).rejects.toThrow();
  });
  it('refuses unverified timestamp remapping and cleans partial output', async () => {
    vi.mocked(runMediaTool).mockImplementation(async (tool, args) => {
      if (tool === 'ffprobe')
        return Buffer.from(args.at(-1) === source ? '0\n0.1\n' : '0\n0.2\n');
      await writeFile(args.at(-1)!, 'proxy');
      return Buffer.alloc(0);
    });
    await expect(cache.generateProxy(source)).rejects.toThrow('timestamps');
    expect((await cache.status()).entries).toHaveLength(0);
    expect(await readdir(join(directory, 'cache'))).toEqual([
      '.opencut-media-cache-v1',
    ]);
  });
  it('cancels before and during generation without publishing; queued work can proceed', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      cache.generateProxy(source, { signal: controller.signal }),
    ).rejects.toThrow('cancelled');
    const active = new AbortController();
    await expect(
      cache.generateProxy(source, {
        signal: active.signal,
        onProgress: () => active.abort(),
      }),
    ).rejects.toThrow('cancelled');
    expect((await cache.status()).entries).toHaveLength(0);
    expect((await cache.generateProxy(source)).proxy).toBe(true);
  });
  it('bounds PNG memory and disk with LRU eviction and reloads persisted limits', async () => {
    await cache.configure({ diskBytes: 1024 ** 2, memoryBytes: 1024 ** 2 });
    await cache.frame(source, 0);
    const first = (await cache.status()).entries[0]!.key;
    await cache.frame(source, 0.5);
    const status = await cache.status();
    expect(status.memoryBytes).toBeLessThanOrEqual(1024 ** 2);
    expect(status.diskBytes).toBeLessThanOrEqual(1024 ** 2);
    expect(status.entries.map((entry) => entry.key)).not.toContain(first);
    const calls = vi.mocked(runMediaTool).mock.calls.length;
    await cache.frame(source, 0.5);
    expect(vi.mocked(runMediaTool)).toHaveBeenCalledTimes(calls);
    expect(
      (await new MediaCache(join(directory, 'cache')).status()).limits,
    ).toEqual(status.limits);
  });
  it('serializes concurrent cross-instance writers and cleans abandoned staging files', async () => {
    const other = new MediaCache(join(directory, 'cache'));
    const [one, two] = await Promise.all([
      cache.generateProxy(source),
      other.generateProxy(source),
    ]);
    expect(one).toEqual(two);
    expect(
      vi.mocked(runMediaTool).mock.calls.filter(([tool]) => tool === 'ffmpeg'),
    ).toHaveLength(1);
    await writeFile(
      join(
        directory,
        'cache',
        'partial-00000000-0000-0000-0000-000000000000.mp4',
      ),
      'truncated',
    );
    await cache.cleanup();
    expect(await readdir(join(directory, 'cache'))).not.toContain(
      'partial-00000000-0000-0000-0000-000000000000.mp4',
    );
    await cache.clear();
    expect((await cache.status()).diskBytes).toBe(0);
    expect(await readFile(source, 'utf8')).toBe('original-media');
  });
  it('retains alpha video instead of flattening it into a preview proxy', async () => {
    vi.mocked(probeMedia).mockResolvedValue({
      ...media,
      video: { ...media.video!, hasAlpha: true },
    });
    expect((await cache.generateProxy(source)).proxy).toBe(false);
    expect(runMediaTool).not.toHaveBeenCalled();
  });
  it('retains original for unsupported timing/audio and rejects invalid budgets', async () => {
    vi.mocked(probeMedia).mockResolvedValue({ ...media, startTimeSeconds: 5 });
    expect((await cache.generateProxy(source)).proxy).toBe(false);
    expect(runMediaTool).not.toHaveBeenCalled();
    await expect(
      cache.configure({ diskBytes: 0, memoryBytes: Infinity }),
    ).rejects.toThrow('limits');
    expect(demandingMedia({ width: 3840, height: 2160 })).toBe(true);
    expect(
      demandingMedia({ width: 640, height: 360, videoCodec: 'h264' }),
    ).toBe(false);
  });
});

it('cancels a queued request immediately without letting later writers overtake the active one', async () => {
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((r) => {
    started = r;
  });
  const wait = new Promise<void>((r) => {
    release = r;
  });
  const normal = vi.mocked(runMediaTool).getMockImplementation()!;
  let first = true;
  vi.mocked(runMediaTool).mockImplementation(async (...args) => {
    if (first && args[0] === 'ffmpeg') {
      first = false;
      started();
      await wait;
    }
    return normal(...args);
  });
  const active = cache.generateProxy(source);
  await ready;
  const controller = new AbortController();
  const waiting = cache.frame(source, 0, controller.signal);
  controller.abort();
  await expect(waiting).rejects.toThrow('cancelled');
  let finished = false;
  const after = cache
    .configure({ diskBytes: 1024 ** 2, memoryBytes: 1024 ** 2 })
    .then(() => {
      finished = true;
    });
  await new Promise((r) => setTimeout(r, 20));
  expect(finished).toBe(false);
  release();
  await active;
  await after;
});

it('enforces memory bounds on disk cache hits and refuses media directories as cache roots', async () => {
  await cache.configure({ diskBytes: 8 * 1024 ** 2, memoryBytes: 1024 ** 2 });
  await cache.frame(source, 0);
  await cache.frame(source, 0.5);
  await cache.frame(source, 0);
  expect((await cache.status()).memoryBytes).toBeLessThanOrEqual(1024 ** 2);
  await expect(new MediaCache(directory).clear()).rejects.toThrow(
    'dedicated empty',
  );
  expect(await readFile(source, 'utf8')).toBe('original-media');
});

it('can clean valid derivatives without optional probing tools and rejects oversized publication', async () => {
  const proxy = await cache.generateProxy(source);
  vi.mocked(probeMedia).mockRejectedValue(new Error('ffprobe unavailable'));
  expect(
    (await new MediaCache(cache.directory).cleanup()).entries.map(
      (entry) => entry.key,
    ),
  ).toContain(proxy.key);
  vi.mocked(probeMedia).mockImplementation(async (path) => ({
    ...media,
    path,
  }));
  await cache.configure({ diskBytes: 1024 ** 2, memoryBytes: 1024 ** 2 });
  const normal = vi.mocked(runMediaTool).getMockImplementation()!;
  vi.mocked(runMediaTool).mockImplementation(async (...args) => {
    if (args[0] === 'ffmpeg') {
      await writeFile(args[1].at(-1)!, Buffer.alloc(2 * 1024 ** 2));
      return Buffer.alloc(0);
    }
    return normal(...args);
  });
  await expect(cache.generateProxy(source, { force: true })).rejects.toThrow(
    'disk cache limit',
  );
  expect((await cache.status()).diskBytes).toBeLessThanOrEqual(1024 ** 2);
  expect(
    (await readdir(join(directory, 'cache'))).some((name) =>
      name.startsWith('partial-'),
    ),
  ).toBe(false);
});

it.each([
  [0.01, '0.000000'],
  [0.04, '0.033332'],
  [0.075, '0.033332'],
  [0.1, '0.099999'],
])(
  'caches the presentation interval covering %s seconds',
  async (timestamp, expected) => {
    await cache.frame(source, timestamp);
    const call = vi
      .mocked(runMediaTool)
      .mock.calls.find(([tool]) => tool === 'ffmpeg')!;
    expect(call[1][call[1].indexOf('-ss') + 1]).toBe(expected);
  },
);

it('does not reuse a cached image from the opposite side of a sub-microsecond frame boundary', async () => {
  await cache.frame(source, 0.0333332);
  await cache.frame(source, 1 / 30);
  const seeks = vi
    .mocked(runMediaTool)
    .mock.calls.filter(([tool]) => tool === 'ffmpeg')
    .map(([, args]) => args[args.indexOf('-ss') + 1]);
  expect(seeks).toEqual(['0.000000', '0.033332']);
});

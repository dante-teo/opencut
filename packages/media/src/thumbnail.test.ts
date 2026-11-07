import { beforeEach, expect, it, vi } from 'vitest';
import { stat } from 'node:fs/promises';
import { ThumbnailCache } from './thumbnail.js';
import { localFile, runMediaTool } from './process.js';
vi.mock('node:fs/promises', () => ({ stat: vi.fn() }));
vi.mock('./process.js', async (original) => ({
  ...(await original<typeof import('./process.js')>()),
  localFile: vi.fn(),
  runMediaTool: vi.fn(),
}));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(localFile).mockResolvedValue('/clip.mp4');
  vi.mocked(stat).mockResolvedValue({
    isFile: () => true,
    dev: 1n,
    ino: 1n,
    size: 1000n,
    mtimeNs: 1n,
    ctimeNs: 1n,
  } as Awaited<ReturnType<typeof stat>>);
  vi.mocked(runMediaTool).mockResolvedValue(
    Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  );
});
it('decodes a small image once and reuses it without frame probes, disk writes, or source hashing', async () => {
  const cache = new ThumbnailCache();
  const first = await cache.get('/clip.mp4', 1, { hardware: false });
  expect(await cache.get('/clip.mp4', 1, { hardware: false })).toBe(first);
  expect(runMediaTool).toHaveBeenCalledTimes(1);
  expect(runMediaTool).toHaveBeenCalledWith(
    'ffmpeg',
    expect.arrayContaining(['-ss', '1.000000', '-c:v', 'mjpeg']),
    256 * 1024,
    15000,
    { signal: undefined },
  );
});
it('invalidates an edited source and refuses changes during decoding', async () => {
  const cache = new ThumbnailCache();
  await cache.get('/clip.mp4', 1, { hardware: false });
  vi.mocked(stat).mockResolvedValue({
    isFile: () => true,
    dev: 1n,
    ino: 1n,
    size: 1000n,
    mtimeNs: 2n,
    ctimeNs: 2n,
  } as Awaited<ReturnType<typeof stat>>);
  await cache.get('/clip.mp4', 1, { hardware: false });
  expect(runMediaTool).toHaveBeenCalledTimes(2);
  vi.mocked(stat).mockResolvedValueOnce({
    isFile: () => true,
    dev: 1n,
    ino: 1n,
    size: 1000n,
    mtimeNs: 3n,
    ctimeNs: 3n,
  } as Awaited<ReturnType<typeof stat>>);
  await expect(cache.get('/clip.mp4', 2, { hardware: false })).rejects.toThrow(
    'Source changed',
  );
});
it.runIf(process.platform === 'darwin')(
  'tries VideoToolbox and remembers a software fallback',
  async () => {
    const cache = new ThumbnailCache();
    vi.mocked(runMediaTool).mockRejectedValueOnce(
      new Error('VideoToolbox unavailable'),
    );
    expect((await cache.get('/clip.mp4', 1, { hardware: true })).decoder).toBe(
      'software',
    );
    expect(vi.mocked(runMediaTool).mock.calls[0]![1]).toContain('videotoolbox');
    await cache.get('/clip.mp4', 2, { hardware: true });
    expect(vi.mocked(runMediaTool).mock.calls[2]![1]).not.toContain(
      'videotoolbox',
    );
  },
);
it('does not retry canceled hardware work as software', async () => {
  const controller = new AbortController();
  vi.mocked(runMediaTool).mockImplementation(async () => {
    controller.abort();
    throw new Error('cancelled');
  });
  await expect(
    new ThumbnailCache().get('/clip.mp4', 1, {
      hardware: true,
      signal: controller.signal,
    }),
  ).rejects.toThrow('cancelled');
  expect(runMediaTool).toHaveBeenCalledTimes(1);
});

for (const [hardwareMs, preferred] of [
  [75, 'videotoolbox'],
  [300, 'software'],
] as const)
  it.runIf(process.platform === 'darwin')(
    `starts quickly and selects the measured faster decoder (${preferred})`,
    async () => {
      let now = 0;
      const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
      try {
        vi.mocked(runMediaTool).mockImplementation(async (_tool, args) => {
          now += args.includes('videotoolbox') ? hardwareMs : 150;
          return Buffer.from([255, 216, 255, 217]);
        });
        const cache = new ThumbnailCache();
        const options = {
          hardware: true,
          adaptive: true,
          count: 4,
          interval: 0.9,
        };
        expect((await cache.get('/clip.mp4', 0, options)).decoder).toBe(
          'software',
        );
        expect((await cache.get('/clip.mp4', 4, options)).decoder).toBe(
          'videotoolbox',
        );
        expect((await cache.get('/clip.mp4', 8, options)).decoder).toBe(
          preferred,
        );
      } finally {
        clock.mockRestore();
      }
    },
  );

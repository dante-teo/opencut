import { beforeEach, expect, it, vi } from 'vitest';
import { waveformImage } from './waveform.js';
import { localFile, runMediaTool } from './process.js';
vi.mock('./process.js', async (original) => ({
  ...(await original<typeof import('./process.js')>()),
  localFile: vi.fn(),
  runMediaTool: vi.fn(),
}));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(localFile).mockResolvedValue('/source.wav');
  vi.mocked(runMediaTool).mockResolvedValue(
    Buffer.from('89504e470d0a1a0a', 'hex'),
  );
});
it('uses an input-relative range and bounded PNG output without an output file', async () => {
  const signal = new AbortController().signal;
  await waveformImage('/source.wav', 1.5, 3.25, 320, signal);
  expect(runMediaTool).toHaveBeenCalledWith(
    'ffmpeg',
    expect.arrayContaining([
      '-ss',
      '1.500000',
      '-t',
      '3.250000',
      '-i',
      '/source.wav',
    ]),
    512 * 1024,
    30000,
    { signal },
  );
});
it.each([
  [-1, 2, 100],
  [0, 0, 100],
  [0, Infinity, 100],
  [0, 121, 100],
  [0, 2, 2049],
  [NaN, 2, 100],
])(
  'rejects invalid or unbounded waveform requests',
  async (start, duration, width) => {
    await expect(
      waveformImage('/source.wav', start!, duration!, width!),
    ).rejects.toThrow('Invalid waveform');
    expect(runMediaTool).not.toHaveBeenCalled();
  },
);
it('reports empty decode output instead of supplying a fake waveform', async () => {
  vi.mocked(runMediaTool).mockResolvedValue(Buffer.alloc(0));
  await expect(waveformImage('/source.wav', 0, 1, 100)).rejects.toThrow(
    'No waveform',
  );
});

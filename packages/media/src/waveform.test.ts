import { beforeEach, expect, it, vi } from 'vitest';
import { waveformPeaks } from './waveform.js';
import { type MediaMetadata, type MediaStream } from './probe.js';
import { runMediaTool } from './process.js';

vi.mock('./process.js', () => ({ runMediaTool: vi.fn() }));
const audio = {
  index: 2,
  startTimeSeconds: 0,
  durationSeconds: 30,
} as MediaStream;
const media: MediaMetadata = {
  path: '/source.wav',
  formatName: 'wav',
  startTimeSeconds: 0,
  durationSeconds: 30,
  video: null,
  audio,
  hasAudio: true,
  streams: [audio],
};
beforeEach(() => vi.resetAllMocks());

it('reads bounded peak metadata from the selected audio stream on the source grid', async () => {
  vi.mocked(runMediaTool).mockResolvedValue(
    Buffer.from(
      'frame:0 pts:0 pts_time:0\nlavfi.astats.Overall.Peak_level=-inf\n' +
        'frame:1 pts:480 pts_time:0.01\nlavfi.astats.Overall.Peak_level=-6.0206\n' +
        'frame:4 pts:1920 pts_time:0.04\nlavfi.astats.Overall.Peak_level=0\n',
    ),
  );
  const signal = new AbortController().signal;
  const peaks = (await waveformPeaks(media, 16, signal))!;
  expect(peaks).toHaveLength(1600);
  expect([...peaks.subarray(0, 5)]).toEqual([0, 127, 0, 0, 255]);
  expect(runMediaTool).toHaveBeenCalledWith(
    'ffmpeg',
    expect.arrayContaining([
      '-ss',
      '16',
      '-t',
      '16',
      '-i',
      media.path,
      '-map',
      '0:2',
    ]),
    256 * 1024,
    30000,
    { signal },
  );
});

it('skips decoding when the probed file has no audio stream', async () => {
  expect(await waveformPeaks({ ...media, audio: null }, 0)).toBeNull();
  expect(runMediaTool).not.toHaveBeenCalled();
});

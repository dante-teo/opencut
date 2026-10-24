import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractFrame } from './frame.js';
import { probeMedia } from './probe.js';
import type { MediaMetadata, MediaStream } from './probe.js';
import { runMediaTool } from './process.js';

vi.mock('./probe.js', () => ({ probeMedia: vi.fn() }));
vi.mock('./process.js', async (original) => ({
  ...(await original<typeof import('./process.js')>()),
  runMediaTool: vi.fn(),
}));

let directory: string;
let output: string;
const png = Buffer.from('89504e470d0a1a0a', 'hex');
const video: MediaStream = {
  index: 2,
  type: 'video',
  codec: 'h264',
  durationSeconds: 2,
  startTimeSeconds: 0,
  timeBase: '1/24',
  bitRate: null,
  language: null,
  isDefault: true,
  isAttachedPicture: false,
  width: 320,
  height: 180,
  frameRate: 24,
  frameRateRatio: '24/1',
  pixelFormat: 'yuv420p',
  sampleRate: null,
  channels: null,
  channelLayout: null,
};
const media: MediaMetadata = {
  path: '/source/clip $(literal);.mp4',
  formatName: 'mov,mp4',
  startTimeSeconds: 0,
  durationSeconds: 3,
  hasAudio: false,
  video,
  audio: null,
  streams: [video],
};

beforeEach(async () => {
  vi.resetAllMocks();
  directory = await mkdtemp(join(tmpdir(), 'opencut-frame-test-'));
  output = join(directory, 'frame.png');
  vi.mocked(probeMedia).mockResolvedValue(media);
  vi.mocked(runMediaTool).mockResolvedValue(png);
});
afterEach(async () => rm(directory, { recursive: true, force: true }));

describe('frame extraction', () => {
  it('selects the probed stream and writes a new PNG only after successful decoding', async () => {
    const result = await extractFrame(media.path, 0.5, output);
    expect(result).toEqual({
      path: output,
      sourcePath: media.path,
      timestampSeconds: 0.5,
      streamIndex: 2,
    });
    expect(await readFile(output)).toEqual(png);
    expect(runMediaTool).toHaveBeenCalledWith(
      'ffmpeg',
      expect.arrayContaining([
        '-ss',
        '0.500000',
        '-i',
        media.path,
        '-map',
        '0:2',
        '-frames:v',
        '1',
        '-c:v',
        'png',
        'pipe:1',
      ]),
      64 * 1024 * 1024,
    );
  });

  it.each([-1, NaN, Infinity])(
    'rejects invalid timestamps %s',
    async (timestamp) => {
      await expect(extractFrame(media.path, timestamp, output)).rejects.toThrow(
        'timestamp',
      );
      expect(probeMedia).not.toHaveBeenCalled();
    },
  );

  it.each([2, 20])(
    'rejects timestamps at or beyond the selected video duration: %s',
    async (timestamp) => {
      await expect(extractFrame(media.path, timestamp, output)).rejects.toThrow(
        'out of range',
      );
      expect(runMediaTool).not.toHaveBeenCalled();
    },
  );

  it.each([
    { inputStart: 0, videoStart: 5, timestamp: 5.5, end: 7 },
    { inputStart: 10, videoStart: 15, timestamp: 5.5, end: 7 },
    { inputStart: -10, videoStart: -5, timestamp: 5.5, end: 7 },
    { inputStart: 10, videoStart: 10, timestamp: 0.5, end: 2 },
  ])(
    'uses the input-relative video end for $inputStart / $videoStart',
    async ({ inputStart, videoStart, timestamp, end }) => {
      const offsetVideo = { ...video, startTimeSeconds: videoStart };
      vi.mocked(probeMedia).mockResolvedValue({
        ...media,
        startTimeSeconds: inputStart,
        durationSeconds: 8,
        video: offsetVideo,
        streams: [offsetVideo],
      });
      await expect(
        extractFrame(media.path, timestamp, output),
      ).resolves.toMatchObject({ timestampSeconds: timestamp });
      vi.mocked(runMediaTool).mockClear();
      await expect(extractFrame(media.path, end, output)).rejects.toThrow(
        'out of range',
      );
      expect(runMediaTool).not.toHaveBeenCalled();
    },
  );

  it('accepts timestamp zero and enforces the container duration when stream duration is unknown', async () => {
    const unknownDurationVideo = { ...video, durationSeconds: null };
    vi.mocked(probeMedia).mockResolvedValue({
      ...media,
      video: unknownDurationVideo,
      streams: [unknownDurationVideo],
    });
    await expect(extractFrame(media.path, 0, output)).resolves.toMatchObject({
      timestampSeconds: 0,
    });
    vi.mocked(runMediaTool).mockClear();
    await expect(extractFrame(media.path, 3, output)).rejects.toThrow(
      'out of range',
    );
    expect(runMediaTool).not.toHaveBeenCalled();
  });

  it('rejects audio-only media', async () => {
    const audio: MediaStream = {
      ...video,
      type: 'audio',
      codec: 'aac',
      width: null,
      height: null,
      frameRate: null,
      frameRateRatio: null,
      pixelFormat: null,
      sampleRate: 48000,
      channels: 2,
      channelLayout: 'stereo',
    };
    vi.mocked(probeMedia).mockResolvedValue({
      ...media,
      video: null,
      hasAudio: true,
      audio,
      streams: [audio],
    });
    await expect(extractFrame(media.path, 0, output)).rejects.toThrow(
      'no video',
    );
    expect(runMediaTool).not.toHaveBeenCalled();
  });

  it('requires PNG output', async () => {
    await expect(extractFrame(media.path, 0, `${output}.jpg`)).rejects.toThrow(
      '.png',
    );
    expect(probeMedia).not.toHaveBeenCalled();
  });

  it('refuses to overwrite an existing file', async () => {
    await writeFile(output, 'keep');
    await expect(extractFrame(media.path, 0, output)).rejects.toThrow(
      'Refusing to overwrite',
    );
    expect(await readFile(output, 'utf8')).toBe('keep');
  });

  it('refuses symlink outputs, including aliases of the source', async () => {
    const source = join(directory, 'source.png');
    await writeFile(source, 'keep source');
    await symlink(source, output);
    vi.mocked(probeMedia).mockResolvedValue({ ...media, path: source });
    await expect(extractFrame(source, 0, output)).rejects.toThrow(
      'Refusing to overwrite',
    );
    expect(await readFile(source, 'utf8')).toBe('keep source');
  });

  it.each([Buffer.alloc(0), Buffer.from('not PNG')])(
    'rejects empty or invalid decoder output',
    async (bytes) => {
      vi.mocked(runMediaTool).mockResolvedValue(bytes);
      await expect(extractFrame(media.path, 1.999, output)).rejects.toThrow(
        'no PNG frame',
      );
      await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('leaves no output after a decoder failure', async () => {
    vi.mocked(runMediaTool).mockRejectedValue(new Error('ffmpeg failed'));
    await expect(extractFrame(media.path, 0, output)).rejects.toThrow(
      'ffmpeg failed',
    );
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('explains missing output directories', async () => {
    await expect(
      extractFrame(media.path, 0, join(directory, 'missing', 'frame.png')),
    ).rejects.toThrow('Cannot create frame');
  });
});

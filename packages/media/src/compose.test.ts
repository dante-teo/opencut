import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { composeMedia } from './compose.js';
import type { CompositionOptions } from './compose.js';
import { probeMedia } from './probe.js';
import type { MediaMetadata, MediaStream } from './probe.js';
import { runMediaTool } from './process.js';

vi.mock('./probe.js', () => ({ probeMedia: vi.fn() }));
vi.mock('./process.js', async (original) => ({
  ...(await original<typeof import('./process.js')>()),
  runMediaTool: vi.fn(),
}));

const video: MediaStream = {
  index: 2,
  type: 'video',
  codec: 'h264',
  durationSeconds: 2,
  startTimeSeconds: 10,
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
const audio: MediaStream = {
  ...video,
  index: 3,
  type: 'audio',
  codec: 'aac',
  sampleRate: 48000,
  channels: 2,
};
const clip: MediaMetadata = {
  path: '/source/literal $(clip);.mp4',
  formatName: 'mov,mp4',
  startTimeSeconds: 10,
  durationSeconds: 3,
  hasAudio: true,
  video,
  audio,
  streams: [video, audio],
};
const verified: MediaMetadata = {
  ...clip,
  durationSeconds: 4,
  startTimeSeconds: 0,
  video: {
    ...video,
    width: 1280,
    height: 720,
    frameRate: 30,
    durationSeconds: 4,
    startTimeSeconds: 0,
  },
  audio: { ...audio, durationSeconds: 4, startTimeSeconds: 0 },
};
let directory: string;
let options: CompositionOptions;

beforeEach(async () => {
  vi.resetAllMocks();
  directory = await mkdtemp(join(tmpdir(), 'opencut-compose-test-'));
  options = {
    clips: [clip.path, '/source/second.mp4'],
    music: '/source/music.wav',
    output: join(directory, 'out.mp4'),
  };
  vi.mocked(probeMedia).mockImplementation(async (path) =>
    path.endsWith('render.mp4') ? { ...verified, path } : { ...clip, path },
  );
  vi.mocked(runMediaTool).mockImplementation(async (_, args) => {
    await writeFile(args.at(-1)!, 'rendered');
    return Buffer.alloc(0);
  });
});
afterEach(async () => rm(directory, { recursive: true, force: true }));

describe('composition file safety and validation', () => {
  it('publishes verified media with stable absolute results and no temporary files', async () => {
    const result = await composeMedia(options);
    expect(result).toMatchObject({
      path: options.output,
      clipPaths: options.clips,
      musicPath: options.music,
      durationSeconds: 4,
      width: 1280,
      height: 720,
      fps: 30,
      clipVolume: 1,
      musicVolume: 0.25,
      metadata: { path: options.output },
    });
    expect(await readFile(options.output, 'utf8')).toBe('rendered');
    expect(await readdir(directory)).toEqual(['out.mp4']);
    expect(runMediaTool).toHaveBeenCalledWith(
      'ffmpeg',
      expect.arrayContaining(['-i', clip.path, '-stream_loop', '-1', '-n']),
      4 * 1024 * 1024,
      600_000,
    );
  });

  it('rounds fallback container timing relative to the selected video start', async () => {
    // Each container lasts 7.02s, but video starts 5s later: 2.02s rounds to
    // 61 frames at 30 fps, so the two-clip output must contain 122 frames.
    const durationSeconds = 122 / 30;
    vi.mocked(probeMedia).mockImplementation(async (path) =>
      path.endsWith('render.mp4')
        ? {
            ...verified,
            path,
            durationSeconds,
            video: { ...verified.video!, durationSeconds },
            audio: { ...verified.audio!, durationSeconds },
          }
        : {
            ...clip,
            path,
            durationSeconds: 7.02,
            video: { ...video, durationSeconds: null, startTimeSeconds: 15 },
          },
    );
    expect((await composeMedia(options)).durationSeconds).toBe(durationSeconds);
  });

  it.each([
    { clips: [] },
    { clips: [clip.path] },
    { clips: Array<string>(17).fill(clip.path) },
    { width: 3 },
    { height: 3 },
    { width: 0 },
    { height: 2162 },
    { fps: 0 },
    { fps: 29.97 },
    { fps: Infinity },
    { clipVolume: -1 },
    { musicVolume: NaN },
    { musicVolume: 2 },
    { output: 'out.mov' },
  ])('rejects invalid options before probing: %j', async (invalid) => {
    await expect(composeMedia({ ...options, ...invalid })).rejects.toThrow();
    expect(probeMedia).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });

  it.each(['existing', 'source alias', 'dangling symlink'])(
    'refuses %s destinations before decoding',
    async (kind) => {
      const source = join(directory, 'source.mp4');
      await writeFile(source, 'source bytes');
      if (kind === 'existing')
        await writeFile(options.output, 'existing bytes');
      else
        await symlink(
          kind === 'source alias' ? source : join(directory, 'missing'),
          options.output,
        );
      await expect(composeMedia(options)).rejects.toThrow(
        'Refusing to overwrite',
      );
      expect(probeMedia).not.toHaveBeenCalled();
      expect(await readFile(source, 'utf8')).toBe('source bytes');
    },
  );

  it('refuses a racing destination and cleans the completed temporary render', async () => {
    vi.mocked(runMediaTool).mockImplementation(async (_, args) => {
      await writeFile(args.at(-1)!, 'rendered');
      await writeFile(options.output, 'racing writer');
      return Buffer.alloc(0);
    });
    await expect(composeMedia(options)).rejects.toThrow(
      'Refusing to overwrite',
    );
    expect(await readFile(options.output, 'utf8')).toBe('racing writer');
    expect(await readdir(directory)).toEqual(['out.mp4']);
  });

  it('removes partial render on encoder/timeout failure and leaves no final output', async () => {
    vi.mocked(runMediaTool).mockImplementation(async (_, args) => {
      await writeFile(args.at(-1)!, 'partial');
      throw new Error('ffmpeg encoder unavailable or timed out');
    });
    await expect(composeMedia(options)).rejects.toThrow('encoder unavailable');
    expect(await readdir(directory)).toEqual([]);
  });

  it.each([
    ['incorrect output format', clip],
    [
      'short streams despite the claimed container duration',
      {
        ...verified,
        video: { ...verified.video!, durationSeconds: 2 },
        audio: { ...verified.audio!, durationSeconds: 2 },
      },
    ],
    [
      'nonzero output timestamps',
      {
        ...verified,
        startTimeSeconds: 1,
        video: { ...verified.video!, startTimeSeconds: 1 },
        audio: { ...verified.audio!, startTimeSeconds: 1 },
      },
    ],
  ] satisfies [string, MediaMetadata][])(
    'does not publish an export with %s',
    async (_, metadata) => {
      vi.mocked(probeMedia).mockImplementation(async (path) =>
        path.endsWith('render.mp4') ? { ...metadata, path } : { ...clip, path },
      );
      await expect(composeMedia(options)).rejects.toThrow(
        'Export verification failed',
      );
      expect(await readdir(directory)).toEqual([]);
    },
  );

  it.each([
    { video: null },
    { video: { ...video, frameRate: null } },
    { video: { ...video, durationSeconds: null }, durationSeconds: null },
    { video: { ...video, durationSeconds: 0 } },
    { video: { ...video, durationSeconds: 301 } },
  ])('rejects unsupported clip timing %j', async (timing) => {
    vi.mocked(probeMedia).mockResolvedValue({ ...clip, ...timing });
    await expect(composeMedia(options)).rejects.toThrow(
      /video|duration|600 seconds/,
    );
    expect(runMediaTool).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });

  it('requires an audio stream in the background track', async () => {
    vi.mocked(probeMedia).mockImplementation(async (path) => ({
      ...clip,
      path,
      audio: path === options.music ? null : audio,
    }));
    await expect(composeMedia(options)).rejects.toThrow('no audio stream');
    expect(runMediaTool).not.toHaveBeenCalled();
  });
});

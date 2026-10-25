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
import { renderVideoTimeline } from './render.js';
import type { VideoTimelineOptions } from './render.js';
import { probeMedia } from './probe.js';
import type { MediaMetadata, MediaStream } from './probe.js';
import { MediaError, runMediaTool } from './process.js';

vi.mock('./probe.js', () => ({ probeMedia: vi.fn() }));
vi.mock('./process.js', async (original) => ({
  ...(await original<typeof import('./process.js')>()),
  runMediaTool: vi.fn(),
}));
const stream: MediaStream = {
  index: 2,
  type: 'video',
  codec: 'h264',
  durationSeconds: 2,
  startTimeSeconds: 0,
  timeBase: '1/30000',
  bitRate: null,
  language: null,
  isDefault: true,
  isAttachedPicture: false,
  width: 320,
  height: 180,
  frameRate: 30000 / 1001,
  frameRateRatio: '30000/1001',
  pixelFormat: 'yuv420p',
  sampleRate: null,
  channels: null,
  channelLayout: null,
};
const source: MediaMetadata = {
  path: '/source/literal $(clip);.mp4',
  formatName: 'mov,mp4',
  startTimeSeconds: 0,
  durationSeconds: 2,
  hasAudio: false,
  video: stream,
  audio: null,
  streams: [stream],
};
let directory: string;
let options: VideoTimelineOptions;
let verified: MediaMetadata;
let count: number;
beforeEach(async () => {
  vi.resetAllMocks();
  directory = await mkdtemp(join(tmpdir(), 'opencut-render-test-'));
  options = {
    width: 320,
    height: 180,
    frameRate: { numerator: 30000, denominator: 1001 },
    frameCount: 12,
    segments: [
      { kind: 'gap', frameCount: 2 },
      {
        kind: 'clip',
        clipId: 'clip',
        path: source.path,
        sourceStartFrame: 3,
        frameCount: 10,
      },
    ],
    output: join(directory, 'out.mp4'),
  };
  const video = { ...stream, durationSeconds: (12 * 1001) / 30000 };
  const audio = {
    ...stream,
    index: 1,
    type: 'audio',
    codec: 'aac',
    sampleRate: 48000,
    channels: 2,
    durationSeconds: video.durationSeconds,
  };
  verified = {
    ...source,
    durationSeconds: video.durationSeconds,
    video,
    audio,
    streams: [video, audio],
  };
  count = 12;
  vi.mocked(probeMedia).mockImplementation(async (path) =>
    path.endsWith('render.mp4') ? { ...verified, path } : { ...source, path },
  );
  vi.mocked(runMediaTool).mockImplementation(async (tool, args) => {
    if (tool === 'ffprobe')
      return Buffer.from(
        JSON.stringify({ streams: [{ nb_read_frames: String(count) }] }),
      );
    await writeFile(args.at(-1)!, 'verified output');
    return Buffer.alloc(0);
  });
});
afterEach(async () => rm(directory, { recursive: true, force: true }));

describe('video timeline executor safety', () => {
  it('uses stream offsets, sample trims/delays, stable gains and the selected audio stream', async () => {
    const audio = {
      ...stream,
      index: 4,
      type: 'audio',
      codec: 'aac',
      startTimeSeconds: 0.25,
    };
    vi.mocked(probeMedia).mockImplementation(async (path) =>
      path.endsWith('render.mp4')
        ? { ...verified, path }
        : { ...source, path, audio },
    );
    options.audioClips = [
      {
        clipId: 'clip',
        path: source.path,
        timelineStartFrame: 2,
        sourceStartFrame: 3,
        frameCount: 10,
        volume: 0.25,
        muted: false,
        required: false,
      },
    ];
    await renderVideoTimeline(options);
    const args = vi.mocked(runMediaTool).mock.calls[0]![1];
    const graph = args[args.indexOf('-filter_complex') + 1]!;
    expect(args.filter((arg) => arg === '-i')).toHaveLength(1);
    expect(graph).toContain('[0:4]asetpts=PTS-STARTPTS+(0.250000000)/TB');
    expect(graph).toContain('atrim=start_sample=4805:end_sample=20821');
    expect(graph).toContain('volume=0.25,adelay=3203S:all=1');
    expect(graph).toContain('normalize=0');
    expect(graph).toContain('latency=1');
  });

  it('rejects invalid audio plans and a required missing audio stream before encoding', async () => {
    const clip = {
      clipId: 'sound',
      path: source.path,
      timelineStartFrame: 0,
      sourceStartFrame: 0,
      frameCount: 12,
      volume: 1,
      muted: false,
      required: true,
    };
    for (const fields of [
      { volume: 1.1 },
      { frameCount: 13 },
      { sourceStartFrame: -1 },
      { timelineStartFrame: 0.5 },
    ]) {
      await expect(
        renderVideoTimeline({
          ...options,
          audioClips: [{ ...clip, ...fields }],
        }),
      ).rejects.toThrow(/Invalid video render plan/);
    }
    await expect(
      renderVideoTimeline({ ...options, audioClips: [clip] }),
    ).rejects.toThrow(/requires an audio stream/);
    expect(runMediaTool).not.toHaveBeenCalled();
  });

  it('publishes only verified output and passes literal paths to the existing subprocess utility', async () => {
    const result = await renderVideoTimeline(options);
    expect(result).toMatchObject({
      path: options.output,
      frameCount: 12,
      frameRate: options.frameRate,
      metadata: { path: options.output },
    });
    expect(await readdir(directory)).toEqual(['out.mp4']);
    const args = vi.mocked(runMediaTool).mock.calls[0]![1];
    expect(args).toContain(source.path);
    expect(args).toContain('[audio]');
    expect(args[args.indexOf('-filter_complex') + 1]).toContain(
      'trim=start_frame=3:end_frame=13',
    );
    expect(args[args.indexOf('-filter_complex') + 1]).toContain(
      'setpts=N*1001[video]',
    );
  });

  it.each(['file', 'symlink'] as const)(
    'refuses an existing %s before reading inputs',
    async (kind) => {
      const sentinel = join(directory, 'sentinel.mp4');
      await writeFile(sentinel, 'source sentinel');
      if (kind === 'file') options.output = sentinel;
      else await symlink(sentinel, options.output);
      await expect(renderVideoTimeline(options)).rejects.toThrow(/overwrite/);
      expect(probeMedia).not.toHaveBeenCalled();
      expect(await readFile(sentinel, 'utf8')).toBe('source sentinel');
    },
  );

  it('preserves a destination created during encoding and removes its temporary render', async () => {
    vi.mocked(runMediaTool).mockImplementation(async (tool, args) => {
      if (tool === 'ffprobe')
        return Buffer.from('{"streams":[{"nb_read_frames":"12"}]}');
      await writeFile(args.at(-1)!, 'render');
      await writeFile(options.output, 'racing writer');
      return Buffer.alloc(0);
    });
    await expect(renderVideoTimeline(options)).rejects.toThrow(/overwrite/);
    expect(await readFile(options.output, 'utf8')).toBe('racing writer');
    expect(await readdir(directory)).toEqual(['out.mp4']);
  });

  it('cleans partial renders after encoder errors', async () => {
    vi.mocked(runMediaTool).mockImplementation(async (_, args) => {
      await writeFile(args.at(-1)!, 'partial');
      throw new MediaError('Decoder failed');
    });
    await expect(renderVideoTimeline(options)).rejects.toThrow(
      /Decoder failed/,
    );
    expect(await readdir(directory)).toEqual([]);
  });

  it.each([
    'codec',
    'duration',
    'frames',
    'audio',
    'unknown duration',
    'fps',
  ] as const)(
    'does not publish when verification detects wrong %s',
    async (bad) => {
      if (bad === 'fps') verified.video!.frameRateRatio = '2997/100';
      if (bad === 'codec') verified.video!.codec = 'mpeg4';
      if (bad === 'duration') verified.video!.durationSeconds = 0.5;
      if (bad === 'frames') count = 11;
      if (bad === 'audio') verified.audio = null;
      if (bad === 'unknown duration') verified.durationSeconds = null;
      await expect(renderVideoTimeline(options)).rejects.toThrow(
        /verification failed/,
      );
      expect(await readdir(directory)).toEqual([]);
    },
  );

  it('wraps missing source errors with the clip and source location', async () => {
    vi.mocked(probeMedia).mockRejectedValue(
      new MediaError('Cannot read media file'),
    );
    await expect(renderVideoTimeline(options)).rejects.toThrow(
      /Clip 'clip'.*Restore a readable source/,
    );
    expect(runMediaTool).not.toHaveBeenCalled();
  });

  it('rejects stills, missing video, unknown duration and stale source ranges', async () => {
    for (const video of [
      null,
      { ...stream, frameRate: null },
      { ...stream, durationSeconds: 0.1 },
    ]) {
      vi.mocked(probeMedia).mockResolvedValue({ ...source, video });
      await expect(renderVideoTimeline(options)).rejects.toThrow(
        /timed video|current video duration/,
      );
    }
    vi.mocked(probeMedia).mockResolvedValue({
      ...source,
      durationSeconds: null,
      video: { ...stream, durationSeconds: null },
    });
    await expect(renderVideoTimeline(options)).rejects.toThrow(
      /duration is unknown/,
    );
    expect(runMediaTool).not.toHaveBeenCalled();
  });

  it('rejects invalid render plans, extensions and missing output directories', async () => {
    await expect(
      renderVideoTimeline({ ...options, frameCount: 13 }),
    ).rejects.toThrow(/Invalid video render plan/);
    await expect(
      renderVideoTimeline({
        ...options,
        frameRate: { numerator: 0, denominator: 1 },
      }),
    ).rejects.toThrow(/Invalid video render plan/);
    await expect(
      renderVideoTimeline({ ...options, output: join(directory, 'out.mov') }),
    ).rejects.toThrow(/.mp4/);
    await expect(
      renderVideoTimeline({
        ...options,
        output: join(directory, 'missing', 'out.mp4'),
      }),
    ).rejects.toThrow(/existing writable directory/);
    expect(runMediaTool).not.toHaveBeenCalled();
  });
});

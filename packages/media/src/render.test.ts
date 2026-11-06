import {
  link,
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
import { renderVideoTimeline, validateVideoTimeline } from './render.js';
import type { RenderProgress } from './render-progress.js';
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

  it('rejects invalid positioned visual plans before probing or encoding', async () => {
    const base = { ...options };
    delete base.segments;
    const clip = {
      clipId: 'layer',
      path: source.path,
      timelineStartFrame: 0,
      sourceStartFrame: 0,
      frameCount: 12,
    };
    for (const fields of [
      { x: Infinity },
      { y: 32769 },
      { scale: 0 },
      { opacity: 1.1 },
      { timelineStartFrame: 1 },
      { frameCount: 0 },
    ]) {
      await expect(
        renderVideoTimeline({ ...base, visualClips: [{ ...clip, ...fields }] }),
      ).rejects.toThrow(/Invalid video render plan/);
    }
    await expect(
      renderVideoTimeline({
        ...base,
        visualClips: [clip],
        backgroundColor: '#123456;null',
      }),
    ).rejects.toThrow(/Invalid video render plan/);
    expect(probeMedia).not.toHaveBeenCalled();
    expect(runMediaTool).not.toHaveBeenCalled();
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
      'setpts=N*1001,scale=320:180:out_color_matrix=bt709,setsar=1,format=yuv420p[video]',
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

  it('replaces only a verified export when explicitly requested', async () => {
    await writeFile(options.output, 'previous export');
    await renderVideoTimeline({ ...options, overwrite: true });
    expect(await readFile(options.output, 'utf8')).toBe('verified output');
    expect(await readdir(directory)).toEqual(['out.mp4']);
  });

  it('preserves an existing export on encoder failure and verification failure with overwrite', async () => {
    await writeFile(options.output, 'previous export');
    verified.video!.codec = 'mpeg4';
    await expect(
      renderVideoTimeline({ ...options, overwrite: true }),
    ).rejects.toThrow(/verification failed/);
    vi.mocked(runMediaTool).mockImplementation(async (_, args) => {
      await writeFile(args.at(-1)!, 'partial');
      throw new MediaError('FFmpeg meaningful diagnostics');
    });
    await expect(
      renderVideoTimeline({ ...options, overwrite: true }),
    ).rejects.toThrow(/meaningful diagnostics/);
    expect(await readFile(options.output, 'utf8')).toBe('previous export');
    expect(await readdir(directory)).toEqual(['out.mp4']);
  });

  it('refuses explicit replacement of source aliases and output symlinks', async () => {
    const original = join(directory, 'source.mp4');
    await writeFile(original, 'source sentinel');
    options.segments![1] = {
      ...options.segments![1]!,
      kind: 'clip',
      clipId: 'clip',
      path: original,
      sourceStartFrame: 0,
    };
    await link(original, options.output);
    await expect(
      renderVideoTimeline({ ...options, overwrite: true }),
    ).rejects.toThrow(/source media/);
    await rm(options.output);
    await symlink(original, options.output);
    await expect(
      renderVideoTimeline({ ...options, overwrite: true }),
    ).rejects.toThrow(/overwrite/);
    expect(await readFile(original, 'utf8')).toBe('source sentinel');
    expect(runMediaTool).not.toHaveBeenCalled();
  });

  it.each(['rendering', 'verifying'] as const)(
    'cancels during %s before publication and cleans up',
    async (phase) => {
      const controller = new AbortController();
      await writeFile(options.output, 'previous export');
      const onProgress = vi.fn((event: RenderProgress) => {
        if (event.phase === phase) controller.abort();
      });
      await expect(
        renderVideoTimeline({
          ...options,
          overwrite: true,
          signal: controller.signal,
          onProgress,
        }),
      ).rejects.toThrow(/cancelled/);
      expect(await readFile(options.output, 'utf8')).toBe('previous export');
      expect(await readdir(directory)).toEqual(['out.mp4']);
      expect(onProgress).toHaveBeenCalled();
    },
  );

  it('does no work for an already cancelled render', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      renderVideoTimeline({ ...options, signal: controller.signal }),
    ).rejects.toThrow(/cancelled/);
    expect(probeMedia).not.toHaveBeenCalled();
    expect(runMediaTool).not.toHaveBeenCalled();
  });

  it.each([
    ['draft', '720p', 1280, 720, 'ultrafast', '28'],
    ['balanced', 'project', 320, 180, 'veryfast', '20'],
    ['high', '1080p', 1920, 1080, 'medium', '16'],
  ] as const)(
    'uses %s quality and %s resolution',
    async (quality, resolution, width, height, preset, crf) => {
      verified.video!.width = width;
      verified.video!.height = height;
      const result = await renderVideoTimeline({
        ...options,
        quality,
        resolution,
      });
      expect(result).toMatchObject({ quality, resolution, width, height });
      const args = vi.mocked(runMediaTool).mock.calls[0]![1];
      expect(args[args.indexOf('-preset') + 1]).toBe(preset);
      expect(args[args.indexOf('-crf') + 1]).toBe(crf);
      expect(args).toContain('-progress');
      expect(args).toContain('pipe:1');
    },
  );

  it.each([
    [704, 396, '1080p', 1920, 1080],
    [396, 704, '1080p', 1080, 1920],
    [1248, 702, '720p', 1280, 720],
    [702, 1248, '720p', 720, 1280],
    [1024, 768, '720p', 960, 720],
    [1000, 700, '1080p', 1542, 1080],
    [1000, 1000, '720p', 720, 720],
    [2, 3840, '720p', 2, 1280],
    [704, 396, 'project', 704, 396],
  ] as const)(
    'scales %ix%i to %s with exact even dimensions',
    async (width, height, resolution, expectedWidth, expectedHeight) => {
      verified.video!.width = expectedWidth;
      verified.video!.height = expectedHeight;
      const result = await renderVideoTimeline({
        ...options,
        width,
        height,
        resolution,
      });
      expect(result).toMatchObject({
        width: expectedWidth,
        height: expectedHeight,
      });
    },
  );

  it('preserves portrait orientation when scaling the finished canvas', async () => {
    verified.video!.width = 720;
    verified.video!.height = 1280;
    const result = await renderVideoTimeline({
      ...options,
      width: 180,
      height: 320,
      resolution: '720p',
    });
    expect(result).toMatchObject({ width: 720, height: 1280 });
    const args = vi.mocked(runMediaTool).mock.calls[0]![1];
    expect(args[args.indexOf('-filter_complex') + 1]).toContain(
      'scale=720:1280:out_color_matrix=bt709,setsar=1,format=yuv420p[video]',
    );
  });

  it('wraps missing source errors with the clip and source location', async () => {
    vi.mocked(probeMedia).mockRejectedValue(
      new MediaError('Cannot read media file'),
    );
    await expect(renderVideoTimeline(options)).rejects.toThrow(
      /Clip 'clip'.*Restore a readable source/,
    );
    expect(runMediaTool).not.toHaveBeenCalled();
  });

  it('rejects missing or untimed video, unknown duration and stale source ranges', async () => {
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

describe('export preflight', () => {
  it('checks the exact media plan and encoders without rendering or creating output files', async () => {
    vi.mocked(runMediaTool).mockResolvedValue(
      Buffer.from(
        ' V..... libx264 H.264\n V..... libx265 HEVC\n A..... aac AAC',
      ),
    );
    const summary = await validateVideoTimeline({
      ...options,
      codec: 'hevc',
      outputFrameRate: { numerator: 24, denominator: 1 },
    });
    expect(summary).toMatchObject({
      codec: 'hevc',
      frameRate: { numerator: 24, denominator: 1 },
      frameCount: 10,
    });
    expect(summary.durationSeconds).toBeCloseTo(10 / 24);
    expect(await readdir(directory)).toEqual([]);
    expect(runMediaTool).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runMediaTool).mock.calls[0]![1]).toContain('-encoders');
  });
  it('rejects unavailable encoders and tools before output creation', async () => {
    vi.mocked(runMediaTool).mockResolvedValue(Buffer.from(' V..... libx264'));
    await expect(validateVideoTimeline(options)).rejects.toThrow(
      "encoder 'aac' is unavailable",
    );
    vi.mocked(runMediaTool).mockRejectedValue(
      new MediaError('ffmpeg not found'),
    );
    await expect(validateVideoTimeline(options)).rejects.toThrow(
      'ffmpeg not found',
    );
    expect(await readdir(directory)).toEqual([]);
  });
  it('refuses output conflicts, unreadable media and incompatible rates before encoding', async () => {
    await writeFile(options.output, 'existing');
    await expect(validateVideoTimeline(options)).rejects.toThrow(
      'Refusing to overwrite',
    );
    expect(await readFile(options.output, 'utf8')).toBe('existing');
    await rm(options.output);
    await expect(
      validateVideoTimeline({
        ...options,
        outputFrameRate: { numerator: 121, denominator: 1 },
      }),
    ).rejects.toThrow('Output frame rate');
    vi.mocked(probeMedia).mockRejectedValue(
      new MediaError('Cannot read media file'),
    );
    await expect(validateVideoTimeline(options)).rejects.toThrow(
      'cannot read/probe media',
    );
    expect(runMediaTool).not.toHaveBeenCalled();
  });
});

it('rejects HEVC dimensions that libx265 cannot encode during preflight', async () => {
  await expect(
    validateVideoTimeline({ ...options, width: 8, height: 8, codec: 'hevc' }),
  ).rejects.toThrow('at least 16');
  expect(runMediaTool).not.toHaveBeenCalled();
});

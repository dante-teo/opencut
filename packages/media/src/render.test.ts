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
import { countDecodedVideo } from './media-engine.js';

vi.mock('./probe.js', async (original) => ({
  ...(await original<typeof import('./probe.js')>()),
  probeMedia: vi.fn(),
}));
vi.mock('./process.js', async (original) => ({
  ...(await original<typeof import('./process.js')>()),
  runMediaTool: vi.fn(),
}));
vi.mock('./media-engine.js', () => ({ countDecodedVideo: vi.fn() }));

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
  const video = {
    ...stream,
    durationSeconds: (12 * 1001) / 30000,
    colorRange: 'tv',
    colorSpace: 'bt709',
    colorPrimaries: 'bt709',
    colorTransfer: 'bt709',
    chromaLocation: 'center',
  };
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
  vi.mocked(countDecodedVideo).mockImplementation(async () => count);
  vi.mocked(runMediaTool).mockImplementation(async (_, args) => {
    await writeFile(args.at(-1)!, 'verified output');
    return Buffer.alloc(0);
  });
});
afterEach(async () => rm(directory, { recursive: true, force: true }));

describe('video timeline executor safety', () => {
  it.each([false, true])(
    'uses stream offsets, exact sample positions and stable gain (with fades: %s)',
    async (faded) => {
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
          ...(faded && {
            fadeIn: {
              duration: { numerator: 4004, denominator: 30000 },
              from: 0,
              to: 1,
            },
            fadeOut: {
              duration: { numerator: 1001, denominator: 30000 },
              from: 1,
              to: 0,
            },
          }),
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
      if (faded) {
        // Round the absolute fade boundaries before subtracting the clip start.
        expect(graph).toContain(
          'asettb=1/48000,asetpts=N,afade=t=in:ss=0:ns=6407:c=tri:silence=0:unity=1,afade=t=out:ss=14415:ns=1601:c=tri:silence=0:unity=1,volume=0.25',
        );
      }
      expect(graph).toContain('normalize=0');
      expect(graph).toContain('latency=1');
    },
  );

  it('fits a shared tempo run before applying independent piece gain and fades', async () => {
    const audio = { ...verified.audio!, index: 4, durationSeconds: 2 };
    vi.mocked(probeMedia).mockImplementation(async (path) =>
      path.endsWith('render.mp4')
        ? { ...verified, path }
        : { ...source, path, audio },
    );
    const at = (ticks: number) => ({
      numerator: ticks * 1001,
      denominator: 30000,
    });
    const base = {
      path: source.path,
      tempoRunId: 'clip',
      sourceStartFrame: 0,
      frameCount: 5,
      required: false,
    };
    const speed = { numerator: 1, denominator: 2 };
    options.audioClips = [
      {
        ...base,
        clipId: 'clip',
        timelineStartFrame: 2,
        volume: 0.25,
        muted: false,
        fadeIn: { duration: at(1), from: 0, to: 1 },
        retiming: {
          timelineStart: at(2),
          timelineEnd: at(7),
          sourceIn: at(1),
          sourceOut: { numerator: 7007, denominator: 60000 },
          speed,
        },
      },
      {
        ...base,
        clipId: 'split',
        timelineStartFrame: 7,
        volume: 0.8,
        muted: true,
        retiming: {
          timelineStart: at(7),
          timelineEnd: at(12),
          sourceIn: { numerator: 7007, denominator: 60000 },
          sourceOut: at(6),
          speed,
        },
      },
    ];
    await renderVideoTimeline(options);
    const args = vi.mocked(runMediaTool).mock.calls[0]![1];
    const graph = args[args.indexOf('-filter_complex') + 1]!;
    expect(graph.match(/atempo=/g)).toHaveLength(1);
    expect(graph).toContain(
      'atrim=start_sample=1602:end_sample=9610,asettb=1/48000,asetpts=N,apad=pad_len=4800,atempo=0.5,apad,atrim=end_sample=16016',
    );
    expect(graph).toContain('asegment=samples=8008[run0p0][run0p1]');
    expect(graph).toContain(
      '[run0p0]asettb=1/48000,asetpts=N,afade=t=in:ss=0:ns=1602:c=tri:silence=0:unity=1,volume=0.25[run0g0]',
    );
    expect(graph).toContain(
      '[run0p1]asettb=1/48000,asetpts=N,volume=0[run0g1]',
    );
    expect(graph).toContain(
      '[run0g0][run0g1]concat=n=2:v=0:a=1,asettb=1/48000,asetpts=N,adelay=3203S:all=1[a0]',
    );
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
      {
        fadeIn: { duration: { numerator: 1, denominator: 1 }, from: 0, to: 1 },
      },
      {
        fadeOut: {
          duration: { numerator: 1, denominator: 10 },
          from: 0.5,
          to: 0,
        },
      },
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

  it('stages each source and freeze time once and cleans up the held PNGs', async () => {
    const original = join(directory, 'source.mp4');
    const alias = join(directory, 'alias.mp4');
    await writeFile(original, '');
    await symlink(original, alias, 'file');
    const png = Buffer.alloc(24);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
    png.writeUInt32BE(320, 16);
    png.writeUInt32BE(180, 20);
    const tool = vi.mocked(runMediaTool);
    const run = tool.getMockImplementation()!;
    tool.mockImplementation(async (name, args, ...rest) => {
      if (name === 'ffprobe' && args.includes('-show_frames'))
        return Buffer.from('0\n');
      if (name === 'ffmpeg' && args.includes('image2pipe')) return png;
      if (name === 'ffmpeg' && args.at(-1)?.endsWith('render.mp4')) {
        const inputs = args
          .flatMap((arg, i) => (arg === '-i' ? [args[i + 1]!] : []))
          .filter((path) => path.endsWith('.png'));
        expect(inputs).toHaveLength(3);
        expect(inputs[0]).toBe(inputs[1]);
        expect(inputs[0]).not.toBe(inputs[2]);
        for (const path of new Set(inputs))
          expect(await readFile(path)).toEqual(png);
      }
      return run(name, args, ...rest);
    });
    const canvas = { ...options };
    delete canvas.segments;
    await renderVideoTimeline({
      ...canvas,
      visualClips: [original, alias, original].map((path, index) => ({
        clipId: `held-${index}`,
        path,
        freezeFrame: [
          { numerator: 1, denominator: 4 },
          { numerator: 2, denominator: 8 },
          { numerator: 1, denominator: 2 },
        ][index]!,
        timelineStartFrame: index * 4,
        sourceStartFrame: 0,
        frameCount: 4,
      })),
    });
    expect(
      tool.mock.calls.filter(([, args]) => args.includes('-show_frames')),
    ).toHaveLength(2);
    expect(
      tool.mock.calls.filter(([, args]) => args.includes('image2pipe')),
    ).toHaveLength(2);
    expect((await readdir(directory)).sort()).toEqual([
      'alias.mp4',
      'out.mp4',
      'source.mp4',
    ]);
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
    expect(countDecodedVideo).toHaveBeenCalledWith(
      expect.stringMatching(/render\.mp4$/),
      options.signal,
    );
    const args = vi.mocked(runMediaTool).mock.calls[0]![1];
    expect(args).toContain(source.path);
    expect(args).toContain('[audio]');
    expect(args[args.indexOf('-filter_complex') + 1]).toContain(
      'trim=start_frame=3:end_frame=13',
    );
    expect(args[args.indexOf('-filter_complex') + 1]).toContain(
      'setpts=N*1001,scale=320:180:in_range=pc:out_range=tv:out_color_matrix=bt709:out_chroma_loc=center,setsar=1,format=yuv420p,setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709:chroma_location=center[video]',
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
    vi.mocked(runMediaTool).mockImplementation(async (_, args) => {
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
    'chroma location',
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
      if (bad === 'chroma location') verified.video!.chromaLocation = 'left';
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

  it('preserves a source linked to the destination during a cached render', async () => {
    const original = join(directory, 'source.mp4');
    await writeFile(original, 'source sentinel');
    const materialize = vi.fn(async () => ({
      path: join(directory, 'cached.nut'),
      reused: true,
    }));
    await expect(
      renderVideoTimeline({
        ...options,
        segments: [
          {
            kind: 'clip',
            clipId: 'visual-only',
            path: original,
            sourceStartFrame: 0,
            frameCount: 12,
          },
        ],
        overwrite: true,
        pictureCache: {
          backend: 'test',
          sourceIdentity: () => original,
          materialize,
        },
        onVerifiedOutput: async () => link(original, options.output),
      }),
    ).rejects.toThrow(/source media/);
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(await readFile(original, 'utf8')).toBe('source sentinel');
    expect(await readFile(options.output, 'utf8')).toBe('source sentinel');
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
    ['fast', '720p', 1280, 720, 'ultrafast', '28'],
    ['quality', 'project', 320, 180, 'veryfast', '17'],
    ['maximum', '1080p', 1920, 1080, 'medium', '16'],
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
      'scale=720:1280:in_range=pc:out_range=tv:out_color_matrix=bt709:out_chroma_loc=center,setsar=1,format=yuv420p,setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709:chroma_location=center[video]',
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

describe('indexed decoding for cached picture', () => {
  it.each([
    { originPts: 0, seekPts: 149149, indexed: true },
    { originPts: 0, seekPts: 149150, indexed: false },
    { originPts: 0, seekPts: 180000, indexed: false },
    { originPts: 1001, seekPts: 90090, indexed: false },
    { originPts: 0, seekPts: undefined, indexed: false },
  ])(
    'requires a zero origin and predecessor frame ($originPts, $seekPts)',
    async ({ originPts, seekPts, indexed }) => {
      vi.mocked(probeMedia).mockImplementation(async (path) =>
        path.endsWith('render.mp4')
          ? { ...verified, path }
          : { ...source, path, video: { ...stream, durationSeconds: 10 } },
      );
      vi.mocked(runMediaTool).mockImplementation(async (tool, args) => {
        if (args.includes('framecrc')) {
          const pts = args.includes('-ss') ? seekPts : originPts;
          return Buffer.from(
            '#tb 0: 1/30000\n' +
              (pts === undefined
                ? ''
                : `0, ${pts}, ${pts}, 1001, 6, 0x00000000\n`),
          );
        }
        if (tool === 'ffprobe' && args.includes('-count_packets'))
          return Buffer.from('12');
        await writeFile(args.at(-1)!, 'rendered output');
        return Buffer.alloc(0);
      });
      const cachePath = join(directory, 'cached.nut');
      await renderVideoTimeline({
        ...options,
        segments: [
          {
            kind: 'clip',
            clipId: 'late',
            path: source.path,
            sourceStartFrame: 150,
            frameCount: 12,
          },
        ],
        pictureCache: {
          backend: 'test',
          sourceIdentity: () => source.path,
          async materialize(_key, encode) {
            await encode(cachePath);
            return { path: cachePath, reused: false };
          },
        },
      });
      const args = vi
        .mocked(runMediaTool)
        .mock.calls.find(
          ([tool, args]) => tool === 'ffmpeg' && args.at(-1) === cachePath,
        )![1];
      expect(args.includes('-ss')).toBe(indexed);
      expect(args[args.indexOf('-filter_complex') + 1]).toContain(
        indexed
          ? 'trim=start_pts=150:end_pts=162'
          : 'trim=start_frame=150:end_frame=162',
      );
    },
  );
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
  it('checks FFV1 availability without consulting or populating the picture cache', async () => {
    const pictureCache = {
      backend: 'test',
      sourceIdentity: vi.fn(),
      materialize: vi.fn(),
    };
    vi.mocked(runMediaTool).mockResolvedValue(
      Buffer.from(' V..... libx264\n A..... aac'),
    );
    await expect(
      validateVideoTimeline({ ...options, pictureCache }),
    ).rejects.toThrow("encoder 'ffv1' is unavailable");
    vi.mocked(runMediaTool).mockResolvedValue(
      Buffer.from(' V..... libx264\n A..... aac\n V..... ffv1'),
    );
    await expect(
      validateVideoTimeline({ ...options, pictureCache }),
    ).resolves.toMatchObject({
      frameCount: 12,
    });
    expect(pictureCache.sourceIdentity).not.toHaveBeenCalled();
    expect(pictureCache.materialize).not.toHaveBeenCalled();
    expect(runMediaTool).toHaveBeenCalledTimes(2);
    expect(await readdir(directory)).toEqual([]);
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

// Range trimming must happen after sampling, composition and mixing, so edits,
// fractional boundaries and limiter state keep the same meaning as full export.
it('preflights exact preview range length and downscales the finished canvas', async () => {
  vi.mocked(runMediaTool).mockResolvedValue(
    Buffer.from(' V..... libx264 H.264\n A..... aac AAC'),
  );
  const summary = await validateVideoTimeline({
    ...options,
    range: { startFrame: 3, endFrame: 10 },
    maxDimension: 64,
  });
  expect(summary).toMatchObject({ width: 64, height: 36, frameCount: 7 });
  // Preflight runs only the encoder query. Execution's filter graph is exercised
  // by native CLI tests; invalid range controls must fail before any subprocess.
});

it.each([
  { startFrame: -1, endFrame: 2 },
  { startFrame: 2, endFrame: 2 },
  { startFrame: 0, endFrame: 13 },
  { startFrame: 0.5, endFrame: 2 },
])('rejects invalid preview ranges before file creation: %j', async (range) => {
  await expect(renderVideoTimeline({ ...options, range })).rejects.toThrow(
    'Preview range',
  );
  expect(runMediaTool).not.toHaveBeenCalled();
  expect(await readdir(directory)).toEqual([]);
});

it('rejects preview range resampling and oversized previews before execution', async () => {
  await expect(
    renderVideoTimeline({
      ...options,
      range: { startFrame: 0, endFrame: 2 },
      outputFrameRate: { numerator: 24, denominator: 1 },
    }),
  ).rejects.toThrow('range and outputFrameRate');
  await expect(
    renderVideoTimeline({ ...options, maxDimension: 1921 }),
  ).rejects.toThrow('Preview size');
  expect(runMediaTool).not.toHaveBeenCalled();
});

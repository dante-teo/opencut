import {
  canvasColorPattern,
  opaqueCanvasColor,
  visualGeometry,
  sourceColorMatrix,
} from '@opencut/shared';
import { link, lstat, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { probeMedia } from './probe.js';
import type { MediaMetadata } from './probe.js';
import { checkRenderSignal, MediaError, runMediaTool } from './process.js';
import { renderProgress } from './render-progress.js';
import type { RenderProgress } from './render-progress.js';
import { fitVisual } from './video-filter.js';

export interface VisualTimelineClip {
  clipId: string;
  path: string;
  timelineStartFrame: number;
  sourceStartFrame: number;
  frameCount: number;
  x?: number;
  y?: number;
  scale?: number;
  opacity?: number;
  fit?: 'contain' | 'cover' | 'stretch';
}

export const renderQualities = ['draft', 'balanced', 'high'] as const;
export const renderResolutions = ['project', '720p', '1080p'] as const;
export type RenderQuality = (typeof renderQualities)[number];
export type RenderResolution = (typeof renderResolutions)[number];
export interface RenderControls {
  quality?: RenderQuality | undefined;
  resolution?: RenderResolution | undefined;
  overwrite?: boolean | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: (progress: RenderProgress) => void;
}

export interface VideoTimelineOptions extends RenderControls {
  width: number;
  height: number;
  frameRate: { numerator: number; denominator: number };
  frameCount: number;
  backgroundColor?: string;
  visualClips?: VisualTimelineClip[];
  /** Legacy sequential plan; supply either segments or visualClips. */
  segments?: Array<
    | { kind: 'gap'; frameCount: number }
    | {
        kind: 'clip';
        clipId: string;
        path: string;
        sourceStartFrame: number;
        frameCount: number;
      }
  >;
  audioClips?: Array<{
    clipId: string;
    path: string;
    timelineStartFrame: number;
    sourceStartFrame: number;
    frameCount: number;
    volume: number;
    muted: boolean;
    required: boolean;
  }>;
  output: string;
}

export interface VideoTimelineResult {
  quality: RenderQuality;
  resolution: RenderResolution;
  path: string;
  width: number;
  height: number;
  frameRate: { numerator: number; denominator: number };
  frameCount: number;
  durationSeconds: number;
  metadata: MediaMetadata;
}

function validateOptions(options: VideoTimelineOptions): void {
  const {
    width,
    height,
    frameRate: { numerator, denominator },
    frameCount,
  } = options;
  const segments = options.segments ?? [];
  if (
    ![width, height, numerator, denominator, frameCount].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    ) ||
    width < 2 ||
    height < 2 ||
    width > 3840 ||
    height > 3840 ||
    width * height > 3840 * 2160 ||
    width % 2 ||
    height % 2 ||
    numerator > 2147483647 ||
    denominator > 2147483647 ||
    numerator < denominator ||
    numerator > 120 * denominator ||
    BigInt(frameCount) * BigInt(denominator) > 600n * BigInt(numerator) ||
    (options.backgroundColor !== undefined &&
      !canvasColorPattern.test(options.backgroundColor)) ||
    (options.visualClips !== undefined && options.segments !== undefined) ||
    (options.visualClips === undefined &&
      (segments.length === 0 ||
        segments.length > 128 ||
        segments.some(
          (s) =>
            !Number.isSafeInteger(s.frameCount) ||
            s.frameCount <= 0 ||
            (s.kind !== 'gap' &&
              (s.kind !== 'clip' ||
                !Number.isSafeInteger(s.sourceStartFrame) ||
                s.sourceStartFrame < 0 ||
                !Number.isSafeInteger(s.sourceStartFrame + s.frameCount))),
        ) ||
        segments.reduce((sum, s) => sum + s.frameCount, 0) !== frameCount)) ||
    (options.visualClips !== undefined &&
      (options.visualClips.length === 0 ||
        options.visualClips.length > 64 ||
        options.visualClips.some(
          (clip) =>
            !Number.isSafeInteger(clip.timelineStartFrame) ||
            clip.timelineStartFrame < 0 ||
            !Number.isSafeInteger(clip.sourceStartFrame) ||
            clip.sourceStartFrame < 0 ||
            !Number.isSafeInteger(clip.frameCount) ||
            clip.frameCount <= 0 ||
            !Number.isSafeInteger(clip.sourceStartFrame + clip.frameCount) ||
            !Number.isSafeInteger(clip.timelineStartFrame + clip.frameCount) ||
            clip.timelineStartFrame + clip.frameCount > frameCount ||
            !Number.isFinite(clip.x ?? 0) ||
            Math.abs(clip.x ?? 0) > 32768 ||
            !Number.isFinite(clip.y ?? 0) ||
            Math.abs(clip.y ?? 0) > 32768 ||
            !Number.isFinite(clip.scale ?? 1) ||
            (clip.scale ?? 1) < 0.01 ||
            (clip.scale ?? 1) > 4 ||
            width * (clip.scale ?? 1) > 8192 ||
            height * (clip.scale ?? 1) > 8192 ||
            !Number.isFinite(clip.opacity ?? 1) ||
            (clip.opacity ?? 1) < 0 ||
            (clip.opacity ?? 1) > 1 ||
            !['contain', 'cover', 'stretch'].includes(clip.fit ?? 'contain'),
        ))) ||
    (options.audioClips?.length ?? 0) > 64 ||
    options.audioClips?.some(
      (clip) =>
        !Number.isSafeInteger(clip.timelineStartFrame) ||
        clip.timelineStartFrame < 0 ||
        !Number.isSafeInteger(clip.sourceStartFrame) ||
        clip.sourceStartFrame < 0 ||
        !Number.isSafeInteger(clip.frameCount) ||
        clip.frameCount <= 0 ||
        !Number.isSafeInteger(clip.sourceStartFrame + clip.frameCount) ||
        clip.timelineStartFrame + clip.frameCount > frameCount ||
        !Number.isFinite(clip.volume) ||
        clip.volume < 0 ||
        clip.volume > 1 ||
        typeof clip.muted !== 'boolean' ||
        typeof clip.required !== 'boolean',
    )
  )
    throw new MediaError(
      'Invalid video render plan: use positive integer frame counts, even sides up to 3840 (at most 3840x2160 pixels), 1–120 fps, at most 64 visual/audio clips (or 128 legacy segments), valid transforms and #RRGGBB[AA]/transparent background, and 600 seconds.',
    );
}

function sameFrameRate(
  actual: string | null,
  numerator: number,
  denominator: number,
): boolean {
  const parts = actual?.match(/^(\d+)\/(\d+)$/);
  return (
    !!parts &&
    BigInt(parts[1]!) * BigInt(denominator) ===
      BigInt(numerator) * BigInt(parts[2]!) &&
    BigInt(parts[2]!) > 0n
  );
}

/** Execute an integer-frame plan without depending on projects, CLI or Electron. */
export async function renderVideoTimeline(
  options: VideoTimelineOptions,
): Promise<VideoTimelineResult> {
  checkRenderSignal(options.signal);
  validateOptions(options);
  const quality = options.quality ?? 'balanced';
  const resolution = options.resolution ?? 'project';
  if (
    !renderQualities.includes(quality) ||
    !renderResolutions.includes(resolution)
  )
    throw new MediaError('Unknown render quality or resolution preset.');
  const encoding = {
    draft: { preset: 'ultrafast', crf: '28' },
    balanced: { preset: 'veryfast', crf: '20' },
    high: { preset: 'medium', crf: '16' },
  }[quality];
  const { width, height, frameRate, frameCount } = options;
  // Scale the finished canvas, preserving project-space transforms and layout.
  const longSide = resolution === '720p' ? 1280 : 1920;
  const shortSide = resolution === '720p' ? 720 : 1080;
  const maxWidth = width < height ? shortSide : longSide;
  const maxHeight = width < height ? longSide : shortSide;
  // Keep the scale as an integer ratio until the final division, so exact even
  // dimensions cannot lose two pixels through floating-point multiplication.
  const [scaleNumerator, scaleDenominator]: [number, number] =
    resolution === 'project'
      ? [1, 1]
      : maxWidth * height <= maxHeight * width
        ? [maxWidth, width]
        : [maxHeight, height];
  const outputWidth = Math.max(
    2,
    Math.floor((width * scaleNumerator) / (2 * scaleDenominator)) * 2,
  );
  const outputHeight = Math.max(
    2,
    Math.floor((height * scaleNumerator) / (2 * scaleDenominator)) * 2,
  );
  let cursor = 0;
  const visualClips: VisualTimelineClip[] =
    options.visualClips ??
    (options.segments ?? []).flatMap((segment) => {
      const timelineStartFrame = cursor;
      cursor += segment.frameCount;
      return segment.kind === 'gap' ? [] : [{ ...segment, timelineStartFrame }];
    });
  const { numerator, denominator } = frameRate;
  const rate = `${numerator}/${denominator}`;
  const durationSeconds = (frameCount * denominator) / numerator;
  const path = resolve(options.output);
  if (extname(path).toLowerCase() !== '.mp4')
    throw new MediaError('Render output must have a .mp4 extension.');
  try {
    const existing = await lstat(path);
    if (!options.overwrite || !existing.isFile())
      throw new MediaError(
        `Refusing to overwrite existing output '${path}'. Use --overwrite for a regular file.`,
      );
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-n',
    '-xerror',
    '-nostats',
    '-stats_period',
    '0.25',
    '-progress',
    'pipe:1',
  ];
  const filters: string[] = [];
  const sources = new Map<string, MediaMetadata>();
  const inputs = new Map<string, number>();
  const readSource = async (clip: { path: string; clipId: string }) => {
    checkRenderSignal(options.signal);
    if (options.overwrite) {
      // Never let explicit replacement target any source, including aliases.
      const existing = await stat(path).catch((error: unknown) => {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        )
          return null;
        throw error;
      });
      const original = await stat(clip.path).catch(() => null);
      if (
        existing &&
        original &&
        existing.dev === original.dev &&
        existing.ino === original.ino
      )
        throw new MediaError(
          `Render output must not replace source media '${clip.path}'.`,
        );
    }
    let source = sources.get(clip.path);
    if (!source) {
      try {
        source = await probeMedia(clip.path, options.signal);
      } catch (cause) {
        checkRenderSignal(options.signal);
        throw new MediaError(
          `Clip '${clip.clipId}' cannot read/probe media '${clip.path}'. Restore a readable source file. ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        );
      }
      sources.set(clip.path, source);
    }
    return source;
  };
  let input = 0;
  filters.push(
    `color=c=${opaqueCanvasColor(options.backgroundColor ?? '#000000')}:s=${width}x${height}:r=${rate},` +
      `format=rgba,trim=end_frame=${frameCount},settb=1/${numerator},setpts=N*${denominator}[canvas0]`,
  );
  for (const [index, clip] of visualClips.entries()) {
    const source = await readSource(clip);
    const { video } = source;
    const format = source.formatName ?? '';
    const still =
      !source.audio &&
      (format.endsWith('_pipe') ||
        ['image2', 'image2pipe'].includes(format) ||
        (['gif', 'apng'].includes(format) && !source.durationSeconds));
    if (!video || video.isAttachedPicture || (!still && !video.frameRate))
      throw new MediaError(
        `Clip '${clip.clipId}' requires timed video or a still image on the video track.`,
      );
    const rotated = Math.abs(video.rotation ?? 0) % 180 === 90;
    const displayWidth =
      (video.width ?? width) * (video.sampleAspectRatio ?? 1);
    const displayHeight = video.height ?? height;
    // Chromium treats untagged HD as BT.709 and SD as BT.601. Compose in RGB,
    // so sources with different YUV matrices and PNG alpha blend like Canvas.
    const matrix = sourceColorMatrix(
      video.colorSpace,
      video.width ?? 0,
      video.height ?? 0,
      video.codec,
    );
    const geometry = visualGeometry(
      width,
      height,
      rotated ? displayHeight : displayWidth,
      rotated ? displayWidth : displayHeight,
      clip,
    );
    const offset =
      (video.startTimeSeconds ?? source.startTimeSeconds ?? 0) -
      (source.startTimeSeconds ?? 0);
    const duration =
      video.durationSeconds ??
      (source.durationSeconds === null
        ? null
        : source.durationSeconds - offset);
    const sourceEnd = clip.sourceStartFrame + clip.frameCount;
    if (
      !still &&
      (duration === null ||
        duration <= 0 ||
        (sourceEnd * denominator) / numerator > duration + 0.000001)
    )
      throw new MediaError(
        `Clip '${clip.clipId}' source out exceeds the current video duration or its duration is unknown. Re-import the media and trim to a known video range.`,
      );
    args.push('-threads', '1', '-i', source.path);
    inputs.set(clip.clipId, input);
    // Sample before trimming so source selection is invariant under splitting.
    // A source frame first covers the project tick at or after its PTS.
    // Rounding down or to nearest can show a frame before its presentation time.
    const sampling = still
      ? `loop=loop=-1:size=1:start=0,trim=end_frame=${clip.frameCount}`
      : `setpts=PTS-STARTPTS,fps=${rate}:start_time=0:round=up:eof_action=pass,tpad=stop_mode=clone:stop=1,` +
        `trim=start_frame=${clip.sourceStartFrame}:end_frame=${sourceEnd}`;
    filters.push(
      `[${input++}:${video.index}]${sampling},` +
        `${fitVisual(geometry, matrix)},format=rgba,` +
        ((clip.opacity ?? 1) === 1 ? '' : `lut=a=val*${clip.opacity},`) +
        `settb=1/${numerator},setpts=(N+${clip.timelineStartFrame})*${denominator}[layer${index}]`,
    );
    filters.push(
      `[canvas${index}][layer${index}]overlay=x=${geometry.x}:y=${geometry.y}:` +
        `eof_action=pass:repeatlast=0:format=rgb:alpha=straight:enable='gte(n,${clip.timelineStartFrame})*lt(n,${clip.timelineStartFrame + clip.frameCount})'[canvas${index + 1}]`,
    );
  }
  filters.push(
    `[canvas${visualClips.length}]settb=1/${numerator},setpts=N*${denominator},scale=${outputWidth}:${outputHeight}:out_color_matrix=bt709,setsar=1,format=yuv420p[video]`,
  );
  // Round absolute project boundaries to the nearest 48 kHz sample. Never sum
  // independently rounded durations: fractional frame rates must not accumulate drift.
  const sample = (frame: number) => {
    const n = BigInt(frame) * BigInt(denominator) * 48000n;
    return Number((2n * n + BigInt(numerator)) / (2n * BigInt(numerator)));
  };
  const totalSamples = sample(frameCount);
  const audioLabels = ['[silence]'];
  filters.push(
    `anullsrc=r=48000:cl=stereo,atrim=end_sample=${totalSamples},asetpts=N/SR/TB[silence]`,
  );
  for (const [index, clip] of (options.audioClips ?? []).entries()) {
    const source = await readSource(clip);
    const { audio, video } = source;
    if (!audio) {
      if (clip.required)
        throw new MediaError(
          `Clip '${clip.clipId}' requires an audio stream. Re-import or relink the audio asset.`,
        );
      continue;
    }
    const origin =
      video?.startTimeSeconds ??
      audio.startTimeSeconds ??
      source.startTimeSeconds ??
      0;
    const offset = (audio.startTimeSeconds ?? origin) - origin;
    const duration =
      audio.durationSeconds === null
        ? source.durationSeconds === null
          ? null
          : source.durationSeconds -
            (origin - (source.startTimeSeconds ?? origin))
        : audio.durationSeconds + offset;
    if (
      clip.required &&
      (duration === null ||
        ((clip.sourceStartFrame + clip.frameCount) * denominator) / numerator >
          duration + 0.000001)
    )
      throw new MediaError(
        `Clip '${clip.clipId}' source out exceeds the current audio duration or its duration is unknown. Re-import the media and trim to a known audio range.`,
      );
    if (clip.muted || clip.volume === 0) continue;
    let audioInput = inputs.get(clip.clipId);
    if (audioInput === undefined) {
      audioInput = input++;
      args.push('-threads', '1', '-i', source.path);
    }
    const start = sample(clip.timelineStartFrame);
    const count = sample(clip.timelineStartFrame + clip.frameCount) - start;
    const sourceStart = sample(clip.sourceStartFrame);
    filters.push(
      `[${audioInput}:${audio.index}]asetpts=PTS-STARTPTS+(${offset.toFixed(9)})/TB,` +
        'aresample=48000:async=1:min_hard_comp=0:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,' +
        `apad,atrim=start_sample=${sourceStart}:end_sample=${sourceStart + count},asetpts=N/SR/TB,` +
        `volume=${clip.volume},adelay=${start}S:all=1[a${index}]`,
    );
    audioLabels.push(`[a${index}]`);
  }
  // Stable linear gains, independent of the number of active sources. Match the
  // existing composer limiter, including latency compensation for sync markers.
  filters.push(
    `${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=first:normalize=0,` +
      `alimiter=limit=0.95:level=0:latency=1,atrim=end_sample=${totalSamples},asetpts=N/SR/TB[audio]`,
  );
  checkRenderSignal(options.signal);
  let temporary: string;
  try {
    temporary = await mkdtemp(join(dirname(path), '.opencut-render-'));
  } catch (cause) {
    throw new MediaError(
      `Cannot create render output in '${dirname(path)}'; use an existing writable directory.`,
      { cause },
    );
  }
  const rendered = join(temporary, 'render.mp4');
  try {
    args.push(
      '-filter_complex_threads',
      '1',
      '-filter_complex',
      filters.join(';'),
      '-map',
      '[video]',
      '-map',
      '[audio]',
      '-map_metadata',
      '-1',
      '-c:v',
      'libx264',
      '-preset',
      encoding.preset,
      '-crf',
      encoding.crf,
      '-pix_fmt',
      'yuv420p',
      '-threads',
      '2',
      '-fps_mode',
      'passthrough',
      '-enc_time_base:v',
      `1/${numerator}`,
      '-colorspace',
      'bt709',
      '-color_primaries',
      'bt709',
      '-color_trc',
      'bt709',
      '-video_track_timescale',
      String(numerator),
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-movflags',
      '+faststart',
      '-f',
      'mp4',
      rendered,
    );
    const progress = renderProgress(frameCount, options.onProgress);
    progress.start();
    checkRenderSignal(options.signal);
    await runMediaTool('ffmpeg', args, 4 * 1024 * 1024, 600_000, {
      signal: options.signal,
      onStdout: progress.chunk,
    });
    checkRenderSignal(options.signal);
    progress.verifying();
    const metadata = await probeMedia(rendered, options.signal);
    const video = metadata.video;
    // Decode/count output frames, rather than trusting container duration alone.
    const frameProbe = await runMediaTool(
      'ffprobe',
      [
        '-v',
        'error',
        '-count_frames',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=nb_read_frames',
        '-of',
        'json',
        rendered,
      ],
      4 * 1024 * 1024,
      600_000,
      { signal: options.signal },
    );
    const counted = JSON.parse(frameProbe.toString('utf8')) as {
      streams?: { nb_read_frames?: string }[];
    };
    if (
      video?.codec !== 'h264' ||
      metadata.streams.length !== 2 ||
      metadata.audio?.codec !== 'aac' ||
      metadata.audio.sampleRate !== 48000 ||
      metadata.audio.channels !== 2 ||
      metadata.audio.startTimeSeconds !== 0 ||
      metadata.audio.durationSeconds === null ||
      Math.abs(metadata.audio.durationSeconds - durationSeconds) > 0.0011 ||
      video.width !== outputWidth ||
      video.height !== outputHeight ||
      !sameFrameRate(video.frameRateRatio, numerator, denominator) ||
      video.durationSeconds === null ||
      Math.abs(video.durationSeconds - durationSeconds) > 0.000002 ||
      metadata.durationSeconds === null ||
      Math.abs(metadata.durationSeconds - durationSeconds) > 0.0011 ||
      video.startTimeSeconds !== 0 ||
      Number(counted.streams?.[0]?.nb_read_frames) !== frameCount
    )
      throw new MediaError(
        'Render verification failed: unexpected codec, dimensions, frame rate, duration or decoded frame count. Check source decodability and trim ranges.',
      );
    checkRenderSignal(options.signal);
    try {
      if (options.overwrite) {
        const destination = await lstat(path).catch((error: unknown) => {
          if (
            error instanceof Error &&
            'code' in error &&
            error.code === 'ENOENT'
          )
            return null;
          throw error;
        });
        if (destination && !destination.isFile())
          throw new MediaError(
            `Refusing to overwrite non-regular output '${path}'.`,
          );
        checkRenderSignal(options.signal);
        // Same-filesystem rename replaces a complete file atomically.
        await rename(rendered, path);
      } else await link(rendered, path);
    } catch (cause) {
      if (cause instanceof MediaError) throw cause;
      throw new MediaError(
        cause instanceof Error && 'code' in cause && cause.code === 'EEXIST'
          ? `Refusing to overwrite existing output '${path}'.`
          : `Cannot publish render '${path}'; check destination permissions and filesystem support for ${options.overwrite ? 'atomic rename' : 'hard links'}.`,
        { cause },
      );
    }
    return {
      path,
      quality,
      resolution,
      width: outputWidth,
      height: outputHeight,
      frameRate,
      frameCount,
      durationSeconds,
      metadata: { ...metadata, path },
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

import { link, lstat, mkdtemp, rm } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { probeMedia } from './probe.js';
import type { MediaMetadata } from './probe.js';
import { MediaError, runMediaTool } from './process.js';
import { fitVideo } from './video-filter.js';

export interface VideoTimelineOptions {
  width: number;
  height: number;
  frameRate: { numerator: number; denominator: number };
  frameCount: number;
  segments: Array<
    | { kind: 'gap'; frameCount: number }
    | {
        kind: 'clip';
        clipId: string;
        path: string;
        sourceStartFrame: number;
        frameCount: number;
      }
  >;
  output: string;
}

export interface VideoTimelineResult {
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
    segments,
  } = options;
  if (
    ![width, height, numerator, denominator, frameCount].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    ) ||
    width < 2 ||
    height < 2 ||
    width > 3840 ||
    height > 2160 ||
    width % 2 ||
    height % 2 ||
    numerator > 2147483647 ||
    denominator > 2147483647 ||
    numerator < denominator ||
    numerator > 120 * denominator ||
    BigInt(frameCount) * BigInt(denominator) > 600n * BigInt(numerator) ||
    segments.length === 0 ||
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
    segments.reduce((sum, s) => sum + s.frameCount, 0) !== frameCount
  )
    throw new MediaError(
      'Invalid video render plan: use positive integer frame counts, even dimensions up to 3840x2160, 1–120 fps, at most 128 segments and 600 seconds.',
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
  validateOptions(options);
  const { width, height, frameRate, frameCount, segments } = options;
  const { numerator, denominator } = frameRate;
  const rate = `${numerator}/${denominator}`;
  const durationSeconds = (frameCount * denominator) / numerator;
  const path = resolve(options.output);
  if (extname(path).toLowerCase() !== '.mp4')
    throw new MediaError('Render output must have a .mp4 extension.');
  try {
    await lstat(path);
    throw new MediaError(`Refusing to overwrite existing output '${path}'.`);
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
  ];
  const filters: string[] = [];
  const sources = new Map<string, MediaMetadata>();
  let input = 0;
  for (const [index, segment] of segments.entries()) {
    if (segment.kind === 'gap') {
      filters.push(
        `color=c=black:s=${width}x${height}:r=${rate},trim=end_frame=${segment.frameCount},setpts=PTS-STARTPTS[v${index}]`,
      );
      continue;
    }
    let source = sources.get(segment.path);
    if (!source) {
      try {
        source = await probeMedia(segment.path);
      } catch (cause) {
        throw new MediaError(
          `Clip '${segment.clipId}' cannot read/probe media '${segment.path}'. Restore a readable source file. ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        );
      }
      sources.set(segment.path, source);
    }
    const { video } = source;
    const format = source.formatName ?? '';
    const still =
      !source.audio &&
      (format.endsWith('_pipe') ||
        ['image2', 'image2pipe'].includes(format) ||
        (['gif', 'apng'].includes(format) && !source.durationSeconds));
    if (!video?.frameRate || video.isAttachedPicture || still)
      throw new MediaError(
        `Clip '${segment.clipId}' requires timed video; still images and audio-only sources are unsupported in T10.`,
      );
    // Source points are relative to the first video frame, as in T03 composition.
    const offset =
      (video.startTimeSeconds ?? source.startTimeSeconds ?? 0) -
      (source.startTimeSeconds ?? 0);
    const duration =
      video.durationSeconds ??
      (source.durationSeconds === null
        ? null
        : source.durationSeconds - offset);
    const sourceEnd = segment.sourceStartFrame + segment.frameCount;
    if (
      duration === null ||
      duration <= 0 ||
      (sourceEnd * denominator) / numerator > duration + 0.000001
    )
      throw new MediaError(
        `Clip '${segment.clipId}' source out exceeds the current video duration or its duration is unknown. Re-import the media and trim to a known video range.`,
      );
    args.push('-threads', '1', '-i', source.path);
    // Sample the entire source on ONE project grid before integer trimming. A split
    // then selects the same frames as the unsplit clip, even at differing rates.
    // One cloned frame covers fractional EOF rounding, never an arbitrary shortfall.
    filters.push(
      `[${input++}:${video.index}]setpts=PTS-STARTPTS,${fitVideo(width, height)},` +
        `fps=${rate}:start_time=0:round=near:eof_action=pass,tpad=stop_mode=clone:stop=1,` +
        `trim=start_frame=${segment.sourceStartFrame}:end_frame=${sourceEnd},` +
        `settb=1/${numerator},setpts=N*${denominator},format=yuv420p[v${index}]`,
    );
  }
  // concat uses a microsecond time base internally. Discard its timestamps and
  // regenerate from the global frame index, so boundary rounding cannot accumulate.
  filters.push(
    `${segments.map((_, i) => `[v${i}]`).join('')}concat=n=${segments.length}:v=1:a=0,` +
      `settb=1/${numerator},setpts=N*${denominator}[video]`,
  );
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
      '-an',
      '-map_metadata',
      '-1',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '20',
      '-pix_fmt',
      'yuv420p',
      '-threads',
      '2',
      '-fps_mode',
      'passthrough',
      '-enc_time_base:v',
      `1/${numerator}`,
      '-video_track_timescale',
      String(numerator),
      '-frames:v',
      String(frameCount),
      '-movflags',
      '+faststart',
      '-f',
      'mp4',
      rendered,
    );
    await runMediaTool('ffmpeg', args, 4 * 1024 * 1024, 600_000);
    const metadata = await probeMedia(rendered);
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
    );
    const counted = JSON.parse(frameProbe.toString('utf8')) as {
      streams?: { nb_read_frames?: string }[];
    };
    if (
      video?.codec !== 'h264' ||
      metadata.streams.length !== 1 ||
      video.width !== width ||
      video.height !== height ||
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
    try {
      await link(rendered, path);
    } catch (cause) {
      throw new MediaError(
        cause instanceof Error && 'code' in cause && cause.code === 'EEXIST'
          ? `Refusing to overwrite existing output '${path}'.`
          : `Cannot publish render '${path}'; the destination filesystem must support hard links.`,
        { cause },
      );
    }
    return {
      path,
      width,
      height,
      frameRate,
      frameCount,
      durationSeconds,
      metadata: { ...metadata, path },
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

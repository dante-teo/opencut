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
    segments.reduce((sum, s) => sum + s.frameCount, 0) !== frameCount ||
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
  const inputs = new Map<string, number>();
  const readSource = async (clip: { path: string; clipId: string }) => {
    let source = sources.get(clip.path);
    if (!source) {
      try {
        source = await probeMedia(clip.path);
      } catch (cause) {
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
  for (const [index, segment] of segments.entries()) {
    if (segment.kind === 'gap') {
      filters.push(
        `color=c=black:s=${width}x${height}:r=${rate},trim=end_frame=${segment.frameCount},setpts=PTS-STARTPTS[v${index}]`,
      );
      continue;
    }
    const source = await readSource(segment);
    const { video } = source;
    const format = source.formatName ?? '';
    const still =
      !source.audio &&
      (format.endsWith('_pipe') ||
        ['image2', 'image2pipe'].includes(format) ||
        (['gif', 'apng'].includes(format) && !source.durationSeconds));
    if (!video?.frameRate || video.isAttachedPicture || still)
      throw new MediaError(
        `Clip '${segment.clipId}' requires timed video; still images and audio-only sources are unsupported on the video track.`,
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
    inputs.set(segment.clipId, input);
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
      metadata.streams.length !== 2 ||
      metadata.audio?.codec !== 'aac' ||
      metadata.audio.sampleRate !== 48000 ||
      metadata.audio.channels !== 2 ||
      metadata.audio.startTimeSeconds !== 0 ||
      metadata.audio.durationSeconds === null ||
      Math.abs(metadata.audio.durationSeconds - durationSeconds) > 0.0011 ||
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

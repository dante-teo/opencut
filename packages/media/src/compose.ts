import { link, lstat, mkdtemp, rm } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fitVideo } from './video-filter.js';
import { probeMedia } from './probe.js';
import type { MediaMetadata, MediaStream } from './probe.js';
import { MediaError, runMediaTool } from './process.js';

export interface CompositionOptions {
  clips: string[];
  music: string;
  output: string;
  width?: number;
  height?: number;
  fps?: number;
  clipVolume?: number;
  musicVolume?: number;
}

export interface CompositionResult {
  path: string;
  clipPaths: string[];
  musicPath: string;
  /** Frame-aligned planned duration; metadata contains the measured duration. */
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  clipVolume: number;
  musicVolume: number;
  metadata: MediaMetadata;
}

interface CompositionClip {
  path: string;
  video: MediaStream;
  audio: MediaStream | null;
  frameCount: number;
  durationSeconds: number;
}

function numberOption(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
  integer = false,
): number {
  if (
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum ||
    (integer && !Number.isInteger(value))
  ) {
    throw new MediaError(
      `${name} must be ${integer ? 'an integer' : 'a finite number'} between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function prepareClip(media: MediaMetadata, fps: number): CompositionClip {
  const { video } = media;
  if (!video || !video.frameRate) {
    throw new MediaError(
      `Clip '${media.path}' must have a timed video stream (not a still image).`,
    );
  }
  const offset =
    (video.startTimeSeconds ?? media.startTimeSeconds ?? 0) -
    (media.startTimeSeconds ?? 0);
  const duration =
    video.durationSeconds ??
    (media.durationSeconds === null ? null : media.durationSeconds - offset);
  if (duration === null || !Number.isFinite(duration) || duration <= 0) {
    throw new MediaError(
      `Clip '${media.path}' needs a known positive video duration.`,
    );
  }
  const frameCount = Math.max(1, Math.round(duration * fps));
  return {
    path: media.path,
    video,
    audio: media.audio,
    frameCount,
    durationSeconds: frameCount / fps,
  };
}

function verifyComposition(
  metadata: MediaMetadata,
  expected: Pick<
    CompositionResult,
    'durationSeconds' | 'width' | 'height' | 'fps'
  >,
): void {
  const { video, audio } = metadata;
  const { durationSeconds, width, height, fps } = expected;
  const durationTolerance = Math.max(0.1, 1 / fps);
  const near = (
    actual: number | null,
    target: number | null,
    tolerance: number,
  ) =>
    actual !== null &&
    target !== null &&
    Math.abs(actual - target) <= tolerance;
  if (
    video?.codec !== 'h264' ||
    audio?.codec !== 'aac' ||
    video.width !== width ||
    video.height !== height ||
    video.frameRate !== fps ||
    audio.sampleRate !== 48000 ||
    audio.channels !== 2 ||
    !near(metadata.durationSeconds, durationSeconds, durationTolerance) ||
    !near(video.durationSeconds, durationSeconds, durationTolerance) ||
    !near(audio.durationSeconds, durationSeconds, durationTolerance) ||
    !near(video.durationSeconds, audio.durationSeconds, 0.1) ||
    !near(metadata.startTimeSeconds, 0, 0.05) ||
    !near(video.startTimeSeconds, 0, 0.05) ||
    !near(audio.startTimeSeconds, 0, 0.05)
  ) {
    throw new MediaError(
      'Export verification failed: unexpected codecs, dimensions, frame rate or A/V timing.',
    );
  }
}

// A short-lived FFmpeg spike, deliberately independent of any project/timeline model.
export async function composeMedia(
  options: CompositionOptions,
): Promise<CompositionResult> {
  if (options.clips.length < 2 || options.clips.length > 16) {
    throw new MediaError('Composition requires between 2 and 16 video clips.');
  }
  const width = numberOption('Width', options.width ?? 1280, 2, 3840, true);
  const height = numberOption('Height', options.height ?? 720, 2, 2160, true);
  if (width % 2 || height % 2)
    throw new MediaError('Output dimensions must be even for H.264/yuv420p.');
  const fps = numberOption('FPS', options.fps ?? 30, 1, 60, true);
  const clipVolume = numberOption('Clip volume', options.clipVolume ?? 1, 0, 1);
  const musicVolume = numberOption(
    'Music volume',
    options.musicVolume ?? 0.25,
    0,
    1,
  );
  const path = resolve(options.output);
  if (extname(path).toLowerCase() !== '.mp4')
    throw new MediaError('Composition output must have a .mp4 extension.');
  try {
    await lstat(path);
    throw new MediaError(`Refusing to overwrite existing output '${path}'.`);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }

  // Probe sequentially to keep the number of concurrent native processes bounded.
  const clips: CompositionClip[] = [];
  for (const file of options.clips) {
    clips.push(prepareClip(await probeMedia(file), fps));
  }
  const durationSeconds =
    clips.reduce((sum, clip) => sum + clip.frameCount, 0) / fps;
  if (durationSeconds > 600)
    throw new MediaError(
      'This composition prototype supports at most 600 seconds of video.',
    );
  const music = await probeMedia(options.music);
  if (!music.audio)
    throw new MediaError(
      `Background music '${music.path}' has no audio stream.`,
    );

  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n'];
  for (const clip of clips) args.push('-i', clip.path);
  args.push('-stream_loop', '-1', '-i', music.path);
  const filters: string[] = [];
  clips.forEach((clip, i) => {
    // Pass the last frame through EOF even when a whole clip is shorter than
    // half an output frame. Padding then covers any remaining frame rounding;
    // trim keeps concat from extending a segment to fit longer audio.
    const duration = clip.durationSeconds.toFixed(9);
    const { video } = clip;
    filters.push(
      `[${i}:${video.index}]setpts=PTS-STARTPTS,` +
        `${fitVideo(width, height)},` +
        `fps=${fps}:eof_action=pass,tpad=stop_mode=clone:stop_duration=${duration},trim=end_frame=${clip.frameCount},` +
        `settb=AVTB,setpts=N/(${fps}*TB),format=yuv420p[v${i}]`,
    );
    if (clip.audio && clipVolume > 0) {
      const offset =
        (clip.audio.startTimeSeconds ?? video.startTimeSeconds ?? 0) -
        (video.startTimeSeconds ?? clip.audio.startTimeSeconds ?? 0);
      filters.push(
        `[${i}:${clip.audio.index}]asetpts=PTS-STARTPTS+(${offset.toFixed(9)})/TB,` +
          `aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
          `apad,atrim=duration=${duration},asetpts=N/SR/TB[a${i}]`,
      );
    } else {
      filters.push(
        `anullsrc=r=48000:cl=stereo,atrim=duration=${duration},asetpts=N/SR/TB[a${i}]`,
      );
    }
  });
  const total = durationSeconds.toFixed(9);
  filters.push(
    `${clips.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${clips.length}:v=1:a=1[video][original]`,
    `[original]volume=${clipVolume.toFixed(9)}[clips]`,
    // Fill even sub-100ms gaps before trimming; the resampler's default
    // threshold would leave them to be compressed when resetting PTS below.
    `[${clips.length}:${music.audio.index}]asetpts=PTS-STARTPTS,aresample=48000:async=1:min_hard_comp=0:first_pts=0,` +
      `aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${total},` +
      `asetpts=N/SR/TB,volume=${musicVolume.toFixed(9)}[music]`,
    // Keep both gains stable across silent clips. A limiter prevents clipping,
    // with latency compensation to avoid shifting the audible sync markers.
    `[clips][music]amix=inputs=2:duration=first:normalize=0,` +
      `alimiter=limit=0.95:level=0:latency=1,atrim=duration=${total}[audio]`,
  );

  let temporary: string;
  try {
    temporary = await mkdtemp(join(dirname(path), '.opencut-compose-'));
  } catch (error) {
    throw new MediaError(
      `Cannot create composition output in '${dirname(path)}'; use an existing writable directory.`,
      { cause: error },
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
      'cfr',
      '-r',
      String(fps),
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-t',
      total,
      '-movflags',
      '+faststart',
      '-f',
      'mp4',
      rendered,
    );
    await runMediaTool('ffmpeg', args, 4 * 1024 * 1024, 600_000);
    const metadata = await probeMedia(rendered);
    verifyComposition(metadata, { durationSeconds, width, height, fps });
    // Publish only a verified render. An atomic, exclusive hard link on the same
    // filesystem refuses existing files/symlinks, including a destination race.
    try {
      await link(rendered, path);
    } catch (error) {
      const exists =
        error instanceof Error && 'code' in error && error.code === 'EEXIST';
      throw new MediaError(
        exists
          ? `Refusing to overwrite existing output '${path}'.`
          : `Cannot publish composition output '${path}'; the destination filesystem must support hard links.`,
        { cause: error },
      );
    }
    return {
      path,
      clipPaths: clips.map((clip) => clip.path),
      musicPath: music.path,
      durationSeconds,
      width,
      height,
      fps,
      clipVolume,
      musicVolume,
      metadata: { ...metadata, path },
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

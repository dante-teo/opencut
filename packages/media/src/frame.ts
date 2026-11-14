import { sourceColorMatrix } from '@opencut/shared';
import { open } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { probeMedia } from './probe.js';
import type { MediaMetadata } from './probe.js';
import { MediaError, renderSourceInputArgs, runMediaTool } from './process.js';

export interface FrameResult {
  path: string;
  sourcePath: string;
  timestampSeconds: number;
  streamIndex: number;
}

export async function extractFrame(
  file: string,
  timestampSeconds: number,
  output: string,
): Promise<FrameResult> {
  if (!Number.isFinite(timestampSeconds) || timestampSeconds < 0) {
    throw new MediaError(
      'Frame timestamp must be a finite, nonnegative number of seconds.',
    );
  }
  const path = resolve(output);
  if (extname(path).toLowerCase() !== '.png') {
    throw new MediaError('Frame output must have a .png extension.');
  }
  const media = await probeMedia(file);
  const { video } = media;
  if (!video) throw new MediaError('Media has no video stream to extract.');
  // -ss is relative to the input start; a stream's duration is only its length.
  // Use its end in that same time base, or fall back to the reported media duration
  // when stream timing is incomplete. Unknown bounds are checked by decoding.
  const endSeconds =
    video.durationSeconds !== null &&
    video.startTimeSeconds !== null &&
    media.startTimeSeconds !== null
      ? video.startTimeSeconds - media.startTimeSeconds + video.durationSeconds
      : media.durationSeconds;
  if (endSeconds !== null && timestampSeconds >= endSeconds) {
    throw new MediaError(
      `Frame timestamp ${timestampSeconds}s is out of range; it must be less than ${endSeconds}s.`,
    );
  }
  const png = await runMediaTool(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-ss',
      // FFmpeg rejects exponential notation; its time base is microseconds.
      timestampSeconds.toFixed(6),
      '-i',
      media.path,
      '-map',
      `0:${video.index}`,
      '-frames:v',
      '1',
      '-c:v',
      'png',
      '-f',
      'image2pipe',
      'pipe:1',
    ],
    64 * 1024 * 1024,
  );
  if (!png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    throw new MediaError(
      'ffmpeg produced no PNG frame at the requested timestamp (possibly beyond the last decodable frame).',
    );
  }
  // Exclusive creation also refuses symlinks and aliases of the source file.
  // Decode first so executable/decoder failures cannot leave a partial output.
  let destination;
  try {
    destination = await open(path, 'wx');
  } catch (error) {
    const exists =
      error instanceof Error && 'code' in error && error.code === 'EEXIST';
    throw new MediaError(
      exists
        ? `Refusing to overwrite existing output '${path}'.`
        : `Cannot create frame output '${path}'.`,
      { cause: error },
    );
  }
  try {
    await destination.writeFile(png);
  } catch (error) {
    throw new MediaError(`Cannot write frame output '${path}'.`, {
      cause: error,
    });
  } finally {
    await destination.close();
  }
  return {
    path,
    sourcePath: media.path,
    timestampSeconds,
    streamIndex: video.index,
  };
}

/** Decode the frame covering a media timestamp using the same selection as project freeze. */
export async function decodeStillFrame(
  source: MediaMetadata,
  timestamp: number,
  fullSize: boolean,
  signal?: AbortSignal,
): Promise<Buffer> {
  const video = source.video;
  if (
    !video ||
    !Number.isFinite(timestamp) ||
    timestamp < 0 ||
    timestamp >= (source.durationSeconds ?? Infinity)
  )
    throw new MediaError('Frame is outside source bounds.');
  // Probe from the preceding seek point through the target, retaining VFR PTS.
  // Interval end is absolute: a relative duration would start at the seek point.
  const origin = source.startTimeSeconds ?? 0;
  const target = origin + timestamp;
  const [numerator, denominator] = (video.timeBase ?? '')
    .split('/')
    .map(Number);
  if (!numerator || !denominator || !Number.isFinite(numerator / denominator))
    throw new MediaError('Video time base is unavailable for cached frames.');
  const frames = await runMediaTool(
    'ffprobe',
    [
      '-v',
      'error',
      '-threads',
      '2',
      ...renderSourceInputArgs(),
      '-select_streams',
      String(video.index),
      '-read_intervals',
      `${(Math.floor(target * 1_000_000) / 1_000_000).toFixed(6)}%${(target + 1).toFixed(6)}`,
      '-show_frames',
      '-show_entries',
      'frame=best_effort_timestamp',
      '-of',
      'csv=p=0',
      source.path,
    ],
    4 * 1024 * 1024,
    60000,
    { signal },
  );
  let presentation = -Infinity;
  for (const line of frames.toString().split('\n')) {
    if (!/^-?\d/.test(line)) continue;
    const ticks = Number(line.split(',')[0]);
    if (!Number.isSafeInteger(ticks)) continue;
    const time = (ticks * numerator) / denominator;
    if (time <= target && time > presentation) presentation = time;
  }
  if (!Number.isFinite(presentation))
    throw new MediaError('No frame covers the requested source time.');
  // Seek just before the chosen PTS so microsecond rounding cannot skip it.
  const seek = Math.max(0, presentation - origin - 0.000001);
  const png = await runMediaTool(
    'ffmpeg',
    [
      '-v',
      'error',
      '-nostdin',
      '-threads',
      '2',
      '-ss',
      seek.toFixed(6),
      ...renderSourceInputArgs(),
      '-i',
      source.path,
      '-map',
      `0:${video.index}`,
      '-vf',
      `scale=${fullSize ? "w='min(3840,iw*sar)':h='min(3840,ih)'" : '640:360'}:force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1:in_color_matrix=${sourceColorMatrix(video.colorSpace, video.width ?? 0, video.height ?? 0, video.codec)}`,
      '-frames:v',
      '1',
      '-threads',
      '1',
      '-c:v',
      'png',
      '-f',
      'image2pipe',
      'pipe:1',
    ],
    (fullSize ? 64 : 2) * 1024 * 1024,
    60000,
    { signal },
  );
  if (!png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
    throw new MediaError('No frame at requested source time.');
  return png;
}

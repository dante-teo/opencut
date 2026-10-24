import { open } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { probeMedia } from './probe.js';
import { MediaError, runMediaTool } from './process.js';

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

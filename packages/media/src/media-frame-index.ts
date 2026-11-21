import { MediaError, runMediaTool, sourceFileStamp } from './process.js';
import { probeMedia } from './probe.js';
import { orientedSource } from './source-window.js';

export async function readMp4FrameIndex(file: string, signal?: AbortSignal) {
  const identity = await sourceFileStamp(file);
  const { path, video } = await probeMedia(file, signal);
  const [numerator = 0, denominator = 0] =
    video?.timeBase?.split('/').map(Number) ?? [];
  if (
    !video ||
    ![numerator, denominator].every((n) => Number.isSafeInteger(n) && n > 0)
  )
    throw new MediaError('MP4 has no usable video time base.');

  const response = await runMediaTool(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      String(video.index),
      '-show_frames',
      '-show_entries',
      'frame=best_effort_timestamp,duration',
      '-of',
      'json',
      path,
    ],
    32 * 1024 * 1024,
    600_000,
    { signal, stage: 'indexing decoded MP4 frames' },
  );
  const { frames = [] } = JSON.parse(response.toString()) as {
    frames?: { best_effort_timestamp?: number; duration?: number }[];
  };
  const first = frames[0]?.best_effort_timestamp;
  const ticks: number[] = [];
  for (const { best_effort_timestamp: pts } of frames) {
    const delta = (pts ?? NaN) - (first ?? NaN);
    if (!Number.isSafeInteger(delta) || delta < (ticks.at(-1) ?? 0))
      throw new MediaError(
        'MP4 frames do not have ordered presentation timestamps.',
      );
    ticks.push(delta);
  }
  if (!ticks.length) throw new MediaError('MP4 has no decoded video frames.');
  const last = ticks.at(-1)!;
  const duration = frames.at(-1)?.duration ?? 0;
  const end =
    Number.isSafeInteger(duration) && duration > 0
      ? last + duration
      : last +
        Math.max(
          1,
          Math.round(denominator / (numerator * (video.frameRate ?? 1))),
        );
  return {
    path,
    stream: video.index,
    ...orientedSource(video),
    timeBase: { numerator, denominator },
    firstPts: first!,
    ticks,
    end,
    async checkSource() {
      if ((await sourceFileStamp(path)) !== identity)
        throw new MediaError('MP4 changed during frame inspection.');
    },
  };
}

export type Mp4FrameIndex = Awaited<ReturnType<typeof readMp4FrameIndex>>;

import { MediaError, runMediaTool } from './process.js';
import { probeMedia } from './probe.js';
import { orientedSource } from './source-window.js';
import {
  fingerprintSourceFile,
  sourceIdentity,
  SourceChangedError,
} from './source-integrity.js';
import { resolve } from 'node:path';

export async function readMp4FrameIndex(file: string, signal?: AbortSignal) {
  const path = resolve(file);
  const stage = 'MP4 frame indexing';
  const baseline = await fingerprintSourceFile(path, signal, stage, true);
  async function checkSource(stage = 'MP4 frame inspection') {
    signal?.throwIfAborted();
    const observed = sourceIdentity(path);
    if (observed !== baseline.identity) {
      const error = new SourceChangedError(
        path,
        stage,
        baseline.identity,
        observed,
      );
      await error.compareContent(baseline, signal);
      throw error;
    }
  }
  const { video } = await probeMedia(path, signal).catch(
    async (error: unknown) => {
      await checkSource(stage);
      throw error;
    },
  );
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
  ).finally(() => checkSource(stage));
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
    fingerprint: { bytes: baseline.bytes, sha256: baseline.sha256 },
    stream: video.index,
    frameRateRatio: video.frameRateRatio,
    ...orientedSource(video),
    timeBase: { numerator, denominator },
    firstPts: first!,
    ticks,
    end,
    checkSource,
  };
}

export type Mp4FrameIndex = Awaited<ReturnType<typeof readMp4FrameIndex>>;

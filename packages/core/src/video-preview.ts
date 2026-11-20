import {
  renderContactSheet,
  renderTimelineFrame,
  renderVideoTimeline,
} from '@opencut/media';
import type { RenderControls } from '@opencut/media';
import {
  inspectProject,
  inspectTimeline,
  previewClipSchema,
  previewFrameSchema,
  previewSheetSchema,
} from './inspection.js';
import { frameTime, timeSchema } from './time.js';
import type { FrameRate, RationalTime } from './time.js';
import type { CompiledVideo } from './video-compiler.js';
import { openAudioMixCache } from './video-audio-mix.js';
import { describeMusicComparison } from './music-comparison.js';
import { withRenderSources } from './render-sources.js';

export type PreviewPosition = number | RationalTime;
export type VideoPreviewOptions = Pick<
  RenderControls,
  'signal' | 'maxDimension' | 'quality'
>;
export type VideoPreviewRange = { startFrame?: number; endFrame?: number };
export class VideoPreviewRangeError extends RangeError {}

function previewFrameIndex(position: PreviewPosition, rate: FrameRate): number {
  if (typeof position === 'number') return position;
  const { numerator, denominator } = timeSchema.parse(position);
  return Number(
    (BigInt(numerator) * BigInt(rate.numerator)) /
      (BigInt(denominator) * BigInt(rate.denominator)),
  );
}

/** Inspect and render a compiled definition on its project frame grid. */
export function previewVideo(video: CompiledVideo) {
  const { project, path, frameCount } = video;
  const { frameRate } = project.settings;
  const base = {
    inspectionVersion: 1,
    projectPath: path,
    projectId: project.metadata.id,
    frameRate,
  };
  function range(startFrame: number, endFrame: number) {
    if (
      !Number.isSafeInteger(startFrame) ||
      !Number.isSafeInteger(endFrame) ||
      startFrame < 0 ||
      endFrame <= startFrame ||
      endFrame > frameCount
    )
      throw new VideoPreviewRangeError(
        `Select a range with 0 <= from < to <= ${frameCount} frames.`,
      );
    return { startFrame, endFrame };
  }
  return {
    frameCount,
    inspect: () => inspectProject(project, path),
    inspectFrame: (position: PreviewPosition) =>
      inspectTimeline(project, path, previewFrameIndex(position, frameRate)),
    async frame(
      position: PreviewPosition,
      output: string,
      options: VideoPreviewOptions = {},
    ) {
      const frame = previewFrameIndex(position, frameRate);
      const selection = range(frame, frame + 1);
      const quality = options.quality ?? 'fast';
      const revision = await video.forQuality(quality, true, options.signal);
      const result = await withRenderSources(revision, options.signal, (plan) =>
        renderTimelineFrame({
          ...plan,
          signal: options.signal,
          maxDimension: options.maxDimension,
          quality,
          output,
          range: selection,
        }),
      );
      return previewFrameSchema.parse({
        ...base,
        ...result,
        kind: 'frame',
        quality,
        frame,
        time: frameTime(frame, frameRate),
      });
    },
    async contactSheet(
      selection: VideoPreviewRange,
      output: string,
      options: VideoPreviewOptions & { count?: number; columns?: number } = {},
    ) {
      const { startFrame, endFrame } = range(
        selection.startFrame ?? 0,
        selection.endFrame ?? frameCount,
      );
      const {
        count = Math.min(8, endFrame - startFrame),
        columns = Math.min(4, count),
        signal,
        maxDimension,
        quality = 'fast',
      } = options;
      if (
        !Number.isSafeInteger(count) ||
        count < 1 ||
        count > Math.min(16, endFrame - startFrame) ||
        !Number.isSafeInteger(columns) ||
        columns < 1 ||
        columns > count
      )
        throw new VideoPreviewRangeError(
          'Contact sheets require 1–16 samples within the range and 1–sample-count columns.',
        );
      const frames = Array.from(
        { length: count },
        (_, i) =>
          startFrame +
          (count === 1
            ? 0
            : Math.floor(((endFrame - startFrame - 1) * i) / (count - 1))),
      );
      const revision = await video.forQuality(quality, true, signal);
      const result = await withRenderSources(revision, signal, (plan) =>
        renderContactSheet(
          { ...plan, signal, maxDimension, quality, output },
          frames,
          columns,
        ),
      );
      return previewSheetSchema.parse({
        ...base,
        ...result,
        kind: 'contact-sheet',
        quality,
        startFrame,
        endFrame,
        samples: frames.map((frame, i) => ({
          frame,
          time: frameTime(frame, frameRate),
          x: (i % columns) * result.cellWidth,
          y: Math.floor(i / columns) * (result.tileHeight + result.labelHeight),
        })),
      });
    },
    async clip(
      selection: Required<VideoPreviewRange>,
      output: string,
      options: VideoPreviewOptions &
        Pick<RenderControls, 'onProgress' | 'audioComparison'> & {
          audioMixCacheDirectory?: string | undefined;
        } = {},
    ) {
      const { startFrame, endFrame } = range(
        selection.startFrame,
        selection.endFrame,
      );
      if (
        BigInt(endFrame - startFrame) * BigInt(frameRate.denominator) >
        30n * BigInt(frameRate.numerator)
      )
        throw new VideoPreviewRangeError(
          'Preview clips are limited to 30 seconds; select a shorter range.',
        );
      const { signal, onProgress } = options;
      const quality = options.quality ?? 'fast';
      const revision = await video.forQuality(quality, true, signal);
      const audioMixCache = await openAudioMixCache(
        options.audioMixCacheDirectory,
        signal,
      );
      const {
        path,
        width,
        height,
        frameCount,
        durationSeconds,
        audioMix,
        audioChannelRouting,
        warnings,
        musicLoudness,
      } = await withRenderSources(revision, signal, (plan) =>
        renderVideoTimeline({
          ...plan,
          signal,
          ...(onProgress && { onProgress }),
          maxDimension: options.maxDimension ?? 640,
          audioComparison: options.audioComparison,
          ...(audioMixCache && { audioMixCache }),
          quality,
          output,
          range: { startFrame, endFrame },
        }),
      );
      const result = previewClipSchema.parse({
        ...base,
        path,
        width,
        height,
        frameCount,
        durationSeconds,
        quality,
        kind: 'clip',
        startFrame,
        endFrame,
        startTime: frameTime(startFrame, frameRate),
        endTime: frameTime(endFrame, frameRate),
      });
      const musicComparison = describeMusicComparison(revision.project);
      return {
        ...result,
        ...(audioMix && { audioMix }),
        ...(audioChannelRouting && { audioChannelRouting }),
        ...(warnings && { warnings }),
        ...(musicLoudness && { musicLoudness }),
        ...(musicComparison && { musicComparison }),
      };
    },
  };
}

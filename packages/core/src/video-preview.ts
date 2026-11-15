import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import {
  renderContactSheet,
  renderTimelineFrame,
  renderVideoTimeline,
} from '@opencut/media';
import type { RenderControls, VideoTimelineOptions } from '@opencut/media';
import {
  inspectProject,
  inspectTimeline,
  previewClipSchema,
  previewFrameSchema,
  previewSheetSchema,
} from './inspection.js';
import { projectRevision } from './editing.js';
import type { Project } from './project.js';
import { frameTime, timeSchema } from './time.js';
import type { FrameRate, RationalTime } from './time.js';
import type { CompiledVideo } from './video-compiler.js';
import { resolveProjectRender } from './render-files.js';
import { copyVideoInput } from './video-input.js';

export type PreviewPosition = number | RationalTime;
export type VideoPreviewOptions = Pick<
  RenderControls,
  'signal' | 'maxDimension'
>;
export type VideoPreviewRange = { startFrame?: number; endFrame?: number };
export class VideoPreviewRangeError extends RangeError {}

type BoundPlan = Awaited<ReturnType<typeof resolveProjectRender>> &
  Pick<VideoTimelineOptions, 'sourceMetadata' | 'snapshotSource'>;
type UseRenderPlan = <T>(
  signal: AbortSignal | undefined,
  run: (plan: BoundPlan) => Promise<T>,
) => Promise<T>;

export function previewFrameIndex(
  position: PreviewPosition,
  rate: FrameRate,
): number {
  if (typeof position === 'number') return position;
  const { numerator, denominator } = timeSchema.parse(position);
  return Number(
    (BigInt(numerator) * BigInt(rate.numerator)) /
      (BigInt(denominator) * BigInt(rate.denominator)),
  );
}

function timelinePreview(
  {
    project,
    path,
    frameCount,
  }: { project: Project; path: string; frameCount: number },
  useRenderPlan: UseRenderPlan,
) {
  const { frameRate } = project.settings;
  const base = {
    inspectionVersion: 1,
    projectPath: path,
    projectId: project.metadata.id,
    revision: projectRevision(project),
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
      const result = await useRenderPlan(options.signal, (plan) =>
        renderTimelineFrame({
          ...plan,
          signal: options.signal,
          maxDimension: options.maxDimension,
          output,
          range: selection,
        }),
      );
      return previewFrameSchema.parse({
        ...base,
        ...result,
        kind: 'frame',
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
      const result = await useRenderPlan(signal, (plan) =>
        renderContactSheet(
          { ...plan, signal, maxDimension, output },
          frames,
          columns,
        ),
      );
      return previewSheetSchema.parse({
        ...base,
        ...result,
        kind: 'contact-sheet',
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
        Pick<RenderControls, 'quality' | 'onProgress'> = {},
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
      const { path, width, height, frameCount, durationSeconds, quality } =
        await useRenderPlan(options.signal, (plan) =>
          renderVideoTimeline({
            ...plan,
            signal: options.signal,
            ...(options.onProgress && { onProgress: options.onProgress }),
            maxDimension: options.maxDimension ?? 640,
            quality: options.quality ?? 'draft',
            output,
            range: { startFrame, endFrame },
          }),
        );
      return previewClipSchema.parse({
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
    },
  };
}

export async function previewProject(project: Project, path: string) {
  const plan = await resolveProjectRender(project, path);
  return timelinePreview(
    { project, path, frameCount: plan.frameCount },
    (_signal, render) => render(plan),
  );
}

/** Inspect and render a compiled definition on its project frame grid. */
export function previewVideo(video: CompiledVideo) {
  return timelinePreview(video, async (signal, run) => {
    const plan = await video.resolveRender();
    const staged = new Map<string, string>();
    let directory: string | undefined;
    try {
      return await run({
        ...plan,
        async snapshotSource(path) {
          const existing = staged.get(path);
          if (existing) return existing;
          directory ??= await mkdtemp(join(tmpdir(), 'opencut-preview-'));
          const snapshot = join(directory, `${staged.size}${extname(path)}`);
          await copyVideoInput(
            path,
            video.sourceIdentity(path)!,
            snapshot,
            signal,
          );
          staged.set(path, snapshot);
          return snapshot;
        },
      });
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  });
}

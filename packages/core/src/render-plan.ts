import { maximumVisualScale } from '@opencut/shared';
import type {
  RenderTimeMapping,
  TransitionRamp,
  VisualAnimation,
} from '@opencut/shared';
import {
  clipSourcePosition,
  clipSourceTime,
  clipSpeed,
} from './clip-timing.js';
import type { Project, TimelineClip } from './project.js';
import { continuesMediaRun, resolveTimeline } from './evaluation.js';
import type { ResolvedMediaClip } from './evaluation.js';
import { resolveAudioFade } from './audio.js';
import { compareTimes, frameTime } from './time.js';
import type { FrameRate, RationalTime } from './time.js';

export class RenderError extends Error {
  override name = 'RenderError';
}

interface VisualRenderProperties {
  crop?: NonNullable<NonNullable<TimelineClip['visual']>['crop']>;
  grade?: NonNullable<TimelineClip['grade']>;
  clipId: string;
  timelineStartFrame: number;
  sourceStartFrame: number;
  retiming?: RenderTimeMapping & {
    sourceOriginNs: number;
    localSourceOriginNs: number;
  };
  frameCount: number;
  x: number;
  y: number;
  scale: number;
  opacity: number;
  rotation?: number;
  animation?: VisualAnimation;
  fit: 'contain' | 'cover' | 'stretch';
}

export type VisualRenderClip = VisualRenderProperties &
  (
    | {
        assetId: string;
        freezeFrame?: RationalTime;
        text?: never;
        subtitle?: never;
      }
    | {
        text: NonNullable<TimelineClip['text']>;
        assetId?: never;
        subtitle?: true;
        subtitleCueId?: string;
      }
  );

export interface ProjectRenderPlan {
  width: number;
  height: number;
  backgroundColor: string;
  frameRate: FrameRate;
  frameCount: number;
  /** Bottom to top, by track array order, then timeline start. */
  visualClips: VisualRenderClip[];
  audioClips: AudioRenderClip[];
  visualTransitions?: Array<{
    afterClipId: string;
    layers: Array<
      Extract<VisualRenderClip, { assetId: string }> & { ramp: TransitionRamp }
    >;
  }>;
}

export interface AudioRenderClip {
  clipId: string;
  assetId: string;
  timelineStartFrame: number;
  sourceStartFrame: number;
  frameCount: number;
  retiming?: RenderTimeMapping;
  tempoRunId?: string;
  volume: number;
  muted: boolean;
  fadeIn?: ReturnType<typeof resolveAudioFade>;
  fadeOut?: ReturnType<typeof resolveAudioFade>;
  gainKeys?: NonNullable<TimelineClip['gainKeys']>;
  effects?: NonNullable<TimelineClip['effects']>;
  /** Audio tracks require an audio stream; video clips may provide silence. */
  required: boolean;
  padAudio?: true;
}

function framePosition(time: RationalTime, rate: FrameRate) {
  return {
    ticks: BigInt(time.numerator) * BigInt(rate.numerator),
    tickSize: BigInt(time.denominator) * BigInt(rate.denominator),
  };
}

function exactFrame(
  time: RationalTime,
  rate: FrameRate,
  label: string,
): number {
  const { ticks, tickSize } = framePosition(time, rate);
  if (ticks % tickSize !== 0n)
    throw new RenderError(
      `${label} is between project frames. Align timeline and source points to project-frame boundaries before rendering.`,
    );
  const frame = ticks / tickSize;
  if (frame > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RenderError(`${label} exceeds the supported frame range.`);
  return Number(frame);
}

function sourceOriginNanoseconds(
  clip: TimelineClip,
  time: RationalTime = { numerator: 0, denominator: 1 },
): number {
  const origin = clipSourcePosition(clip, time);
  return Number((origin.numerator * 1_000_000_000n) / origin.denominator);
}

/** Pure compilation from saved-model semantics to ordered, integer-frame segments. */
export function planProjectRender(
  project: Project,
  { burnSubtitles = true }: { burnSubtitles?: boolean | undefined } = {},
): ProjectRenderPlan {
  const timeline = resolveTimeline(project);
  if (
    project.settings.durationFrames === undefined &&
    !timeline.clips.some((clip) => clip.trackType === 'video') &&
    !project.subtitles?.cues.length
  )
    throw new RenderError(
      'Video tracks are empty. Add a video, image or text clip before rendering.',
    );
  if (project.clips.length > 64)
    throw new RenderError(
      'Rendering supports at most 64 clips across all tracks. Render a smaller project.',
    );
  const { width, height } = project.settings;
  if (
    width < 2 ||
    height < 2 ||
    width > 3840 ||
    height > 3840 ||
    width * height > 3840 * 2160 ||
    width % 2 ||
    height % 2
  )
    throw new RenderError(
      'H.264 rendering requires even dimensions: each side 2–3840, at most 3840×2160 pixels. Update project settings.',
    );
  let { numerator, denominator } = project.settings.frameRate;
  let a = numerator;
  let b = denominator;
  while (b) [a, b] = [b, a % b];
  numerator /= a;
  denominator /= a;
  const frameRate = { numerator, denominator };
  if (
    numerator > 2147483647 ||
    denominator > 2147483647 ||
    numerator < denominator ||
    numerator > 120 * denominator
  )
    throw new RenderError(
      'Rendering requires an FFmpeg-compatible rational frame rate between 1 and 120 fps. Update project settings.',
    );
  const visualClips: VisualRenderClip[] = [];
  const audioClips: AudioRenderClip[] = [];
  if (compareTimes(timeline.duration, { numerator: 600, denominator: 1 }) > 0)
    throw new RenderError(
      'Rendering supports at most 600 seconds. Shorten the timeline.',
    );
  const sampledFrame = (time: RationalTime) => {
    const { ticks, tickSize } = framePosition(time, frameRate);
    return Number((ticks + tickSize - 1n) / tickSize);
  };
  const totalFrames = sampledFrame(timeline.duration);
  if (BigInt(totalFrames) * BigInt(denominator) > 600n * BigInt(numerator))
    throw new RenderError(
      'Rendering supports at most 600 seconds after frame sampling. Shorten the timeline.',
    );
  const freezes = new Map(
    project.assets.flatMap(({ id, freezeFrame }) =>
      freezeFrame ? [[id, freezeFrame] as const] : [],
    ),
  );
  let previousMedia: ResolvedMediaClip | undefined;
  let tempoRunId: string | undefined;
  for (const clip of timeline.clips) {
    if (clip.kind === 'text') {
      if (clip.subtitle && !burnSubtitles) continue;
      const start = sampledFrame(clip.timelineStart);
      const end = sampledFrame(clip.timelineEnd);
      if (end > start)
        visualClips.push({
          clipId: clip.id,
          text: clip.text,
          ...(clip.subtitle && { subtitle: true }),
          ...(clip.subtitleCueId && { subtitleCueId: clip.subtitleCueId }),
          timelineStartFrame: start,
          sourceStartFrame: 0,
          frameCount: end - start,
          ...clip.visual,
          ...(clip.keyframes && {
            animation: {
              start: clip.animationStart ?? clip.timelineStart,
              keyframes: clip.keyframes,
            },
          }),
        });
      continue;
    }
    const needsRationalSampling =
      clip.speed !== undefined ||
      [clip.timelineStart, clip.sourceIn, clip.sourceOut].some((time) => {
        const { ticks, tickSize } = framePosition(time, frameRate);
        return ticks % tickSize !== 0n;
      });
    const retiming: RenderTimeMapping | undefined = needsRationalSampling
      ? {
          timelineStart: clip.timelineStart,
          timelineEnd: clip.timelineEnd,
          sourceIn: clip.sourceIn,
          sourceOut: clip.sourceOut,
          speed: clipSpeed(clip),
        }
      : undefined;
    const start = retiming
      ? sampledFrame(clip.timelineStart)
      : exactFrame(
          clip.timelineStart,
          frameRate,
          `Clip '${clip.id}' timeline start`,
        );
    const sourceStart = retiming
      ? 0
      : exactFrame(clip.sourceIn, frameRate, `Clip '${clip.id}' source in`);
    const count = retiming
      ? sampledFrame(clip.timelineEnd) - start
      : exactFrame(clip.sourceOut, frameRate, `Clip '${clip.id}' source out`) -
        sourceStart;
    const freezeFrame = freezes.get(clip.assetId);
    if (!freezeFrame) {
      const speed = clipSpeed(clip);
      if (
        !previousMedia ||
        !continuesMediaRun(previousMedia, clip) ||
        previousMedia.detachedAudio !== clip.detachedAudio
      )
        tempoRunId =
          speed.numerator === speed.denominator && !clip.effects?.length
            ? undefined
            : clip.id;
      previousMedia = clip;
      audioClips.push({
        clipId: clip.id,
        assetId: clip.assetId,
        timelineStartFrame: start,
        sourceStartFrame: sourceStart,
        frameCount: count,
        ...(retiming || clip.effects?.length
          ? {
              retiming: retiming ?? {
                timelineStart: clip.timelineStart,
                timelineEnd: clip.timelineEnd,
                sourceIn: clip.sourceIn,
                sourceOut: clip.sourceOut,
                speed,
              },
            }
          : {}),
        ...(tempoRunId && { tempoRunId }),
        volume: clip.volume * (clip.trackVolume ?? 1),
        muted: clip.muted || (clip.trackMuted ?? false),
        ...(clip.fadeIn && { fadeIn: resolveAudioFade('fadeIn', clip.fadeIn) }),
        ...(clip.gainKeys && { gainKeys: clip.gainKeys }),
        ...(clip.effects && { effects: clip.effects }),
        ...(clip.fadeOut && {
          fadeOut: resolveAudioFade('fadeOut', clip.fadeOut),
        }),
        required: clip.trackType === 'audio',
        ...(clip.detachedAudio && { padAudio: true }),
      });
    }
    if (clip.trackType === 'video' && count > 0) {
      const visual = clip.visual;
      const maxScale = maximumVisualScale(visual, clip.keyframes);
      if (width * maxScale > 8192 || height * maxScale > 8192)
        throw new RenderError(
          `Clip '${clip.id}' scaled canvas exceeds 8192 pixels per side. Reduce scale.`,
        );
      visualClips.push({
        clipId: clip.id,
        assetId: clip.assetId,
        ...(freezeFrame && { freezeFrame }),
        timelineStartFrame: start,
        sourceStartFrame: sourceStart,
        frameCount: count,
        ...(retiming && {
          retiming: {
            ...retiming,
            sourceOriginNs: sourceOriginNanoseconds(clip),
            localSourceOriginNs: sourceOriginNanoseconds(
              clip,
              frameTime(start, frameRate),
            ),
          },
        }),
        ...visual,
        ...(clip.grade && { grade: clip.grade }),
        ...(clip.keyframes && {
          animation: { start: clip.timelineStart, keyframes: clip.keyframes },
        }),
      });
    }
  }
  const visualById = new Map(visualClips.map((clip) => [clip.clipId, clip]));
  const visualTransitions = timeline.transitions.map((transition) => ({
    afterClipId: transition.ownerId,
    layers: transition.layers.map(({ clip, direction }) => {
      const { start, end, startFrame, endFrame } = transition;
      const sourceIn = clipSourceTime(clip, start);
      const sourceOut = clipSourceTime(clip, end);
      const visual = visualById.get(clip.id);
      if (!visual?.assetId)
        throw new RenderError(
          `Transition clip '${clip.id}' requires a video render layer.`,
        );
      return {
        ...visual,
        timelineStartFrame: startFrame,
        sourceStartFrame: 0,
        frameCount: endFrame - startFrame,
        ramp: { startFrame, endFrame, direction },
        retiming: {
          timelineStart: start,
          timelineEnd: end,
          sourceIn,
          sourceOut,
          speed: clipSpeed(clip),
          sourceOriginNs: sourceOriginNanoseconds(clip),
          localSourceOriginNs: sourceOriginNanoseconds(
            clip,
            frameTime(startFrame, frameRate),
          ),
        },
      };
    }),
  }));
  return {
    width,
    height,
    frameRate,
    frameCount: totalFrames,
    backgroundColor: project.settings.backgroundColor ?? '#000000',
    visualClips,
    audioClips,
    ...(visualTransitions.length && { visualTransitions }),
  };
}

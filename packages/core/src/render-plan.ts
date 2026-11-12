import { maximumVisualScale } from '@opencut/shared';
import type { RenderTimeMapping, VisualAnimation } from '@opencut/shared';
import { clipSourcePosition, clipSpeed } from './clip-timing.js';
import type { Project, TimelineClip } from './project.js';
import { continuesMediaRun, resolveTimeline } from './evaluation.js';
import type { ResolvedMediaClip } from './evaluation.js';
import { resolveAudioFade } from './audio.js';
import { compareTimes } from './time.js';
import type { FrameRate, RationalTime } from './time.js';

export class RenderError extends Error {
  override name = 'RenderError';
}

interface VisualRenderProperties {
  clipId: string;
  timelineStartFrame: number;
  sourceStartFrame: number;
  retiming?: RenderTimeMapping & { sourceOriginNs: number };
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
    | { assetId: string; text?: never; subtitle?: never }
    | {
        text: NonNullable<TimelineClip['text']>;
        assetId?: never;
        subtitle?: true;
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
  /** Audio tracks require an audio stream; video clips may provide silence. */
  required: boolean;
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

/** The affine source origin stays identical for every piece of a split. */
function sourceOriginNanoseconds(clip: TimelineClip): number {
  const origin = clipSourcePosition(clip, { numerator: 0, denominator: 1 });
  return Number((origin.numerator * 1_000_000_000n) / origin.denominator);
}

/** Pure compilation from saved-model semantics to ordered, integer-frame segments. */
export function planProjectRender(
  project: Project,
  { burnSubtitles = true }: { burnSubtitles?: boolean | undefined } = {},
): ProjectRenderPlan {
  const timeline = resolveTimeline(project);
  if (
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
  let previousMedia: ResolvedMediaClip | undefined;
  let tempoRunId: string | undefined;
  for (const clip of timeline.clips) {
    if (clip.kind === 'text' && clip.subtitle) {
      if (!burnSubtitles) continue;
      const start = sampledFrame(clip.timelineStart);
      const end = sampledFrame(clip.timelineEnd);
      if (end > start)
        visualClips.push({
          clipId: clip.id,
          text: clip.text,
          subtitle: true,
          timelineStartFrame: start,
          sourceStartFrame: 0,
          frameCount: end - start,
          ...clip.visual,
        });
      continue;
    }
    const needsRationalSampling =
      clip.kind !== 'text' &&
      (clip.speed !== undefined ||
        [clip.timelineStart, clip.sourceIn, clip.sourceOut].some((time) => {
          const { ticks, tickSize } = framePosition(time, frameRate);
          return ticks % tickSize !== 0n;
        }));
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
    if (clip.kind !== 'text') {
      const speed = clipSpeed(clip);
      if (!previousMedia || !continuesMediaRun(previousMedia, clip))
        tempoRunId =
          speed.numerator === speed.denominator ? undefined : clip.id;
      previousMedia = clip;
      audioClips.push({
        clipId: clip.id,
        assetId: clip.assetId,
        timelineStartFrame: start,
        sourceStartFrame: sourceStart,
        frameCount: count,
        ...(retiming && { retiming }),
        ...(tempoRunId && { tempoRunId }),
        volume: clip.volume * (clip.trackVolume ?? 1),
        muted: clip.muted || (clip.trackMuted ?? false),
        ...(clip.fadeIn && { fadeIn: resolveAudioFade('fadeIn', clip.fadeIn) }),
        ...(clip.fadeOut && {
          fadeOut: resolveAudioFade('fadeOut', clip.fadeOut),
        }),
        required: clip.trackType === 'audio',
      });
    }
    if (clip.trackType === 'video' && count > 0) {
      const visual = clip.visual;
      const maxScale = maximumVisualScale(visual, clip.keyframes);
      if (
        clip.kind !== 'text' &&
        (width * maxScale > 8192 || height * maxScale > 8192)
      )
        throw new RenderError(
          `Clip '${clip.id}' scaled canvas exceeds 8192 pixels per side. Reduce scale.`,
        );
      visualClips.push({
        clipId: clip.id,
        ...(clip.kind === 'text'
          ? { text: clip.text }
          : { assetId: clip.assetId }),
        timelineStartFrame: start,
        sourceStartFrame: sourceStart,
        frameCount: count,
        ...(retiming && {
          retiming: {
            ...retiming,
            sourceOriginNs: sourceOriginNanoseconds(clip),
          },
        }),
        ...visual,
        ...(clip.keyframes && {
          animation: { start: clip.timelineStart, keyframes: clip.keyframes },
        }),
      });
    }
  }
  return {
    width,
    height,
    frameRate,
    frameCount: totalFrames,
    backgroundColor: project.settings.backgroundColor ?? '#000000',
    visualClips,
    audioClips,
  };
}

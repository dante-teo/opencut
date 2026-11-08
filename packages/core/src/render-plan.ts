import type { Project, TimelineClip } from './project.js';
import { resolveTimeline } from './evaluation.js';
import type { FrameRate, RationalTime } from './time.js';

export class RenderError extends Error {
  override name = 'RenderError';
}

interface VisualRenderProperties {
  clipId: string;
  timelineStartFrame: number;
  sourceStartFrame: number;
  frameCount: number;
  x: number;
  y: number;
  scale: number;
  opacity: number;
  fit: 'contain' | 'cover' | 'stretch';
}

export type VisualRenderClip = VisualRenderProperties &
  (
    | { assetId: string; text?: never }
    | { text: NonNullable<TimelineClip['text']>; assetId?: never }
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
  volume: number;
  muted: boolean;
  /** Audio tracks require an audio stream; video clips may provide silence. */
  required: boolean;
}

/** Never round each clip independently: every boundary must lie on the project grid. */
function exactFrame(
  time: RationalTime,
  rate: FrameRate,
  label: string,
): number {
  const numerator = BigInt(time.numerator) * BigInt(rate.numerator);
  const denominator = BigInt(time.denominator) * BigInt(rate.denominator);
  if (numerator % denominator !== 0n)
    throw new RenderError(
      `${label} is between project frames. Align timeline and source points to project-frame boundaries before rendering.`,
    );
  const frame = numerator / denominator;
  if (frame > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RenderError(`${label} exceeds the supported frame range.`);
  return Number(frame);
}

/** Pure compilation from saved-model semantics to ordered, integer-frame segments. */
export function planProjectRender(project: Project): ProjectRenderPlan {
  const timeline = resolveTimeline(project);
  if (!timeline.clips.some((clip) => clip.trackType === 'video'))
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
  let totalFrames = 0;
  for (const clip of timeline.clips) {
    const start = exactFrame(
      clip.timelineStart,
      frameRate,
      `Clip '${clip.id}' timeline start`,
    );
    const sourceStart = exactFrame(
      clip.sourceIn,
      frameRate,
      `Clip '${clip.id}' source in`,
    );
    const sourceEnd = exactFrame(
      clip.sourceOut,
      frameRate,
      `Clip '${clip.id}' source out`,
    );
    const count = sourceEnd - sourceStart;
    const end = start + count;
    if (
      !Number.isSafeInteger(end) ||
      BigInt(end) * BigInt(denominator) > 600n * BigInt(numerator)
    )
      throw new RenderError(
        'Rendering supports at most 600 seconds. Shorten the timeline.',
      );
    totalFrames = Math.max(totalFrames, end);
    if (clip.kind !== 'text')
      audioClips.push({
        clipId: clip.id,
        assetId: clip.assetId,
        timelineStartFrame: start,
        sourceStartFrame: sourceStart,
        frameCount: count,
        volume: clip.volume,
        muted: clip.muted,
        required: clip.trackType === 'audio',
      });
    if (clip.trackType === 'video') {
      const visual = clip.visual;
      if (
        clip.kind !== 'text' &&
        (width * visual.scale > 8192 || height * visual.scale > 8192)
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
        ...visual,
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

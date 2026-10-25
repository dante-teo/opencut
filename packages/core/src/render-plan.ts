import type { Project } from './project.js';
import { listTimeline } from './timeline.js';
import type { FrameRate, RationalTime } from './time.js';

export class RenderError extends Error {
  override name = 'RenderError';
}

export type RenderSegment =
  | { kind: 'gap'; frameCount: number }
  | {
      kind: 'clip';
      clipId: string;
      assetId: string;
      sourceStartFrame: number;
      frameCount: number;
    };

export interface ProjectRenderPlan {
  width: number;
  height: number;
  frameRate: FrameRate;
  frameCount: number;
  segments: RenderSegment[];
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
  const timeline = listTimeline(project);
  if (project.tracks.length !== 1 || project.tracks[0]?.type !== 'video')
    throw new RenderError(
      'T10 rendering requires exactly one video track and no audio or additional tracks. Remove unsupported tracks before rendering.',
    );
  if (project.clips.length === 0)
    throw new RenderError(
      'The video track is empty. Add a video clip before rendering.',
    );
  if (project.clips.length > 64)
    throw new RenderError(
      'T10 rendering supports at most 64 clips. Render a smaller project.',
    );
  const { width, height } = project.settings;
  if (
    width < 2 ||
    height < 2 ||
    width > 3840 ||
    height > 2160 ||
    width % 2 ||
    height % 2
  )
    throw new RenderError(
      'H.264 rendering requires even dimensions: width 2–3840 and height 2–2160. Update project settings.',
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
  const segments: RenderSegment[] = [];
  let frameCount = 0;
  for (const clip of timeline.tracks[0]!.clips) {
    const start = exactFrame(
      clip.timelineStart,
      frameRate,
      `Clip '${clip.id}' timeline start`,
    );
    const sourceStartFrame = exactFrame(
      clip.sourceIn,
      frameRate,
      `Clip '${clip.id}' source in`,
    );
    const sourceEndFrame = exactFrame(
      clip.sourceOut,
      frameRate,
      `Clip '${clip.id}' source out`,
    );
    const count = sourceEndFrame - sourceStartFrame;
    if (start > frameCount)
      segments.push({ kind: 'gap', frameCount: start - frameCount });
    segments.push({
      kind: 'clip',
      clipId: clip.id,
      assetId: clip.assetId,
      sourceStartFrame,
      frameCount: count,
    });
    frameCount = start + count;
    if (
      !Number.isSafeInteger(frameCount) ||
      BigInt(frameCount) * BigInt(denominator) > 600n * BigInt(numerator)
    )
      throw new RenderError(
        'T10 rendering supports at most 600 seconds. Shorten the timeline.',
      );
  }
  return { width, height, frameRate, frameCount, segments };
}

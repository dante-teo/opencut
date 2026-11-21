import type { VideoTimelineOptions, VisualTimelineClip } from './render.js';

export const maxPictureInputs = 32;

type Transitions = NonNullable<VideoTimelineOptions['visualTransitions']>;
interface Range {
  startFrame: number;
  endFrame: number;
}

export function selectPictureInputs(
  clips: readonly VisualTimelineClip[],
  transitions: Transitions,
  { startFrame, endFrame }: Range,
): { visualClips: VisualTimelineClip[]; visualTransitions: Transitions } {
  const overlaps = (start: number, end: number) =>
    start < endFrame && startFrame < end;
  const visualTransitions = transitions.filter(({ layers }) =>
    overlaps(layers[0]!.ramp.startFrame, layers[0]!.ramp.endFrame),
  );
  const members = new Set(
    visualTransitions.flatMap(({ layers }) =>
      layers.map(({ clipId }) => clipId),
    ),
  );
  const visualClips = clips.filter(
    ({ clipId, timelineStartFrame, frameCount }) =>
      members.has(clipId) ||
      overlaps(timelineStartFrame, timelineStartFrame + frameCount),
  );
  return { visualClips, visualTransitions };
}

export function boundPictureInputs(
  clips: readonly VisualTimelineClip[],
  transitions: Transitions,
  { startFrame, endFrame }: Range,
) {
  const starts = new Map<number, string[]>();
  const ends = new Map<number, string[]>();
  function include(key: string, from: number, to: number) {
    const start = Math.max(startFrame, from);
    const end = Math.min(endFrame, to);
    if (start >= end) return;
    const opening = starts.get(start) ?? [];
    const closing = ends.get(end) ?? [];
    opening.push(key);
    closing.push(key);
    starts.set(start, opening);
    ends.set(end, closing);
  }
  for (const clip of clips)
    include(
      'clip:' + clip.clipId,
      clip.timelineStartFrame,
      clip.timelineStartFrame + clip.frameCount,
    );
  for (const [index, transition] of transitions.entries())
    for (const { clipId, ramp } of transition.layers)
      include(`transition:${index}:${clipId}`, ramp.startFrame, ramp.endFrame);
  if (
    [...starts.values()].reduce((total, ids) => total + ids.length, 0) <=
    maxPictureInputs
  )
    return [];
  const edges = [
    ...new Set([startFrame, endFrame, ...starts.keys(), ...ends.keys()]),
  ].sort((a, b) => a - b);
  const active = new Set<string>();
  let window = new Set<string>();
  let boundary = startFrame;
  const ranges = [];
  for (const frame of edges.slice(0, -1)) {
    for (const key of ends.get(frame) ?? []) active.delete(key);
    for (const key of starts.get(frame) ?? []) active.add(key);
    const combined = new Set([...window, ...active]);
    // An overlapping stack is split spatially by the compositor. Do not
    // keep adding unrelated inputs to its time window.
    if (frame > boundary && combined.size > maxPictureInputs) {
      ranges.push({ startFrame: boundary, endFrame: frame });
      boundary = frame;
      window = new Set(active);
    } else window = combined;
  }
  ranges.push({ startFrame: boundary, endFrame });
  return ranges;
}

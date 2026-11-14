import {
  addTimes,
  subtractTimes,
  clipDuration,
  clipTimelineEnd,
  clipSourceTime,
  compareTimes,
  frameTime,
  linkedSelection,
  previewTransaction,
  projectRevision,
  projectSnapshot,
  type FrameRate,
  type Project,
  type EditOperation,
  type RationalTime,
  type TimelineClip,
  type AudioFadeEdge,
} from '@opencut/core';
import {
  cueTimelineClip,
  frameIndex,
  relativePixels,
  ZERO,
} from './timeline-geometry.js';

export type GestureKind = 'move' | 'left' | 'right' | AudioFadeEdge;
export interface EditProposal {
  operations: EditOperation[];
  clip: TimelineClip;
  clips?: TimelineClip[];
  error: string | null;
  snap: RationalTime | null;
}

function safeFrame(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || value < 0n)
    throw new Error('Edit is outside the supported frame range.');
  return number;
}

/** Cache this validated content snapshot for previews; main validates history at commit. */
export function createTimelinePreview(project: Project) {
  const content = { ...project };
  delete content.editing;
  return projectSnapshot(content);
}

function previewClipEdit(
  project: Project,
  clip: TimelineClip,
  operations: EditOperation[],
  snap: RationalTime | null,
): EditProposal {
  const preview = previewTransaction(project, {
    expectedRevision: projectRevision(project),
    operations,
  }).project;
  const group = operations.find((operation) => operation.type === 'clips.move');
  return {
    operations,
    ...(group ? { clips: linkedSelection(preview, group.ids) } : {}),
    clip: preview.clips.find((entry) => entry.id === clip.id)!,
    error: null,
    snap,
  };
}

export function snapTargets(
  project: Project,
  playhead: RationalTime,
  excluded: Set<string> = new Set(),
) {
  return [
    playhead,
    ...(project.markers ?? []).map((marker) =>
      frameTime(marker.frame, project.settings.frameRate),
    ),
    ZERO,
    ...project.clips
      .filter((clip) => !excluded.has(clip.id))
      .flatMap((clip) => [clip.timelineStart, clipTimelineEnd(clip)]),
  ];
}

/** Snap a frame position or signed shift by comparing each eligible moving edge. */
export function snapFrames(
  desired: bigint,
  edges: readonly bigint[],
  candidates: RationalTime[],
  rate: FrameRate,
  zoom: number,
  threshold: number,
  minimum = 0n,
) {
  let value = desired;
  let snap: RationalTime | null = null;
  let distance = threshold;
  if (threshold <= 0 || desired < minimum) return { value, snap };
  for (const time of candidates) {
    const frame = exactFrame(time, rate);
    if (frame === null) continue;
    for (const edge of edges) {
      const candidate = frame - edge;
      if (candidate < minimum) continue;
      const pixels =
        (Math.abs(Number(candidate - desired)) * zoom * rate.denominator) /
        rate.numerator;
      if (pixels <= distance && (!snap || pixels < distance)) {
        value = candidate;
        snap = time;
        distance = pixels;
      }
    }
  }
  return { value, snap };
}

function exactFrame(time: RationalTime, rate: FrameRate) {
  const ticks = BigInt(time.numerator) * BigInt(rate.numerator);
  const step = BigInt(time.denominator) * BigInt(rate.denominator);
  return ticks % step === 0n ? ticks / step : null;
}

function proposeGroupMove(
  project: Project,
  clip: TimelineClip,
  ids: string[],
  delta: bigint,
  trackId: string,
  playhead: RationalTime,
  zoom: number,
  pixels: number,
): EditProposal {
  const rate = project.settings.frameRate;
  const group = linkedSelection(project, ids);
  const earliest = group.reduce(
    (start, member) =>
      compareTimes(start, member.timelineStart) <= 0
        ? start
        : member.timelineStart,
    clip.timelineStart,
  );
  const minimum = -frameIndex(earliest, rate);
  const edges = group
    .flatMap((member) => [member.timelineStart, clipTimelineEnd(member)])
    .map((time) => exactFrame(time, rate))
    .filter((frame) => frame !== null);
  const { value: shift, snap } = snapFrames(
    delta < minimum ? minimum : delta,
    edges,
    pixels > 0
      ? snapTargets(
          project,
          playhead,
          new Set(group.map((member) => member.id)),
        )
      : [],
    rate,
    zoom,
    pixels,
    minimum,
  );
  const row = (id: string) =>
    project.tracks.findIndex((track) => track.id === id);
  if (row(trackId) < 0) throw new Error('Drop onto a timeline track.');
  const offset = row(trackId) - row(clip.trackId);
  const tracks = Object.fromEntries(
    group.map((member) => {
      const track = project.tracks[row(member.trackId) + offset];
      if (!track)
        throw new Error('The selection does not fit on those tracks.');
      return [member.trackId, track.id];
    }),
  );
  return previewClipEdit(
    project,
    clip,
    [
      {
        type: 'clips.move',
        ids,
        tracks,
        frames: safeFrame(shift < 0n ? -shift : shift),
        backwards: shift < 0n,
      },
    ],
    snap,
  );
}

/** UI coordinate policy only. The core validates and produces every proposed clip. */
export function proposeEdit(
  project: Project,
  clip: TimelineClip,
  kind: GestureKind,
  delta: bigint,
  trackId: string,
  playhead: RationalTime,
  zoom: number,
  snapPixels: number,
  ids: string[] = [clip.id],
): EditProposal {
  let operations: EditOperation[] = [];
  let snap: RationalTime | null = null;
  try {
    const rate = project.settings.frameRate;
    if (kind === 'move' && (ids.length > 1 || clip.linkId))
      return proposeGroupMove(
        project,
        clip,
        ids,
        delta,
        trackId,
        playhead,
        zoom,
        snapPixels,
      );
    if (kind === 'fadeIn' || kind === 'fadeOut') {
      const unchanged = { operations, clip, error: null, snap };
      if (delta === 0n) return unchanged;
      const previous = clip[kind]?.duration ?? ZERO;
      const other =
        clip[kind === 'fadeIn' ? 'fadeOut' : 'fadeIn']?.duration ?? ZERO;
      const current = frameIndex(previous, rate, true);
      const maximum = frameIndex(
        subtractTimes(clipDuration(clip), other),
        rate,
      );
      const target = current + (kind === 'fadeIn' ? delta : -delta);
      const duration = safeFrame(
        target < 0n ? 0n : target > maximum ? maximum : target,
      );
      if (compareTimes(frameTime(duration, rate), previous) === 0)
        return unchanged;
      const operation: EditOperation = {
        type: 'clip.audio',
        id: clip.id,
        [kind]: duration,
      };
      return previewClipEdit(project, clip, [operation], null);
    }
    const start = frameIndex(clip.timelineStart, rate, true);
    const sourceIn = frameIndex(clip.sourceIn, rate, true);
    const sourceOut = frameIndex(clip.sourceOut, rate, true);
    const boundary =
      kind === 'right' ? frameIndex(clipTimelineEnd(clip), rate, true) : start;
    let target = boundary + delta;
    // Move clamps at sequence zero; trims report invalid source bounds via the core.
    if (kind === 'move' && target < 0n) target = 0n;
    if (
      kind !== 'move' &&
      !clip.speed &&
      (compareTimes(frameTime(safeFrame(start), rate), clip.timelineStart) !==
        0 ||
        compareTimes(frameTime(safeFrame(sourceIn), rate), clip.sourceIn) !== 0)
    )
      throw new Error(
        'Align clip start and source-in to project frames before edge trimming.',
      );
    const duration = clipDuration(clip);
    const durationFrame = frameIndex(duration, rate, true);
    const tail = kind === 'move' ? exactFrame(duration, rate) : null;
    const snapped = snapFrames(
      target,
      tail === null ? [0n] : [0n, tail],
      snapPixels > 0 ? snapTargets(project, playhead, new Set([clip.id])) : [],
      rate,
      zoom,
      snapPixels,
    );
    target = snapped.value;
    snap = snapped.snap;
    const change = target - boundary;
    if (kind === 'move') {
      operations = [
        { type: 'clip.move', id: clip.id, trackId, at: safeFrame(target) },
      ];
    } else if (kind === 'left' && clip.text) {
      if (
        compareTimes(frameTime(safeFrame(durationFrame), rate), duration) !== 0
      )
        throw new Error(
          'Align the text clip end to a project frame before trimming its left edge.',
        );
      operations = [
        {
          type: 'text.set',
          id: clip.id,
          at: safeFrame(target),
          duration: safeFrame(durationFrame - change),
        },
      ];
    } else {
      const trim: EditOperation = { type: 'clip.trim', id: clip.id };
      if (clip.speed) {
        if (change === 0n) return { operations, clip, error: null, snap };
        const at = frameTime(safeFrame(target), rate);
        trim[kind === 'left' ? 'inTime' : 'outTime'] = clipSourceTime(clip, at);
      } else {
        const boundary = kind === 'left' ? sourceIn : sourceOut;
        trim[kind === 'left' ? 'in' : 'out'] = safeFrame(boundary + change);
      }
      if (kind === 'right') {
        operations = [trim];
      } else {
        const move: EditOperation = {
          type: 'clip.move',
          id: clip.id,
          at: safeFrame(target),
        };
        // Shrink before moving inward; move before extending outward. Each primitive
        // remains valid against neighbours, and the batch is a single undo step.
        operations = change >= 0n ? [trim, move] : [move, trim];
      }
    }
    return previewClipEdit(project, clip, operations, snap);
  } catch (error) {
    return {
      operations,
      clip,
      error: error instanceof Error ? error.message : String(error),
      snap,
    };
  }
}

/** Pointer movement is measured in timeline seconds, independent of project fps. */
export function proposeSubtitleEdit(
  clip: TimelineClip,
  kind: GestureKind,
  delta: RationalTime,
  backwards: boolean,
  playhead: RationalTime,
  zoom: number,
  snapPixels: number,
): EditProposal {
  let snap: RationalTime | null = null;
  try {
    if (kind === 'fadeIn' || kind === 'fadeOut')
      throw new Error('Subtitles have no audio.');
    const end = clipTimelineEnd(clip);
    const edge = kind === 'right' ? end : clip.timelineStart;
    let target = backwards
      ? compareTimes(delta, edge) > 0
        ? ZERO
        : subtractTimes(edge, delta)
      : addTimes(edge, delta);
    if (
      snapPixels &&
      Math.abs(relativePixels(target, playhead, zoom)) <= snapPixels
    ) {
      target = playhead;
      snap = playhead;
    }
    const start = kind === 'right' ? clip.timelineStart : target;
    const stop =
      kind === 'move'
        ? addTimes(start, clipDuration(clip))
        : kind === 'right'
          ? target
          : end;
    if (compareTimes(stop, start) <= 0)
      throw new Error('Subtitle end must be later than start.');
    const operation: EditOperation =
      kind === 'move'
        ? { type: 'subtitle.move', id: clip.id, start }
        : { type: 'subtitle.set', id: clip.id, start, end: stop };
    return {
      clip: cueTimelineClip(
        { id: clip.id, text: clip.text!.content, start, end: stop },
        clip.trackId,
      ),
      operations: [operation],
      error: null,
      snap,
    };
  } catch (error) {
    return {
      operations: [],
      clip,
      error: error instanceof Error ? error.message : String(error),
      snap,
    };
  }
}

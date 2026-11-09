import {
  addTimes,
  subtractTimes,
  clipDuration,
  clipTimelineEnd,
  compareTimes,
  frameTime,
  previewTransaction,
  projectRevision,
  projectSnapshot,
  type Project,
  type RationalTime,
  type TimelineClip,
  type AudioFadeEdge,
} from '@opencut/core';
import type { TimelineOperation } from '../bridge.js';
import {
  cueTimelineClip,
  frameIndex,
  relativePixels,
  ZERO,
} from './timeline-geometry.js';

export type GestureKind = 'move' | 'left' | 'right' | AudioFadeEdge;
export interface EditProposal {
  operations: TimelineOperation[];
  clip: TimelineClip;
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
  operations: TimelineOperation[],
  snap: RationalTime | null,
): EditProposal {
  const preview = previewTransaction(project, {
    expectedRevision: projectRevision(project),
    operations,
  }).project;
  return {
    operations,
    clip: preview.clips.find((entry) => entry.id === clip.id)!,
    error: null,
    snap,
  };
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
): EditProposal {
  let operations: TimelineOperation[] = [];
  let snap: RationalTime | null = null;
  try {
    const rate = project.settings.frameRate;
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
      const operation: TimelineOperation = {
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
      (compareTimes(frameTime(safeFrame(start), rate), clip.timelineStart) !==
        0 ||
        compareTimes(frameTime(safeFrame(sourceIn), rate), clip.sourceIn) !== 0)
    )
      throw new Error(
        'Align clip start and source-in to project frames before edge trimming.',
      );
    const candidates = [
      ZERO,
      playhead,
      ...project.clips
        .filter((other) => other.id !== clip.id)
        .flatMap((other) => [other.timelineStart, clipTimelineEnd(other)]),
    ];
    const unsnappedTarget = target;
    let bestDistance = Math.max(0, snapPixels);
    const duration = clipDuration(clip);
    const durationFrame = frameIndex(duration, rate, true);
    for (const candidate of candidates) {
      const candidateFrame = frameIndex(candidate, rate, true);
      let candidateTime;
      try {
        candidateTime = frameTime(safeFrame(candidateFrame), rate);
      } catch {
        continue;
      }
      if (compareTimes(candidateTime, candidate) !== 0) continue;
      const anchors = [candidateFrame];
      if (
        kind === 'move' &&
        compareTimes(frameTime(safeFrame(durationFrame), rate), duration) === 0
      )
        anchors.push(candidateFrame - durationFrame);
      for (const anchor of anchors) {
        if (anchor < 0n || target < 0n) continue;
        const snapped = frameTime(safeFrame(anchor), rate);
        const distance = Math.abs(
          relativePixels(
            snapped,
            frameTime(safeFrame(unsnappedTarget), rate),
            zoom,
          ),
        );
        if (snapPixels > 0 && distance <= bestDistance) {
          bestDistance = distance;
          target = anchor;
          snap = candidate;
        }
      }
    }
    const change = target - boundary;
    if (kind === 'move') {
      operations = [
        { type: 'clip.move', id: clip.id, trackId, at: safeFrame(target) },
      ];
    } else if (kind === 'right') {
      operations = [
        { type: 'clip.trim', id: clip.id, out: safeFrame(sourceOut + change) },
      ];
    } else if (clip.text) {
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
      const trim: TimelineOperation = {
        type: 'clip.trim',
        id: clip.id,
        in: safeFrame(sourceIn + change),
      };
      const move: TimelineOperation = {
        type: 'clip.move',
        id: clip.id,
        at: safeFrame(target),
      };
      // Shrink before moving inward; move before extending outward. Each primitive
      // remains valid against neighbours, and the batch is a single undo step.
      operations = change >= 0n ? [trim, move] : [move, trim];
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
    const operation: TimelineOperation =
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

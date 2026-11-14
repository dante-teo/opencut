import { clipTimelineEnd } from './clip-timing.js';
import type { Project, TimelineClip } from './project.js';
import {
  addTimes,
  compareTimes,
  subtractTimes,
  type RationalTime,
} from './time.js';
import { TimelineError } from './timeline-error.js';

export const ZERO = { numerator: 0, denominator: 1 };
export type RippleScope = 'selected-tracks' | 'all-unlocked';

export function invalid(message: string): never {
  throw new TimelineError('INVALID_EDIT', message);
}

export function linkedSelection(project: Project, ids: readonly string[]) {
  const selected = new Set(ids);
  const links = new Set(
    project.clips
      .filter((clip) => selected.has(clip.id))
      .map((clip) => clip.linkId)
      .filter(Boolean),
  );
  return project.clips.filter(
    (clip) => selected.has(clip.id) || (clip.linkId && links.has(clip.linkId)),
  );
}

export function requireSelection(project: Project, ids: string[]) {
  if (!ids.length || new Set(ids).size !== ids.length)
    invalid('Select one or more unique clip IDs.');
  const clips = linkedSelection(project, ids);
  const found = new Set(clips.map((clip) => clip.id));
  for (const id of ids)
    if (!found.has(id))
      throw new TimelineError(
        'CLIP_NOT_FOUND',
        "Clip '" +
          id +
          "' does not exist. Use timeline list to find its stable ID.",
      );
  return clips;
}

export function editableTracks(project: Project, trackIds: Iterable<string>) {
  const tracks = new Set(trackIds);
  for (const id of tracks) {
    const track = project.tracks.find((entry) => entry.id === id);
    if (!track) invalid("Track '" + id + "' does not exist.");
    if (track.locked) invalid("Track '" + track.name + "' is locked.");
  }
  return tracks;
}

export function scopeTracks(
  project: Project,
  trackIds: Iterable<string>,
  scope?: RippleScope,
) {
  const tracks = editableTracks(project, trackIds);
  if (scope === 'all-unlocked')
    for (const track of project.tracks) if (!track.locked) tracks.add(track.id);
  return tracks;
}

/** Check every affected link, including links to tracks outside the edit scope. */
export function checkLinkedShifts(
  project: Project,
  shifted: Map<string, RationalTime>,
) {
  const shifts = new Map<string, RationalTime>();
  for (const clip of project.clips) {
    if (!clip.linkId) continue;
    const shift = shifted.get(clip.id) ?? ZERO;
    const previous = shifts.get(clip.linkId);
    if (previous && compareTimes(previous, shift) !== 0)
      invalid(
        'This edit would desynchronize linked clips. Include their tracks in the edit scope.',
      );
    shifts.set(clip.linkId, shift);
  }
}

type Interval = { start: RationalTime; end: RationalTime };
export function clipIntervals(clips: TimelineClip[]) {
  const ordered = clips
    .map((clip) => ({ start: clip.timelineStart, end: clipTimelineEnd(clip) }))
    .sort((a, b) => compareTimes(a.start, b.start));
  const merged: Interval[] = [];
  for (const interval of ordered) {
    const last = merged.at(-1);
    if (!last || compareTimes(interval.start, last.end) > 0)
      merged.push(interval);
    else if (compareTimes(interval.end, last.end) > 0) last.end = interval.end;
  }
  return merged;
}

export function closeIntervals(
  project: Project,
  tracks: Set<string>,
  ranges: Interval[],
) {
  const shifted = new Map<string, RationalTime>();
  for (const clip of project.clips) {
    if (!tracks.has(clip.trackId)) continue;
    let shift = ZERO;
    for (const range of ranges) {
      if (compareTimes(clip.timelineStart, range.end) >= 0)
        shift = addTimes(shift, subtractTimes(range.end, range.start));
      else if (compareTimes(clipTimelineEnd(clip), range.start) > 0)
        invalid(
          'An unselected clip spans the ripple range. Select it or narrow the edit scope.',
        );
      else break;
    }
    if (shift.numerator) shifted.set(clip.id, shift);
  }
  shiftLinkedClips(project, shifted, true);
}

export function destinationTracks(
  project: Project,
  clips: TimelineClip[],
  mapping: Record<string, string>,
  operation: 'Group moves' | 'Paste',
) {
  const tracks = new Map(project.tracks.map((track) => [track.id, track]));
  return clips.map((clip) => {
    const targetId = Object.hasOwn(mapping, clip.trackId)
      ? mapping[clip.trackId]!
      : clip.trackId;
    const target = tracks.get(targetId);
    if (!target) invalid("Track '" + targetId + "' does not exist.");
    if (target.locked) invalid("Track '" + target.name + "' is locked.");
    const source = tracks.get(clip.trackId);
    if (source && target.type !== source.type)
      invalid(operation + ' must keep each clip on the same type of track.');
    return targetId;
  });
}

export function shiftLinkedClips(
  project: Project,
  shifts: Map<string, RationalTime>,
  backwards = false,
) {
  checkLinkedShifts(project, shifts);
  for (const clip of project.clips) {
    const shift = shifts.get(clip.id);
    if (shift?.numerator)
      clip.timelineStart = backwards
        ? subtractTimes(clip.timelineStart, shift)
        : addTimes(clip.timelineStart, shift);
  }
}

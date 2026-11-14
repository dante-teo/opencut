import { animatedProperties, evaluateVisual } from '@opencut/shared';
import type { VisualKeyframe } from '@opencut/shared';
import { transitionSchema, transitionUsesClip } from './transitions.js';
import type { Transition, TransitionInput } from './transitions.js';
import { retimeKeyframes, trimKeyframes } from './keyframes.js';
import type { KeyframeEdit } from './keyframes.js';
import type { Project, TimelineClip, Track } from './project.js';
import { clipSchema, markerSchema, validateProject } from './project.js';
import { addTimes, compareTimes, frameTime, subtractTimes } from './time.js';
import { z } from 'zod';
import type { RationalTime } from './time.js';
import {
  clipDuration,
  clipSpeed,
  clipSpeedSchema,
  clipTimelineEnd,
  clipSourceTime,
  timelineToSourceOffset,
} from './clip-timing.js';
import type { ClipSpeed } from './clip-timing.js';
import {
  audioFadeEdges,
  shiftGainKeys,
  sliceAudioFades,
  sliceGainKeys,
} from './audio.js';
import { TimelineError } from './timeline-error.js';
import {
  ZERO,
  invalid,
  linkedSelection,
  requireSelection,
  editableTracks,
  scopeTracks,
  checkLinkedShifts,
  shiftLinkedClips,
  clipIntervals,
  closeIntervals,
  destinationTracks,
  type RippleScope,
} from './timeline-layout.js';

export { linkedSelection } from './timeline-layout.js';
export type { RippleScope } from './timeline-layout.js';
export { TimelineError } from './timeline-error.js';

function copyProject(project: Project): Project {
  const result = validateProject(project);
  if (!result.success) throw result.error;
  return result.project;
}

function finish(project: Project): Project {
  const validated = copyProject(project);
  validated.metadata.updatedAt = new Date(
    Math.max(Date.now(), Date.parse(validated.metadata.updatedAt)),
  ).toISOString();
  return validated;
}

function newId(project: Project, requested?: string): string {
  if (requested !== undefined) return requested;
  const ids = new Set([
    project.metadata.id,
    ...project.assets.map((asset) => asset.id),
    ...project.tracks.map((track) => track.id),
    ...project.clips.map((clip) => clip.id),
    ...(project.subtitles?.cues.map((cue) => cue.id) ?? []),
    ...(project.transitions?.map((transition) => transition.id) ?? []),
    ...(project.markers?.map((marker) => marker.id) ?? []),
  ]);
  let id = globalThis.crypto.randomUUID();
  while (ids.has(id)) id = globalThis.crypto.randomUUID();
  return id;
}

function requireClip(project: Project, id: string): TimelineClip {
  const clip = project.clips.find((clip) => clip.id === id);
  if (!clip)
    throw new TimelineError(
      'CLIP_NOT_FOUND',
      `Clip '${id}' does not exist. Use timeline list to find its stable ID.`,
    );
  return clip;
}

/** Track insertion order, then exact timeline start order. No media access or mutation. */
export function listTimeline(project: Project) {
  const validated = copyProject(project);
  let duration: RationalTime = { numerator: 0, denominator: 1 };
  const tracks = validated.tracks.map((track) => ({
    ...track,
    clips: validated.clips
      .filter((clip) => clip.trackId === track.id)
      .sort((a, b) => compareTimes(a.timelineStart, b.timelineStart))
      .map((clip) => {
        const timelineEnd = clipTimelineEnd(clip);
        if (compareTimes(timelineEnd, duration) > 0) duration = timelineEnd;
        return { ...clip, duration: clipDuration(clip), timelineEnd };
      }),
  }));
  for (const cue of validated.subtitles?.cues ?? []) {
    if (compareTimes(cue.end, duration) > 0) duration = cue.end;
  }
  return {
    frameRate: validated.settings.frameRate,
    duration,
    tracks,
    ...(validated.subtitles ? { subtitles: validated.subtitles } : {}),
    ...(validated.transitions ? { transitions: validated.transitions } : {}),
    ...(validated.markers ? { markers: validated.markers } : {}),
  };
}

export interface AddTrackOptions {
  id?: string;
  name: string;
  type: Track['type'];
}

export function addTrack(project: Project, options: AddTrackOptions) {
  const next = copyProject(project);
  const track: Track = {
    id: newId(next, options.id),
    name: options.name,
    type: options.type,
  };
  next.tracks.push(track);
  return { project: finish(next), track };
}

/** Refuse populated tracks; removing a track never implicitly deletes clips. */
export function removeTrack(project: Project, id: string) {
  const next = copyProject(project);
  if (!next.tracks.some((track) => track.id === id))
    throw new TimelineError(
      'TRACK_NOT_FOUND',
      `Track '${id}' does not exist. Use timeline list to find its stable ID.`,
    );
  const clips = next.clips.filter((clip) => clip.trackId === id);
  if (clips.length)
    throw new TimelineError(
      'TRACK_NOT_EMPTY',
      `Cannot remove track '${id}'; it contains clips: ${clips.map((clip) => clip.id).join(', ')}. Move or remove those clips first.`,
    );
  next.tracks = next.tracks.filter((track) => track.id !== id);
  return { project: finish(next), removedTrackId: id };
}

export interface AddClipOptions
  extends
    Omit<
      TimelineClip,
      'id' | 'assetId' | 'text' | 'speed' | 'linkId' | keyof ClipAudioOptions
    >,
    ClipAudioOptions {
  id?: string;
  assetId: string;
}

/** Explicit 1x source range; unknown asset durations have no inferred bound. */
export function addClip(project: Project, options: AddClipOptions) {
  const next = copyProject(project);
  const clip = appendClip(next, options);
  const updated = finish(next);
  return { project: updated, clip: requireClip(updated, clip.id) };
}

function appendClip(next: Project, options: AddClipOptions) {
  const clip: TimelineClip = {
    id: newId(next, options.id),
    assetId: options.assetId,
    trackId: options.trackId,
    timelineStart: options.timelineStart,
    sourceIn: options.sourceIn,
    sourceOut: options.sourceOut,
    ...(options.visual !== undefined ? { visual: options.visual } : {}),
  };
  applyClipAudioSettings(clip, options);
  next.clips.push(clip);
  return clip;
}

export interface AddTextOptions {
  id?: string | undefined;
  trackId?: string | undefined;
  timelineStart: RationalTime;
  duration: RationalTime;
  text: NonNullable<TimelineClip['text']>;
  visual?: Omit<ClipVisualOptions, 'fit'> | undefined;
}

/** Text uses the same clip interval and track order as media, with no asset. */
export function addText(project: Project, options: AddTextOptions) {
  const next = copyProject(project);
  const clipId = newId(next, options.id);
  let trackId = options.trackId;
  if (trackId === undefined) {
    do trackId = newId(next);
    while (trackId === clipId);
    next.tracks.push({ id: trackId, name: 'Text', type: 'video' });
  }
  next.clips.push({
    id: clipId,
    trackId,
    timelineStart: options.timelineStart,
    sourceIn: { numerator: 0, denominator: 1 },
    sourceOut: options.duration,
    text: options.text,
    ...(options.visual === undefined ? {} : { visual: options.visual }),
  });
  const updated = finish(next);
  return { project: updated, clip: requireClip(updated, clipId) };
}

export function setText(
  project: Project,
  id: string,
  options: {
    text?:
      | {
          [Key in keyof NonNullable<TimelineClip['text']>]?:
            NonNullable<TimelineClip['text']>[Key] | undefined;
        }
      | undefined;
    timelineStart?: RationalTime | undefined;
    duration?: RationalTime | undefined;
  },
) {
  if (
    (options.timelineStart || options.duration) &&
    linkedSelection(project, [id]).length > 1
  )
    invalid(
      'Unlink these clips before changing their timing or source independently.',
    );
  const next = copyProject(project);
  const clip = requireClip(next, id);
  if (!clip.text)
    throw new TimelineError(
      'INVALID_EDIT',
      'Text properties require a text clip.',
    );
  const properties = Object.entries(options.text ?? {}).filter(
    ([, value]) => value !== undefined,
  );
  if (
    !properties.length &&
    options.timelineStart === undefined &&
    options.duration === undefined
  )
    throw new TimelineError(
      'INVALID_EDIT',
      'Specify text properties, a start or a duration.',
    );
  const text = { ...clip.text, ...Object.fromEntries(properties) };
  const start = options.timelineStart ?? clip.timelineStart;
  const end = options.duration
    ? addTimes(clip.sourceIn, options.duration)
    : clip.sourceOut;
  if (
    JSON.stringify(clip.text) === JSON.stringify(text) &&
    compareTimes(start, clip.timelineStart) === 0 &&
    compareTimes(end, clip.sourceOut) === 0
  )
    return { project: next, clip };
  const previous = { ...clip };
  clip.text = text;
  clip.timelineStart = start;
  clip.sourceOut = end;
  if (compareTimes(previous.sourceOut, end) !== 0)
    trimKeyframes(previous, clip);
  const updated = finish(next);
  return { project: updated, clip: requireClip(updated, id) };
}

export interface MoveClipOptions {
  trackId?: string;
  timelineStart?: RationalTime;
}

/** Preserve source mapping. No snapping, ripple or automatic repositioning. */
export function moveClip(
  project: Project,
  id: string,
  options: MoveClipOptions,
) {
  const next = copyProject(project);
  const clip = requireClip(next, id);
  if (options.trackId === undefined && options.timelineStart === undefined)
    throw new TimelineError(
      'INVALID_EDIT',
      'Specify a destination track or timeline start when moving a clip.',
    );
  const unchanged =
    (options.trackId === undefined || options.trackId === clip.trackId) &&
    (options.timelineStart === undefined ||
      compareTimes(options.timelineStart, clip.timelineStart) === 0);
  if (unchanged) return { project: next, clip };
  if (clip.linkId) {
    const at = options.timelineStart ?? clip.timelineStart;
    const backwards = compareTimes(at, clip.timelineStart) < 0;
    const delta = backwards
      ? subtractTimes(clip.timelineStart, at)
      : subtractTimes(at, clip.timelineStart);
    const moved = moveClips(
      next,
      [id],
      delta,
      backwards,
      options.trackId ? { [clip.trackId]: options.trackId } : {},
    );
    return { project: moved.project, clip: requireClip(moved.project, id) };
  }
  if (options.trackId !== undefined) {
    clip.trackId = options.trackId;
    if (
      next.tracks.find((track) => track.id === clip.trackId)?.type === 'video'
    )
      delete clip.detachedAudio;
  }
  if (options.timelineStart !== undefined)
    clip.timelineStart = options.timelineStart;
  const updated = finish(next);
  return { project: updated, clip: requireClip(updated, id) };
}

/** Move clips together, validating only the final arrangement. */
export function moveClips(
  project: Project,
  ids: string[],
  delta: RationalTime,
  backwards: boolean,
  tracks: Record<string, string> = {},
) {
  const next = copyProject(project);
  const clips = requireSelection(next, ids);
  editableTracks(
    next,
    clips.map((clip) => clip.trackId),
  );
  const destinations = destinationTracks(next, clips, tracks, 'Group moves');
  for (const [index, clip] of clips.entries()) {
    clip.trackId = destinations[index]!;
    if (delta.numerator)
      clip.timelineStart = backwards
        ? subtractTimes(clip.timelineStart, delta)
        : addTimes(clip.timelineStart, delta);
  }
  return { project: finish(next), clipIds: clips.map((clip) => clip.id) };
}

/** Remove clips together. Ripple removes the union of the selected time ranges. */
export function removeClips(
  project: Project,
  ids: string[],
  ripple?: RippleScope,
) {
  const next = copyProject(project);
  const clips = requireSelection(next, ids);
  const tracks = scopeTracks(
    next,
    clips.map((clip) => clip.trackId),
    ripple,
  );
  const removedClipIds = clips.map((clip) => clip.id);
  const selected = new Set(removedClipIds);
  next.clips = next.clips.filter((clip) => !selected.has(clip.id));
  if (next.transitions) {
    next.transitions = next.transitions.filter(
      (transition) =>
        !removedClipIds.some((id) => transitionUsesClip(transition, id)),
    );
    if (!next.transitions.length) delete next.transitions;
  }
  if (ripple) closeIntervals(next, tracks, clipIntervals(clips));
  return { project: finish(next), removedClipIds };
}

/** Close the common gap containing the requested time across the named tracks. */
export function closeGap(
  project: Project,
  trackIds: string[],
  at: RationalTime,
) {
  const next = copyProject(project);
  const tracks = editableTracks(next, trackIds);
  let start = ZERO;
  let end: RationalTime | undefined;
  for (const clip of next.clips) {
    if (!tracks.has(clip.trackId)) continue;
    const stop = clipTimelineEnd(clip);
    if (compareTimes(stop, at) <= 0) {
      if (compareTimes(stop, start) > 0) start = stop;
    } else if (compareTimes(clip.timelineStart, at) <= 0) {
      invalid('The playhead must be in a gap on every selected track.');
    } else if (!end || compareTimes(clip.timelineStart, end) < 0) {
      end = clip.timelineStart;
    }
  }
  if (!end) invalid('There are no clips after this gap.');
  closeIntervals(next, tracks, [{ start, end }]);
  return { project: finish(next), start, end };
}

export const clipClipboardSchema = z.strictObject({
  projectId: z.string(),
  clips: z.array(clipSchema).min(1),
  transitions: z.array(transitionSchema),
});
export type ClipClipboard = z.infer<typeof clipClipboardSchema>;

export function copyClips(project: Project, ids: string[]): ClipClipboard {
  const clips = requireSelection(project, ids);
  const selected = new Set(clips.map((clip) => clip.id));
  return structuredClone({
    projectId: project.metadata.id,
    clips,
    transitions: (project.transitions ?? []).filter((transition) =>
      transition.kind === 'cross-dissolve'
        ? selected.has(transition.from) && selected.has(transition.to)
        : selected.has(transition.clipId),
    ),
  });
}

function insertSpace(
  project: Project,
  tracks: Set<string>,
  at: RationalTime,
  duration: RationalTime,
) {
  const crossing = project.clips.filter(
    (clip) =>
      tracks.has(clip.trackId) &&
      compareTimes(clip.timelineStart, at) < 0 &&
      compareTimes(at, clipTimelineEnd(clip)) < 0,
  );
  const crossingIds = new Set(crossing.map((clip) => clip.id));
  const affectedLinks = new Set(
    crossing.flatMap((clip) => (clip.linkId ? [clip.linkId] : [])),
  );
  if (
    project.clips.some(
      (clip) =>
        clip.linkId &&
        affectedLinks.has(clip.linkId) &&
        !crossingIds.has(clip.id),
    )
  )
    invalid('The insert point must split all parts of a linked clip together.');
  const rightLinks = new Map<string, string>();
  for (const clip of crossing) {
    const right = splitClipInPlace(project, clip.id, at);
    if (clip.linkId) {
      const linkId =
        rightLinks.get(clip.linkId) ?? globalThis.crypto.randomUUID();
      rightLinks.set(clip.linkId, linkId);
      right.linkId = linkId;
    }
  }
  const shifted = new Map(
    project.clips
      .filter(
        (clip) =>
          tracks.has(clip.trackId) && compareTimes(clip.timelineStart, at) >= 0,
      )
      .map((clip) => [clip.id, duration]),
  );
  shiftLinkedClips(project, shifted);
}

export function pasteClips(
  project: Project,
  input: ClipClipboard,
  at?: RationalTime,
  insert?: RippleScope,
  tracks: Record<string, string> = {},
) {
  const clipboard = clipClipboardSchema.parse(input);
  if (clipboard.projectId !== project.metadata.id)
    invalid('The clipboard belongs to another project.');
  const next = copyProject(project);
  let start = clipboard.clips[0]!.timelineStart;
  let end = clipTimelineEnd(clipboard.clips[0]!);
  for (const clip of clipboard.clips.slice(1)) {
    if (compareTimes(clip.timelineStart, start) < 0) start = clip.timelineStart;
    const stop = clipTimelineEnd(clip);
    if (compareTimes(stop, end) > 0) end = stop;
  }
  const destination = at ?? end;
  const targets = destinationTracks(next, clipboard.clips, tracks, 'Paste');
  if (insert)
    insertSpace(
      next,
      scopeTracks(next, targets, insert),
      destination,
      subtractTimes(end, start),
    );
  const ids = new Map<string, string>();
  const links = new Map<string, string>();
  for (const [index, clip] of clipboard.clips.entries()) {
    if (ids.has(clip.id)) invalid('Clipboard clip IDs must be unique.');
    const id = newId(next);
    ids.set(clip.id, id);
    const copy = {
      ...clip,
      id,
      trackId: targets[index]!,
      timelineStart: addTimes(
        destination,
        subtractTimes(clip.timelineStart, start),
      ),
    };
    if (clip.linkId) {
      const linkId = links.get(clip.linkId) ?? globalThis.crypto.randomUUID();
      links.set(clip.linkId, linkId);
      copy.linkId = linkId;
    }
    next.clips.push(copy);
  }
  const copiedId = (id: string) =>
    ids.get(id) ?? invalid('Clipboard transition references an uncopied clip.');
  for (const transition of clipboard.transitions) {
    const copy =
      transition.kind === 'cross-dissolve'
        ? {
            ...transition,
            from: copiedId(transition.from),
            to: copiedId(transition.to),
          }
        : { ...transition, clipId: copiedId(transition.clipId) };
    (next.transitions ??= []).push({ ...copy, id: newId(next) });
  }
  return { project: finish(next), clipIds: [...ids.values()] };
}

export function insertClip(
  project: Project,
  options: AddClipOptions,
  scope: RippleScope,
) {
  const next = copyProject(project);
  const tracks = scopeTracks(next, [options.trackId], scope);
  const duration = subtractTimes(options.sourceOut, options.sourceIn);
  if (!duration.numerator)
    invalid('An inserted clip must have positive duration.');
  insertSpace(next, tracks, options.timelineStart, duration);
  const clip = appendClip(next, options);
  const updated = finish(next);
  return { project: updated, clip: requireClip(updated, clip.id) };
}

export function setTrackLock(project: Project, id: string, locked: boolean) {
  const next = copyProject(project);
  const track = next.tracks.find((track) => track.id === id);
  if (!track) invalid("Track '" + id + "' does not exist.");
  if (locked) track.locked = true;
  else delete track.locked;
  return { project: finish(next), track };
}

export function setClipLinks(project: Project, ids: string[], linked: boolean) {
  const next = copyProject(project);
  const clips = requireSelection(next, ids);
  editableTracks(
    next,
    clips.map((clip) => clip.trackId),
  );
  if (linked && clips.length < 2) invalid('Select at least two clips to link.');
  const linkId = globalThis.crypto.randomUUID();
  for (const clip of clips) {
    if (linked) clip.linkId = linkId;
    else delete clip.linkId;
  }
  return { project: finish(next), clipIds: clips.map((clip) => clip.id) };
}

export function addMarker(
  project: Project,
  frame: number,
  name: string,
  id?: string,
) {
  const next = copyProject(project);
  frameTime(frame, project.settings.frameRate);
  const marker = markerSchema.parse({ id: newId(next, id), frame, name });
  (next.markers ??= []).push(marker);
  return { project: finish(next), marker };
}

export function removeMarker(project: Project, id: string) {
  const next = copyProject(project);
  if (!next.markers?.some((marker) => marker.id === id))
    invalid('Marker does not exist.');
  next.markers = next.markers.filter((marker) => marker.id !== id);
  if (!next.markers.length) delete next.markers;
  return { project: finish(next), removedMarkerId: id };
}

export function replaceClipAsset(
  project: Project,
  id: string,
  options: {
    assetId: string;
    sourceIn?: RationalTime | undefined;
    sourceOut?: RationalTime | undefined;
    ripple?: boolean | undefined;
  },
) {
  if (linkedSelection(project, [id]).length > 1)
    invalid(
      'Unlink these clips before changing their timing or source independently.',
    );
  const next = copyProject(project);
  const clip = requireClip(next, id);
  if (!clip.assetId)
    throw new TimelineError('INVALID_EDIT', 'Select a media clip to replace.');
  const previous = { ...clip };
  clip.assetId = options.assetId;
  clip.sourceIn = options.sourceIn ?? clip.sourceIn;
  clip.sourceOut = options.sourceOut ?? clip.sourceOut;
  if (
    clip.assetId === previous.assetId &&
    compareTimes(clip.sourceIn, previous.sourceIn) === 0 &&
    compareTimes(clip.sourceOut, previous.sourceOut) === 0
  )
    return { project: next, clip };
  if (compareTimes(clip.sourceIn, clip.sourceOut) >= 0)
    throw new TimelineError(
      'INVALID_EDIT',
      'The replacement source range must have positive duration.',
    );
  const replacement = next.assets.find((asset) => asset.id === clip.assetId);
  if (!replacement?.mediaTypes.includes('video')) delete clip.detachedAudio;
  if (replacement?.metadata?.kind === 'image') {
    delete clip.speed;
    delete clip.gainKeys;
    delete clip.effects;
  }
  const duration = clipDuration(clip);
  const oldDuration = clipDuration(previous);
  if (compareTimes(duration, oldDuration) !== 0) {
    // Preserve animation relative to the clip start, regardless of source identity.
    const zero = { numerator: 0, denominator: 1 };
    if (clip.gainKeys)
      clip.gainKeys = sliceGainKeys(clip.gainKeys, zero, duration);
    const local = { ...clip, sourceIn: zero, sourceOut: duration };
    const oldLocal = { ...previous, sourceIn: zero, sourceOut: oldDuration };
    delete local.speed;
    delete oldLocal.speed;
    trimKeyframes(oldLocal, local);
    if (local.keyframes) clip.keyframes = local.keyframes;
    else delete clip.keyframes;
    let available = duration;
    for (const edge of audioFadeEdges) {
      const fade = clip[edge];
      if (!fade) continue;
      if (available.numerator === 0) delete clip[edge];
      else if (compareTimes(fade.duration, available) > 0)
        clip[edge] = { ...fade, duration: available };
      if (clip[edge]) available = subtractTimes(available, clip[edge].duration);
    }
    if (options.ripple) {
      const oldEnd = clipTimelineEnd(previous);
      const newEnd = clipTimelineEnd(clip);
      const neighbors = next.clips.filter(
        (neighbor) =>
          neighbor.id !== id &&
          neighbor.trackId === clip.trackId &&
          compareTimes(neighbor.timelineStart, oldEnd) >= 0,
      );
      const grows = compareTimes(newEnd, oldEnd) > 0;
      const shift = grows
        ? subtractTimes(newEnd, oldEnd)
        : subtractTimes(oldEnd, newEnd);
      checkLinkedShifts(
        next,
        new Map(neighbors.map((neighbor) => [neighbor.id, shift])),
      );
      for (const neighbor of neighbors)
        neighbor.timelineStart = addTimes(
          newEnd,
          subtractTimes(neighbor.timelineStart, oldEnd),
        );
    }
  }
  const updated = finish(next);
  return { project: updated, clip: requireClip(updated, id) };
}

/** Move the audible mix settings to a new audio clip with the same source mapping. */
export function detachClipAudio(project: Project, id: string) {
  const next = copyProject(project);
  const clip = requireClip(next, id);
  const track = next.tracks.find((track) => track.id === clip.trackId);
  const asset = next.assets.find((asset) => asset.id === clip.assetId);
  if (track?.type !== 'video' || !asset?.mediaTypes.includes('audio'))
    throw new TimelineError(
      'INVALID_EDIT',
      'Select a video clip with source audio.',
    );
  const audioTrack: Track = {
    ...track,
    id: newId(next),
    name: `${track.name} audio`,
    type: 'audio',
  };
  delete audioTrack.locked;
  next.tracks.push(audioTrack);
  clip.linkId ??= globalThis.crypto.randomUUID();
  const audioClip: TimelineClip = {
    ...clip,
    id: newId(next),
    trackId: audioTrack.id,
    detachedAudio: true,
  };
  delete audioClip.visual;
  delete audioClip.keyframes;
  delete audioClip.grade;
  next.clips.push(audioClip);
  clip.muted = true;
  const updated = finish(next);
  return {
    project: updated,
    clip: requireClip(updated, id),
    audioClip: requireClip(updated, audioClip.id),
  };
}

export function addTransition(
  project: Project,
  input: TransitionInput,
  id?: string,
) {
  const next = copyProject(project);
  const transition: Transition = { ...input, id: newId(next, id) };
  (next.transitions ??= []).push(transition);
  return { project: finish(next), transition };
}

export function setTransition(project: Project, id: string, frames: number) {
  const next = copyProject(project);
  const transition = next.transitions?.find((entry) => entry.id === id);
  if (!transition)
    throw new TimelineError(
      'INVALID_EDIT',
      `Transition '${id}' does not exist.`,
    );
  if (frames === transition.frames) return { project: next, transition };
  transition.frames = frames;
  return { project: finish(next), transition };
}

export function removeTransition(project: Project, id: string) {
  const next = copyProject(project);
  const remaining = next.transitions?.filter((entry) => entry.id !== id);
  if (!remaining || remaining.length === next.transitions?.length)
    throw new TimelineError(
      'INVALID_EDIT',
      `Transition '${id}' does not exist.`,
    );
  if (remaining.length) next.transitions = remaining;
  else delete next.transitions;
  return { project: finish(next), removedTransitionId: id };
}

/** Dissolve two adjacent video clips by moving the incoming clip to a higher layer. */
export function dissolveClips(
  project: Project,
  from: string,
  to: string,
  duration: RationalTime,
) {
  if (
    linkedSelection(project, [from]).length > 1 ||
    linkedSelection(project, [to]).length > 1
  )
    invalid(
      'Unlink these clips before changing their timing or source independently.',
    );
  const next = copyProject(project);
  const outgoing = requireClip(next, from);
  const incoming = requireClip(next, to);
  const trackIndex = next.tracks.findIndex(
    (track) => track.id === outgoing.trackId,
  );
  const track = next.tracks[trackIndex];
  if (
    track?.type !== 'video' ||
    outgoing.trackId !== incoming.trackId ||
    compareTimes(clipTimelineEnd(outgoing), incoming.timelineStart) !== 0 ||
    duration.numerator === 0 ||
    compareTimes(duration, clipDuration(outgoing)) >= 0 ||
    compareTimes(duration, clipDuration(incoming)) >= 0 ||
    incoming.keyframes?.opacity?.length
  )
    throw new TimelineError(
      'INVALID_EDIT',
      'Choose two adjacent video clips, a shorter transition, and an incoming clip without opacity keys.',
    );
  const layer: Track = {
    ...track,
    id: newId(next),
    name: `${track.name} transition`,
  };
  next.tracks.splice(trackIndex + 1, 0, layer);
  incoming.trackId = layer.id;
  incoming.timelineStart = subtractTimes(incoming.timelineStart, duration);
  if (
    !outgoing.text &&
    !outgoing.fadeOut &&
    (!outgoing.fadeIn ||
      compareTimes(
        addTimes(outgoing.fadeIn.duration, duration),
        clipDuration(outgoing),
      ) <= 0)
  )
    outgoing.fadeOut = { duration };
  if (
    !incoming.text &&
    !incoming.fadeIn &&
    (!incoming.fadeOut ||
      compareTimes(
        addTimes(incoming.fadeOut.duration, duration),
        clipDuration(incoming),
      ) <= 0)
  )
    incoming.fadeIn = { duration };
  incoming.keyframes = {
    ...incoming.keyframes,
    opacity: [
      { time: { numerator: 0, denominator: 1 }, value: 0, easing: 'linear' },
      {
        time: duration,
        value: incoming.visual?.opacity ?? 1,
        easing: 'linear',
      },
    ],
  };
  const updated = finish(next);
  return { project: updated, clip: requireClip(updated, to) };
}

export function flashClip(
  project: Project,
  id: string,
  duration: RationalTime,
) {
  const next = copyProject(project);
  const clip = requireClip(next, id);
  const trackIndex = next.tracks.findIndex(
    (track) => track.id === clip.trackId,
  );
  if (
    next.tracks[trackIndex]?.type !== 'video' ||
    duration.numerator === 0 ||
    compareTimes(duration, clipDuration(clip)) > 0
  )
    throw new TimelineError(
      'INVALID_EDIT',
      'Choose a video clip and a flash duration within the clip.',
    );
  const layer: Track = { id: newId(next), name: 'Flash', type: 'video' };
  next.tracks.splice(trackIndex + 1, 0, layer);
  const overlay = addText(next, {
    trackId: layer.id,
    timelineStart: clip.timelineStart,
    duration,
    text: { content: '', canvasFill: '#ffffff' },
    visual: { opacity: 0.9 },
  });
  const result = copyProject(overlay.project);
  const flash = requireClip(result, overlay.clip.id);
  flash.keyframes = {
    opacity: [
      {
        time: { numerator: 0, denominator: 1 },
        value: 0.9,
        easing: 'ease-out',
      },
      { time: duration, value: 0, easing: 'linear' },
    ],
  };
  return { project: finish(result), clip: flash };
}

export function fadeClipVisual(
  project: Project,
  id: string,
  edge: 'in' | 'out',
  length: RationalTime,
) {
  const next = copyProject(project);
  const clip = requireClip(next, id);
  const duration = clipDuration(clip);
  if (
    next.tracks.find((track) => track.id === clip.trackId)?.type !== 'video' ||
    length.numerator === 0 ||
    compareTimes(length, duration) > 0
  )
    throw new TimelineError(
      'INVALID_EDIT',
      'Choose a visual clip and a fade duration within the clip.',
    );
  const zero = { numerator: 0, denominator: 1 };
  const start = edge === 'in' ? zero : subtractTimes(duration, length);
  const end = edge === 'in' ? length : duration;
  const opacity = clip.visual?.opacity ?? 1;
  const previous = clip.keyframes?.opacity ?? [];
  if (
    previous.some(
      (key) =>
        compareTimes(key.time, start) >= 0 && compareTimes(key.time, end) <= 0,
    )
  )
    throw new TimelineError(
      'INVALID_EDIT',
      'Clear opacity keyframes in the fade interval first.',
    );
  clip.keyframes = {
    ...clip.keyframes,
    opacity: [
      ...previous,
      {
        time: start,
        value: edge === 'in' ? 0 : opacity,
        easing: 'linear' as const,
      },
      {
        time: end,
        value: edge === 'in' ? opacity : 0,
        easing: 'linear' as const,
      },
    ].sort((a, b) => compareTimes(a.time, b.time)),
  };
  return { project: finish(next), clip };
}

export function insertFreeze(
  project: Project,
  id: string,
  stillId: string,
  at: RationalTime,
  duration: RationalTime,
) {
  const clip = requireClip(project, id);
  if (
    project.assets.find((asset) => asset.id === stillId)?.metadata?.kind !==
      'image' ||
    project.tracks.find((track) => track.id === clip.trackId)?.type !==
      'video' ||
    !clip.assetId ||
    compareTimes(at, clip.timelineStart) < 0 ||
    compareTimes(at, clipTimelineEnd(clip)) >= 0 ||
    duration.numerator === 0
  )
    throw new TimelineError(
      'INVALID_EDIT',
      'Choose a video frame within the clip and a positive freeze duration.',
    );
  if (linkedSelection(project, [id]).length > 1)
    invalid(
      'Unlink these clips before inserting a freeze frame independently.',
    );
  const next = copyProject(project);
  insertSpace(next, editableTracks(next, [clip.trackId]), at, duration);
  const frozen: TimelineClip = {
    id: newId(next),
    assetId: stillId,
    trackId: clip.trackId,
    timelineStart: at,
    sourceIn: { numerator: 0, denominator: 1 },
    sourceOut: duration,
    visual: evaluateVisual(
      clip.visual ?? {},
      clip.keyframes,
      at,
      clip.timelineStart,
    ),
    ...(clip.grade && { grade: clip.grade }),
  };
  next.clips.push(frozen);
  const updated = finish(next);
  return { project: updated, clip: requireClip(updated, frozen.id) };
}

export interface TrimClipOptions {
  sourceIn?: RationalTime | undefined;
  sourceOut?: RationalTime | undefined;
}

export type TrackAudioOptions = Pick<Track, 'volume' | 'muted'>;
export type ClipAudioOptions = TrackAudioOptions & {
  fadeIn?: RationalTime | undefined;
  fadeOut?: RationalTime | undefined;
};

function applyAudioSettings(
  target: TrackAudioOptions,
  options: TrackAudioOptions,
) {
  if (options.volume !== undefined) target.volume = options.volume;
  if (options.muted !== undefined) target.muted = options.muted;
}

function applyClipAudioSettings(clip: TimelineClip, options: ClipAudioOptions) {
  applyAudioSettings(clip, options);
  for (const edge of audioFadeEdges) {
    const duration = options[edge];
    if (duration === undefined) continue;
    if (compareTimes(duration, { numerator: 0, denominator: 1 }) === 0)
      delete clip[edge];
    else {
      const current = clip[edge];
      if (
        !current ||
        current.from !== undefined ||
        current.to !== undefined ||
        compareTimes(current.duration, duration) !== 0
      )
        clip[edge] = { duration };
    }
  }
}

export function setTrackAudio(
  project: Project,
  id: string,
  options: TrackAudioOptions,
) {
  if (linkedSelection(project, [id]).length > 1)
    invalid(
      'Unlink these clips before changing their timing or source independently.',
    );
  const next = copyProject(project);
  const track = next.tracks.find((track) => track.id === id);
  if (!track)
    throw new TimelineError(
      'TRACK_NOT_FOUND',
      `Track '${id}' does not exist. Use timeline list to find its stable ID.`,
    );
  if (options.volume === undefined && options.muted === undefined)
    throw new TimelineError(
      'INVALID_EDIT',
      'Specify volume or muted when configuring track audio.',
    );
  if (
    (options.volume === undefined || options.volume === track.volume) &&
    (options.muted === undefined || options.muted === track.muted)
  )
    return { project: next, track };
  applyAudioSettings(track, options);
  const updated = finish(next);
  return {
    project: updated,
    track: updated.tracks.find((track) => track.id === id)!,
  };
}

/** Applies to original video audio as well as independent audio clips. */
export function setClipAudio(
  project: Project,
  id: string,
  options: ClipAudioOptions,
) {
  const next = copyProject(project);
  const clip = requireClip(next, id);
  if (
    options.volume === undefined &&
    options.muted === undefined &&
    options.fadeIn === undefined &&
    options.fadeOut === undefined
  )
    throw new TimelineError(
      'INVALID_EDIT',
      'Specify volume, muted or a fade duration when configuring clip audio.',
    );
  if (clip.text)
    throw new TimelineError('INVALID_EDIT', 'Text has no clip audio.');
  const previous = JSON.stringify(clip);
  applyClipAudioSettings(clip, options);
  if (JSON.stringify(clip) === previous) return { project: next, clip };
  const updated = finish(next);
  return { project: updated, clip: requireClip(updated, id) };
}

export type ClipVisualOptions = NonNullable<TimelineClip['visual']>;

export function setClipGrade(
  project: Project,
  ids: string[],
  grade: TimelineClip['grade'],
) {
  const next = copyProject(project);
  for (const id of ids) {
    const clip = requireClip(next, id);
    if (grade) clip.grade = grade;
    else delete clip.grade;
  }
  return { project: finish(next), ids };
}

export function setClipGainKeys(
  project: Project,
  id: string,
  keys: TimelineClip['gainKeys'],
) {
  const next = copyProject(project);
  const clip = requireClip(next, id);
  if (keys) {
    if (compareTimes(keys.at(-1)!.time, clipDuration(clip)) > 0)
      throw new TimelineError(
        'INVALID_EDIT',
        'Volume keyframes must be inside the clip.',
      );
    clip.gainKeys = keys;
  } else delete clip.gainKeys;
  return { project: finish(next), clip };
}

export function setClipEffects(
  project: Project,
  id: string,
  effects: NonNullable<TimelineClip['effects']>,
) {
  const next = copyProject(project);
  const clip = requireClip(next, id);
  if (effects.length) clip.effects = effects;
  else delete clip.effects;
  return { project: finish(next), clip };
}

/** Merge explicit properties; omitted values retain their current setting. */
export function setClipVisual(
  project: Project,
  id: string,
  options: ClipVisualOptions,
) {
  const next = copyProject(project);
  const clip = requireClip(next, id);
  if (!Object.values(options).some((value) => value !== undefined))
    throw new TimelineError(
      'INVALID_EDIT',
      'Specify at least one visual property.',
    );
  const visual = {
    ...clip.visual,
    ...Object.fromEntries(
      Object.entries(options).filter(([, value]) => value !== undefined),
    ),
  };
  if (JSON.stringify(visual) === JSON.stringify(clip.visual))
    return { project: next, clip };
  clip.visual = visual;
  const updated = finish(next);
  return { project: updated, clip: requireClip(updated, id) };
}

export function setCanvas(
  project: Project,
  options: {
    width?: number | undefined;
    height?: number | undefined;
    backgroundColor?: string | undefined;
  },
) {
  const next = copyProject(project);
  if (!Object.values(options).some((value) => value !== undefined))
    throw new TimelineError(
      'INVALID_EDIT',
      'Specify at least one canvas property.',
    );
  const settings = {
    ...next.settings,
    ...Object.fromEntries(
      Object.entries(options).filter(([, value]) => value !== undefined),
    ),
  };
  if (JSON.stringify(settings) === JSON.stringify(next.settings))
    return { project: next, settings: next.settings };
  next.settings = settings;
  const updated = finish(next);
  return { project: updated, settings: updated.settings };
}

/** Preserve timeline start, source bounds and fade times. Validation rejects collisions. */
export function setClipSpeed(project: Project, id: string, speed: ClipSpeed) {
  if (linkedSelection(project, [id]).length > 1)
    invalid(
      'Unlink these clips before changing their timing or source independently.',
    );
  const next = copyProject(project);
  const clip = requireClip(next, id);
  if (
    clip.text ||
    next.assets.find((asset) => asset.id === clip.assetId)?.metadata?.kind ===
      'image'
  )
    throw new TimelineError(
      'INVALID_EDIT',
      'Playback speed requires a video or audio clip.',
    );
  clipSpeedSchema.parse(speed);
  if (compareTimes(clipSpeed(clip), speed) === 0)
    return { project: next, clip };
  const previous = { ...clip };
  clip.speed = speed;
  retimeKeyframes(previous, clip);
  if (previous.gainKeys)
    clip.gainKeys = previous.gainKeys.map((key) => ({
      ...key,
      time: clipDuration({
        timelineStart: clip.timelineStart,
        sourceIn: { numerator: 0, denominator: 1 },
        sourceOut: timelineToSourceOffset(previous, key.time),
        speed,
      }),
    }));
  const updated = finish(next);
  return { project: updated, clip: requireClip(updated, id) };
}

/** Keep timeline start fixed and preserve playback speed when changing source bounds. */
export function trimClip(
  project: Project,
  id: string,
  options: TrimClipOptions,
) {
  if (linkedSelection(project, [id]).length > 1)
    invalid(
      'Unlink these clips before changing their timing or source independently.',
    );
  const next = copyProject(project);
  const clip = requireClip(next, id);
  if (options.sourceIn === undefined && options.sourceOut === undefined)
    throw new TimelineError(
      'INVALID_EDIT',
      'Specify a source in or exclusive source out point when trimming a clip.',
    );
  const startChanged =
    options.sourceIn !== undefined &&
    compareTimes(options.sourceIn, clip.sourceIn) !== 0;
  if (
    !startChanged &&
    (options.sourceOut === undefined ||
      compareTimes(options.sourceOut, clip.sourceOut) === 0)
  )
    return { project: next, clip };
  const previous = { ...clip };
  if (options.sourceIn !== undefined) clip.sourceIn = options.sourceIn;
  if (options.sourceOut !== undefined) clip.sourceOut = options.sourceOut;
  trimKeyframes(previous, clip);
  if (previous.gainKeys && compareTimes(clip.sourceOut, clip.sourceIn) > 0) {
    const start =
      compareTimes(clip.sourceIn, previous.sourceIn) > 0
        ? clipDuration({
            ...clip,
            sourceIn: previous.sourceIn,
            sourceOut: clip.sourceIn,
          })
        : { numerator: 0, denominator: 1 };
    const end = addTimes(start, clipDuration(clip));
    const extension =
      compareTimes(clip.sourceIn, previous.sourceIn) < 0
        ? clipDuration({ ...clip, sourceOut: previous.sourceIn })
        : { numerator: 0, denominator: 1 };
    clip.gainKeys = sliceGainKeys(
      shiftGainKeys(previous.gainKeys, extension),
      start,
      end,
    );
  }
  if (
    (clip.fadeIn || clip.fadeOut) &&
    compareTimes(clip.sourceOut, clip.sourceIn) > 0
  ) {
    // Re-anchor the fades to the new clip edges, shortening the edited edge first.
    let available = clipDuration(clip);
    for (const edge of startChanged
      ? (['fadeOut', 'fadeIn'] as const)
      : audioFadeEdges) {
      const fade = clip[edge];
      if (!fade) continue;
      const duration =
        compareTimes(fade.duration, available) > 0 ? available : fade.duration;
      if (duration.numerator === 0) delete clip[edge];
      else clip[edge] = { duration };
      available = subtractTimes(available, duration);
    }
  }
  const updated = finish(next);
  return { project: updated, clip: requireClip(updated, id) };
}

/** Absolute timeline split. The left clip keeps its ID; the right gets a new ID. */
export function splitClip(
  project: Project,
  id: string,
  at: RationalTime,
  rightId?: string,
) {
  if (linkedSelection(project, [id]).length > 1)
    invalid('Unlink these clips before splitting one independently.');
  const next = copyProject(project);
  const right = splitClipInPlace(next, id, at, rightId);
  const updated = finish(next);
  return {
    project: updated,
    left: requireClip(updated, id),
    right: requireClip(updated, right.id),
  };
}

function splitClipInPlace(
  next: Project,
  id: string,
  at: RationalTime,
  rightId?: string,
) {
  const clip = requireClip(next, id);
  if (
    compareTimes(at, clip.timelineStart) <= 0 ||
    compareTimes(at, clipTimelineEnd(clip)) >= 0
  )
    throw new TimelineError(
      'SPLIT_BOUNDS',
      `Split position must be strictly inside clip '${id}' on the timeline, excluding its start and end.`,
    );
  const offset = subtractTimes(at, clip.timelineStart);
  const sourceSplit = clipSourceTime(clip, at);
  const right: TimelineClip = {
    ...clip,
    id: newId(next, rightId),
    timelineStart: at,
    sourceIn: sourceSplit,
  };
  if (clip.fadeIn || clip.fadeOut) {
    const duration = clipDuration(clip);
    const leftFades = sliceAudioFades(
      clip,
      duration,
      { numerator: 0, denominator: 1 },
      offset,
    );
    const rightFades = sliceAudioFades(clip, duration, offset, duration);
    for (const edge of audioFadeEdges) {
      delete clip[edge];
      delete right[edge];
    }
    Object.assign(clip, leftFades);
    Object.assign(right, rightFades);
  }
  const previous = { ...clip };
  if (previous.gainKeys) {
    clip.gainKeys = sliceGainKeys(
      previous.gainKeys,
      { numerator: 0, denominator: 1 },
      offset,
    );
    right.gainKeys = sliceGainKeys(
      previous.gainKeys,
      offset,
      clipDuration(previous),
    );
  }
  clip.sourceOut = sourceSplit;
  trimKeyframes(previous, clip);
  trimKeyframes(previous, right);
  next.clips.splice(next.clips.indexOf(clip) + 1, 0, right);
  for (const transition of next.transitions ?? []) {
    if (transition.kind === 'cross-dissolve' && transition.from === id)
      transition.from = right.id;
    if (transition.kind === 'fade-out' && transition.clipId === id)
      transition.clipId = right.id;
  }
  return right;
}

export function removeClip(project: Project, id: string) {
  if (linkedSelection(project, [id]).length > 1)
    invalid(
      'Use clips.remove to delete a linked group, or unlink the clip first.',
    );
  return { project: removeClips(project, [id]).project, removedClipId: id };
}

/** Edit one exact clip-local timestamp, keeping all other channels unchanged. */
export function editClipKeyframe(
  project: Project,
  id: string,
  edit: KeyframeEdit,
) {
  const next = copyProject(project);
  const clip = requireClip(next, id);
  const { property, time } = edit;
  const keys = clip.keyframes?.[property] ?? [];
  const index = keys.findIndex((key) => compareTimes(key.time, time) === 0);
  const exists = index >= 0;
  if ((edit.type === 'clip.keyframe.add') === exists)
    throw new TimelineError(
      'INVALID_EDIT',
      exists
        ? 'A keyframe already exists at this property and time.'
        : 'No keyframe exists at this property and time.',
    );
  if (edit.type === 'clip.keyframe.add') {
    keys.push({ time, value: edit.value, easing: edit.easing ?? 'linear' });
  } else if (edit.type === 'clip.keyframe.remove') {
    keys.splice(index, 1);
  } else {
    const old = keys[index]!;
    const replacement: VisualKeyframe = {
      time: edit.newTime ?? old.time,
      value: edit.value ?? old.value,
      easing: edit.easing ?? old.easing,
      ...(old.curve && edit.easing === undefined && { curve: old.curve }),
    };
    if (
      compareTimes(replacement.time, old.time) === 0 &&
      replacement.value === old.value &&
      replacement.easing === old.easing &&
      replacement.curve === old.curve
    )
      return { project: next, clip };
    keys[index] = replacement;
  }
  const keyframes = clip.keyframes ?? {};
  if (keys.length)
    keyframes[property] = keys.sort((a, b) => compareTimes(a.time, b.time));
  else delete keyframes[property];
  if (animatedProperties.some((name) => keyframes[name]))
    clip.keyframes = keyframes;
  else delete clip.keyframes;
  const updated = finish(next);
  return { project: updated, clip: requireClip(updated, id) };
}

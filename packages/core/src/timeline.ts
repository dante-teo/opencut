import type { Project, TimelineClip, Track } from './project.js';
import { validateProject } from './project.js';
import { addTimes, compareTimes, subtractTimes } from './time.js';
import type { RationalTime } from './time.js';

export class TimelineError extends Error {
  override name = 'TimelineError';
  constructor(
    public readonly code:
      | 'TRACK_NOT_FOUND'
      | 'CLIP_NOT_FOUND'
      | 'TRACK_NOT_EMPTY'
      | 'INVALID_EDIT'
      | 'SPLIT_BOUNDS',
    message: string,
  ) {
    super(message);
  }
}

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

export function clipDuration(clip: TimelineClip): RationalTime {
  return subtractTimes(clip.sourceOut, clip.sourceIn);
}

export function clipTimelineEnd(clip: TimelineClip): RationalTime {
  return addTimes(clip.timelineStart, clipDuration(clip));
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
  return { frameRate: validated.settings.frameRate, duration, tracks };
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

export interface AddClipOptions extends Omit<
  TimelineClip,
  'id' | 'assetId' | 'text'
> {
  id?: string;
  assetId: string;
}

/** Explicit 1x source range; unknown asset durations have no inferred bound. */
export function addClip(project: Project, options: AddClipOptions) {
  const next = copyProject(project);
  const clip: TimelineClip = {
    id: newId(next, options.id),
    assetId: options.assetId,
    trackId: options.trackId,
    timelineStart: options.timelineStart,
    sourceIn: options.sourceIn,
    sourceOut: options.sourceOut,
    ...(options.visual !== undefined ? { visual: options.visual } : {}),
    ...(options.volume !== undefined ? { volume: options.volume } : {}),
    ...(options.muted !== undefined ? { muted: options.muted } : {}),
  };
  next.clips.push(clip);
  const updated = finish(next);
  return { project: updated, clip: requireClip(updated, clip.id) };
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
  clip.text = text;
  clip.timelineStart = start;
  clip.sourceOut = end;
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
  if (options.trackId !== undefined) clip.trackId = options.trackId;
  if (options.timelineStart !== undefined)
    clip.timelineStart = options.timelineStart;
  const updated = finish(next);
  return { project: updated, clip: requireClip(updated, id) };
}

export interface TrimClipOptions {
  sourceIn?: RationalTime;
  sourceOut?: RationalTime;
}

export type ClipAudioOptions = Pick<TimelineClip, 'volume' | 'muted'>;

/** Applies to original video audio as well as independent audio clips. */
export function setClipAudio(
  project: Project,
  id: string,
  options: ClipAudioOptions,
) {
  const next = copyProject(project);
  const clip = requireClip(next, id);
  if (options.volume === undefined && options.muted === undefined)
    throw new TimelineError(
      'INVALID_EDIT',
      'Specify volume or muted when configuring clip audio.',
    );
  if (
    (options.volume === undefined || options.volume === clip.volume) &&
    (options.muted === undefined || options.muted === clip.muted)
  )
    return { project: next, clip };
  if (options.volume !== undefined) clip.volume = options.volume;
  if (options.muted !== undefined) clip.muted = options.muted;
  const updated = finish(next);
  return { project: updated, clip: requireClip(updated, id) };
}

export type ClipVisualOptions = NonNullable<TimelineClip['visual']>;

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

/** Keep timeline start fixed; changing the source range changes duration at 1x. */
export function trimClip(
  project: Project,
  id: string,
  options: TrimClipOptions,
) {
  const next = copyProject(project);
  const clip = requireClip(next, id);
  if (options.sourceIn === undefined && options.sourceOut === undefined)
    throw new TimelineError(
      'INVALID_EDIT',
      'Specify a source in or exclusive source out point when trimming a clip.',
    );
  const unchanged =
    (options.sourceIn === undefined ||
      compareTimes(options.sourceIn, clip.sourceIn) === 0) &&
    (options.sourceOut === undefined ||
      compareTimes(options.sourceOut, clip.sourceOut) === 0);
  if (unchanged) return { project: next, clip };
  if (options.sourceIn !== undefined) clip.sourceIn = options.sourceIn;
  if (options.sourceOut !== undefined) clip.sourceOut = options.sourceOut;
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
  const next = copyProject(project);
  const clip = requireClip(next, id);
  if (
    compareTimes(at, clip.timelineStart) <= 0 ||
    compareTimes(at, clipTimelineEnd(clip)) >= 0
  )
    throw new TimelineError(
      'SPLIT_BOUNDS',
      `Split position must be strictly inside clip '${id}' on the timeline, excluding its start and end.`,
    );
  const sourceSplit = addTimes(
    clip.sourceIn,
    subtractTimes(at, clip.timelineStart),
  );
  const right: TimelineClip = {
    ...clip,
    id: newId(next, rightId),
    timelineStart: at,
    sourceIn: sourceSplit,
  };
  clip.sourceOut = sourceSplit;
  next.clips.splice(next.clips.indexOf(clip) + 1, 0, right);
  const updated = finish(next);
  return {
    project: updated,
    left: requireClip(updated, id),
    right: requireClip(updated, right.id),
  };
}

export function removeClip(project: Project, id: string) {
  const next = copyProject(project);
  requireClip(next, id);
  next.clips = next.clips.filter((clip) => clip.id !== id);
  return { project: finish(next), removedClipId: id };
}

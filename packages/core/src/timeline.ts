import type { Project, TimelineClip, Track } from './project.js';
import { validateProject } from './project.js';
import { addTimes, compareTimes, subtractTimes } from './time.js';
import type { RationalTime } from './time.js';
import {
  clipDuration,
  clipSpeed,
  clipSpeedSchema,
  clipTimelineEnd,
  clipSourceTime,
} from './clip-timing.js';
import type { ClipSpeed } from './clip-timing.js';
import { audioFadeEdges, sliceAudioFades } from './audio.js';

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
    ...(project.subtitles?.cues.map((cue) => cue.id) ?? []),
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
      'id' | 'assetId' | 'text' | 'speed' | keyof ClipAudioOptions
    >,
    ClipAudioOptions {
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
  };
  applyClipAudioSettings(clip, options);
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
  clip.speed = speed;
  const updated = finish(next);
  return { project: updated, clip: requireClip(updated, id) };
}

/** Keep timeline start fixed and preserve playback speed when changing source bounds. */
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
  const startChanged =
    options.sourceIn !== undefined &&
    compareTimes(options.sourceIn, clip.sourceIn) !== 0;
  if (
    !startChanged &&
    (options.sourceOut === undefined ||
      compareTimes(options.sourceOut, clip.sourceOut) === 0)
  )
    return { project: next, clip };
  if (options.sourceIn !== undefined) clip.sourceIn = options.sourceIn;
  if (options.sourceOut !== undefined) clip.sourceOut = options.sourceOut;
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

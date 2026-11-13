import { animatedProperties, evaluateVisual } from '@opencut/shared';
import type { VisualKeyframe } from '@opencut/shared';
import { retimeKeyframes, trimKeyframes } from './keyframes.js';
import type { KeyframeEdit } from './keyframes.js';
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
  timelineToSourceOffset,
} from './clip-timing.js';
import type { ClipSpeed } from './clip-timing.js';
import {
  audioFadeEdges,
  shiftGainKeys,
  sliceAudioFades,
  sliceGainKeys,
} from './audio.js';

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
      for (const neighbor of next.clips) {
        if (
          neighbor.id === id ||
          neighbor.trackId !== clip.trackId ||
          compareTimes(neighbor.timelineStart, oldEnd) < 0
        )
          continue;
        neighbor.timelineStart = addTimes(
          newEnd,
          subtractTimes(neighbor.timelineStart, oldEnd),
        );
      }
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
  next.tracks.push(audioTrack);
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

/** Dissolve two adjacent video clips by moving the incoming clip to a higher layer. */
export function dissolveClips(
  project: Project,
  from: string,
  to: string,
  duration: RationalTime,
) {
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
  const next =
    compareTimes(at, clip.timelineStart) === 0
      ? copyProject(project)
      : splitClip(project, id, at).project;
  for (const neighbor of next.clips) {
    if (
      neighbor.trackId === clip.trackId &&
      compareTimes(neighbor.timelineStart, at) >= 0
    )
      neighbor.timelineStart = addTimes(neighbor.timelineStart, duration);
  }
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

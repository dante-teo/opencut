import { clipDuration, clipTimelineEnd } from './clip-timing.js';
import { validateProject, type Project } from './project.js';
import { compareTimes, frameTime } from './time.js';

const ZERO = { numerator: 0, denominator: 1 };

/** Track insertion order, then exact timeline start order. No media access or mutation. */
export function listTimeline(project: Project) {
  const result = validateProject(project);
  if (!result.success) throw result.error;
  const validated = result.project;
  let duration =
    validated.settings.durationFrames === undefined
      ? ZERO
      : frameTime(
          validated.settings.durationFrames,
          validated.settings.frameRate,
        );
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

import type { Project, TimelineClip } from './project.js';
import { listTimeline } from './timeline.js';
import {
  addTimes,
  compareTimes,
  frameTime,
  subtractTimes,
  timeSchema,
} from './time.js';
import type { RationalTime } from './time.js';

/** Derived intent only: no decoded frames, stream offsets, or media availability. */
export interface ResolvedTimelineClip extends TimelineClip {
  duration: RationalTime;
  timelineEnd: RationalTime;
  trackIndex: number;
  trackType: 'video' | 'audio';
  /** Metadata-free visual assets are conservatively classified as video. */
  kind: 'video' | 'audio' | 'image';
  visual: {
    [Key in keyof NonNullable<TimelineClip['visual']>]-?: NonNullable<
      NonNullable<TimelineClip['visual']>[Key]
    >;
  };
  volume: number;
  muted: boolean;
  /** Unknown means the decoder must inspect the actual source. */
  audioPresence: 'present' | 'absent' | 'unknown';
}

/** Shared resolution for point evaluation and offline render compilation. */
export function resolveTimeline(project: Project) {
  const timeline = listTimeline(project);
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  const clips: ResolvedTimelineClip[] = timeline.tracks.flatMap(
    (track, trackIndex) =>
      track.clips.map((clip) => {
        const asset = assets.get(clip.assetId)!;
        const kind =
          track.type === 'audio'
            ? 'audio'
            : asset.metadata?.kind === 'image'
              ? 'image'
              : 'video';
        return {
          ...clip,
          trackIndex,
          trackType: track.type,
          kind,
          visual: {
            x: clip.visual?.x ?? 0,
            y: clip.visual?.y ?? 0,
            scale: clip.visual?.scale ?? 1,
            opacity: clip.visual?.opacity ?? 1,
            fit: clip.visual?.fit ?? 'contain',
          },
          volume: clip.volume ?? 1,
          muted: clip.muted ?? false,
          audioPresence:
            kind === 'image' || asset.metadata?.hasAudio === false
              ? 'absent'
              : asset.metadata
                ? 'present'
                : 'unknown',
        };
      }),
  );
  return { duration: timeline.duration, clips };
}

export interface EvaluatedTimelineClip extends ResolvedTimelineClip {
  sourceTime: RationalTime;
  /** Opacity-based eligibility, not occlusion or decoded-alpha detection. */
  visible: boolean;
  effectiveVolume: number;
}

export interface TimelineEvaluation {
  time: RationalTime;
  duration: RationalTime;
  boundary: 'inside' | 'end' | 'after';
  activeClips: EvaluatedTimelineClip[];
  /** Bottom to top. Includes transparent clips, whose visible flag is false. */
  visualClips: EvaluatedTimelineClip[];
  /** Includes muted sources; unknown stream presence remains a candidate. */
  audioClips: EvaluatedTimelineClip[];
  mixingSources: EvaluatedTimelineClip[];
  gap: boolean;
  visualGap: boolean;
  backgroundColor: string;
}

/** Evaluate exact nonnegative seconds on half-open intervals without sampling media. */
export function evaluateTimeline(
  project: Project,
  time: RationalTime,
): TimelineEvaluation {
  timeSchema.parse(time);
  const timeline = resolveTimeline(project);
  const activeClips = timeline.clips
    .filter(
      (clip) =>
        compareTimes(time, clip.timelineStart) >= 0 &&
        compareTimes(time, clip.timelineEnd) < 0,
    )
    .map((clip): EvaluatedTimelineClip => ({
      ...clip,
      sourceTime: addTimes(
        clip.sourceIn,
        subtractTimes(time, clip.timelineStart),
      ),
      visible: clip.trackType === 'video' && clip.visual.opacity > 0,
      effectiveVolume:
        clip.muted || clip.audioPresence === 'absent' ? 0 : clip.volume,
    }));
  const visualClips = activeClips.filter((clip) => clip.trackType === 'video');
  const audioClips = activeClips.filter(
    (clip) => clip.audioPresence !== 'absent',
  );
  const endComparison = compareTimes(time, timeline.duration);
  return {
    time: { ...time },
    duration: timeline.duration,
    boundary:
      endComparison < 0 ? 'inside' : endComparison === 0 ? 'end' : 'after',
    activeClips,
    visualClips,
    audioClips,
    mixingSources: audioClips.filter((clip) => clip.effectiveVolume > 0),
    gap: activeClips.length === 0,
    visualGap: !visualClips.some((clip) => clip.visible),
    backgroundColor: project.settings.backgroundColor ?? '#000000',
  };
}

/** Frame indices always use the project rate, never a source's average frame rate. */
export function evaluateTimelineFrame(
  project: Project,
  frame: number,
): TimelineEvaluation {
  return evaluateTimeline(
    project,
    frameTime(frame, project.settings.frameRate),
  );
}

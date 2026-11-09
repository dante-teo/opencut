import type { Project, TimelineClip } from './project.js';
import { audioFadeGain, baseAudioGain } from './audio.js';
import { clipSpeed, sampleClipSourceTime } from './clip-timing.js';
import { listTimeline } from './timeline.js';
import { subtitleTextLayers } from './subtitles.js';
import { compareTimes, frameTime, subtractTimes, timeSchema } from './time.js';
import type { RationalTime } from './time.js';

/** Derived intent only: no decoded frames, stream offsets, or media availability. */
interface ResolvedClipProperties extends TimelineClip {
  duration: RationalTime;
  timelineEnd: RationalTime;
  trackIndex: number;
  trackType: 'video' | 'audio';
  visual: {
    [Key in keyof NonNullable<TimelineClip['visual']>]-?: NonNullable<
      NonNullable<TimelineClip['visual']>[Key]
    >;
  };
  volume: number;
  muted: boolean;
  trackVolume?: number | undefined;
  trackMuted?: boolean | undefined;
  /** Unknown means the decoder must inspect the actual source. */
  audioPresence: 'present' | 'absent' | 'unknown';
}

export type ResolvedMediaClip = ResolvedClipProperties & {
  assetId: string;
  /** Metadata-free visual assets are conservatively classified as video. */
  kind: 'video' | 'audio' | 'image';
};
/** Adjacent pieces with the same mapping can share one decoder or tempo filter. */
export function continuesMediaRun(
  previous: ResolvedMediaClip,
  clip: ResolvedMediaClip,
): boolean {
  return (
    previous.trackId === clip.trackId &&
    previous.assetId === clip.assetId &&
    compareTimes(previous.timelineEnd, clip.timelineStart) === 0 &&
    compareTimes(previous.sourceOut, clip.sourceIn) === 0 &&
    compareTimes(clipSpeed(previous), clipSpeed(clip)) === 0
  );
}

export type ResolvedTextClip = ResolvedClipProperties & {
  text: NonNullable<TimelineClip['text']>;
  kind: 'text';
  subtitle?: true;
};
export type ResolvedTimelineClip = ResolvedMediaClip | ResolvedTextClip;

/** Shared resolution for point evaluation and offline render compilation. */
export function resolveTimeline(project: Project) {
  const timeline = listTimeline(project);
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  const clips: ResolvedTimelineClip[] = timeline.tracks.flatMap(
    (track, trackIndex) =>
      track.clips.map((clip): ResolvedTimelineClip => {
        const asset =
          clip.assetId === undefined ? undefined : assets.get(clip.assetId);
        const kind =
          track.type === 'audio'
            ? 'audio'
            : asset?.metadata?.kind === 'image'
              ? 'image'
              : 'video';
        return {
          ...clip,
          trackIndex,
          trackType: track.type,
          visual: {
            x: clip.visual?.x ?? 0,
            y: clip.visual?.y ?? 0,
            scale: clip.visual?.scale ?? 1,
            opacity: clip.visual?.opacity ?? 1,
            fit: clip.visual?.fit ?? 'contain',
          },
          volume: clip.volume ?? 1,
          muted: clip.muted ?? false,
          ...(track.volume === undefined ? {} : { trackVolume: track.volume }),
          ...(track.muted === undefined ? {} : { trackMuted: track.muted }),
          audioPresence:
            clip.text || kind === 'image' || asset?.metadata?.hasAudio === false
              ? 'absent'
              : asset?.metadata
                ? 'present'
                : 'unknown',
          ...(clip.text
            ? { kind: 'text', text: clip.text }
            : { kind, assetId: clip.assetId! }),
        };
      }),
  );
  for (const [lane, layers] of subtitleTextLayers({
    settings: project.settings,
    subtitles: timeline.subtitles,
  }).entries()) {
    for (const { cue, text, visual } of layers) {
      const duration = subtractTimes(cue.end, cue.start);
      clips.push({
        id: cue.id,
        trackId: `subtitle:${lane}`,
        trackIndex: project.tracks.length + lane,
        trackType: 'video',
        kind: 'text',
        subtitle: true,
        timelineStart: cue.start,
        timelineEnd: cue.end,
        sourceIn: { numerator: 0, denominator: 1 },
        sourceOut: duration,
        duration,
        text,
        visual,
        volume: 1,
        muted: false,
        audioPresence: 'absent',
      });
    }
  }
  return { duration: timeline.duration, clips };
}

export type EvaluatedTimelineClip = ResolvedTimelineClip & {
  sourceTime: RationalTime;
  /** Opacity-based eligibility, not occlusion or decoded-alpha detection. */
  visible: boolean;
  effectiveVolume: number;
};

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
  return createTimelineEvaluator(project)(time);
}

/** Validate and resolve one snapshot once; recreate after edits. Results stay detached. */
export function createTimelineEvaluator(
  project: Project,
  sampleSubtitles = false,
) {
  const timeline = resolveTimeline(project);
  const backgroundColor = project.settings.backgroundColor ?? '#000000';
  const rate = { ...project.settings.frameRate };
  const needsSubtitleSampling =
    sampleSubtitles && !!project.subtitles?.cues.length;
  const tracks = new Map<string, ResolvedTimelineClip[]>();
  for (const clip of timeline.clips) {
    const entries = tracks.get(clip.trackId) ?? [];
    entries.push(clip);
    tracks.set(clip.trackId, entries);
  }
  return (time: RationalTime): TimelineEvaluation => {
    timeSchema.parse(time);
    const activeClips: EvaluatedTimelineClip[] = [];
    const frame = needsSubtitleSampling
      ? (BigInt(time.numerator) * BigInt(rate.numerator)) /
        (BigInt(time.denominator) * BigInt(rate.denominator))
      : null;
    const sampled =
      frame !== null && frame <= BigInt(Number.MAX_SAFE_INTEGER)
        ? frameTime(Number(frame), rate)
        : time;
    for (const [id, entries] of tracks) {
      const at = id.startsWith('subtitle:') ? sampled : time;
      let low = 0,
        high = entries.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (compareTimes(entries[middle]!.timelineEnd, at) <= 0)
          low = middle + 1;
        else high = middle;
      }
      const clip = entries[low];
      if (clip && compareTimes(clip.timelineStart, at) <= 0) {
        const gain = baseAudioGain(clip);
        const effectiveVolume =
          clip.fadeIn || clip.fadeOut
            ? gain *
              audioFadeGain(
                clip,
                clip.duration,
                subtractTimes(at, clip.timelineStart),
              )
            : gain;
        activeClips.push({
          ...structuredClone(clip),
          sourceTime:
            clip.kind === 'text' && clip.subtitle
              ? { ...clip.sourceIn }
              : sampleClipSourceTime(clip, at),
          visible: clip.trackType === 'video' && clip.visual.opacity > 0,
          effectiveVolume,
        });
      }
    }
    const visualClips = activeClips.filter(
      (clip) => clip.trackType === 'video',
    );
    const audioClips = activeClips.filter(
      (clip) => clip.audioPresence !== 'absent',
    );
    const endComparison = compareTimes(time, timeline.duration);
    return {
      time: { ...time },
      duration: { ...timeline.duration },
      boundary:
        endComparison < 0 ? 'inside' : endComparison === 0 ? 'end' : 'after',
      activeClips,
      visualClips,
      audioClips,
      mixingSources: audioClips.filter((clip) => clip.effectiveVolume > 0),
      gap: activeClips.length === 0,
      visualGap: !visualClips.some((clip) => clip.visible),
      backgroundColor,
    };
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

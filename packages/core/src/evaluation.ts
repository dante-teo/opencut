import {
  evaluateVisual,
  transitionOpacity,
  visualDefaults,
} from '@opencut/shared';
import type { Project, TimelineClip } from './project.js';
import { audioFadeGain, baseAudioGain, keyframeGain } from './audio.js';
import { clipSpeed, sampleClipSourceTime } from './clip-timing.js';
import { resolveTransition, stillAsset } from './transitions.js';
import { listTimeline } from './timeline-view.js';
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
    [
      Key in Exclude<
        keyof NonNullable<TimelineClip['visual']>,
        'rotation' | 'crop' | 'sourceWindow'
      >
    ]-?: NonNullable<NonNullable<TimelineClip['visual']>[Key]>;
  } & {
    rotation?: number;
    sourceWindow?: NonNullable<
      NonNullable<TimelineClip['visual']>['sourceWindow']
    >;
    crop?: NonNullable<NonNullable<TimelineClip['visual']>['crop']>;
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
  kind: 'video' | 'audio' | 'image' | 'graphic';
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
    JSON.stringify(previous.effects ?? []) ===
      JSON.stringify(clip.effects ?? []) &&
    compareTimes(clipSpeed(previous), clipSpeed(clip)) === 0
  );
}

export type ResolvedTextClip = ResolvedClipProperties & {
  text: NonNullable<TimelineClip['text']>;
  kind: 'text';
  subtitle?: true;
  subtitleCueId?: string;
  animationStart?: RationalTime;
};
export type ResolvedTimelineClip = ResolvedMediaClip | ResolvedTextClip;

/** Shared resolution for point evaluation and offline render compilation. */
export function resolveTimeline(project: Project) {
  const timeline = listTimeline(project);
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  const inactiveMusic = new Set(
    project.musicComparison?.candidates
      .filter(({ trackId }) => trackId !== project.musicComparison?.selected)
      .map(({ trackId }) => trackId),
  );
  const clips: ResolvedTimelineClip[] = timeline.tracks.flatMap(
    (track, trackIndex) =>
      track.clips.map((clip): ResolvedTimelineClip => {
        const asset =
          clip.assetId === undefined ? undefined : assets.get(clip.assetId);
        const trackMuted = inactiveMusic.has(track.id) || track.muted;
        const kind =
          track.type === 'audio'
            ? 'audio'
            : asset?.metadata?.kind === 'image' ||
                asset?.metadata?.kind === 'graphic'
              ? asset.metadata.kind
              : 'video';
        return {
          ...clip,
          trackIndex,
          trackType: track.type,
          visual: {
            x: clip.visual?.x ?? visualDefaults.x,
            y: clip.visual?.y ?? visualDefaults.y,
            scale: clip.visual?.scale ?? visualDefaults.scale,
            opacity: clip.visual?.opacity ?? visualDefaults.opacity,
            fit: clip.visual?.fit ?? 'contain',
            ...(clip.visual?.sourceWindow && {
              sourceWindow: clip.visual.sourceWindow,
            }),
            ...(clip.visual?.crop && { crop: clip.visual.crop }),
            ...(clip.visual?.rotation !== undefined && {
              rotation: clip.visual.rotation,
            }),
          },
          volume: clip.volume ?? 1,
          muted: clip.muted ?? false,
          ...(track.volume === undefined ? {} : { trackVolume: track.volume }),
          ...(trackMuted !== undefined && { trackMuted }),
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
    for (const {
      id,
      start,
      end,
      text,
      visual,
      keyframes,
      subtitleCueId,
      animationStart,
    } of layers) {
      const duration = subtractTimes(end, start);
      clips.push({
        id,
        trackId: `subtitle:${lane}`,
        trackIndex: project.tracks.length + lane,
        trackType: 'video',
        kind: 'text',
        subtitle: true,
        timelineStart: start,
        timelineEnd: end,
        sourceIn: { numerator: 0, denominator: 1 },
        sourceOut: duration,
        duration,
        text,
        visual,
        ...(keyframes && { keyframes }),
        ...(subtitleCueId && { subtitleCueId }),
        ...(animationStart && { animationStart }),
        volume: 1,
        muted: false,
        audioPresence: 'absent',
      });
    }
  }
  const transitions = [];
  if (timeline.transitions?.length) {
    const media = new Map(
      clips.flatMap((clip) =>
        clip.kind === 'video' ||
        clip.kind === 'image' ||
        clip.kind === 'graphic'
          ? [[clip.id, clip] as const]
          : [],
      ),
    );
    for (const transition of timeline.transitions)
      transitions.push(
        resolveTransition(transition, media, timeline.frameRate),
      );
  }
  return { duration: timeline.duration, clips, transitions };
}

type ClipSample = {
  sourceTime: RationalTime;
  /** Opacity-based eligibility, not occlusion or decoded-alpha detection. */
  visible: boolean;
  effectiveVolume: number;
  transitionId?: string;
};

export type EvaluatedTimelineClip = ResolvedTimelineClip & ClipSample;
export interface TimelineEvaluation {
  time: RationalTime;
  duration: RationalTime;
  boundary: 'inside' | 'end' | 'after';
  /** Nominal clip intervals. Video handles appear only in visualClips. */
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
  sampleVisuals = false,
) {
  const timeline = resolveTimeline(project);
  const backgroundColor = project.settings.backgroundColor ?? '#000000';
  const rate = { ...project.settings.frameRate };
  const needsFrameSampling =
    timeline.transitions.length > 0 ||
    (sampleVisuals &&
      (!!project.subtitles?.cues.length ||
        timeline.clips.some((clip) => clip.keyframes)));
  const tracks = new Map<string, ResolvedTimelineClip[]>();
  for (const clip of timeline.clips) {
    const entries = tracks.get(clip.trackId) ?? [];
    entries.push(clip);
    tracks.set(clip.trackId, entries);
  }
  const stillAssets = new Set(
    project.assets.filter(stillAsset).map(({ id }) => id),
  );
  const transitions = new Map<string, typeof timeline.transitions>();
  for (const transition of timeline.transitions) {
    const entries = transitions.get(transition.trackId) ?? [];
    entries.push(transition);
    transitions.set(transition.trackId, entries);
  }
  return (time: RationalTime): TimelineEvaluation => {
    timeSchema.parse(time);
    const activeClips: EvaluatedTimelineClip[] = [];
    const visualClips: EvaluatedTimelineClip[] = [];
    const frame = needsFrameSampling
      ? (BigInt(time.numerator) * BigInt(rate.numerator)) /
        (BigInt(time.denominator) * BigInt(rate.denominator))
      : null;
    const sampled =
      frame !== null && frame <= BigInt(Number.MAX_SAFE_INTEGER)
        ? frameTime(Number(frame), rate)
        : time;
    for (const [id, entries] of tracks) {
      const at = sampleVisuals && id.startsWith('subtitle:') ? sampled : time;
      let low = 0,
        high = entries.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (compareTimes(entries[middle]!.timelineEnd, at) <= 0)
          low = middle + 1;
        else high = middle;
      }
      const nominal = entries[low];
      const clip =
        nominal && compareTimes(nominal.timelineStart, at) <= 0
          ? nominal
          : undefined;
      const transition =
        frame !== null
          ? transitions
              .get(id)
              ?.find(
                ({ startFrame, endFrame }) =>
                  frame >= BigInt(startFrame) && frame < BigInt(endFrame),
              )
          : undefined;
      if (clip) {
        const gain = baseAudioGain(clip);
        const local =
          clip.fadeIn || clip.fadeOut || clip.gainKeys
            ? subtractTimes(at, clip.timelineStart)
            : undefined;
        const effectiveVolume = local
          ? gain *
            audioFadeGain(clip, clip.duration, local) *
            (clip.gainKeys ? keyframeGain(clip.gainKeys, local) : 1)
          : gain;
        const detached = structuredClone(clip);
        const visual = evaluateVisual(
          detached.visual,
          clip.keyframes,
          sampleVisuals ? sampled : time,
          clip.kind === 'text'
            ? (clip.animationStart ?? clip.timelineStart)
            : clip.timelineStart,
        );
        const sample = Object.assign(detached, {
          sourceTime:
            clip.kind === 'text' && clip.subtitle
              ? { ...clip.sourceIn }
              : sampleClipSourceTime(clip, at),
          visual,
          visible: clip.trackType === 'video' && visual.opacity > 0,
          effectiveVolume,
        });
        activeClips.push(sample);
        if (!transition && clip.trackType === 'video') visualClips.push(sample);
      }
      if (transition) {
        for (const { clip: participant, direction } of transition.layers) {
          const detached = structuredClone(participant);
          const visual = evaluateVisual(
            detached.visual,
            participant.keyframes,
            sampled,
            participant.timelineStart,
          );
          const opacity =
            visual.opacity *
            transitionOpacity(Number(frame), { ...transition, direction });
          const sample = Object.assign(detached, {
            visual: { ...visual, opacity },
            sourceTime: stillAssets.has(participant.assetId)
              ? { ...participant.sourceIn }
              : sampleClipSourceTime(participant, sampled),
            transitionId: transition.id,
            visible: opacity > 0,
            effectiveVolume: 0,
          });
          visualClips.push(sample);
        }
      }
    }
    const audioClips = activeClips.filter(
      (clip): boolean => clip.audioPresence !== 'absent',
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

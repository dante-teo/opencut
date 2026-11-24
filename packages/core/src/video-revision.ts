import { z } from 'zod';
import {
  inspectEncodedPicture,
  inspectTimelineRender,
  MediaError,
  recipeBackendVersion,
  sameFrameRate,
  SourceChangedError,
} from '@opencut/media';
import type {
  RenderControls,
  VideoTimelineOptions,
  VisualTimelineClip,
} from '@opencut/media';
import { frameRateSchema } from './time.js';
import type { CompiledVideo } from './video-compiler.js';
import { withRenderSources } from './render-sources.js';
import { hashJson } from './video-integrity.js';
import { videoInputIdentity } from './video-input.js';

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const span = z.object({
  startFrame: z.int().nonnegative(),
  endFrame: z.int().positive(),
});
const dependency = span.extend({
  id: z.string(),
  key: sha,
  alignmentKey: sha.optional(),
  rasterKey: sha.optional(),
  audioDriven: z.literal(true).optional(),
  kind: z.enum([
    'caption',
    'picture',
    'graphic',
    'audio-driven graphic',
    'transition',
    'audio',
    'music',
  ]),
});
const revisionRenderSettingsSchema = z.object({
  codec: z.enum(['h264', 'hevc']),
  quality: z.enum(['fast', 'quality', 'maximum']),
  resolution: z.enum(['project', '720p', '1080p']),
  burnSubtitles: z.boolean(),
  encoder: z.enum(['auto', 'software', 'videotoolbox']).optional(),
  outputSize: z
    .object({ width: z.int().positive(), height: z.int().positive() })
    .optional(),
  outputFrameRate: frameRateSchema.optional(),
  videoBitrateKbps: z.int().positive().optional(),
  keyframeInterval: z.int().min(1).max(10000).optional(),
  audioBitrateKbps: z.int().positive(),
  audioSampleRate: z.union([z.literal(44100), z.literal(48000)]),
  audioChannels: z.union([z.literal(1), z.literal(2)]),
  audioComparison: z.enum(['before', 'after']).optional(),
});
export type RevisionRenderSettings = z.infer<
  typeof revisionRenderSettingsSchema
>;

const timeline = z.object({
  frameRate: frameRateSchema,
  frameCount: z.int().positive(),
  width: z.int().positive(),
  height: z.int().positive(),
  pictureKey: sha,
  pictureSettingsKey: sha,
  audioSettingsKey: sha,
  voiceSettingsKey: sha,
  musicCandidatesKey: sha.optional(),
  picture: z.array(dependency),
  audio: z.array(dependency),
});
export type RevisionTimeline = z.infer<typeof timeline>;

export const revisionEvidenceSchema = z.object({
  version: z.literal(1),
  settings: revisionRenderSettingsSchema,
  timeline,
  packetHash: sha,
  timingHash: sha,
  frameCount: z.int().positive(),
  width: z.int().positive(),
  height: z.int().positive(),
  frameRate: frameRateSchema,
});
export type RevisionEvidence = z.infer<typeof revisionEvidenceSchema>;
type Range = z.infer<typeof span>;
type Dependency = z.infer<typeof dependency>;
type EvidenceControls = RenderControls & { burnSubtitles?: boolean };

export function revisionRenderSettings(
  controls: EvidenceControls,
): RevisionRenderSettings {
  return {
    codec: controls.codec ?? 'h264',
    quality: controls.quality ?? 'quality',
    resolution: controls.resolution ?? 'project',
    burnSubtitles: controls.burnSubtitles ?? true,
    audioBitrateKbps: controls.audioBitrateKbps ?? 192,
    audioSampleRate: controls.audioSampleRate ?? 48000,
    audioChannels: controls.audioChannels ?? 2,
    ...(controls.encoder && { encoder: controls.encoder }),
    ...(controls.outputSize && { outputSize: controls.outputSize }),
    ...(controls.outputFrameRate && {
      outputFrameRate: controls.outputFrameRate,
    }),
    ...(controls.keyframeInterval && {
      keyframeInterval: controls.keyframeInterval,
    }),
    ...(controls.videoBitrateKbps && {
      videoBitrateKbps: controls.videoBitrateKbps,
    }),
    ...(controls.audioComparison && {
      audioComparison: controls.audioComparison,
    }),
  };
}

export async function describeRevisionPlan(
  video: CompiledVideo,
  plan: VideoTimelineOptions,
  settings: RevisionRenderSettings,
) {
  if (plan.range || plan.maxDimension !== undefined)
    throw new MediaError('Revision evidence requires a full timeline render.');
  const paths = new Set<string>();
  function identity(path: string) {
    const expected = video.sourceIdentity(path);
    if (!expected || expected !== videoInputIdentity(path))
      throw new SourceChangedError(
        path,
        'checking revision dependencies',
        expected ?? null,
      );
    paths.add(path);
    return expected;
  }
  function checkInputs() {
    for (const path of paths) identity(path);
    for (const input of video.graphicInputs) {
      if (input.identity !== videoInputIdentity(input.path))
        throw new SourceChangedError(
          input.path,
          'checking revision graphics',
          input.identity,
        );
    }
  }
  const backend = await recipeBackendVersion(
    plan.signal ?? new AbortController().signal,
  );
  const inspected = await inspectTimelineRender(plan, {
    cache: { backend, sourceIdentity: identity },
    pendingSources: new Map(),
  });
  const {
    visualClips = [],
    visualTransitions = [],
    audioClips = [],
    frameCount,
    frameRate,
  } = plan;
  const picture: Dependency[] = [];
  const describeLayer = (clip: VisualTimelineClip, transition = false) => {
    const { clipId, timelineStartFrame, frameCount, subtitleCueId, ...visual } =
      clip;
    const graphic = visual.graphic;
    const id = subtitleCueId ?? clipId;
    const kind = transition
      ? 'transition'
      : visual.subtitle
        ? 'caption'
        : graphic?.audioAnalysis
          ? 'audio-driven graphic'
          : graphic
            ? 'graphic'
            : 'picture';
    for (const { path } of Object.values(graphic?.mediaFrames ?? {}))
      identity(path);
    const sourceIdentity =
      !graphic && visual.path ? identity(visual.path) : null;
    const rasterKey = visual.text && inspected.textRasterKeys.get(clipId);
    picture.push({
      startFrame: timelineStartFrame,
      endFrame: timelineStartFrame + frameCount,
      id,
      kind,
      ...(rasterKey && { rasterKey }),
      ...(transition && graphic?.audioAnalysis && { audioDriven: true }),
      ...(kind === 'picture' &&
        visual.path && {
          alignmentKey: hashJson([
            sourceIdentity,
            visual.sourceStartFrame,
            visual.retiming?.sourceIn,
            visual.retiming?.sourceOut,
            visual.retiming?.speed,
            visual.freezeFrame,
          ]),
        }),
      key: hashJson([
        visual,
        sourceIdentity,
        !visual.text ? timelineStartFrame : null,
        graphic?.motionBlur ? frameCount : null,
      ]),
    });
  };
  for (const clip of visualClips) describeLayer(clip);
  for (const { layers } of visualTransitions)
    for (const layer of layers) describeLayer(layer, true);
  const comparison = plan.musicComparison;
  const musicCandidatesKey =
    comparison &&
    hashJson([
      frameRate,
      frameCount,
      comparison.candidates,
      audioClips
        .filter(
          ({ trackId }) => trackId && comparison.candidates.includes(trackId),
        )
        .map((clip) => [clip, identity(clip.path)]),
    ]);
  const audio: Dependency[] = audioClips.flatMap((clip) => {
    const { clipId, frameCount, timelineStartFrame, path, trackId } = clip;
    if (
      clip.muted ||
      clip.volume === 0 ||
      !plan.sourceMetadata?.get(path)?.audio ||
      (trackId &&
        comparison?.candidates.includes(trackId) &&
        trackId !== comparison.selected)
    )
      return [];
    return [
      {
        startFrame: timelineStartFrame,
        endFrame: timelineStartFrame + frameCount,
        id: clipId,
        kind: clip.role === 'music' ? 'music' : 'audio',
        key: hashJson([
          clip,
          identity(path),
          clip.role === 'music' ? comparison : null,
          // Unselected candidates can change the common gain for the selected bed.
          ...(comparison?.matchLoudness && trackId === comparison.selected
            ? [musicCandidatesKey]
            : []),
        ]),
      },
    ];
  });
  // Reactive mix keys include every source, including comparison candidates.
  if (
    [...visualClips, ...visualTransitions.flatMap(({ layers }) => layers)].some(
      ({ graphic }) => graphic?.audioAnalysis,
    )
  )
    for (const { path } of audioClips) identity(path);
  checkInputs();
  const audioSettings = [
    settings.audioComparison,
    settings.audioSampleRate,
    settings.audioChannels,
    settings.audioBitrateKbps,
  ];
  const description: RevisionTimeline = {
    frameRate,
    frameCount,
    width: plan.width,
    height: plan.height,
    pictureKey: inspected.savedKey!,
    pictureSettingsKey: hashJson([
      backend,
      plan.width,
      plan.height,
      plan.backgroundColor,
      plan.visualGroups,
      settings.codec,
      settings.quality,
      settings.burnSubtitles,
      inspected.outputWidth,
      inspected.outputHeight,
      inspected.encoder.name,
      inspected.encoder.settings,
      settings.outputFrameRate,
    ]),
    audioSettingsKey: hashJson([plan.professionalMix, ...audioSettings]),
    voiceSettingsKey: hashJson([
      video.definition.professionalMix
        ? {
            ...plan.professionalMix,
            ducking: undefined,
            automation: plan.professionalMix?.automation?.dialogue,
          }
        : plan.professionalMix,
      audioSettings,
      audio.filter(({ kind }) => kind !== 'music'),
    ]),
    ...(musicCandidatesKey && { musicCandidatesKey }),
    picture,
    audio,
  };
  return { timeline: description, checkInputs, inspected };
}

/** Use the same bound graphic and audio dependencies as a normal render. */
export async function inspectVideoRevision(
  video: CompiledVideo,
  output: string,
  settings: RevisionRenderSettings,
  signal?: AbortSignal,
) {
  return withRenderSources(
    video,
    signal,
    (plan) =>
      describeRevisionPlan(
        video,
        {
          ...plan,
          ...settings,
          visualClips: plan.visualClips.filter(
            ({ subtitle }) => settings.burnSubtitles || !subtitle,
          ),
          output,
          signal,
        },
        settings,
      ),
    settings,
  );
}

function intersectingChanges(
  before: Dependency[],
  after: Dependency[],
  frame: number,
) {
  const active = (items: Dependency[]) =>
    items.filter(
      ({ startFrame, endFrame }) => startFrame <= frame && endFrame > frame,
    );
  const left = active(before);
  const right = active(after);
  if (
    hashJson(left.map(({ key }) => key)) ===
    hashJson(right.map(({ key }) => key))
  )
    return [];
  const differences = [
    ...left.filter((a) => !right.some((b) => a.id === b.id && a.key === b.key)),
    ...right.filter((b) => !left.some((a) => a.id === b.id && a.key === b.key)),
  ];
  return [
    ...new Set(
      (differences.length ? differences : [...left, ...right]).map(
        ({ kind, id }) => kind + ' ' + id,
      ),
    ),
  ];
}

export function compareRevisionTimelines(
  before: RevisionTimeline,
  after: RevisionTimeline,
) {
  if (
    before.frameRate.numerator * after.frameRate.denominator !==
    after.frameRate.numerator * before.frameRate.denominator
  )
    return {
      alignment: 'manual' as const,
      reason: 'Project frame rates differ.',
      ranges: [],
    };
  const cuts = new Set([0, before.frameCount, after.frameCount]);
  for (const { startFrame, endFrame } of [
    ...before.picture,
    ...after.picture,
    ...before.audio,
    ...after.audio,
  ]) {
    cuts.add(startFrame);
    cuts.add(endFrame);
  }
  const ranges: (Range & {
    affects: 'picture' | 'audio' | 'both';
    reasons: string[];
  })[] = [];
  const edges = [...cuts].sort((a, b) => a - b);
  for (let i = 0; i < edges.length - 1; i++) {
    const startFrame = edges[i]!;
    const endFrame = edges[i + 1]!;
    const picture = intersectingChanges(
      before.picture,
      after.picture,
      startFrame,
    );
    const audio = intersectingChanges(before.audio, after.audio, startFrame);
    if (before.pictureSettingsKey !== after.pictureSettingsKey)
      picture.push('picture render settings');
    if (before.audioSettingsKey !== after.audioSettingsKey)
      audio.push('mix or audio output settings');
    if (startFrame >= Math.min(before.frameCount, after.frameCount)) {
      picture.push('timeline duration');
      audio.push('timeline duration');
    }
    if (!picture.length && !audio.length) continue;
    const affects =
      picture.length && audio.length
        ? 'both'
        : picture.length
          ? 'picture'
          : 'audio';
    const reasons = [...picture, ...audio].sort();
    const last = ranges.at(-1);
    if (
      last?.endFrame === startFrame &&
      last.affects === affects &&
      JSON.stringify(last.reasons) === JSON.stringify(reasons)
    )
      last.endFrame = endFrame;
    else ranges.push({ startFrame, endFrame, affects, reasons });
  }
  const pictureAnchors = (timeline: RevisionTimeline) =>
    timeline.picture.flatMap(({ alignmentKey, startFrame, endFrame }) =>
      alignmentKey ? [[alignmentKey, startFrame, endFrame]] : [],
    );
  const aligned =
    before.frameCount === after.frameCount &&
    hashJson(pictureAnchors(before)) === hashJson(pictureAnchors(after));
  return {
    alignment: aligned ? ('same-grid' as const) : ('manual' as const),
    ...(!aligned && {
      reason:
        'Picture placements, settings, or duration differ. Supply corresponding ranges for shifted material.',
    }),
    ranges,
  };
}

/** Match encoded video and its presentation grid to a render report. */
export function matchesRevisionPicture(
  picture: Awaited<ReturnType<typeof inspectEncodedPicture>>,
  evidence: RevisionEvidence,
) {
  const { metadata } = picture;
  return (
    picture.packetHash === evidence.packetHash &&
    picture.timingHash === evidence.timingHash &&
    picture.frameCount === evidence.frameCount &&
    metadata.width === evidence.width &&
    metadata.height === evidence.height &&
    metadata.codec === evidence.settings.codec &&
    sameFrameRate(
      metadata.frameRateRatio,
      evidence.frameRate.numerator,
      evidence.frameRate.denominator,
    ) &&
    metadata.pixelFormat === 'yuv420p' &&
    (metadata.rotation ?? 0) === 0 &&
    (metadata.sampleAspectRatio ?? 1) === 1 &&
    !metadata.hasHdrMetadata &&
    metadata.colorSpace === 'bt709' &&
    metadata.colorPrimaries === 'bt709' &&
    metadata.colorTransfer === 'bt709' &&
    metadata.colorRange === 'tv'
  );
}

export async function preflightPictureReuse(
  baseline: string,
  evidence: RevisionEvidence,
  candidate: Awaited<ReturnType<typeof inspectVideoRevision>>,
  signal?: AbortSignal,
) {
  const comparison = compareRevisionTimelines(
    evidence.timeline,
    candidate.timeline,
  );
  const reasons: string[] = [];
  const checks = [
    'render evidence version',
    'visual layers and dependencies',
    'picture output settings',
  ];
  const { inspected } = candidate;
  if (
    evidence.timeline.pictureKey !== candidate.timeline.pictureKey ||
    evidence.timeline.pictureSettingsKey !==
      candidate.timeline.pictureSettingsKey
  )
    reasons.push(
      'The candidate picture or video export settings differ from the baseline.',
    );
  if (
    evidence.width !== inspected.outputWidth ||
    evidence.height !== inspected.outputHeight ||
    evidence.frameCount !== inspected.outputFrameCount
  )
    reasons.push(
      'The candidate output dimensions or frame count differ from the baseline.',
    );
  const identity = videoInputIdentity(baseline);
  try {
    const original = await inspectEncodedPicture(baseline, signal);
    checks.push(
      'encoded video packet hash',
      'codec initialization data',
      'packet timestamps and frame count',
      'video stream settings',
    );
    if (!matchesRevisionPicture(original, evidence))
      reasons.push(
        'The supplied MP4 does not match the encoded picture or timing in the report.',
      );
    if (!identity || identity !== videoInputIdentity(baseline))
      reasons.push('The supplied MP4 changed during preflight.');
  } catch (error) {
    signal?.throwIfAborted();
    reasons.push(error instanceof Error ? error.message : String(error));
  }
  const affectedRanges = comparison.ranges.filter(
    ({ affects }) => affects !== 'audio',
  );
  if (
    !affectedRanges.length &&
    evidence.timeline.pictureKey !== candidate.timeline.pictureKey
  )
    affectedRanges.push({
      startFrame: 0,
      endFrame: candidate.timeline.frameCount,
      affects: 'picture',
      reasons: [
        comparison.reason ?? 'Picture samples or visual dependencies changed.',
      ],
    });
  return {
    baseline,
    status: reasons.length ? ('blocked' as const) : ('reuse' as const),
    checks,
    reasons,
    affectedRanges,
    ...(!reasons.length &&
      identity && {
        pictureFrom: {
          path: baseline,
          identity,
          packetHash: evidence.packetHash,
          timingHash: evidence.timingHash,
        },
      }),
  };
}

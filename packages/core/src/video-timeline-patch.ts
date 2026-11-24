import { link, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { audioSourceDuration, videoSourceDuration } from '@opencut/media';
import { clipTimelineEnd } from './clip-timing.js';
import { checkGraphicAudio } from './graphic-audio.js';
import { entityIdSchema } from './project.js';
import type { Project } from './project.js';
import { subtitleCueInputSchema } from './subtitles.js';
import {
  addTimes,
  compareTimes,
  frameTime,
  subtractTimes,
  timeSchema,
} from './time.js';
import type { FrameRate, RationalTime } from './time.js';
import { resolveTransition } from './transitions.js';
import { compileDefinition } from './video-compiler.js';
import type { CompiledVideo } from './video-compiler.js';
import {
  isVideoDefinitionPath,
  parseVideoDefinition,
  VideoDefinitionError,
} from './video-definition.js';
import { compileVideoGraphics } from './video-graphics.js';
import { inspectVideoLayout, VideoLayoutError } from './video-layout.js';
import { packageEntryName } from './video-package-format.js';

const frame = z.int().nonnegative();
const operation = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('caption'),
    id: entityIdSchema,
    text: subtitleCueInputSchema.shape.text.optional(),
    start: frame.optional(),
    end: frame.optional(),
  }),
  z.strictObject({
    operation: z.literal('graphic'),
    id: entityIdSchema,
    at: frame,
  }),
  z.strictObject({
    operation: z.literal('replace-source'),
    id: entityIdSchema,
    asset: entityIdSchema,
    sourceIn: z.union([frame, timeSchema]),
    audio: z.enum(['replace', 'mute']).optional(),
  }),
  z.strictObject({
    operation: z.literal('trim'),
    id: entityIdSchema,
    sourceIn: frame.optional(),
    sourceOut: frame.optional(),
    placement: z.enum(['keep', 'ripple']),
  }),
]);
export const timelinePatchSchema = z.strictObject({
  operations: z.array(operation).min(1).max(100),
});
type Patch = z.infer<typeof timelinePatchSchema>;
type Definition = ReturnType<typeof parseVideoDefinition>;
type Range = { startFrame: number; endFrame: number };
type Item = Range & {
  id: string;
  kind: 'clip' | 'caption' | 'transition' | 'audio';
  trackId?: string;
};

function projectFrame(
  time: RationalTime,
  rate: FrameRate,
  rounding: 'ceil' | 'floor' | 'exact' = 'ceil',
) {
  const n = BigInt(time.numerator) * BigInt(rate.numerator);
  const d = BigInt(time.denominator) * BigInt(rate.denominator);
  if (rounding === 'exact' && n % d)
    throw new VideoDefinitionError(
      'Ripple requires the edited clip end to stay on a project frame.',
    );
  return frame.parse(Number((n + (rounding === 'ceil' ? d - 1n : 0n)) / d));
}

function frameRange(
  start: RationalTime,
  end: RationalTime,
  rate: FrameRate,
): Range {
  return {
    startFrame: projectFrame(start, rate),
    endFrame: projectFrame(end, rate),
  };
}

function describe(
  project: Project,
  plan: Awaited<ReturnType<CompiledVideo['resolveRender']>>,
) {
  const { frameRate } = project.settings;
  const clips = new Map(project.clips.map((clip) => [clip.id, clip]));
  const items: Item[] = project.clips.map((clip) => ({
    id: clip.id,
    kind: 'clip',
    trackId: clip.trackId,
    ...frameRange(clip.timelineStart, clipTimelineEnd(clip), frameRate),
  }));
  for (const { id, start, end } of project.subtitles?.cues ?? [])
    items.push({ id, kind: 'caption', ...frameRange(start, end, frameRate) });
  for (const transition of project.transitions ?? []) {
    const { id, startFrame, endFrame, trackId } = resolveTransition(
      transition,
      clips,
      frameRate,
    );
    items.push({ id, kind: 'transition', trackId, startFrame, endFrame });
  }
  for (const {
    clipId,
    trackId,
    timelineStartFrame,
    frameCount,
    path,
    muted,
    volume,
  } of plan.audioClips)
    if (!muted && volume && plan.sourceMetadata.get(path)?.audio)
      items.push({
        id: clipId,
        kind: 'audio',
        ...(trackId && { trackId }),
        startFrame: timelineStartFrame,
        endFrame: timelineStartFrame + frameCount,
      });
  return items;
}

function bindIds(definition: Definition, project: Project) {
  let index = 0;
  const authored = new Map<
    string,
    Definition['tracks'][number]['clips'][number]
  >();
  for (const [trackIndex, track] of definition.tracks.entries()) {
    track.id ??= project.tracks[trackIndex]!.id;
    for (const item of track.clips) {
      const clip = project.clips[index++]!;
      item.id ??= clip.id;
      if (authored.has(item.id))
        throw new VideoDefinitionError(`Clip ID '${item.id}' is ambiguous.`);
      authored.set(item.id, item);
    }
  }
  return authored;
}

function relocate(time: RationalTime, delta: number, rate: FrameRate) {
  const offset = frameTime(Math.abs(delta), rate);
  return delta < 0 ? subtractTimes(time, offset) : addTimes(time, offset);
}

export async function patchVideoTimeline(
  video: CompiledVideo,
  input: Patch,
  options: {
    output?: string | undefined;
    signal?: AbortSignal | undefined;
  } = {},
) {
  const { signal } = options;
  const edit = timelinePatchSchema.parse(input);
  const definition = structuredClone(video.definition);
  const { project } = video;
  const { frameRate: rate } = project.settings;
  const authored = bindIds(definition, project);
  const current = new Map(project.clips.map((clip) => [clip.id, { ...clip }]));
  const captions = definition.subtitles?.cues ?? [];
  const plan = await video.resolveRender();
  const original = describe(project, plan);
  const media = new Map(
    plan.audioClips.map(({ clipId, assetId, path, required }) => [
      clipId,
      { assetId, path, audio: required },
    ]),
  );
  const touched = new Set<string>();
  type Step = z.infer<typeof operation> & {
    before: Range;
    after: Range;
    wordTimingsCleared?: boolean;
    rippleFrames?: number;
    moved?: string[];
    replacement?: {
      previousAsset: string;
      sourceIn: RationalTime;
      sourceOut: RationalTime;
      sourceDuration: RationalTime | null;
      sourceWindow:
        NonNullable<Project['clips'][number]['visual']>['sourceWindow'] | null;
      crop: NonNullable<Project['clips'][number]['visual']>['crop'] | null;
      transitionIds: string[];
      embeddedAudio: 'unchanged' | 'replace' | 'mute';
      linkedAudioClipIds: string[];
    };
    source?: {
      before: Range;
      after: Range;
      availableThroughFrame: number | null;
    };
  };
  const steps: Step[] = [];
  for (const operation of edit.operations) {
    signal?.throwIfAborted();
    const { id } = operation;
    touched.add(id);
    if (operation.operation === 'caption') {
      if (
        operation.text === undefined &&
        operation.start === undefined &&
        operation.end === undefined
      )
        throw new VideoDefinitionError(
          'A caption edit requires text, start, or end.',
        );
      const matches = captions.filter((cue) => cue.id === id);
      if (matches.length !== 1)
        throw new VideoDefinitionError(`Expected one caption with ID '${id}'.`);
      const cue = matches[0]!;
      const before = frameRange(cue.start, cue.end, rate);
      const wordTimingsCleared =
        operation.text !== undefined &&
        operation.text !== cue.text &&
        !!cue.words?.length;
      if (operation.text !== undefined) cue.text = operation.text;
      if (operation.start !== undefined)
        cue.start = frameTime(operation.start, rate);
      if (operation.end !== undefined) cue.end = frameTime(operation.end, rate);
      if (wordTimingsCleared) delete cue.words;
      steps.push({
        ...operation,
        before,
        after: frameRange(cue.start, cue.end, rate),
        wordTimingsCleared,
      });
      continue;
    }
    const item = authored.get(id);
    const clip = current.get(id);
    if (!item || !clip)
      throw new VideoDefinitionError(`Unknown clip ID '${id}'.`);
    const oldEnd = clipTimelineEnd(clip);
    const before = frameRange(clip.timelineStart, oldEnd, rate);
    const asset = project.assets.find(({ id }) => id === clip.assetId);
    if (operation.operation === 'graphic') {
      if (asset?.metadata?.kind !== 'graphic')
        throw new VideoDefinitionError(
          `Clip '${id}' is not a graphic placement.`,
        );
      item.at = operation.at;
      clip.timelineStart = frameTime(operation.at, rate);
      steps.push({
        ...operation,
        before,
        after: frameRange(clip.timelineStart, clipTimelineEnd(clip), rate),
      });
      continue;
    }
    if (operation.operation === 'replace-source') {
      const track = project.tracks.find(({ id }) => id === clip.trackId);
      if (
        !('asset' in item) ||
        !asset ||
        asset.metadata?.kind !== 'video' ||
        track?.type !== 'video'
      )
        throw new VideoDefinitionError(
          `Clip '${id}' must be a timed picture clip on a video track.`,
        );
      const next = project.assets.find(({ id }) => id === operation.asset);
      if (next?.metadata?.kind !== 'video')
        throw new VideoDefinitionError(
          `Replacement asset '${operation.asset}' must be a declared timed video asset. Check the assets in the definition.`,
        );
      const sourceIn =
        typeof operation.sourceIn === 'number'
          ? frameTime(operation.sourceIn, rate)
          : operation.sourceIn;
      const sourceOut = addTimes(
        sourceIn,
        subtractTimes(clip.sourceOut, clip.sourceIn),
      );
      const changesSource =
        asset.id !== next.id || compareTimes(clip.sourceIn, sourceIn) !== 0;
      const audible =
        !clip.muted &&
        !track.muted &&
        (clip.volume ?? 1) > 0 &&
        (track.volume ?? 1) > 0 &&
        (!project.musicComparison?.candidates.some(
          ({ trackId }) => trackId === track.id,
        ) ||
          project.musicComparison.selected === track.id);
      const changesEmbedded =
        changesSource &&
        audible &&
        (asset.metadata.hasAudio || next.metadata.hasAudio);
      if (changesEmbedded && !operation.audio)
        throw new VideoDefinitionError(
          `Replacing '${id}' can change its embedded audio. Set audio to 'replace' or 'mute'.`,
        );
      if (
        operation.audio === 'replace' &&
        changesEmbedded &&
        !next.metadata.hasAudio
      )
        throw new VideoDefinitionError(
          `Replacement asset '${next.id}' has no audio stream. Set audio to 'mute'.`,
        );
      const transitionIds = (project.transitions ?? [])
        .filter((transition) => {
          const resolved = resolveTransition(transition, current, rate);
          return resolved.layers.some(({ clip }) => clip.id === id);
        })
        .map(({ id }) => id);
      for (const transition of transitionIds) touched.add(transition);
      const linkedAudioClipIds = [...current.values()]
        .filter(
          (other) =>
            other.assetId === asset.id &&
            project.tracks.some(
              ({ id, type }) => id === other.trackId && type === 'audio',
            ) &&
            compareTimes(other.timelineStart, oldEnd) < 0 &&
            compareTimes(clip.timelineStart, clipTimelineEnd(other)) < 0,
        )
        .map(({ id }) => id);

      item.asset = clip.assetId = next.id;
      item.sourceIn = clip.sourceIn = sourceIn;
      item.sourceOut = clip.sourceOut = sourceOut;
      if (operation.audio === 'mute') item.muted = clip.muted = true;
      steps.push({
        ...operation,
        before,
        after: before,
        replacement: {
          previousAsset: asset.id,
          sourceIn,
          sourceOut,
          sourceDuration: next.metadata.videoDuration ?? next.duration ?? null,
          sourceWindow: clip.visual?.sourceWindow ?? null,
          crop: clip.visual?.crop ?? null,
          transitionIds,
          embeddedAudio: operation.audio ?? 'unchanged',
          linkedAudioClipIds,
        },
      });
      continue;
    }
    if (operation.sourceIn === undefined && operation.sourceOut === undefined)
      throw new VideoDefinitionError(
        `Trim '${id}' requires sourceIn or sourceOut.`,
      );
    if (asset?.metadata?.kind !== 'video' && asset?.metadata?.kind !== 'audio')
      throw new VideoDefinitionError(
        `Trim '${id}' requires timed audio or video footage.`,
      );
    const originalSource = frameRange(clip.sourceIn, clip.sourceOut, rate);
    if (operation.sourceIn !== undefined)
      clip.sourceIn = frameTime(operation.sourceIn, rate);
    if (operation.sourceOut !== undefined)
      clip.sourceOut = frameTime(operation.sourceOut, rate);
    if (compareTimes(clip.sourceIn, clip.sourceOut) >= 0)
      throw new VideoDefinitionError(
        `Trim '${id}' must leave a nonempty source range.`,
      );
    const bound = media.get(id);
    const metadata = bound && plan.sourceMetadata.get(bound.path);
    const videoDuration = asset.metadata.videoDuration;
    const duration =
      bound && bound.assetId !== clip.assetId
        ? videoDuration
          ? videoDuration.numerator / videoDuration.denominator
          : asset.metadata.durationSeconds
        : metadata &&
          (bound.audio
            ? audioSourceDuration(metadata)
            : videoSourceDuration(metadata));

    const sourceLimit =
      duration && duration > 0
        ? projectFrame(
            {
              numerator: Math.round(duration * 1_000_000) + 1,
              denominator: 1_000_000,
            },
            rate,
            'floor',
          )
        : null;
    if (
      !clip.detachedAudio &&
      (!duration ||
        clip.sourceOut.numerator / clip.sourceOut.denominator >
          duration + 0.000001)
    )
      throw new VideoDefinitionError(
        sourceLimit === null
          ? `Cannot determine source availability for '${id}'.`
          : `Insufficient source footage for '${id}'. Last whole project-frame boundary is ${sourceLimit}.`,
      );
    item.sourceIn = operation.sourceIn ?? item.sourceIn;
    item.sourceOut = operation.sourceOut ?? item.sourceOut;
    const nextEnd = clipTimelineEnd(clip);
    const after = frameRange(clip.timelineStart, nextEnd, rate);
    let rippleFrames = 0;
    const moved: string[] = [];
    if (
      operation.placement === 'ripple' &&
      compareTimes(oldEnd, nextEnd) !== 0
    ) {
      rippleFrames =
        projectFrame(nextEnd, rate, 'exact') -
        projectFrame(oldEnd, rate, 'exact');
      if (definition.canvas.durationFrames !== undefined)
        definition.canvas.durationFrames += rippleFrames;
      for (const later of current.values()) {
        if (later.id === id || compareTimes(later.timelineStart, oldEnd) < 0)
          continue;
        later.timelineStart = relocate(later.timelineStart, rippleFrames, rate);
        authored.get(later.id)!.at = later.timelineStart;
        moved.push(later.id);
      }
      for (const cue of captions) {
        if (compareTimes(cue.start, oldEnd) < 0) continue;
        cue.start = relocate(cue.start, rippleFrames, rate);
        cue.end = relocate(cue.end, rippleFrames, rate);
        moved.push(cue.id);
      }
    }
    steps.push({
      ...operation,
      before,
      after,
      source: {
        before: originalSource,
        after: frameRange(clip.sourceIn, clip.sourceOut, rate),
        availableThroughFrame: sourceLimit,
      },
      rippleFrames,
      moved,
    });
  }
  const revision = parseVideoDefinition(definition);
  checkGraphicAudio(revision);
  const graphics = await compileVideoGraphics(
    video.path,
    revision,
    undefined,
    signal,
  );
  const compiled = await compileDefinition(
    { path: video.path, definition: revision, graphics },
    { signal },
  );
  if (compiled.layoutAssertions?.length) {
    const layout = await inspectVideoLayout(compiled, { signal });
    if (!layout.ok) throw new VideoLayoutError(layout);
  }
  const changed = describe(compiled.project, await compiled.resolveRender());
  const itemKey = ({ kind, id }: Item) => kind + ':' + id;
  const affected = changed.flatMap<{
    id: string;
    kind: Item['kind'];
    before: Item | null;
    after: Item | null;
    movementFrames: number | null;
  }>((after) => {
    const before = original.find((item) => itemKey(item) === itemKey(after));
    if (
      before &&
      !touched.has(after.id) &&
      before.startFrame === after.startFrame &&
      before.endFrame === after.endFrame
    )
      return [];
    return [
      {
        id: after.id,
        kind: after.kind,
        before: before ?? null,
        after,
        movementFrames: before ? after.startFrame - before.startFrame : null,
      },
    ];
  });
  for (const before of original) {
    if (
      touched.has(before.id) &&
      !changed.some((after) => itemKey(before) === itemKey(after))
    )
      affected.push({
        id: before.id,
        kind: before.kind,
        before,
        after: null,
        movementFrames: null,
      });
  }
  // Show adjacent boundaries and anything playing through either side of an edit.
  const neighbors = original.filter(
    (item) =>
      !affected.some(({ kind, id }) => kind === item.kind && id === item.id) &&
      steps.some(
        ({ before, after }) =>
          item.startFrame <= Math.max(before.endFrame, after.endFrame) &&
          item.endFrame >= Math.min(before.startFrame, after.startFrame),
      ),
  );
  const changedFrames = affected
    .flatMap(({ before, after }) => [before, after])
    .filter((range) => range !== null);
  const report = {
    ok: true,
    frameRate: rate,
    operations: steps,
    affected,
    neighbors,
    duration: {
      before: video.frameCount,
      after: compiled.frameCount,
      deltaFrames: compiled.frameCount - video.frameCount,
    },
    affectedRange: changedFrames.length
      ? {
          startFrame: Math.min(
            ...changedFrames.map(({ startFrame }) => startFrame),
          ),
          endFrame: Math.max(...changedFrames.map(({ endFrame }) => endFrame)),
        }
      : null,
  };
  if (!options.output) return report;
  const path = resolve(options.output);
  const parent = await realpath(dirname(path));
  if (
    parent !== dirname(video.path) ||
    !isVideoDefinitionPath(path) ||
    basename(path) === packageEntryName
  )
    throw new VideoDefinitionError(
      'Choose a new .video.ts file beside the input definition.',
    );
  const stage = await mkdtemp(join(parent, '.opencut-patch-'));
  try {
    const staged = join(stage, 'revision.video.ts');
    await writeFile(
      staged,
      'export default ' + JSON.stringify(revision, null, 2) + ';\n',
      { signal },
    );
    signal?.throwIfAborted();
    await link(staged, path);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  return { ...report, path };
}

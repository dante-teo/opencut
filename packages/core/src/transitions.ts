import { z } from 'zod';
import { clipTimelineEnd, clipSourceTime } from './clip-timing.js';
import { cubicBezier } from './motion-schema.js';
import type { Project, TimelineClip } from './project.js';
import { compareTimes, frameTime } from './time.js';
import type { FrameRate, RationalTime } from './time.js';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
export const transitionFrames = z.int().min(2);
const cross = {
  from: id,
  to: id,
  frames: transitionFrames,
};
export const transitionStyleSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('dip-to-color'),
    color: z.string().regex(/^#[0-9a-f]{6}$/i),
  }),
  z.strictObject({
    kind: z.enum(['wipe', 'slide', 'push']),
    direction: z.enum(['left', 'right', 'up', 'down']),
    easing: cubicBezier(z.number().min(0).max(1)).optional(),
  }),
  z.strictObject({
    kind: z.literal('zoom'),
    amount: z.number().min(0.01).max(0.5),
  }),
  z.strictObject({
    kind: z.literal('blur'),
    radius: z.number().min(1).max(64),
  }),
]);
const transitionKinds = [
  z.strictObject({
    kind: z.literal('cross-dissolve'),
    ...cross,
    style: transitionStyleSchema.optional(),
  }),
  z.strictObject({
    kind: z.enum(['fade-in', 'fade-out']),
    clipId: id,
    frames: transitionFrames,
  }),
] as const;
export const transitionInputSchema = z.discriminatedUnion(
  'kind',
  transitionKinds,
);
export const transitionSchema = z.discriminatedUnion('kind', [
  transitionKinds[0].extend({ id }),
  transitionKinds[1].extend({ id }),
]);
export type Transition = z.infer<typeof transitionSchema>;
export type TransitionInput = z.infer<typeof transitionInputSchema>;

export function transitionOwner(transition: Transition) {
  return transition.kind === 'cross-dissolve'
    ? transition.to
    : transition.clipId;
}

function boundaryFrame(time: RationalTime, rate: FrameRate) {
  const ticks = BigInt(time.numerator) * BigInt(rate.numerator);
  const size = BigInt(time.denominator) * BigInt(rate.denominator);
  const frame = ticks / size;
  if (ticks % size || frame > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError('The transition edge must be on a project frame.');
  return Number(frame);
}

export function resolveTransition<Clip extends TimelineClip>(
  transition: Transition,
  clips: ReadonlyMap<string, Clip>,
  rate: FrameRate,
) {
  const owner = clips.get(transitionOwner(transition));
  const from =
    transition.kind === 'cross-dissolve'
      ? clips.get(transition.from)
      : transition.kind === 'fade-out'
        ? owner
        : undefined;
  const to = transition.kind === 'fade-out' ? undefined : owner;
  if (!owner || (transition.kind === 'cross-dissolve' && !from))
    throw new RangeError('The transition references a missing clip.');
  if (
    from &&
    to &&
    (from.trackId !== to.trackId ||
      compareTimes(clipTimelineEnd(from), to.timelineStart) !== 0)
  )
    throw new RangeError(
      'Cross-dissolve requires adjacent clips on the same video track.',
    );
  const cut = boundaryFrame(
    transition.kind === 'fade-out'
      ? clipTimelineEnd(owner)
      : owner.timelineStart,
    rate,
  );
  const startFrame =
    cut -
    (transition.kind === 'fade-out'
      ? transition.frames
      : transition.kind === 'cross-dissolve'
        ? Math.floor(transition.frames / 2)
        : 0);
  const endFrame = startFrame + transition.frames;
  if (startFrame < 0 || !Number.isSafeInteger(endFrame))
    throw new RangeError(
      'The transition exceeds the supported timeline range.',
    );
  const start = frameTime(startFrame, rate);
  const end = frameTime(endFrame, rate);
  if (
    (from && compareTimes(start, from.timelineStart) < 0) ||
    (to && compareTimes(end, clipTimelineEnd(to)) > 0)
  )
    throw new RangeError(
      'The transition extends past a participating clip boundary.',
    );
  return {
    ...(transition.kind === 'cross-dissolve' &&
      transition.style && { style: transition.style }),
    id: transition.id,
    ownerId: owner.id,
    trackId: owner.trackId,
    layers: [
      ...(from ? [{ clip: from, direction: 'out' as const }] : []),
      ...(to ? [{ clip: to, direction: 'in' as const }] : []),
    ],
    start,
    end,
    startFrame,
    endFrame,
  };
}

// Match export's allowance for ffprobe's decimal seconds and saved microsecond bounds.
function exceedsVideoDuration(sourceOut: RationalTime, duration: RationalTime) {
  return (
    sourceOut.numerator / sourceOut.denominator >
    duration.numerator / duration.denominator + 0.000001
  );
}

function stillAsset(asset: Project['assets'][number] | undefined) {
  return (
    asset?.metadata?.kind === 'image' ||
    (asset?.metadata?.kind === 'graphic' && asset.duration === undefined)
  );
}

export function validateTransitions(
  project: Project,
  report: (path: string, code: string, message: string) => void,
  ids: Set<string>,
) {
  if (!project.transitions?.length) return;
  const clips = new Map(project.clips.map((clip) => [clip.id, clip]));
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  const videoTracks = new Set(
    project.tracks
      .filter((track) => track.type === 'video')
      .map((track) => track.id),
  );
  const windows = new Map<
    string,
    { startFrame: number; endFrame: number; index: number }[]
  >();
  project.transitions.forEach((transition, index) => {
    const path = `/transitions/${index}`;
    if (ids.has(transition.id))
      report(
        path + '/id',
        'duplicate_id',
        `ID '${transition.id}' is already in use.`,
      );
    ids.add(transition.id);
    try {
      const window = resolveTransition(
        transition,
        clips,
        project.settings.frameRate,
      );
      const { layers, start, end, startFrame, endFrame, trackId } = window;
      for (const { clip } of layers) {
        const asset = assets.get(clip.assetId ?? '');
        if (
          !videoTracks.has(clip.trackId) ||
          !asset?.mediaTypes.includes('video') ||
          (asset.metadata &&
            !['video', 'image', 'graphic'].includes(asset.metadata.kind))
        )
          throw new RangeError(
            'Transitions require photo, video, or graphic clips on a video track.',
          );
        const videoDuration = asset.metadata?.videoDuration;
        if (
          videoDuration &&
          exceedsVideoDuration(clip.sourceOut, videoDuration)
        )
          throw new RangeError(
            'The clip out point exceeds the known video stream duration.',
          );
      }
      if (layers.length === 2) {
        const from = layers[0]!.clip;
        const to = layers[1]!.clip;
        const outgoing = assets.get(from.assetId!);
        if (!stillAsset(outgoing)) {
          const videoDuration = outgoing?.metadata?.videoDuration;
          const limit = videoDuration ?? outgoing?.duration;
          if (!limit)
            throw new RangeError(
              `Cross-dissolve requires a known duration for outgoing clip '${from.id}'. Re-import the source to refresh its metadata or use a fade-out.`,
            );
          const sourceOut = clipSourceTime(from, end);
          if (
            videoDuration
              ? exceedsVideoDuration(sourceOut, videoDuration)
              : compareTimes(sourceOut, limit) > 0
          )
            throw new RangeError(
              `Outgoing clip '${from.id}' has insufficient source after its out point. Shorten the dissolve if there is spare footage, adjust the trim or use a fade-out.`,
            );
        }
        if (!stillAsset(assets.get(to.assetId!))) {
          try {
            clipSourceTime(to, start);
          } catch (error) {
            if (!(error instanceof RangeError)) throw error;
            throw new RangeError(
              `Incoming clip '${to.id}' needs usable source before its in point. Shorten the dissolve if there is spare footage, adjust the trim or use a fade-in.`,
            );
          }
        }
      }
      const entries = windows.get(trackId) ?? [];
      entries.push({ startFrame, endFrame, index });
      windows.set(trackId, entries);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      report(path, 'invalid_transition', error.message);
    }
  });
  for (const entries of windows.values()) {
    entries.sort((a, b) => a.startFrame - b.startFrame);
    let end = 0;
    for (const entry of entries) {
      if (entry.startFrame < end)
        report(
          `/transitions/${entry.index}`,
          'transition_overlap',
          'Transitions on the same track cannot overlap.',
        );
      end = Math.max(end, entry.endFrame);
    }
  }
}

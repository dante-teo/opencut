import {
  animatedProperties,
  clampVisualValue,
  ease,
  keyframeProgress,
  lerp,
  sampleKeyframes,
} from '@opencut/shared';
import type {
  AnimatedProperty,
  VisualKeyframe,
  VisualKeyframes,
} from '@opencut/shared';
import { randomUUID } from 'node:crypto';
import { link, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { z } from 'zod';
import {
  entityIdSchema,
  graphicPropsSchema,
  relativeMediaPathSchema,
} from './project.js';
import type { Project } from './project.js';
import { resolveTransition } from './transitions.js';
import { compareTimes, frameTime, subtractTimes } from './time.js';
import type { RationalTime } from './time.js';
import {
  isVideoDefinitionPath,
  parseVideoDefinition,
  VideoDefinitionError,
} from './video-definition.js';
import { packageEntryName } from './video-package-format.js';
import {
  graphicAnimationSchema,
  graphicFrameIndex,
  resolveGraphicProps,
  validateAnimationProps,
} from './video-graphics-contract.js';
import { compileDefinition } from './video-compiler.js';
import type { CompiledVideo } from './video-compiler.js';
import { compileVideoGraphics } from './video-graphics.js';
import { checkGraphicAudio } from './graphic-audio.js';

const frame = z.int().nonnegative();
const clip = entityIdSchema;
export const motionEditSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('import'),
    at: frame,
    duration: z.int().positive(),
    options: graphicAnimationSchema.omit({ version: true }),
    props: graphicPropsSchema,
    resources: z.record(entityIdSchema, relativeMediaPathSchema).optional(),
  }),
  z.strictObject({
    operation: z.literal('add'),
    asset: entityIdSchema,
    at: frame,
  }),
  z.strictObject({
    operation: z.literal('change'),
    clip,
    at: frame,
    sourceIn: frame,
    sourceOut: frame,
    props: graphicPropsSchema,
  }),
  z.strictObject({ operation: z.literal('duplicate'), clip, at: frame }),
  z.strictObject({ operation: z.literal('split'), clip, at: frame }),
]);
export type MotionEdit = z.input<typeof motionEditSchema>;

function animeAsset(
  asset: NonNullable<CompiledVideo['definition']['assets']>[string] | undefined,
) {
  return asset?.kind === 'graphic' &&
    asset.renderer === 'react' &&
    asset.animation
    ? asset
    : undefined;
}

interface TransitionSplitLimits {
  earliest?: number;
  latest?: number;
}

function transitionSplitLimits(project: Project) {
  const limits = new Map<string, TransitionSplitLimits>();
  if (!project.transitions?.length) return limits;
  const clips = new Map(project.clips.map((clip) => [clip.id, clip]));
  for (const transition of project.transitions) {
    const { layers, startFrame, endFrame } = resolveTransition(
      transition,
      clips,
      project.settings.frameRate,
    );
    for (const { clip, direction } of layers) {
      const limit = limits.get(clip.id) ?? {};
      if (direction === 'in')
        limit.earliest = Math.max(limit.earliest ?? 0, endFrame);
      else limit.latest = Math.min(limit.latest ?? Infinity, startFrame);
      limits.set(clip.id, limit);
    }
  }
  return limits;
}

/** Transition windows must stay on one side of a split. Edges are allowed. */
export function validateMotionSplit(
  video: CompiledVideo,
  clip: string,
  at: number,
) {
  const limit = transitionSplitLimits(video.project).get(clip);
  if (at < (limit?.earliest ?? 0) || at > (limit?.latest ?? Infinity))
    throw new VideoDefinitionError(
      'Split at or outside the edge of the clip’s transition.',
    );
}

export function describeMotionGraphics({ definition, project }: CompiledVideo) {
  const assets = Object.entries(definition.assets ?? {}).flatMap(
    ([id, asset]) => {
      const graphic = animeAsset(asset);
      return graphic
        ? [
            {
              id,
              name: graphic.name ?? id,
              duration: graphic.durationFrames,
              parameters: graphic.animation?.parameters ?? {},
              defaults: graphic.props ?? {},
            },
          ]
        : [];
    },
  );
  const known = new Set(assets.map(({ id }) => id));
  const rate = project.settings.frameRate;
  const limits = transitionSplitLimits(project);
  const clips = project.clips.flatMap(
    ({ id, assetId, timelineStart, sourceIn, sourceOut, graphicProps }) =>
      assetId && known.has(assetId)
        ? [
            {
              id,
              asset: assetId,
              at: graphicFrameIndex(timelineStart, rate),
              sourceIn: graphicFrameIndex(sourceIn, rate),
              sourceOut: graphicFrameIndex(sourceOut, rate),
              props: graphicProps ?? {},
              splitLimits: limits.get(id),
            },
          ]
        : [],
  );
  return { assets, clips };
}

export type MotionGraphics = ReturnType<typeof describeMotionGraphics>;

const zero = { numerator: 0, denominator: 1 };

function sliceKeys(
  property: AnimatedProperty,
  keys: VisualKeyframe[],
  from: RationalTime,
  to: RationalTime,
) {
  const positions = [
    from,
    ...keys
      .map(({ time }) => time)
      .filter(
        (time) => compareTimes(time, from) > 0 && compareTimes(time, to) < 0,
      ),
    to,
  ];
  return positions.map((time, i): VisualKeyframe => {
    const raw = sampleKeyframes(keys, time);
    const value = clampVisualValue(property, raw);
    const key: VisualKeyframe = {
      time: subtractTimes(time, from),
      value,
      easing: 'linear',
      ...(raw !== value && { curveValue: raw }),
    };
    const next = positions[i + 1];
    if (!next) return key;
    const index = keys.findLastIndex(
      (edge) => compareTimes(edge.time, time) <= 0,
    );
    const left = keys[index];
    const right = keys[index + 1];
    if (!left || !right) return key;
    const [start, end] = left.curve ?? [0, 1];
    const a = lerp(start, end, keyframeProgress(time, left.time, right.time));
    const b = lerp(start, end, keyframeProgress(next, left.time, right.time));
    if (b <= a) return key;
    const delta = ease(end, left.easing) - ease(start, left.easing);
    return {
      ...key,
      easing: left.easing,
      curve: [a, b],
      ...(typeof left.easing !== 'string' &&
        (left.curveAmplitude !== undefined || delta !== 0) && {
          curveAmplitude:
            left.curveAmplitude ??
            ((right.curveValue ?? right.value) -
              (left.curveValue ?? left.value)) /
              delta,
        }),
    };
  });
}

function sliceKeyframes(
  keyframes: VisualKeyframes | undefined,
  from: RationalTime,
  to: RationalTime,
) {
  if (!keyframes) return undefined;
  const result: VisualKeyframes = {};
  for (const property of animatedProperties) {
    const keys = keyframes[property];
    if (keys?.length) result[property] = sliceKeys(property, keys, from, to);
  }
  return result;
}

export function editMotionDefinition(
  video: CompiledVideo,
  input: MotionEdit,
  newId: string,
  source?: { path: string; name: string },
) {
  const edit = motionEditSchema.parse(input);
  const definition = structuredClone(video.definition);
  const { project } = video;
  const rate = project.settings.frameRate;
  let index = 0;
  for (const [trackIndex, track] of definition.tracks.entries()) {
    track.id ??= project.tracks[trackIndex]!.id;
    for (const clip of track.clips) {
      clip.id ??= project.clips[index]!.id;
      index++;
    }
  }
  const assets = (definition.assets ??= {});
  if (edit.operation === 'import' || edit.operation === 'add') {
    const assetId = edit.operation === 'add' ? edit.asset : newId + '-asset';
    if (edit.operation === 'import') {
      if (!source) throw new Error('Choose a TSX composition source.');
      assets[assetId] = {
        kind: 'graphic',
        renderer: 'react',
        name: source.name,
        path: source.path,
        durationFrames: edit.duration,
        animation: { version: 1, ...edit.options },
        props: edit.props,
        resources: edit.resources,
      };
      if (definition.version === 1) definition.version = 2;
    }
    const graphic = animeAsset(assets[assetId]);
    if (!graphic) throw new Error('Choose a registered Anime.js composition.');
    validateAnimationProps(
      graphic.animation?.parameters ?? {},
      graphic.props ?? {},
    );
    definition.tracks.push({
      type: 'video',
      id: newId + '-track',
      name: graphic.name ?? assetId,
      clips: [
        {
          id: newId,
          asset: assetId,
          at: edit.at,
          sourceOut: graphic.durationFrames,
        },
      ],
    });
  } else {
    const track = definition.tracks.find((track) =>
      track.clips.some(({ id }) => id === edit.clip),
    );
    if (track?.type !== 'video')
      throw new Error('Choose an Anime.js clip on the timeline.');
    const position = track.clips.findIndex(({ id }) => id === edit.clip);
    const item = track.clips[position];
    const graphic =
      item && 'asset' in item ? animeAsset(assets[item.asset]) : undefined;
    if (!item || !('asset' in item) || !graphic || item.sourceOut === undefined)
      throw new Error('Choose an Anime.js clip on the timeline.');
    const start = graphicFrameIndex(item.at, rate);
    const first = graphicFrameIndex(item.sourceIn ?? 0, rate);
    const end = graphicFrameIndex(item.sourceOut, rate);
    if (edit.operation === 'change') {
      if (
        edit.sourceIn < first ||
        edit.sourceOut > end ||
        edit.sourceIn >= edit.sourceOut
      )
        throw new Error(
          'Choose a nonempty trim inside the current source range.',
        );
      validateAnimationProps(
        graphic.animation?.parameters ?? {},
        resolveGraphicProps(graphic.props, edit.props),
      );
      track.clips[position] = {
        ...item,
        at: edit.at,
        sourceIn: edit.sourceIn,
        sourceOut: edit.sourceOut,
        props: edit.props,
        keyframes:
          first === edit.sourceIn && end === edit.sourceOut
            ? item.keyframes
            : sliceKeyframes(
                item.keyframes,
                frameTime(edit.sourceIn - first, rate),
                frameTime(edit.sourceOut - first, rate),
              ),
      };
    } else if (edit.operation === 'duplicate') {
      track.clips.push({ ...item, id: newId, at: edit.at });
    } else {
      const split = first + edit.at - start;
      if (split <= first || split >= end)
        throw new Error('Split inside the visible clip range.');
      validateMotionSplit(video, edit.clip, edit.at);
      const offset = frameTime(split - first, rate);
      track.clips.splice(
        position,
        1,
        {
          ...item,
          sourceOut: split,
          keyframes: sliceKeyframes(item.keyframes, zero, offset),
        },
        {
          ...item,
          id: newId,
          at: edit.at,
          sourceIn: split,
          keyframes: sliceKeyframes(
            item.keyframes,
            offset,
            frameTime(end - first, rate),
          ),
        },
      );
      for (const transition of definition.transitions ?? []) {
        if (
          transition.kind === 'cross-dissolve' &&
          transition.from === edit.clip
        )
          transition.from = newId;
        else if (
          transition.kind === 'fade-out' &&
          transition.clipId === edit.clip
        )
          transition.clipId = newId;
      }
    }
  }
  return parseVideoDefinition(definition);
}

/** Save a resolved revision alongside its input so local asset paths still resolve. */
export async function saveMotionDefinition(
  video: CompiledVideo,
  output: string,
  edit: MotionEdit,
  {
    component,
    signal,
  }: { component?: string | undefined; signal?: AbortSignal } = {},
) {
  signal?.throwIfAborted();
  const path = resolve(output);
  const folder = dirname(video.path);
  const parent = await realpath(dirname(path));
  if (
    !isVideoDefinitionPath(path) ||
    basename(path) === packageEntryName ||
    parent !== folder
  )
    throw new VideoDefinitionError(
      'Choose a new .video.ts file beside the open definition.',
    );
  let source: { path: string; name: string } | undefined;
  if (component) {
    const physical = await realpath(component);
    const file = relative(folder, physical);
    if (
      !/\.[jt]sx$/i.test(file) ||
      file === '..' ||
      file.startsWith('..' + sep) ||
      isAbsolute(file)
    )
      throw new VideoDefinitionError(
        'Choose a TSX or JSX component inside the definition directory.',
      );
    source = {
      path: file.split(sep).join('/'),
      name: basename(file).replace(/\.[jt]sx$/i, ''),
    };
  }
  let revision: ReturnType<typeof editMotionDefinition>;
  try {
    revision = editMotionDefinition(
      video,
      edit,
      'motion-' + randomUUID(),
      source,
    );
  } catch (cause) {
    throw new VideoDefinitionError(
      cause instanceof Error ? cause.message : String(cause),
      { cause },
    );
  }
  checkGraphicAudio(revision);
  const graphics = await compileVideoGraphics(
    video.path,
    revision,
    undefined,
    signal,
  );
  await compileDefinition(
    { path: video.path, definition: revision, graphics },
    { preview: true, signal },
  );
  const stage = await mkdtemp(join(parent, '.opencut-motion-'));
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
  return path;
}

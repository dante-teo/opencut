import { DEFAULT_TEXT_SIZE } from '@opencut/shared';
import { clipSourceTime } from './clip-timing.js';
import { effectiveSubtitleStyle } from './subtitles.js';
import type { TimelineClip } from './project.js';
import { frameTime, subtractTimes, compareTimes } from './time.js';
import type { RationalTime } from './time.js';
import { resolveTransition } from './transitions.js';
import { clipIdAt, generatedTrackId } from './video-compiler.js';
import {
  parseVideoDefinition,
  VideoDefinitionError,
} from './video-definition.js';
import type {
  ParsedVideoDefinition,
  VideoAssetDefinition,
  VideoDefinition,
} from './video-definition.js';

export interface Delivery4K60Options {
  /** IDs of video clips that need optical-flow interpolation. */
  interpolateShots?: readonly string[];
  /** Source asset IDs already at delivery cadence. They bypass recipe creation. */
  nativeSources?: readonly string[];
}

type AuthoredClip = ParsedVideoDefinition['tracks'][number]['clips'][number];
interface InterpolationShot {
  clip: Extract<AuthoredClip, { asset: string }>;
  asset: VideoAssetDefinition;
  source: TimelineClip;
  start: RationalTime;
  end: RationalTime;
}

/** Recompose a 16:9 or 9:16 definition on a 4K, 60 fps canvas. */
export function create4K60Delivery(
  approved: VideoDefinition,
  { interpolateShots = [], nativeSources = [] }: Delivery4K60Options = {},
): VideoDefinition {
  const definition = parseVideoDefinition(approved);
  const { canvas } = definition;
  const rate =
    typeof canvas.frameRate === 'number'
      ? { numerator: canvas.frameRate, denominator: 1 }
      : canvas.frameRate;
  const multiplier = (60 * rate.denominator) / rate.numerator;
  const portrait = canvas.height * 9 === canvas.width * 16;
  if (!portrait && canvas.width * 9 !== canvas.height * 16)
    throw new VideoDefinitionError(
      '4K60 delivery requires a 16:9 or 9:16 canvas.',
    );
  if (!Number.isSafeInteger(multiplier) || multiplier < 1)
    throw new VideoDefinitionError(
      '4K60 delivery requires a canvas frame rate that divides 60 so every cut stays on its approved time.',
    );
  const width = portrait ? 2160 : 3840;
  const height = portrait ? 3840 : 2160;
  const scale = width / canvas.width;
  const assets = (definition.assets ??= {});
  const native = new Set(nativeSources);
  for (const id of native) {
    const asset = Object.hasOwn(assets, id) && assets[id];
    if (!asset || asset.kind !== 'video' || asset.freezeFrame)
      throw new VideoDefinitionError(`Unknown timed video source '${id}'.`);
  }
  const pending = new Set(interpolateShots);
  const frameNumber = (value: number) => value * multiplier;
  const position = <T extends number | RationalTime | undefined>(value: T) =>
    typeof value === 'number' ? frameNumber(value) : value;
  const time = (value: number | RationalTime) =>
    typeof value === 'number' ? frameTime(value, rate) : value;
  const occurrences = new Map<string, number>();
  const clips = new Map<string, TimelineClip>();
  const selected = new Map<string, InterpolationShot>();
  const pixels = (value: number | undefined) =>
    value === undefined ? undefined : value * scale;
  const offset = (value: number) => Math.round(value * scale);
  const scaleStyle = (style: {
    fontSize?: number | undefined;
    stroke?: { width: number } | null | undefined;
    shadow?: { x: number; y: number; blur: number } | null | undefined;
    background?: { padding: number } | null | undefined;
  }) => {
    if (style.fontSize !== undefined) style.fontSize *= scale;
    if (style.stroke) style.stroke.width *= scale;
    if (style.shadow) {
      style.shadow.x *= scale;
      style.shadow.y *= scale;
      style.shadow.blur *= scale;
    }
    if (style.background) style.background.padding *= scale;
  };

  for (const track of definition.tracks) {
    const trackId = track.id ?? generatedTrackId(track, occurrences);
    track.id = trackId;
    for (const clip of track.clips) {
      const start = time(clip.at);
      const id = clip.id ?? clipIdAt(trackId, start);
      clip.id = id;
      const authoredOut = clip.sourceOut ?? clip.duration;
      if ('asset' in clip && authoredOut !== undefined) {
        const sourceIn = time(clip.sourceIn ?? 0);
        const sourceOut = time(authoredOut);
        const source = {
          id,
          trackId,
          timelineStart: start,
          sourceIn,
          sourceOut,
          speed: clip.speed,
        };
        clips.set(id, source);
        const asset = Object.hasOwn(assets, clip.asset) && assets[clip.asset];
        if (pending.delete(id)) {
          if (
            track.type !== 'video' ||
            clip.sourceOut === undefined ||
            !asset ||
            asset.kind !== 'video' ||
            asset.freezeFrame
          )
            throw new VideoDefinitionError(
              `Clip '${id}' must be a timed video shot to interpolate.`,
            );
          if (native.has(clip.asset))
            throw new VideoDefinitionError(
              `Clip '${id}' uses native source '${clip.asset}' and was also selected for interpolation.`,
            );
          if (asset.recipe?.some(({ type }) => type === 'beauty'))
            throw new VideoDefinitionError(
              `Clip '${id}' uses an asset-specific beauty recipe. Apply shot interpolation in that asset's recipe.`,
            );
          selected.set(id, {
            clip,
            asset,
            source,
            start: sourceIn,
            end: sourceOut,
          });
        }
      }
      clip.at = position(clip.at);
      clip.sourceIn = position(clip.sourceIn);
      clip.sourceOut = position(clip.sourceOut);
      clip.duration = position(clip.duration);
      if (typeof clip.fadeIn === 'number')
        clip.fadeIn = frameNumber(clip.fadeIn);
      if (typeof clip.fadeOut === 'number')
        clip.fadeOut = frameNumber(clip.fadeOut);
      if (clip.visual) {
        clip.visual.x = pixels(clip.visual.x);
        clip.visual.y = pixels(clip.visual.y);
      }
      for (const property of ['x', 'y'] as const) {
        for (const key of clip.keyframes?.[property] ?? []) {
          key.value *= scale;
          key.curveValue = pixels(key.curveValue);
          key.curveAmplitude = pixels(key.curveAmplitude);
        }
      }
      if ('text' in clip) {
        clip.text.fontSize ??= DEFAULT_TEXT_SIZE;
        clip.text.wrapWidth =
          clip.text.wrapWidth == null
            ? clip.text.wrapWidth
            : clip.text.wrapWidth * scale;
        scaleStyle(clip.text);
      }
    }
  }
  if (pending.size)
    throw new VideoDefinitionError(
      `Unknown interpolation shot IDs: ${[...pending].join(', ')}.`,
    );

  for (const transition of definition.transitions ?? []) {
    const targetFrames = frameNumber(transition.frames);
    if (transition.kind === 'cross-dissolve') {
      if (
        Math.floor(transition.frames / 2) * multiplier !==
        Math.floor(targetFrames / 2)
      )
        throw new VideoDefinitionError(
          `Transition '${transition.id}' needs an even frame count to preserve its cut window at 60 fps.`,
        );
      if (selected.has(transition.from) || selected.has(transition.to)) {
        const window = resolveTransition(transition, clips, rate);
        for (const { clip } of window.layers) {
          const range = selected.get(clip.id);
          if (!range) continue;
          const start = clipSourceTime(clip, window.start);
          const end = clipSourceTime(clip, window.end);
          if (compareTimes(start, range.start) < 0) range.start = start;
          if (compareTimes(end, range.end) > 0) range.end = end;
        }
      }
      if (transition.style?.kind === 'blur') transition.style.radius *= scale;
    }
    transition.frames = targetFrames;
  }
  const used = new Set([
    ...Object.keys(assets),
    ...clips.keys(),
    ...definition.tracks.map(({ id }) => id),
    ...(definition.transitions ?? []).map(({ id }) => id),
    ...(definition.markers ?? []).map(({ id }) => id),
  ]);
  for (const { clip, asset, source, start, end } of selected.values()) {
    const prefix = `${clip.asset}-4k60`;
    let assetId = prefix;
    for (let suffix = 2; used.has(assetId); suffix++)
      assetId = `${prefix}-${suffix}`;
    used.add(assetId);
    clip.asset = assetId;
    clip.sourceIn = subtractTimes(source.sourceIn, start);
    clip.sourceOut = subtractTimes(source.sourceOut, start);
    const recipe: NonNullable<VideoAssetDefinition['recipe']> = [
      ...(asset.recipe ?? []),
      {
        type: 'trim',
        clock: 'picture',
        start: start.numerator / start.denominator,
        end: end.numerator / end.denominator,
      },
      {
        type: 'interpolateFrames',
        numerator: 60,
        denominator: 1,
        sceneCuts: [],
        sceneThreshold: 8,
      },
    ];
    assets[assetId] = { ...asset, recipe };
  }
  for (const asset of Object.values(assets)) {
    if (asset.kind !== 'graphic') continue;
    const constrained =
      asset.renderer === 'three' ||
      ('motionBlur' in asset && !!asset.motionBlur);
    if (constrained) {
      asset.width ??= canvas.width;
      asset.height ??= canvas.height;
    } else {
      if (asset.width !== undefined) asset.width = offset(asset.width);
      if (asset.height !== undefined) asset.height = offset(asset.height);
      if (
        asset.renderer === 'scene' &&
        'children' in asset.scene &&
        scale !== 1
      ) {
        asset.scene.children = [
          {
            type: 'group',
            id: 'delivery-scale',
            origin: [0, 0],
            scaleX: scale,
            scaleY: scale,
            children: asset.scene.children,
          },
        ];
      }
    }
    if (asset.renderer !== 'svg')
      asset.durationFrames = frameNumber(asset.durationFrames);
    if (asset.renderer === 'react') {
      for (const range of asset.staticRanges ?? []) {
        range.startFrame = frameNumber(range.startFrame);
        range.endFrame = frameNumber(range.endFrame);
      }
    }
  }
  if (definition.subtitles) {
    const { style, cues } = definition.subtitles;
    const { fontSize, stroke, y } = effectiveSubtitleStyle({
      settings: { ...canvas, frameRate: rate },
      subtitles: definition.subtitles,
    });
    Object.assign(style, { fontSize, stroke, y });
    for (const current of [
      style,
      ...cues.flatMap((cue) => (cue.style ? [cue.style] : [])),
    ]) {
      current.x = pixels(current.x);
      current.y = pixels(current.y);
      scaleStyle(current);
    }
  }
  for (const marker of definition.markers ?? [])
    marker.frame = frameNumber(marker.frame);
  for (const group of definition.visualGroups ?? []) {
    if (group.x !== undefined) group.x = offset(group.x);
    if (group.y !== undefined) group.y = offset(group.y);
    group.blur = pixels(group.blur);
    group.backdropBlur = pixels(group.backdropBlur);
    const clip = group.clip;
    if (clip) {
      clip.width = offset(clip.x + clip.width) - offset(clip.x);
      clip.height = offset(clip.y + clip.height) - offset(clip.y);
      clip.x = offset(clip.x);
      clip.y = offset(clip.y);
    }
  }
  for (const assertion of definition.layoutAssertions ?? []) {
    assertion.tolerance *= scale;
    if (assertion.kind === 'bottom-center') assertion.bottom *= scale;
    if (assertion.kind === 'upper-left') {
      assertion.left *= scale;
      assertion.top *= scale;
    }
    if (assertion.kind === 'inside' && assertion.insets) {
      assertion.insets.top *= scale;
      assertion.insets.right *= scale;
      assertion.insets.bottom *= scale;
      assertion.insets.left *= scale;
    }
  }
  definition.canvas = {
    ...canvas,
    width,
    height,
    frameRate: 60,
    durationFrames: position(canvas.durationFrames),
  };
  return parseVideoDefinition(definition);
}

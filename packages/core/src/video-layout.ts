import {
  orientedSource,
  rasterizeTextLayer,
  resolveSourceWindow,
} from '@opencut/media';
import type { VisualTimelineClip } from '@opencut/media';
import {
  evaluateVisual,
  transitionLayerGeometry,
  transitionProgress,
  usesLayerTransform,
  visualGeometry,
} from '@opencut/shared';
import type { TransitionRamp, VisualGroup } from '@opencut/shared';
import type { ParsedLayoutAssertion } from './layout-assertion-schema.js';
import type { CompiledVideo } from './video-compiler.js';
import { frameTime } from './time.js';
import { clipPolygon, fittedOutline } from './timeline-framing.js';
import type { Bounds, Point } from './timeline-framing.js';

type Plan = Awaited<ReturnType<CompiledVideo['resolveRender']>>;
type TransitionLayer = NonNullable<
  Plan['visualTransitions']
>[number]['layers'][number];
interface Layout {
  bounds: Bounds | null;
  panel?: Bounds;
  glyphs?: Bounds;
  outline?: Point[];
  reason?: string;
  transitionHidden?: boolean;
}

const corners = ({ left, top, right, bottom }: Bounds): Point[] => [
  { x: left, y: top },
  { x: right, y: top },
  { x: right, y: bottom },
  { x: left, y: bottom },
];

function bounds(points: Point[]): Bounds {
  return {
    left: Math.min(...points.map(({ x }) => x)),
    right: Math.max(...points.map(({ x }) => x)),
    top: Math.min(...points.map(({ y }) => y)),
    bottom: Math.max(...points.map(({ y }) => y)),
  };
}

function place(x: number, y: number, scale: number, angle: number) {
  const cos = Math.cos(angle) * scale;
  const sin = Math.sin(angle) * scale;
  return (p: Point) => ({
    x: x + p.x * cos - p.y * sin,
    y: y + p.x * sin + p.y * cos,
  });
}

function visible(
  box: Bounds | undefined,
  width: number,
  height: number,
): box is Bounds {
  return (
    !!box &&
    box.left < width &&
    box.top < height &&
    box.right > 0 &&
    box.bottom > 0
  );
}

async function resolveLayout(
  plan: Plan,
  clip: VisualTimelineClip,
  frame: number,
  groups: ReadonlyMap<string, VisualGroup>,
  signal?: AbortSignal,
  ramp?: TransitionRamp,
): Promise<Layout> {
  const { width, height, frameRate } = plan;
  const visual = evaluateVisual(
    clip,
    clip.animation?.keyframes,
    frameTime(frame, frameRate),
    clip.animation?.start,
  );
  const group = groups.get(clip.trackId ?? '');
  const canvas = { left: 0, top: 0, right: width, bottom: height };
  const rampGeometry =
    ramp &&
    transitionLayerGeometry(
      transitionProgress(frame, ramp),
      ramp,
      width,
      height,
    );
  if (rampGeometry?.alpha === 0)
    return { bounds: null, transitionHidden: true };
  if (visual.opacity === 0 || group?.opacity === 0)
    return { bounds: null, reason: 'invisible' };
  if (group && (group.matte || group.blur))
    return { bounds: null, reason: 'unsupported-group-geometry' };
  function position(points: Point[], applyRamp = true) {
    if (applyRamp && rampGeometry) {
      const { x, y, scale, clip } = rampGeometry;
      const transform = place(
        x + ((1 - scale) * width) / 2,
        y + ((1 - scale) * height) / 2,
        scale,
        0,
      );
      points = clipPolygon(points.map(transform), clip);
    }
    if (!group) return points;
    const crop = group.clip;
    points = clipPolygon(
      points,
      crop
        ? {
            left: crop.x,
            top: crop.y,
            right: crop.x + crop.width,
            bottom: crop.y + crop.height,
          }
        : canvas,
    );
    const w = Math.max(1, Math.round(width * (group.scale ?? 1)));
    const h = Math.max(1, Math.round(height * (group.scale ?? 1)));
    const offsetX = Math.trunc((group.x ?? 0) + Math.round((width - w) / 2));
    const offsetY = Math.trunc((group.y ?? 0) + Math.round((height - h) / 2));
    const transform = place(
      w / 2,
      h / 2,
      1,
      ((group.rotation ?? 0) * Math.PI) / 180,
    );
    const rotated = points.map(({ x, y }) =>
      transform({ x: (x * w) / width - w / 2, y: (y * h) / height - h / 2 }),
    );
    return clipPolygon(rotated, { left: 0, top: 0, right: w, bottom: h }).map(
      ({ x, y }) => ({ x: x + offsetX, y: y + offsetY }),
    );
  }
  if (clip.text) {
    const raster = await rasterizeTextLayer(
      width,
      height,
      clip.text,
      {},
      signal,
      true,
    );
    const anchorX = width / 2 + (visual.x ?? 0);
    const anchorY = height / 2 + (visual.y ?? 0);
    const scale = visual.scale ?? 1;
    const rotation = Math.PI / 180;
    const text = place(0, 0, 1, (clip.text.rotation ?? 0) * rotation);
    const layer = place(
      anchorX,
      anchorY,
      scale,
      (visual.rotation ?? 0) * rotation,
    );
    const box = (rectangles: readonly Bounds[]) => {
      const points = rectangles.flatMap((rectangle) =>
        position(corners(rectangle).map((point) => layer(text(point)))),
      );
      return points.length ? bounds(points) : undefined;
    };
    const panel = raster.panel && box([raster.panel]);
    const glyphs = raster.ink && box(raster.ink);
    const canvasPoints =
      clip.text.canvasFill &&
      raster.png &&
      !/^transparent$|^#[\da-f]{6}00$/i.test(clip.text.canvasFill)
        ? position(
            corners(canvas).map((point) =>
              usesLayerTransform(clip.rotation, !!clip.animation)
                ? layer({ x: point.x - width / 2, y: point.y - height / 2 })
                : point,
            ),
          )
        : undefined;
    const rect = canvasPoints?.length
      ? bounds(canvasPoints)
      : (panel ?? glyphs);
    return {
      bounds: visible(rect, width, height) ? rect : null,
      ...(panel && { panel }),
      ...(glyphs && { glyphs }),
    };
  }
  const source = plan.sourceMetadata.get(clip.path)?.video;
  const size = clip.graphic ?? (source && orientedSource(source));
  if (!size) return { bounds: null, reason: 'missing-source-geometry' };
  const region = resolveSourceWindow(size, clip.clipId, clip.sourceWindow);
  const sar = 'sar' in size ? size.sar : 1;
  const geometry = visualGeometry(
    width,
    height,
    region.width * sar,
    region.height,
    visual,
    clip.animation ? 'subpixel' : 'even',
  );
  const fitted = fittedOutline(geometry);
  const outline = position(fitted);
  const rect = outline.length >= 3 ? bounds(outline) : undefined;
  if (visible(rect, width, height)) return { bounds: rect, outline };
  // Skip a layer only when the transition itself put it out of view.
  if (rampGeometry) {
    const authored = position(fitted, false);
    if (authored.length >= 3 && visible(bounds(authored), width, height))
      return { bounds: null, transitionHidden: true };
  }
  return { bounds: null };
}

const centerX = ({ left, right }: Bounds) => (left + right) / 2;
const centerY = ({ top, bottom }: Bounds) => (top + bottom) / 2;
const move = ({ left, right, top, bottom }: Bounds, x: number, y: number) => ({
  left: left + x,
  right: right + x,
  top: top + y,
  bottom: bottom + y,
});

/** Maximum perpendicular distance of any canvas corner outside the fitted polygon. */
function uncovered(canvas: Bounds, outline: Point[]) {
  return Math.max(
    0,
    ...corners(canvas).flatMap((point) =>
      outline.map(({ x, y }, index) => {
        const next = outline[(index + 1) % outline.length]!;
        const dx = next.x - x;
        const dy = next.y - y;
        const length = Math.hypot(dx, dy);
        return length > 0
          ? (dy * (point.x - x) - dx * (point.y - y)) / length
          : 0;
      }),
    ),
  );
}

type Measurement = {
  expectedBounds: Bounds | null;
  actualBounds: Bounds | null;
  deviationPixels: number | null;
  referenceBounds?: Bounds;
  reason?: string;
};

const missingSegment = {
  expectedBounds: null,
  actualBounds: null,
  deviationPixels: null,
  reason: 'no-matching-visible-segment',
};

function measure(
  assertion: ParsedLayoutAssertion,
  layout: Layout,
  reference: Layout,
): Measurement {
  const actual =
    assertion.kind === 'glyphs-centered'
      ? (layout.glyphs ?? null)
      : layout.bounds;
  const expected =
    assertion.kind === 'glyphs-centered'
      ? (layout.panel ?? null)
      : reference.bounds;
  if (!actual || !expected || !layout.bounds)
    return {
      actualBounds: actual,
      expectedBounds: expected,
      deviationPixels: null,
      reason:
        layout.reason ??
        reference.reason ??
        (assertion.kind === 'glyphs-centered'
          ? 'missing-panel-or-glyphs'
          : 'invisible'),
    };
  let box = expected;
  let deviation: number;
  switch (assertion.kind) {
    case 'covers-canvas':
      if (!layout.outline)
        return {
          actualBounds: actual,
          expectedBounds: expected,
          deviationPixels: null,
          reason: 'coverage-requires-media-or-graphic',
        };
      deviation = uncovered(expected, layout.outline);
      break;
    case 'inside': {
      const inset = assertion.insets;
      box = {
        left: expected.left + (inset?.left ?? 0),
        top: expected.top + (inset?.top ?? 0),
        right: expected.right - (inset?.right ?? 0),
        bottom: expected.bottom - (inset?.bottom ?? 0),
      };
      if (box.left > box.right || box.top > box.bottom)
        return {
          actualBounds: actual,
          expectedBounds: box,
          deviationPixels: null,
          reason: 'insets-exceed-reference-bounds',
        };
      deviation = Math.max(
        0,
        box.left - actual.left,
        box.top - actual.top,
        actual.right - box.right,
        actual.bottom - box.bottom,
      );
      break;
    }
    default: {
      const dx =
        assertion.kind === 'upper-left'
          ? expected.left + assertion.left - actual.left
          : centerX(expected) - centerX(actual);
      const dy =
        assertion.kind === 'bottom-center'
          ? expected.bottom - assertion.bottom - actual.bottom
          : assertion.kind === 'upper-left'
            ? expected.top + assertion.top - actual.top
            : centerY(expected) - centerY(actual);
      box = move(actual, dx, dy);
      deviation = Math.max(Math.abs(dx), Math.abs(dy));
    }
  }
  return {
    actualBounds: actual,
    expectedBounds: box,
    deviationPixels: deviation,
    ...(assertion.kind === 'glyphs-centered' && { referenceBounds: expected }),
  };
}

export interface LayoutCheck extends Measurement {
  assertionId: string;
  objectId: string | null;
  frame: number | null;
  framesChecked: number;
  tolerancePixels: number;
  required: boolean;
  passed: boolean;
}

/** Check every active project frame and report the worst frame per resolved segment. */
export async function inspectVideoLayout(
  video: CompiledVideo,
  options: { burnSubtitles?: boolean; signal?: AbortSignal | undefined } = {},
) {
  const { signal, burnSubtitles = true } = options;
  const checks: LayoutCheck[] = [];
  const assertions = video.layoutAssertions;
  if (!assertions?.length) return { ok: true, checks };
  const plan = await video.resolveRender();
  const canvas = {
    bounds: { left: 0, top: 0, right: plan.width, bottom: plan.height },
  };
  const clips = plan.visualClips.filter(
    (clip) => burnSubtitles || !clip.subtitle,
  );
  const tracks = new Map(
    video.project.clips.map(({ id, trackId }) => [id, trackId] as const),
  );
  const groups = new Map(
    plan.visualGroups?.flatMap((group) =>
      group.tracks.map((track) => [track, group] as const),
    ),
  );
  const transitionRanges = new Map<string, TransitionLayer[]>();
  for (const transition of plan.visualTransitions ?? []) {
    for (const layer of transition.layers) {
      const ranges = transitionRanges.get(layer.clipId) ?? [];
      ranges.push(layer);
      transitionRanges.set(layer.clipId, ranges);
    }
  }
  const active = (clip: VisualTimelineClip, frame: number) =>
    frame >= clip.timelineStartFrame &&
    frame < clip.timelineStartFrame + clip.frameCount;
  const objectId = (clip: VisualTimelineClip) =>
    clip.subtitleCueId ?? clip.clipId;
  const staticLayouts = new Map<VisualTimelineClip, Promise<Layout>>();
  const transitionAt = (clip: VisualTimelineClip, frame: number) =>
    transitionRanges.get(clip.clipId)?.find((layer) => active(layer, frame));
  function resolve(clip: VisualTimelineClip, frame: number): Promise<Layout> {
    const transition = transitionAt(clip, frame);
    if (transition)
      return resolveLayout(
        plan,
        transition,
        frame,
        groups,
        signal,
        transition.ramp,
      );
    if (clip.animation) return resolveLayout(plan, clip, frame, groups, signal);
    let layout = staticLayouts.get(clip);
    if (!layout) {
      layout = resolveLayout(plan, clip, frame, groups, signal);
      staticLayouts.set(clip, layout);
    }
    return layout;
  }
  for (const assertion of assertions) {
    signal?.throwIfAborted();
    const { target, required, tolerance, id } = assertion;
    const selected = clips.filter((clip) =>
      'clip' in target
        ? objectId(clip) === target.clip
        : 'track' in target
          ? tracks.get(clip.clipId) === target.track
          : clip.subtitle,
    );
    const references =
      'against' in assertion && assertion.against !== undefined
        ? clips.filter((clip) => objectId(clip) === assertion.against)
        : null;
    const defaults = { assertionId: id, required, tolerancePixels: tolerance };
    if (!selected.length) {
      checks.push({
        ...defaults,
        objectId:
          'clip' in target
            ? target.clip
            : 'track' in target
              ? target.track
              : null,
        frame: null,
        framesChecked: 0,
        passed: false,
        ...missingSegment,
      });
      continue;
    }
    for (const clip of selected) {
      let worst: { frame: number; result: Measurement } | undefined;
      let framesChecked = 0;
      const transitions = transitionRanges.get(clip.clipId) ?? [];
      const start = Math.min(
        clip.timelineStartFrame,
        ...transitions.map(({ ramp }) => ramp.startFrame),
      );
      const end = Math.min(
        plan.frameCount,
        Math.max(
          clip.timelineStartFrame + clip.frameCount,
          ...transitions.map(({ ramp }) => ramp.endFrame),
        ),
      );
      for (let frame = start; frame < end; frame++) {
        signal?.throwIfAborted();
        if (!active(clip, frame) && !transitionAt(clip, frame)) continue;
        const layout = await resolve(clip, frame);
        if (layout.transitionHidden) continue;
        const reference = references?.find(
          (clip) => active(clip, frame) || transitionAt(clip, frame),
        );
        const against = reference
          ? await resolve(reference, frame)
          : references
            ? { bounds: null, reason: 'reference-not-visible' }
            : canvas;
        const result = measure(assertion, layout, against);
        if (
          !worst ||
          (result.deviationPixels ?? Infinity) >
            (worst.result.deviationPixels ?? Infinity)
        )
          worst = { frame, result };
        framesChecked++;
      }
      checks.push({
        ...defaults,
        objectId: objectId(clip),
        frame: worst?.frame ?? null,
        framesChecked,
        passed:
          worst?.result.deviationPixels != null &&
          worst.result.deviationPixels <= tolerance + 1e-9,
        ...(worst?.result ?? missingSegment),
      });
    }
  }
  return {
    ok: checks.every(({ required, passed }) => !required || passed),
    checks,
  };
}

export class VideoLayoutError extends Error {
  override name = 'VideoLayoutError';
  readonly code = 'LAYOUT_ASSERTION_FAILED';

  constructor(readonly layout: Awaited<ReturnType<typeof inspectVideoLayout>>) {
    super('Required video layout assertions failed.');
  }
}

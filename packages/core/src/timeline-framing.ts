import {
  orientedSource,
  resolveSourceWindow,
  SourceChangedError,
} from '@opencut/media';
import { dirname, resolve } from 'node:path';
import { visualGeometry } from '@opencut/shared';
import type { CompiledVideo } from './video-compiler.js';
import type { inspectTimeline } from './inspection.js';
import { fingerprintFile } from './video-integrity.js';
import { originalRecipeTime } from './video-recipe.js';
import { videoInputIdentity } from './video-input.js';

export interface Point {
  x: number;
  y: number;
}

export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function clipEdge(
  points: Point[],
  axis: keyof Point,
  limit: number,
  inside: (v: number, limit: number) => boolean,
) {
  const out: Point[] = [];
  for (const [i, a] of points.entries()) {
    const b = points[(i + 1) % points.length]!;
    const aIn = inside(a[axis], limit);
    const bIn = inside(b[axis], limit);
    if (aIn) out.push(a);
    if (aIn !== bIn) {
      const t = (limit - a[axis]) / (b[axis] - a[axis]);
      out.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
    }
  }
  return out;
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

export function clipPolygon(points: Point[], area: Bounds) {
  let visible = clipEdge(points, 'x', area.left, (v, l) => v >= l);
  visible = clipEdge(visible, 'x', area.right, (v, l) => v <= l);
  visible = clipEdge(visible, 'y', area.top, (v, l) => v >= l);
  return clipEdge(visible, 'y', area.bottom, (v, l) => v <= l);
}

export function fittedOutline(geometry: ReturnType<typeof visualGeometry>) {
  const { x, y, layerWidth, layerHeight, angle, centerX, centerY } = geometry;
  const { left = 0, right = 0, top = 0, bottom = 0 } = geometry.crop ?? {};
  const x0 = x + layerWidth * left;
  const x1 = x + layerWidth * (1 - right);
  const y0 = y + layerHeight * top;
  const y1 = y + layerHeight * (1 - bottom);
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ].map((p) => ({
    x: centerX + (p.x - centerX) * cosine - (p.y - centerY) * sine,
    y: centerY + (p.x - centerX) * sine + (p.y - centerY) * cosine,
  }));
}

export async function inspectTimelineFraming(
  video: CompiledVideo,
  report: ReturnType<typeof inspectTimeline>,
  signal?: AbortSignal,
) {
  const plan = await video.resolveRender();
  const { width, height } = plan;
  const byId = new Map(plan.visualClips.map((clip) => [clip.clipId, clip]));
  const resolved = new Map(
    report.visualClips.flatMap((clip) => {
      const layer = byId.get(clip.id);
      if (!layer?.path || layer.graphic) return [];
      const source = plan.sourceMetadata.get(layer.path)?.video;
      if (!source) return [];
      const oriented = orientedSource(source);
      if (!oriented.width || !oriented.height) return [];
      const sourceWindow = resolveSourceWindow(
        oriented,
        clip.id,
        clip.visual.sourceWindow,
      );
      const g = visualGeometry(
        width,
        height,
        sourceWindow.width * oriented.sar,
        sourceWindow.height,
        clip.visual,
        clip.keyframes ? 'subpixel' : 'even',
      );
      const cosine = Math.cos(g.angle);
      const sine = Math.sin(g.angle);
      const corners = fittedOutline(g);
      const xs = corners.map(({ x }) => x);
      const ys = corners.map(({ y }) => y);
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      const destinationBounds = {
        x: round(minX),
        y: round(minY),
        width: round(Math.max(...xs) - minX),
        height: round(Math.max(...ys) - minY),
      };
      const visible =
        g.opacity > 0
          ? clipPolygon(corners, {
              left: 0,
              top: 0,
              right: width,
              bottom: height,
            })
          : [];
      const polygon = visible.map(({ x, y }) => {
        const ux =
          g.centerX + (x - g.centerX) * cosine + (y - g.centerY) * sine;
        const uy =
          g.centerY - (x - g.centerX) * sine + (y - g.centerY) * cosine;
        return {
          x: round(
            sourceWindow.x +
              (sourceWindow.width * (ux - g.x + g.cropX)) / g.scaledWidth,
          ),
          y: round(
            sourceWindow.y +
              (sourceWindow.height * (uy - g.y + g.cropY)) / g.scaledHeight,
          ),
        };
      });
      const area = polygon.reduce((sum, p, i) => {
        const q = polygon[(i + 1) % polygon.length]!;
        return sum + p.x * q.y - p.y * q.x;
      }, 0);
      return [
        [
          clip.id,
          {
            sourceWindow,
            destinationBounds,
            visibleSourceRegion: { polygon: Math.abs(area) > 0 ? polygon : [] },
          },
        ] as const,
      ];
    }),
  );
  const assetByClip = new Map(
    video.project.clips.map(({ id, assetId }) => [id, assetId]),
  );
  const pathByAsset = new Map<string, string>();
  for (const { clipId, path } of [...plan.visualClips, ...plan.audioClips]) {
    const assetId = assetByClip.get(clipId);
    if (assetId && path && !pathByAsset.has(assetId))
      pathByAsset.set(assetId, path);
  }
  const recipes = new Map(
    video.recipes.map((recipe) => [recipe.assetId, recipe]),
  );
  const directory = dirname(video.path);
  const sources = new Map(
    await Promise.all(
      [
        ...new Set(
          [...report.activeClips, ...report.visualClips].flatMap(
            ({ assetId }) => (assetId ? [assetId] : []),
          ),
        ),
      ].map(async (id) => {
        const asset = video.definition.assets?.[id];
        if (!asset || asset.kind === 'graphic') return [id, null] as const;
        const originalPath = resolve(directory, asset.path);
        const original = await fingerprintFile(originalPath, signal);
        const expected = video.sourceIdentity(originalPath);
        if (
          (expected && expected !== original.identity) ||
          original.identity !== videoInputIdentity(originalPath)
        )
          throw new SourceChangedError(
            originalPath,
            'timeline source inspection',
            expected ?? original.identity,
          );
        const processedPath = pathByAsset.get(id) ?? null;
        const metadata =
          processedPath && plan.sourceMetadata.get(processedPath);
        const steps = recipes.get(id)?.steps ?? [];
        return [
          id,
          {
            originalPath,
            fingerprint: { sha256: original.sha256, bytes: original.bytes },
            processedPath,
            metadata: metadata
              ? { video: metadata.video, audio: metadata.audio }
              : null,
            steps,
            sampleProvenance: {
              status: 'unavailable',
              reason: steps.length
                ? 'This recipe does not expose a source sample map.'
                : 'Inspection does not decode the source sample.',
            },
          },
        ] as const;
      }),
    ),
  );
  const annotate = (clip: (typeof report.visualClips)[number]) => {
    const framing = resolved.get(clip.id);
    const source = clip.assetId ? sources.get(clip.assetId) : undefined;
    return {
      ...clip,
      ...(framing && { framing }),
      ...(source && {
        source: {
          ...source,
          sourceTime: clip.sourceTime,
          originalSourceTime: originalRecipeTime(
            clip.sourceTime,
            clip.assetId ? recipes.get(clip.assetId) : undefined,
          ),
        },
      }),
    };
  };
  return {
    ...report,
    activeClips: report.activeClips.map(annotate),
    visualClips: report.visualClips.map(annotate),
  };
}

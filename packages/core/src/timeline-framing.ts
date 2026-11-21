import { orientedSource, resolveSourceWindow } from '@opencut/media';
import { visualGeometry } from '@opencut/shared';
import type { CompiledVideo } from './video-compiler.js';
import type { inspectTimeline } from './inspection.js';

interface Point {
  x: number;
  y: number;
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

export async function inspectTimelineFraming(
  video: CompiledVideo,
  report: ReturnType<typeof inspectTimeline>,
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
      const { left = 0, right = 0, top = 0, bottom = 0 } = g.crop ?? {};
      const x0 = g.x + g.layerWidth * left;
      const x1 = g.x + g.layerWidth * (1 - right);
      const y0 = g.y + g.layerHeight * top;
      const y1 = g.y + g.layerHeight * (1 - bottom);
      const cosine = Math.cos(g.angle);
      const sine = Math.sin(g.angle);
      const corners = [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
      ].map(([x, y]) => ({
        x: g.centerX + (x! - g.centerX) * cosine - (y! - g.centerY) * sine,
        y: g.centerY + (x! - g.centerX) * sine + (y! - g.centerY) * cosine,
      }));
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
      let visible = g.opacity > 0 ? corners : [];
      visible = clipEdge(visible, 'x', 0, (v, l) => v >= l);
      visible = clipEdge(visible, 'x', width, (v, l) => v <= l);
      visible = clipEdge(visible, 'y', 0, (v, l) => v >= l);
      visible = clipEdge(visible, 'y', height, (v, l) => v <= l);
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
  const annotate = (clip: (typeof report.visualClips)[number]) => {
    const framing = resolved.get(clip.id);
    return framing ? { ...clip, framing } : clip;
  };
  return {
    ...report,
    activeClips: report.activeClips.map(annotate),
    visualClips: report.visualClips.map(annotate),
  };
}

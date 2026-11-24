import { readFile } from 'node:fs/promises';
import type { GraphicAudioAnalysis, GraphicAudioSample } from '@opencut/shared';
import type {
  GraphicTemplate,
  ReactGraphicBundle,
} from '@opencut/graphics/renderer';
import { MediaError } from './process.js';
import type { StaticSvgBundle } from './static-svg.js';
import { LRUCache } from 'lru-cache';
import { trackRenderProcess } from './render-budget.js';

export type { BuiltinGraphic } from '@opencut/graphics/renderer';

export type GraphicBundle =
  | (ReactGraphicBundle & { renderer: 'react' })
  | (StaticSvgBundle & { renderer: 'svg' });

async function graphicsAdapter() {
  try {
    return await import('@opencut/graphics/renderer');
  } catch (cause) {
    throw new MediaError(
      'React graphics require the optional OpenCut graphics runtime.',
      { cause },
    );
  }
}

export async function compileReactGraphic(
  ...args: Parameters<
    typeof import('@opencut/graphics/renderer').compileReactGraphic
  >
) {
  return (await graphicsAdapter()).compileReactGraphic(...args);
}

export async function compileStaticSvg(
  ...args: Parameters<typeof import('./static-svg.js').compileStaticSvg>
) {
  return (await import('./static-svg.js')).compileStaticSvg(...args);
}

export async function validateGraphicTemplate(
  template: GraphicTemplate,
  props: unknown,
) {
  (await graphicsAdapter()).parseTemplateProps(template, props);
}

export async function inspectGraphicsRuntime() {
  return (await graphicsAdapter()).graphicsRuntime();
}

export interface GraphicLayer {
  key: string;
  bundleKey: string;
  width: number;
  height: number;
  durationFrames?: number;
  staticRanges?: readonly { startFrame: number; endFrame: number }[];
  props?: Record<string, unknown>;
  sampling?: 'exact';
  audioAnalysis?: GraphicAudioAnalysis;
  mediaFrames?: Readonly<
    Record<
      string,
      {
        path: string;
        identity: string;
        offset?: { numerator: number; denominator: number } | undefined;
      }
    >
  >;
  motionBlur?: { samples: number; shutterAngle: number };
}

const frames = new LRUCache<string, Buffer>({
  maxSize: 32 * 1024 * 1024,
  sizeCalculation: (frame) => frame.length,
});

export function openGraphicsRenderer() {
  let font: Promise<Buffer> | undefined;
  let react:
    | Promise<
        ReturnType<
          typeof import('@opencut/graphics/renderer').openReactGraphics
        >
      >
    | undefined;
  return {
    async frame(
      bundle: GraphicBundle,
      graphic: GraphicLayer,
      sample: number | { numerator: number; denominator: number },
      frameRate: { numerator: number; denominator: number },
      signal?: AbortSignal,
      audio?: { key: number; sample: GraphicAudioSample },
      readMedia?: () => Promise<Record<string, string>>,
    ) {
      signal?.throwIfAborted();
      const exact = typeof sample === 'number' ? undefined : sample;
      const frame =
        typeof sample === 'number'
          ? sample
          : Number(
              (BigInt(sample.numerator) * BigInt(frameRate.numerator)) /
                (BigInt(sample.denominator) * BigInt(frameRate.denominator)),
            );
      const sourceId = exact
        ? `${exact.numerator}/${exact.denominator}`
        : frame;
      const cacheKey = `${graphic.key}:${sourceId}:${audio?.key ?? ''}`;
      const cached = frames.get(cacheKey);
      if (cached) return cached;
      const { durationFrames, width, height, props } = graphic;
      let png: Buffer;
      if (bundle.renderer === 'svg') {
        png = await (
          await import('./static-svg.js')
        ).rasterizeStaticSvg(bundle, signal);
      } else {
        if (durationFrames === undefined)
          throw new MediaError('Missing React graphics duration.');
        const worker = await (react ??= graphicsAdapter().then((adapter) =>
          adapter.openReactGraphics(
            () =>
              (font ??= readFile(
                new URL('../fonts/NotoSansSC.ttf', import.meta.url),
              )),
            (pid, stop) => trackRenderProcess(pid, stop, true),
          ),
        ));
        png = await worker.frame(
          bundle,
          {
            timing: {
              width,
              height,
              frame,
              durationFrames,
              ...(exact && { exactSourceTime: exact }),
              frameRate,
              seconds: (frame * frameRate.denominator) / frameRate.numerator,
            },
            props: props ?? {},
            ...(audio && { audio: audio.sample }),
            ...(readMedia && { mediaFrames: await readMedia() }),
          },
          signal,
        );
      }
      if (
        png.length < 24 ||
        png.readUInt32BE(16) !== width ||
        png.readUInt32BE(20) !== height
      )
        throw new MediaError(
          'Graphics renderer returned unexpected frame dimensions.',
        );
      frames.set(cacheKey, png);
      return png;
    },
    async close() {
      const worker = await react?.catch(() => undefined);
      await worker?.close();
    },
  };
}

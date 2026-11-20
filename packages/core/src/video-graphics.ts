import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  compileReactGraphic,
  compileStaticSvg,
  validateGraphicTemplate,
} from '@opencut/media';
import type { GraphicBundle, GraphicLayer } from '@opencut/media';
import {
  graphicSurface,
  resolveGraphicProps,
} from './video-graphics-contract.js';
import type {
  GraphicAssetDefinition,
  GraphicProps,
} from './video-graphics-contract.js';
import {
  fileIdentity,
  identifyVideoInput,
  videoInputIdentity,
} from './video-input.js';
import type { VideoInput, RecordVideoInput } from './video-input.js';
import { frameTime } from './time.js';
import type { FrameRate } from './time.js';
import { hashJson } from './video-integrity.js';
import type { MediaAsset, ProjectSettings } from './project.js';
import {
  definitionLoadError,
  VideoDefinitionError,
} from './video-definition.js';
import type { ParsedVideoDefinition } from './video-definition.js';

export async function compileVideoGraphics(
  path: string,
  { assets = {}, canvas, tracks }: ParsedVideoDefinition,
  record?: RecordVideoInput,
  signal?: AbortSignal,
  packaged?: ReadonlyMap<string, Extract<GraphicBundle, { renderer: 'react' }>>,
) {
  const { frameRate, ...settings } = canvas;
  const rate =
    typeof frameRate === 'number'
      ? { numerator: frameRate, denominator: 1 }
      : frameRate;
  const graphics = new Map<string, CompiledGraphic>();
  let bundleBytes = 0;
  for (const id of Object.keys(assets).sort()) {
    const asset = assets[id]!;
    if (asset.kind !== 'graphic') continue;
    const compiled = await compileGraphic(
      id,
      asset,
      dirname(path),
      { ...settings, frameRate: rate },
      record,
      signal,
      packaged?.get(id),
    );
    bundleBytes += graphicBundleSize(compiled.bundle);
    if (bundleBytes > 128 * 1024 * 1024)
      throw new VideoDefinitionError(
        'Compiled graphics exceed the 128 MiB project limit.',
      );
    graphics.set(id, compiled);
  }
  const validate = async (
    id: string,
    location: string,
    overrides?: GraphicProps,
  ) => {
    const source = graphics.get(id);
    if (source?.bundle.renderer !== 'react' || !source.bundle.template) return;
    try {
      await validateGraphicTemplate(
        source.bundle.template,
        resolveGraphicProps(source.react?.props, overrides),
      );
    } catch (cause) {
      throw new VideoDefinitionError(
        `${location}.props: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
  };
  for (const id of graphics.keys()) await validate(id, `assets.${id}`);
  for (const [i, track] of tracks.entries())
    for (const [j, clip] of track.clips.entries())
      if ('asset' in clip && 'props' in clip && clip.props)
        await validate(clip.asset, `tracks.${i}.clips.${j}`, clip.props);
  return graphics;
}

function graphicBundleSize(bundle: GraphicBundle) {
  const parts =
    bundle.renderer === 'react'
      ? [
          bundle.js,
          bundle.css,
          bundle.sourceMap ?? '',
          ...Object.values(bundle.notices ?? {}),
          ...Object.values(bundle.resources),
        ]
      : [bundle.svg, ...Object.values(bundle.fonts ?? {})];
  return parts.reduce((bytes, part) => bytes + Buffer.byteLength(part), 0);
}

export interface CompiledGraphic {
  path: string;
  asset: MediaAsset;
  surface: { width: number; height: number };
  react?: { durationFrames: number; props: GraphicProps | undefined };
  bundle: GraphicBundle;
  inputs: readonly VideoInput[];
}

export type CompiledGraphics = ReadonlyMap<string, CompiledGraphic>;

export function graphicBundleKeys(graphics: CompiledGraphics) {
  return Array.from(graphics, ([id, { bundle }]) => [id, bundle.key] as const);
}

export function graphicLayer(
  { bundle, surface, react }: CompiledGraphic,
  rate: FrameRate,
  overrides?: GraphicProps,
): GraphicLayer {
  const props = react && resolveGraphicProps(react.props, overrides);
  return {
    ...surface,
    key: hashJson([
      bundle.key,
      surface.width,
      surface.height,
      react?.durationFrames,
      rate,
      props,
    ]),
    bundleKey: bundle.key,
    ...(react && { durationFrames: react.durationFrames }),
    ...(props && { props }),
  };
}

const maxFileBytes = 32 * 1024 * 1024;
const maxGraphBytes = 64 * 1024 * 1024;

async function compileGraphic(
  id: string,
  definition: GraphicAssetDefinition,
  directory: string,
  canvas: ProjectSettings,
  record?: RecordVideoInput,
  signal?: AbortSignal,
  packaged?: Extract<GraphicBundle, { renderer: 'react' }>,
): Promise<CompiledGraphic> {
  const path = resolve(directory, definition.path);
  const inputs = new Map<string, VideoInput>();
  const pending = new Map<string, Promise<Buffer>>();
  let totalBytes = 0;
  function read(file: string, runtime = false) {
    let result = pending.get(file);
    if (!result) {
      result = capture(file, runtime);
      pending.set(file, result);
    }
    return result;
  }

  function identify(path: string, kind: VideoInput['kind']) {
    const input = identifyVideoInput(path, kind);
    if (!inputs.has(path)) {
      inputs.set(path, input);
      record?.(input);
    }
    return input.identity;
  }

  async function capture(file: string, runtime: boolean) {
    signal?.throwIfAborted();
    const kind = runtime ? 'graphic-runtime' : 'graphic';
    const identity = identify(file, kind);
    const target = await realpath(file);
    identify(target, kind);
    const fd = await open(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await fd.stat({ bigint: true });
      const size = Number(info.size);
      if (
        !identity ||
        fileIdentity(info) !== identity ||
        !size ||
        size > maxFileBytes ||
        totalBytes + size > maxGraphBytes ||
        inputs.size > 1024
      )
        throw new Error(
          `Cannot capture graphics dependency '${file}' within the graphics input limits.`,
        );
      totalBytes += size;
      const bytes = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        signal?.throwIfAborted();
        const { bytesRead } = await fd.read(
          bytes,
          offset,
          size - offset,
          offset,
        );
        if (!bytesRead)
          throw new Error(
            `Graphics dependency '${file}' changed while reading.`,
          );
        offset += bytesRead;
      }
      if (
        videoInputIdentity(file) !== identity ||
        videoInputIdentity(target) !== identity
      )
        throw new Error(`Graphics dependency '${file}' changed while reading.`);
      return bytes;
    } finally {
      await fd.close();
    }
  }

  async function compileBundle(
    width: number,
    height: number,
  ): Promise<GraphicBundle> {
    // Capture the entry first so a missing file is also recorded for watch recovery.
    const entry = await read(path);
    if (definition.renderer === 'svg') {
      const fonts = Object.fromEntries(
        await Promise.all(
          Object.entries(definition.fonts ?? {}).map(async ([name, file]) => [
            name,
            await read(resolve(directory, file)),
          ]),
        ),
      );
      return {
        ...(await compileStaticSvg(entry, width, height, fonts)),
        renderer: 'svg',
      };
    }
    const resources = Object.fromEntries(
      Object.entries(definition.resources ?? {}).map(([name, file]) => [
        name,
        resolve(directory, file),
      ]),
    );
    const bundle = await compileReactGraphic(
      path,
      resources,
      read,
      signal,
      record && ((file) => record(identifyVideoInput(file, 'graphic'))),
    );
    return { ...bundle, renderer: 'react' };
  }

  try {
    const { width, height } = graphicSurface(definition, canvas);
    const bundle = packaged ?? (await compileBundle(width, height));
    for (const { path, identity } of inputs.values())
      if (videoInputIdentity(path) !== identity)
        throw new Error(
          `Graphics dependency '${path}' changed during compilation.`,
        );
    const duration =
      definition.renderer === 'react'
        ? frameTime(definition.durationFrames, canvas.frameRate)
        : undefined;
    return {
      path,
      bundle,
      surface: { width, height },
      ...(definition.renderer === 'react' && {
        react: {
          durationFrames: definition.durationFrames,
          props: definition.props,
        },
      }),
      inputs: [...inputs.values()],
      asset: {
        id,
        name: definition.name ?? id,
        ...(duration && { duration }),
        file: { type: 'relative', path: definition.path },
        mediaTypes: ['video'],
        metadata: {
          kind: 'graphic',
          width,
          height,
          formatName: definition.renderer,
          durationSeconds: duration
            ? duration.numerator / duration.denominator
            : null,
          frameRate: duration
            ? canvas.frameRate.numerator / canvas.frameRate.denominator
            : null,
          frameRateRatio: duration
            ? `${canvas.frameRate.numerator}/${canvas.frameRate.denominator}`
            : null,
          hasAudio: false,
          audioCodec: null,
          videoCodec: null,
        },
      },
    };
  } catch (cause) {
    signal?.throwIfAborted();
    throw definitionLoadError(`assets.${id}.path (${definition.path})`, cause);
  }
}

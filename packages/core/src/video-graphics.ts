import type { GraphicScene } from '@opencut/shared';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import {
  compileReactGraphic,
  compileStaticSvg,
  validateGraphicTemplate,
} from '@opencut/media';
import type {
  BuiltinGraphic,
  GraphicBundle,
  GraphicLayer,
} from '@opencut/media';
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
import { createPresetScene } from './scene-presets.js';
import { validateSceneResources, walkScene } from './graphic-scene-schema.js';
import {
  readLottieClock,
  validateGlb,
  validateThreeResources,
} from './graphic-adapter-inputs.js';
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
      path,
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
  scene?: GraphicScene;
  react?: {
    durationFrames: number;
    props: GraphicProps | undefined;
    sampling?: 'exact';
    motionBlur?: NonNullable<GraphicLayer['motionBlur']>;
    audioAnalysis?: NonNullable<GraphicLayer['audioAnalysis']>;
    mediaFrames?: Readonly<
      Record<string, { asset: string; offset?: FrameRate | undefined }>
    >;
  };
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
  mapMedia?: (asset: string) => { path: string; identity: string },
): GraphicLayer {
  const props = react && resolveGraphicProps(react.props, overrides);
  const mediaFrames =
    react?.mediaFrames &&
    mapMedia &&
    Object.fromEntries(
      Object.entries(react.mediaFrames).map(([name, { asset, offset }]) => [
        name,
        { ...mapMedia(asset), offset },
      ]),
    );
  return {
    ...surface,
    key: hashJson([
      bundle.key,
      surface.width,
      surface.height,
      react?.durationFrames,
      rate,
      props,
      ...(react?.sampling ? [react.sampling, react.motionBlur] : []),
      ...(mediaFrames ? ['exact-media-frame-pts', mediaFrames] : []),
    ]),
    bundleKey: bundle.key,
    ...(react && { durationFrames: react.durationFrames }),
    ...(props && { props }),
    ...(mediaFrames && { mediaFrames }),
    ...(react?.sampling && { sampling: react.sampling }),
    ...(react?.motionBlur && { motionBlur: react.motionBlur }),
    ...(react?.audioAnalysis && { audioAnalysis: react.audioAnalysis }),
  };
}

const maxFileBytes = 32 * 1024 * 1024;
const maxGraphBytes = 64 * 1024 * 1024;

async function compileGraphic(
  id: string,
  definition: GraphicAssetDefinition,
  definitionPath: string,
  canvas: ProjectSettings,
  record?: RecordVideoInput,
  signal?: AbortSignal,
  packaged?: Extract<GraphicBundle, { renderer: 'react' }>,
): Promise<CompiledGraphic> {
  const directory = dirname(definitionPath);
  const path = definition.path
    ? resolve(directory, definition.path)
    : definitionPath;
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
    scene: GraphicScene | undefined,
  ): Promise<GraphicBundle> {
    if (definition.renderer === 'svg') {
      const entry = await read(path);
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
    let builtin: BuiltinGraphic | undefined;
    const declared = definition.resources ?? {};
    switch (definition.renderer) {
      case 'scene': {
        if (!scene) throw new Error('Missing normalized graphic scene.');
        validateSceneResources(scene, declared, definition.mediaFrames);
        if (
          Object.keys(definition.mediaFrames ?? {}).some((id) =>
            Object.hasOwn(declared, id),
          )
        )
          throw new Error(
            'Static resources and media-frame aliases must use distinct IDs.',
          );
        for (const node of walkScene(scene.children))
          if (node.type === 'audio' && !definition.audioAnalysis)
            throw new Error(
              `Scene node '${node.id}' requires audioAnalysis on its graphic asset.`,
            );
        builtin = { kind: 'scene', scene };
        break;
      }
      case 'template':
        builtin = { kind: 'template', name: definition.template };
        break;
      case 'lottie': {
        if (Object.hasOwn(resources, '__opencut_asset'))
          throw new Error('Reserved resource ID __opencut_asset.');
        resources.__opencut_asset = path;
        builtin = {
          kind: 'lottie',
          clock: readLottieClock(await read(path)),
          range: definition.outOfRange ?? 'hold',
        };
        break;
      }
      case 'three':
        validateThreeResources(definition.scene, !!definition.path, declared);
        if (definition.path) {
          if (Object.hasOwn(resources, '__opencut_asset'))
            throw new Error('Reserved resource ID __opencut_asset.');
          resources.__opencut_asset = path;
          validateGlb(
            await read(path),
            definition.scene.model?.animation?.name,
          );
        }
        builtin = { kind: 'three', scene: definition.scene };
        break;
    }
    const bundle = await compileReactGraphic(
      path,
      resources,
      read,
      signal,
      record && ((file) => record(identifyVideoInput(file, 'graphic'))),
      builtin,
    );
    return { ...bundle, renderer: 'react' };
  }

  try {
    const { width, height } = graphicSurface(definition, canvas);
    const exact =
      definition.renderer === 'scene' ||
      definition.renderer === 'three' ||
      definition.renderer === 'lottie' ||
      (definition.renderer === 'react' && definition.sampling === 'exact');
    const motionBlur =
      'motionBlur' in definition ? definition.motionBlur : undefined;
    if (definition.renderer === 'three' && width * height > 1920 * 1080)
      throw new Error('Three.js surfaces are limited to 2,073,600 pixels.');
    if (motionBlur && (!exact || width * height > 1920 * 1080))
      throw new Error(
        'Motion blur requires exact sampling on a surface of at most 2,073,600 pixels.',
      );
    const scene =
      definition.renderer !== 'scene'
        ? undefined
        : 'preset' in definition.scene
          ? createPresetScene(definition.scene.preset, { width, height })
          : definition.scene;
    const bundle = packaged ?? (await compileBundle(width, height, scene));
    for (const { path, identity } of inputs.values())
      if (videoInputIdentity(path) !== identity)
        throw new Error(
          `Graphics dependency '${path}' changed during compilation.`,
        );
    const duration =
      definition.renderer !== 'svg'
        ? frameTime(definition.durationFrames, canvas.frameRate)
        : undefined;
    return {
      path,
      bundle,
      surface: { width, height },
      ...(scene && { scene }),
      ...(definition.renderer !== 'svg' && {
        react: {
          durationFrames: definition.durationFrames,
          props: 'props' in definition ? definition.props : undefined,
          ...(exact && { sampling: 'exact' as const }),
          ...(motionBlur && { motionBlur }),
          ...(definition.renderer === 'scene' &&
            definition.mediaFrames && { mediaFrames: definition.mediaFrames }),
          ...('audioAnalysis' in definition &&
            definition.audioAnalysis && {
              audioAnalysis: definition.audioAnalysis,
            }),
        },
      }),
      inputs: [...inputs.values()],
      asset: {
        id,
        name: definition.name ?? id,
        ...(duration && { duration }),
        file: {
          type: 'relative',
          path: definition.path ?? basename(definitionPath),
        },
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
    throw definitionLoadError(
      `assets.${id}.${definition.renderer} (${path})`,
      cause,
    );
  }
}

import { graphicNodeTime, sampleMotion } from '@opencut/shared';
import type { AnimatedNumber, GraphicSceneNode } from '@opencut/shared';
import { clipSourceTime } from './clip-timing.js';
import { frameTime } from './time.js';
import { z } from 'zod';
import { audioAnalysisSchema } from './graphic-audio-schema.js';
import { threeSceneSchema } from './graphic-adapter-inputs.js';
import { visualGroupsSchema } from './visual-groups.js';
import { graphicSceneSchema, sceneLimits } from './graphic-scene-schema.js';
import { graphicScenePresets, presetSceneSchema } from './scene-presets.js';
import { graphicTemplates } from './video-graphics-contract.js';
import { graphicFrameSamples } from './graphic-sampling.js';
import type { CompiledVideo } from './video-compiler.js';

export const videoGraphicsCapabilities = {
  version: 1,
  scene: {
    version: 1,
    units: 'px',
    ...sceneLimits,
    presets: graphicScenePresets,
  },
  templates: graphicTemplates,
  backends: {
    svg: { version: 1, requirements: ['Sharp'] },
    react: {
      version: 2,
      requirements: ['pinned Chromium Headless Shell'],
      trustedCode: true,
    },
    scene: { version: 1, requirements: ['pinned Chromium Headless Shell'] },
    lottie: {
      version: 1,
      requirements: ['pinned Chromium Headless Shell', 'lottie-web 5.13.0'],
      maxInputBytes: 4194304,
    },
    three: {
      version: 1,
      requirements: [
        'pinned Chromium Headless Shell',
        'Three.js 0.184.0',
        'WebGL2',
      ],
      maxInputBytes: 16777216,
      maxSurfacePixels: 2073600,
      glbExtensions: [],
    },
  },
  motionBlur: {
    scope: 'graphic',
    sampling: 'exact',
    minSamples: 2,
    maxSamples: 12,
    maxSurfacePixels: 2073600,
    shutterAngleDegrees: [1, 360],
  },
  compositing: {
    scope: 'visual-track-group',
    maxGroups: 8,
    maxTracksPerGroup: 8,
    blendModes: ['normal', 'multiply', 'screen', 'overlay'],
    matte: 'alpha',
    backdropBlur: true,
  },
  transitions: [
    'cross-dissolve',
    'fade-in',
    'fade-out',
    'dip-to-color',
    'wipe',
    'slide',
    'push',
    'zoom',
    'blur',
  ],
  audioAnalysis: {
    version: 1,
    sampleRate: 48000,
    sources: ['mix', 'track'],
    windows: [512, 1024, 2048, 4096],
    maxFeaturesPerAnalysisBytes: 64 * 1024 * 1024,
  },
} as const;

export function videoGraphicsSchemas() {
  const options = { cycles: 'ref', unrepresentable: 'any' } as const;
  return {
    scene: z.toJSONSchema(graphicSceneSchema, options),
    preset: z.toJSONSchema(presetSceneSchema, options),
    three: z.toJSONSchema(threeSceneSchema, options),
    audioAnalysis: z.toJSONSchema(audioAnalysisSchema, options),
    visualGroups: z.toJSONSchema(visualGroupsSchema.unwrap(), options),
  };
}

interface InspectedTextBox {
  id: string;
  parent?: string;
  time: number;
  x: number;
  y: number;
  width: number;
  height: number;
  overflow: string;
}

function inspectNodeBounds(
  nodes: readonly GraphicSceneNode[],
  time: number,
  parent?: string,
): InspectedTextBox[] {
  const result: InspectedTextBox[] = [];
  for (const node of nodes) {
    const local = graphicNodeTime(time, node.timing);
    if (local === undefined) continue;
    if (node.type === 'group') {
      result.push(...inspectNodeBounds(node.children, local, node.id));
      continue;
    }
    if (node.type !== 'text') continue;
    const number = (value: AnimatedNumber, min: number, max: number) =>
      Math.max(
        min,
        Math.min(
          max,
          typeof value === 'number' ? value : sampleMotion(value, local),
        ),
      );
    result.push({
      id: node.id,
      ...(parent && { parent }),
      time: local,
      x: number(node.x ?? 0, -32768, 32768),
      y: number(node.y ?? 0, -32768, 32768),
      width: number(node.width, 0, 8192),
      height: number(node.height, 0, 8192),
      overflow: node.overflow ?? 'clip',
    });
  }
  return result;
}

/** Resolve graphic sources at a project frame without starting the renderer. */
export async function inspectGraphicFrames(
  video: CompiledVideo,
  frame: number,
) {
  const { frameRate, visualClips, visualTransitions } =
    await video.resolveRender();
  const active = ({
    timelineStartFrame,
    frameCount,
  }: (typeof visualClips)[number]) =>
    timelineStartFrame <= frame && frame < timelineStartFrame + frameCount;
  const transitionLayers = (visualTransitions ?? []).flatMap(({ layers }) =>
    layers.filter(active),
  );
  const transitioning = new Set(transitionLayers.map(({ clipId }) => clipId));
  return [
    ...visualClips.filter(
      (clip) => active(clip) && !transitioning.has(clip.clipId),
    ),
    ...transitionLayers,
  ].flatMap((clip) => {
    const graphic = clip.graphic;
    if (!graphic) return [];
    const bundle = video.graphicSource(graphic.bundleKey)!;
    const scene = video.graphicScene(graphic.bundleKey);
    const time = clip.retiming
      ? clipSourceTime(clip.retiming, frameTime(frame, frameRate))
      : frameTime(
          clip.sourceStartFrame + frame - clip.timelineStartFrame,
          frameRate,
        );
    const sourceFrame =
      (time.numerator * frameRate.numerator) /
      (time.denominator * frameRate.denominator);
    return [
      {
        clipId: clip.clipId,
        timelineFrame: frame,
        samples: graphicFrameSamples({ ...clip, graphic }, frame, frameRate),
        ...(scene && {
          layout: {
            space: 'parent-scene-pixels',
            textBoxes: inspectNodeBounds(scene.children, sourceFrame),
          },
        }),
        sampling: graphic.sampling ?? 'integer',
        clock:
          graphic.sampling === 'exact' ? 'source-seconds' : 'source-frames',
        renderer:
          bundle.renderer === 'svg'
            ? 'svg'
            : (bundle.adapter ?? (bundle.template ? 'template' : 'react')),
        backend: bundle.renderer === 'react' ? bundle.backend : 'svg-sharp-v1',
        dependencyKey: graphic.key,
        width: graphic.width,
        height: graphic.height,
        ...(graphic.motionBlur && { motionBlur: graphic.motionBlur }),
        ...(graphic.audioAnalysis && { audioAnalysis: graphic.audioAnalysis }),
        ...(graphic.mediaFrames && {
          mediaFrames: Object.keys(graphic.mediaFrames),
        }),
        ...(bundle.renderer === 'react' && {
          resources: Object.keys(bundle.resources),
        }),
      },
    ];
  });
}

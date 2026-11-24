import { expect, it } from 'vitest';
import type { GraphicLayer, VisualTimelineClip } from '@opencut/media';
import {
  declaredGraphicHold,
  graphicFrameSamples,
} from './graphic-sampling.js';

const rate = { numerator: 30000, denominator: 1001 };
const clip = {
  clipId: 'card',
  path: '/card.tsx',
  frameCount: 90,
  timelineStartFrame: 10,
  sourceStartFrame: 0,
  retiming: {
    timelineStart: { numerator: 1001, denominator: 3000 },
    timelineEnd: { numerator: 1001, denominator: 300 },
    sourceIn: { numerator: 1001, denominator: 1500 },
    sourceOut: { numerator: 13013, denominator: 6000 },
    speed: { numerator: 1, denominator: 2 },
  },
  graphic: {
    key: 'sample',
    bundleKey: 'source',
    width: 320,
    height: 180,
    durationFrames: 100,
    sampling: 'exact',
  },
} satisfies Omit<Extract<VisualTimelineClip, { path: string }>, 'retiming'> & {
  graphic: GraphicLayer;
  retiming: Omit<NonNullable<VisualTimelineClip['retiming']>, 'sourceOriginNs'>;
};
const sample = { ...clip, retiming: { ...clip.retiming, sourceOriginNs: 0 } };

it('preserves exact source mapping across trim and half-speed at 30000/1001', () => {
  expect(graphicFrameSamples(sample, 11, rate)).toEqual([
    { numerator: 41041, denominator: 60000 },
  ]);
  const legacy: GraphicLayer = { ...sample.graphic };
  delete legacy.sampling;
  expect(graphicFrameSamples({ ...sample, graphic: legacy }, 11, rate)).toEqual(
    [20],
  );
});

it('uses distinct exposure samples and excludes samples before the placement starts', () => {
  const blurred = {
    ...sample,
    graphic: {
      ...sample.graphic,
      motionBlur: { samples: 8, shutterAngle: 180 },
    },
  };
  expect(graphicFrameSamples(blurred, 10, rate)).toHaveLength(4);
  const current = graphicFrameSamples(blurred, 11, rate);
  expect(new Set(current.map((value) => JSON.stringify(value))).size).toBe(8);
  graphicFrameSamples(blurred, 44, rate);
  expect(graphicFrameSamples(blurred, 11, rate)).toEqual(current);
});

it('uses a declared hold only when all exposure samples stay inside it', () => {
  const hold = { startFrame: 20, endFrame: 24 };
  const graphic = { ...sample.graphic, staticRanges: [hold] };
  expect(declaredGraphicHold(graphic, [20, 23], rate)).toBe(hold);
  expect(declaredGraphicHold(graphic, [19, 20], rate)).toBeUndefined();
  expect(declaredGraphicHold(graphic, [23, 24], rate)).toBeUndefined();
  expect(
    declaredGraphicHold(
      graphic,
      [
        { numerator: 47047, denominator: 60000 },
        { numerator: 49049, denominator: 60000 },
      ],
      rate,
    ),
  ).toBeUndefined();
  expect(
    declaredGraphicHold(
      {
        ...graphic,
        audioAnalysis: {
          version: 1,
          source: 'mix',
          window: 512,
          hop: 256,
          waveform: 4,
          bins: 4,
        },
      },
      [22],
      rate,
    ),
  ).toBeUndefined();
});

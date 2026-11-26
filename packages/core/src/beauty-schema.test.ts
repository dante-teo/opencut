import { describe, expect, it } from 'vitest';
import { beautyRecipeSchema, isActiveBeautyStep } from './beauty-schema.js';
import { videoRecipeSchema } from './video-recipe-schema.js';

const analysisRef = 'a'.repeat(64);
const target = { assetId: 'source', shotId: 'shot-1', trackId: 'person-1' };
const effect = {
  type: 'beauty',
  id: 'face',
  version: 1,
  target,
  timeRange: { start: 0, end: 3 },
} as const;

const recipe = (effects: unknown[]) => ({
  type: 'beauty',
  analysisRef,
  effects,
});

describe('beauty recipe contract', () => {
  it('keeps exact coverage as the default and accepts an explicit visibility policy', () => {
    const definition = recipe([{ ...effect, parameters: { faceSlim: 0.25 } }]);
    expect(beautyRecipeSchema.parse(definition).acceptance).toBe(
      'complete-coverage',
    );
    expect(
      beautyRecipeSchema.parse({ ...definition, acceptance: 'visible-result' })
        .acceptance,
    ).toBe('visible-result');
  });

  it('uses neutral defaults and bypasses both disabled and neutral keyframed parameters', () => {
    expect(isActiveBeautyStep(beautyRecipeSchema.parse(recipe([effect])))).toBe(
      false,
    );
    expect(
      isActiveBeautyStep(
        beautyRecipeSchema.parse(
          recipe([
            { ...effect, enabled: false, parameters: { headReduce: 0.1 } },
          ]),
        ),
      ),
    ).toBe(false);
    expect(
      isActiveBeautyStep(
        beautyRecipeSchema.parse(
          recipe([
            {
              ...effect,
              parameters: { faceSlim: 0.5 },
              keyframes: { faceSlim: [{ time: 1, value: 0 }] },
            },
          ]),
        ),
      ),
    ).toBe(false);
    expect(
      isActiveBeautyStep(
        beautyRecipeSchema.parse(
          recipe([
            { ...effect, keyframes: { warmth: [{ time: 1, value: -0.3 }] } },
          ]),
        ),
      ),
    ).toBe(true);
  });

  it('rejects unknown fields, invalid strengths, and unsupported versions', () => {
    for (const parameters of [
      { eyes: 0.3 },
      { faceSlim: -0.1 },
      { headReduce: 1.1 },
      { tint: -1.1 },
      { warmth: Infinity },
      { skinSmooth: NaN },
    ]) {
      expect(
        beautyRecipeSchema.safeParse(recipe([{ ...effect, parameters }]))
          .success,
      ).toBe(false);
    }
    expect(
      beautyRecipeSchema.safeParse(recipe([{ ...effect, version: 2 }])).success,
    ).toBe(false);
    expect(
      beautyRecipeSchema.safeParse({
        ...recipe([effect]),
        analysisRef: '../../etc',
      }).success,
    ).toBe(false);
  });

  it('enforces monotonic keys, exclusive range ends, and bounded protected regions', () => {
    for (const times of [
      [1, 1],
      [1, 0],
      [1, 3],
    ]) {
      expect(
        beautyRecipeSchema.safeParse(
          recipe([
            {
              ...effect,
              keyframes: {
                skinBrighten: times.map((time) => ({ time, value: 0.2 })),
              },
            },
          ]),
        ).success,
      ).toBe(false);
    }
    expect(
      beautyRecipeSchema.safeParse(
        recipe([
          {
            ...effect,
            protectedRegions: [{ x: 0.6, y: 0, width: 0.5, height: 0.4 }],
          },
        ]),
      ).success,
    ).toBe(false);
  });

  it('allows simultaneous targets and rejects overlapping settings for the same target', () => {
    const first = { ...effect, parameters: { faceSlim: 0.2 } };
    const second = { ...first, id: 'another' };
    expect(beautyRecipeSchema.safeParse(recipe([first, second])).success).toBe(
      false,
    );
    expect(
      beautyRecipeSchema.safeParse(
        recipe([
          first,
          { ...second, target: { ...target, trackId: 'person-2' } },
        ]),
      ).success,
    ).toBe(true);
    expect(
      beautyRecipeSchema.safeParse(
        recipe([first, { ...second, timeRange: { start: 3, end: 4 } }]),
      ).success,
    ).toBe(true);
  });

  it('requires active beauty to precede source-changing recipes', () => {
    const trim = { type: 'trim', start: 0, end: 2 };
    const active = recipe([{ ...effect, parameters: { faceSlim: 0.2 } }]);
    expect(videoRecipeSchema.safeParse([active, trim]).success).toBe(true);
    expect(videoRecipeSchema.safeParse([trim, active]).success).toBe(false);
    expect(videoRecipeSchema.safeParse([trim, recipe([effect])]).success).toBe(
      true,
    );
  });
});

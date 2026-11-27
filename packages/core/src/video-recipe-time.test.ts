import { describe, expect, it } from 'vitest';
import { originalRecipeTime } from './video-recipe.js';
import type { VideoRecipeInspection } from './video-recipe.js';

const media = {
  kind: 'video',
  width: 108,
  height: 192,
  durationSeconds: 10,
  frameRate: 60,
  hasAudio: false,
  audioDurationSeconds: null,
  videoStartSeconds: 0,
  audioStartSeconds: null,
} as const;

describe('original recipe time', () => {
  it('maps a valid fractional slow-motion speed through a precise trim', () => {
    const recipe: VideoRecipeInspection = {
      sourceFrameRate: 60,
      assetId: 'clip',
      source: '/source.mp4',
      steps: [
        {
          parameters: { type: 'trim', start: 1.2345678912, end: 8 },
          media,
          format: 'mp4',
        },
        {
          parameters: {
            type: 'smoothSlowMotion',
            speed: 1 / 3,
            numerator: 60,
            denominator: 1,
            quality: 'fast',
            sceneThreshold: 8,
            sceneCuts: [],
          },
          media,
          format: 'mov',
        },
      ],
    };

    expect(
      originalRecipeTime({ numerator: 3, denominator: 1 }, recipe),
    ).toEqual({
      numerator: 279321,
      denominator: 125000,
    });
  });
});

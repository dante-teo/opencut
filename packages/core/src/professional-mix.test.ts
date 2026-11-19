import { describe, expect, it } from 'vitest';
import { parseVideoDefinition } from './video-definition.js';
import { videoMixEditSchema } from './professional-mix.js';

describe('professional dialogue mix serialization', () => {
  const definition = {
    canvas: { width: 160, height: 90, frameRate: 30, durationFrames: 60 },
    tracks: [{ type: 'audio', id: 'music', audioRole: 'music', clips: [] }],
    professionalMix: {
      preset: 'natural-cinematic',
      cleanup: 0,
      automation: {
        music: [
          { sample: 0, db: -8 },
          { sample: 96000, db: 0 },
        ],
      },
      delivery: { preset: 'broadcast', truePeakDbtp: -1 },
    },
  };
  it('preserves optional controls and authored zero values', () => {
    expect(
      parseVideoDefinition(JSON.parse(JSON.stringify(definition))),
    ).toEqual(definition);
    expect(
      videoMixEditSchema.parse({ mix: null, roles: { music: 'other' } }),
    ).toEqual({
      mix: null,
      roles: { music: 'other' },
    });
  });
  it('rejects mistyped routing, gain curves and filter parameters', () => {
    expect(() =>
      parseVideoDefinition({
        ...definition,
        tracks: [{ type: 'image', audioRole: 'music', clips: [] }],
      }),
    ).toThrow('audioRole');
    const mix = definition.professionalMix;
    expect(
      videoMixEditSchema.safeParse({
        mix: {
          ...mix,
          automation: {
            music: [
              { sample: 5, db: 0 },
              { sample: 5, db: -8 },
            ],
          },
        },
      }).success,
    ).toBe(false);
    expect(
      videoMixEditSchema.safeParse({ mix: { ...mix, highPassHz: 560 } })
        .success,
    ).toBe(false);
    expect(
      videoMixEditSchema.safeParse({ mix: { ...mix, ai: 'remote' } }).success,
    ).toBe(false);
  });
});

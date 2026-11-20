import { describe, expect, it } from 'vitest';
import { sampleClipSourceFrame } from './clip-timing.js';
import { frameTime } from './time.js';
import { parseVideoDefinition } from './video-definition.js';
import {
  graphicSurface,
  resolveGraphicProps,
} from './video-graphics-contract.js';

const frameRate = { numerator: 30_000, denominator: 1001 };
const canvas = { width: 320, height: 180, frameRate };
const card = {
  kind: 'graphic',
  renderer: 'react',
  path: 'Card.tsx',
  durationFrames: 180,
  props: { title: '你好', nested: { color: 'blue' } },
} as const;

describe('graphic asset contract', () => {
  it('accepts independently authored React and SVG surfaces and per-placement props', () => {
    const definition = parseVideoDefinition({
      version: 2,
      canvas,
      assets: {
        card,
        logo: { kind: 'graphic', renderer: 'svg', path: 'logo.svg' },
      },
      tracks: [
        {
          type: 'video',
          clips: [
            {
              asset: 'card',
              at: 15,
              sourceIn: 30,
              sourceOut: 90,
              props: { title: 'Hello' },
            },
          ],
        },
      ],
    });
    expect(definition.assets?.card).toEqual(card);
    expect(definition.tracks[0]?.clips[0]).toMatchObject({
      props: { title: 'Hello' },
    });
    expect(graphicSurface(card, canvas)).toEqual({ width: 320, height: 180 });
    expect(
      resolveGraphicProps(card.props, { nested: { text: 'New' } }),
    ).toEqual({
      title: '你好',
      nested: { text: 'New' },
    });
  });

  it.each([
    { ...card, durationFrames: undefined },
    { ...card, width: 0 },
    { ...card, path: 'http://example.com/Card.tsx' },
    { ...card, props: { value: Infinity } },
    { ...card, recipe: [] },
    { kind: 'graphic', renderer: 'svg', path: 'logo.png' },
    { kind: 'graphic', renderer: 'svg', path: 'logo.svg', durationFrames: 20 },
  ])('rejects unsupported asset descriptors %#', (asset) => {
    expect(() =>
      parseVideoDefinition({ canvas, assets: { asset }, tracks: [] }),
    ).toThrow(/assets.asset/);
  });

  it('samples trimmed and retimed frames on an exact rational frame grid', () => {
    const at = (frame: number) => frameTime(frame, frameRate);
    const clip = {
      timelineStart: at(60),
      sourceIn: at(30),
      sourceOut: at(180),
      speed: { numerator: 3, denominator: 2 },
    };
    expect(
      [60, 61, 62, 63, 64].map((frame) =>
        sampleClipSourceFrame(clip, frame, frameRate),
      ),
    ).toEqual([30, 31, 33, 34, 36]);
    const split = { ...clip, timelineStart: at(64), sourceIn: at(36) };
    expect(sampleClipSourceFrame(split, 85, frameRate)).toBe(
      sampleClipSourceFrame(clip, 85, frameRate),
    );
  });
});

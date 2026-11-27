import { describe, expect, it } from 'vitest';
import { compileDeclaredTimeline } from './video-compiler.js';
import { create4K60Delivery } from './video-delivery.js';
import { parseVideoDefinition } from './video-definition.js';
import type { VideoDefinition } from './video-definition.js';
import { planProjectRender } from './render-plan.js';

describe('4K60 delivery', () => {
  const shots = [0, 150, 300, 450, 600, 750, 900, 1050, 1188].map(
    (at, i, starts) => ({
      id: `shot-${i + 1}`,
      asset: 'camera',
      at,
      sourceIn: 30,
      sourceOut: 30 + (starts[i + 1] ?? 1623) - at,
      muted: true,
    }),
  );
  const approved: VideoDefinition = {
    canvas: { width: 1080, height: 1920, frameRate: 30, durationFrames: 1623 },
    assets: {
      camera: { kind: 'video', path: 'camera.mp4' },
      native: { kind: 'video', path: 'native.mp4' },
      sweep: {
        kind: 'graphic',
        renderer: 'svg',
        path: 'sweep.svg',
        width: 540,
        height: 960,
      },
      music: { kind: 'audio', path: 'music.wav' },
    },
    tracks: [
      { type: 'video', clips: shots },
      {
        type: 'video',
        clips: [
          {
            id: 'sweep-overlay',
            asset: 'sweep',
            at: 1188,
            duration: 15,
            visual: { x: 24, y: -48, scale: 0.65 },
          },
          { id: 'native-shot', asset: 'native', at: 1203, sourceOut: 3 },
        ],
      },
      {
        type: 'audio',
        clips: [
          {
            id: 'music-bed',
            asset: 'music',
            at: 0,
            sourceOut: 1623,
            fadeIn: 12,
            fadeOut: 30,
          },
        ],
      },
    ],
    subtitles: {
      style: { fontSize: 54, y: 650 },
      cues: [
        {
          id: 'reveal-caption',
          start: { numerator: 198, denominator: 5 },
          end: { numerator: 41, denominator: 1 },
          text: 'Reveal',
        },
      ],
    },
    markers: [{ id: 'reveal', frame: 1188, name: 'Reveal' }],
  };

  it('preserves the 39.600s reveal, 54.100s duration, and approved layout and fades', async () => {
    const delivery = create4K60Delivery(approved, {
      interpolateShots: shots.map(({ id }) => id),
      nativeSources: ['native'],
    });
    const project = await compileDeclaredTimeline(
      {
        path: '/delivery.video.ts',
        definition: parseVideoDefinition(delivery),
      },
      {},
    );
    const plan = planProjectRender(project);
    expect(plan).toMatchObject({
      width: 2160,
      height: 3840,
      frameRate: { numerator: 60, denominator: 1 },
      frameCount: 3246,
    });
    expect(plan.frameCount / plan.frameRate.numerator).toBe(54.1);
    expect(
      plan.visualClips.find(({ clipId }) => clipId === 'shot-9'),
    ).toMatchObject({ timelineStartFrame: 2376, sourceStartFrame: 0 });
    expect(
      plan.visualClips.find(({ clipId }) => clipId === 'sweep-overlay'),
    ).toMatchObject({ timelineStartFrame: 2376, x: 48, y: -96, scale: 0.65 });
    expect(
      plan.visualClips.find(({ clipId }) => clipId === 'reveal-caption'),
    ).toMatchObject({
      timelineStartFrame: 2376,
      y: 1228.5,
      text: { fontSize: 108 },
    });
    expect(
      plan.audioClips.find(({ clipId }) => clipId === 'music-bed'),
    ).toMatchObject({
      frameCount: 3246,
      fadeIn: { duration: { numerator: 2, denominator: 5 } },
      fadeOut: { duration: { numerator: 1, denominator: 1 } },
    });
    expect(delivery.assets?.native).toEqual(approved.assets?.native);
    expect(delivery.markers?.[0]?.frame).toBe(2376);
    expect(
      Object.values(delivery.assets ?? {}).flatMap(
        (asset) => asset.recipe ?? [],
      ),
    ).toHaveLength(18);
    expect(delivery.assets?.['camera-4k60']).toMatchObject({
      recipe: [
        { type: 'trim', clock: 'picture', start: 1, end: 6 },
        { type: 'interpolateFrames', numerator: 60 },
      ],
    });
    expect(approved.canvas.durationFrames).toBe(1623);
    expect(approved.subtitles?.style.y).toBe(650);
  });

  it('keeps source frames on both sides of a cut for selected shots in a dissolve', () => {
    const delivery = create4K60Delivery(
      {
        ...approved,
        transitions: [
          {
            id: 'dissolve',
            kind: 'cross-dissolve',
            from: 'shot-1',
            to: 'shot-2',
            frames: 6,
          },
        ],
      },
      { interpolateShots: ['shot-1', 'shot-2'] },
    );
    expect(delivery.transitions?.[0]?.frames).toBe(12);
    expect(delivery.assets?.['camera-4k60']?.recipe?.[0]).toEqual({
      type: 'trim',
      clock: 'picture',
      start: 1,
      end: 6.1,
    });
    expect(delivery.assets?.['camera-4k60-2']?.recipe?.[0]).toEqual({
      type: 'trim',
      clock: 'picture',
      start: 0.9,
      end: 6,
    });
    expect(delivery.tracks[0]?.clips[1]).toMatchObject({
      at: 300,
      sourceIn: { numerator: 1, denominator: 10 },
    });
  });

  it('includes a duration-authored still when the other side of a dissolve is interpolated', () => {
    const delivery = create4K60Delivery(
      {
        canvas: approved.canvas,
        assets: {
          still: { kind: 'image', path: 'still.png' },
          camera: { kind: 'video', path: 'camera.mp4' },
        },
        tracks: [
          {
            type: 'video',
            clips: [
              { id: 'intro', asset: 'still', at: 0, duration: 30 },
              {
                id: 'reveal',
                asset: 'camera',
                at: 30,
                sourceIn: 6,
                sourceOut: 36,
              },
            ],
          },
        ],
        transitions: [
          {
            id: 'fade',
            kind: 'cross-dissolve',
            from: 'intro',
            to: 'reveal',
            frames: 6,
          },
        ],
      },
      { interpolateShots: ['reveal'] },
    );
    expect(delivery.transitions?.[0]?.frames).toBe(12);
    expect(delivery.tracks[0]?.clips[0]).toMatchObject({ duration: 60 });
    expect(delivery.assets?.['camera-4k60']?.recipe?.[0]).toEqual({
      type: 'trim',
      clock: 'picture',
      start: 0.1,
      end: 1.2,
    });
    expect(delivery.tracks[0]?.clips[1]).toMatchObject({
      at: 60,
      sourceIn: { numerator: 1, denominator: 10 },
    });
  });

  it('rejects interpolating a shot from a declared native source', () => {
    expect(() =>
      create4K60Delivery(approved, {
        interpolateShots: ['native-shot'],
        nativeSources: ['native'],
      }),
    ).toThrow(/uses native source/);
  });
});

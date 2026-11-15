import { defineVideo } from '@opencut/sdk';
import { title } from './review-title.ts';

const fixtures = '../../tests/fixtures/generated';
const grade = {
  exposure: 0,
  temperature: 0,
  tint: 0,
  contrast: 1,
  saturation: 0.35,
  curve: [],
};

export default defineVideo({
  name: title,
  canvas: { width: 320, height: 180, frameRate: 24, durationFrames: 48 },
  assets: {
    camera: { kind: 'video', path: `${fixtures}/video-long.mp4` },
    music: { kind: 'audio', path: `${fixtures}/audio-tone.wav` },
    still: { kind: 'image', path: `${fixtures}/still.png` },
  },
  tracks: [
    {
      type: 'video',
      clips: [
        {
          id: 'first',
          asset: 'camera',
          at: 0,
          sourceIn: 12,
          sourceOut: 36,
          muted: true,
          grade,
        },
        {
          id: 'second',
          asset: 'camera',
          at: 24,
          sourceIn: 48,
          sourceOut: 72,
          muted: true,
          grade,
        },
      ],
    },
    {
      type: 'image',
      clips: [
        {
          asset: 'still',
          at: 12,
          duration: 24,
          visual: { scale: 0.25, x: 94, y: -42, opacity: 0.7 },
        },
      ],
    },
    {
      type: 'text',
      clips: [{ at: 0, duration: 12, text: { content: title, fontSize: 24 } }],
    },
    {
      type: 'audio',
      clips: [
        {
          asset: 'music',
          at: 12,
          sourceOut: 36,
          fadeIn: 4,
          fadeOut: 6,
          volume: 0.65,
        },
      ],
    },
  ],
  transitions: [
    {
      id: 'dissolve',
      kind: 'cross-dissolve',
      frames: 8,
      from: 'first',
      to: 'second',
    },
  ],
  subtitles: {
    style: { fontSize: 22 },
    cues: [
      {
        id: 'caption',
        text: 'Across the cut',
        start: { numerator: 3, denominator: 4 },
        end: { numerator: 3, denominator: 2 },
      },
    ],
  },
});

import { defineVideo } from '@opencut/sdk';

const source = '../../tests/fixtures/generated/video-medium.mp4';

export default defineVideo({
  name: 'Media recipes',
  canvas: { width: 160, height: 90, frameRate: 24, durationFrames: 24 },
  assets: {
    picture: {
      kind: 'video',
      path: source,
      recipe: [
        { type: 'trim', start: 1, end: 2 },
        { type: 'crop', x: 16, y: 8, width: 288, height: 162 },
        { type: 'resize', width: 160, height: 90 },
        { type: 'frameRate', numerator: 24 },
      ],
    },
    soundtrack: {
      kind: 'audio',
      path: source,
      recipe: [
        { type: 'trim', start: 1, end: 2 },
        { type: 'extractAudio' },
        { type: 'normalizeAudio', targetLufs: -18 },
        { type: 'convert', format: 'flac' },
      ],
    },
  },
  tracks: [
    {
      type: 'video',
      clips: [{ asset: 'picture', at: 0, sourceOut: 24, muted: true }],
    },
    { type: 'audio', clips: [{ asset: 'soundtrack', at: 0, sourceOut: 24 }] },
  ],
});

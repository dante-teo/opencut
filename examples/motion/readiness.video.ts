import { defineVideo } from '@opencut/sdk';

export default defineVideo({
  version: 3,
  name: 'Exact source clock',
  canvas: {
    width: 640,
    height: 360,
    frameRate: { numerator: 30000, denominator: 1001 },
  },
  assets: {
    dial: {
      kind: 'graphic',
      renderer: 'react',
      path: './ReadinessDial.tsx',
      durationFrames: 180,
      sampling: 'exact',
    },
  },
  tracks: [
    {
      type: 'video',
      clips: [
        {
          asset: 'dial',
          at: 0,
          sourceIn: 12,
          sourceOut: 72,
          speed: { numerator: 1, denominator: 2 },
        },
      ],
    },
  ],
});

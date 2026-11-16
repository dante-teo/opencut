import { defineVideo, videoParams } from '@opencut/sdk';

export default defineVideo(
  {
    seconds: videoParams.number().int().min(2).max(30).default(2),
    software: videoParams.boolean().default(false),
  },
  ({ seconds, software }) => ({
    name: 'Half-speed motion study',
    canvas: {
      width: 640,
      height: 360,
      frameRate: 24,
      durationFrames: seconds * (software ? 24 : 48),
    },
    assets: {
      motion: {
        kind: 'video',
        path: seconds === 2 ? 'media/motion.mp4' : 'media/sustained.mp4',
        recipe: software
          ? [{ type: 'resize', width: 320, height: 180, method: 'lanczos' }]
          : [
              {
                type: 'smoothSlowMotion',
                numerator: 24,
                speed: 0.5,
                sceneCuts: [1],
              },
            ],
      },
    },
    tracks: [
      {
        type: 'video',
        clips: [
          {
            asset: 'motion',
            at: 0,
            sourceOut: seconds * (software ? 24 : 48),
            grade: {
              exposure: 0.15,
              temperature: 0,
              tint: 0,
              contrast: 1,
              saturation: 0.8,
              curve: [],
            },
          },
        ],
      },
    ],
  }),
);

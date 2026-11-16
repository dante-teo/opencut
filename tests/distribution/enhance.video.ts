import { defineVideo, videoParams } from '@opencut/sdk';

export default defineVideo(
  { method: videoParams.enum(['ai', 'lanczos', 'denoise']).default('ai') },
  ({ method }) => ({
    name: 'UHD detail study',
    canvas: { width: 3840, height: 2160, frameRate: 12, durationFrames: 12 },
    assets: {
      picture: {
        kind: 'video',
        path: 'media/low.mp4',
        recipe:
          method === 'denoise'
            ? [{ type: 'denoise', strength: 'medium' }]
            : method === 'ai'
              ? [{ type: 'superResolution', width: 3840, height: 2160 }]
              : [
                  {
                    type: 'resize',
                    width: 3840,
                    height: 2160,
                    method: 'lanczos',
                  },
                ],
      },
    },
    tracks: [
      {
        type: 'video',
        clips: [
          {
            asset: 'picture',
            at: 0,
            sourceOut: 12,
            grade: {
              exposure: 0,
              temperature: 0,
              tint: 0,
              contrast: 1,
              saturation: 1,
              curve: [],
            },
          },
        ],
      },
    ],
  }),
);

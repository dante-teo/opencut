import { defineVideo, videoParams } from '@opencut/sdk';

const frameRate = 24;
const frames = 54;

export default defineVideo(
  {
    analysisRef: videoParams.string().regex(/^[a-f0-9]{64}$/),
    diagnostic: videoParams.boolean().default(false),
  },
  ({ analysisRef, diagnostic }) => ({
    canvas: { width: 640, height: 480, frameRate },
    assets: {
      picture: {
        kind: 'video',
        path: 'generated/beauty-dev/held-out/full-body/source.mp4',
        recipe: [
          {
            type: 'beauty',
            analysisRef,
            acceptance: diagnostic ? 'allow-limitations' : 'complete-coverage',
            effects: [
              {
                type: 'beauty',
                version: 1,
                id: 'head-and-limb-length',
                target: {
                  assetId: 'picture',
                  shotId: 'shot-1',
                  trackId: 'person-1',
                },
                timeRange: { start: 0, end: frames / frameRate },
                parameters: {
                  headReduce: 0.15,
                  armLength: 0.25,
                  legLength: 0.25,
                },
                failurePolicy: { trackingUncertain: 'bypass' },
              },
            ],
          },
        ],
      },
    },
    tracks: [
      {
        type: 'video',
        clips: [{ asset: 'picture', at: 0, sourceOut: frames }],
      },
    ],
  }),
);

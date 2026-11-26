import { defineVideo, videoParams as z } from '@opencut/sdk';

export default defineVideo(
  {
    picture: z.string().min(1),
    frames: z.int().positive(),
    soundtrack: z.string().min(1).optional(),
    stepCards: z
      .array(
        z.strictObject({
          at: z.int().nonnegative(),
          duration: z.int().positive(),
          text: z.string().trim().min(1),
        }),
      )
      .default([]),
  },
  ({ picture, frames, soundtrack, stepCards }) => ({
    name: 'Vertical 4K60',
    canvas: {
      width: 2160,
      height: 3840,
      frameRate: 60,
      durationFrames: frames,
    },
    assets: {
      picture: { kind: 'video', path: picture },
      ...(soundtrack && { soundtrack: { kind: 'audio', path: soundtrack } }),
    },
    tracks: [
      {
        id: 'picture-track',
        type: 'video',
        clips: [
          {
            asset: 'picture',
            at: 0,
            sourceOut: frames,
            muted: soundtrack !== undefined,
            visual: { fit: 'cover' },
          },
        ],
      },
      {
        id: 'step-cards',
        type: 'text',
        clips: stepCards.map(({ at, duration, text }) => ({
          at,
          duration,
          text: {
            content: text,
            fontSize: 100,
            wrapWidth: 1680,
            color: '#ffffff',
            background: { color: '#151019e6', padding: 32 },
          },
          visual: { y: -1180 },
        })),
      },
      ...(soundtrack
        ? [
            {
              id: 'soundtrack-track',
              type: 'audio' as const,
              clips: [{ asset: 'soundtrack', at: 0, sourceOut: frames }],
            },
          ]
        : []),
    ],
  }),
);

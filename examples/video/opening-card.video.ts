import { defineVideo } from '@opencut/sdk';

export default defineVideo({
  name: 'Opening card',
  canvas: {
    width: 640,
    height: 360,
    frameRate: 24,
    durationFrames: 48,
    backgroundColor: '#182032',
  },
  tracks: [
    {
      type: 'text',
      clips: [
        {
          at: 0,
          duration: 48,
          text: { content: 'Opening card', fontSize: 54 },
          keyframes: {
            opacity: [
              {
                time: { numerator: 0, denominator: 1 },
                value: 0,
                easing: 'linear',
              },
              {
                time: { numerator: 1, denominator: 2 },
                value: 1,
                easing: 'ease-out',
              },
            ],
          },
        },
      ],
    },
  ],
  subtitles: {
    style: { fontSize: 28 },
    cues: [
      {
        id: 'opening',
        text: '今日开场',
        start: { numerator: 1, denominator: 2 },
        end: { numerator: 3, denominator: 2 },
      },
    ],
  },
});

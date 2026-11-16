import { defineVideo, videoParams } from '@opencut/sdk';

const seconds = (numerator: number) => ({ numerator, denominator: 1 });

export default defineVideo(
  { caption: videoParams.string().min(1).default('城市漫游') },
  ({ caption }) => ({
    name: 'City in motion',
    canvas: { width: 360, height: 640, frameRate: 24, durationFrames: 96 },
    assets: {
      street: { kind: 'video', path: 'media/street.mp4' },
      river: { kind: 'video', path: 'media/river.mp4' },
      music: { kind: 'audio', path: 'media/music.wav' },
    },
    tracks: [
      {
        type: 'video',
        clips: [
          {
            id: 'street-cut',
            asset: 'street',
            at: 0,
            sourceOut: 48,
            muted: true,
          },
          {
            id: 'river-cut',
            asset: 'river',
            at: 48,
            sourceOut: 48,
            muted: true,
          },
        ],
      },
      {
        type: 'text',
        clips: [
          {
            at: 6,
            duration: 36,
            text: { content: 'CITY IN MOTION', fontSize: 24 },
            keyframes: {
              opacity: [
                { time: seconds(0), value: 0, easing: 'linear' },
                {
                  time: { numerator: 1, denominator: 4 },
                  value: 1,
                  easing: 'ease-out',
                },
              ],
            },
          },
        ],
      },
      {
        type: 'audio',
        clips: [
          { asset: 'music', at: 0, sourceOut: 96, volume: 0.75, fadeOut: 12 },
        ],
      },
    ],
    subtitles: {
      style: { fontSize: 28 },
      cues: [
        { id: 'a', text: caption, start: seconds(1), end: seconds(2) },
        { id: 'b', text: '沿河而行', start: seconds(2), end: seconds(4) },
      ],
    },
  }),
);

import { defineVideo } from '@opencut/sdk';

export default defineVideo({
  version: 2,
  name: 'Tideline',
  canvas: { width: 1920, height: 1080, frameRate: 30, durationFrames: 390 },
  assets: {
    plate: { kind: 'graphic', renderer: 'svg', path: 'plate.svg' },
    tideline: {
      kind: 'graphic',
      renderer: 'react',
      path: 'Tideline.tsx',
      durationFrames: 390,
      width: 1920,
      height: 1080,
      animation: {
        version: 1,
        seed: 8042,
        parameters: { headline: 'string', accent: 'string' },
      },
      props: { headline: 'Read the tide', accent: '#ff896d' },
    },
    pulse: { kind: 'audio', path: 'pulse.wav' },
  },
  tracks: [
    {
      type: 'video',
      name: 'Chart paper',
      clips: [{ asset: 'plate', at: 0, duration: 390 }],
    },
    {
      type: 'video',
      name: 'Transparent animation',
      clips: [
        { id: 'tideline-overlay', asset: 'tideline', at: 0, sourceOut: 390 },
      ],
    },
    {
      type: 'audio',
      name: 'Sound cues',
      clips: [
        { asset: 'pulse', at: 5, sourceOut: 18, volume: 0.63 },
        { asset: 'pulse', at: 62, sourceOut: 18, volume: 0.36 },
        { asset: 'pulse', at: 123, sourceOut: 18, volume: 0.53 },
        { asset: 'pulse', at: 176, sourceOut: 18, volume: 0.44 },
        { asset: 'pulse', at: 251, sourceOut: 18, volume: 0.54 },
        { asset: 'pulse', at: 320, sourceOut: 18, volume: 0.43 },
      ],
    },
  ],
});

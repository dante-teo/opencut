import { defineVideo } from '@opencut/sdk';

export default defineVideo({
  canvas: { width: 160, height: 90, frameRate: 12, durationFrames: 12 },
  assets: {
    badge: { kind: 'graphic', renderer: 'svg', path: './Badge.svg' },
    card: {
      kind: 'graphic',
      renderer: 'react',
      path: './Graphic.tsx',
      durationFrames: 12,
      props: { label: '有效帧 / Frames', value: 12 },
    },
  },
  tracks: [
    { type: 'video', clips: [{ asset: 'card', at: 0, sourceOut: 12 }] },
    { type: 'video', clips: [{ asset: 'badge', at: 0, duration: 12 }] },
  ],
});

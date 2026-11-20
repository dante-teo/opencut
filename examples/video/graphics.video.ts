import { defineVideo } from '@opencut/sdk';

export default defineVideo({
  version: 2,
  name: 'Bilingual graphics examples',
  canvas: {
    width: 640,
    height: 360,
    frameRate: 24,
    durationFrames: 240,
    backgroundColor: '#152426',
  },
  assets: {
    section: {
      kind: 'graphic',
      renderer: 'react',
      path: '../graphics/Section.tsx',
      durationFrames: 60,
    },
    statistic: {
      kind: 'graphic',
      renderer: 'react',
      path: '../graphics/Statistic.tsx',
      durationFrames: 48,
    },
    chart: {
      kind: 'graphic',
      renderer: 'react',
      path: '../graphics/Chart.tsx',
      durationFrames: 84,
      width: 540,
      height: 360,
    },
    lower: {
      kind: 'graphic',
      renderer: 'react',
      path: '../graphics/Lower.tsx',
      durationFrames: 64,
    },
    callout: {
      kind: 'graphic',
      renderer: 'react',
      path: '../graphics/Callout.tsx',
      durationFrames: 48,
      props: { x: 0.91, y: 0.1, label: '品牌标记 / Brand mark' },
    },
    logo: { kind: 'graphic', renderer: 'svg', path: '../graphics/Mark.svg' },
  },
  tracks: [
    {
      type: 'video',
      clips: [
        { asset: 'section', at: 0, sourceOut: 60 },
        { asset: 'statistic', at: 60, sourceOut: 48 },
        { asset: 'chart', at: 108, sourceOut: 84, visual: { x: 100, y: -12 } },
        { asset: 'callout', at: 192, sourceOut: 48 },
      ],
    },
    {
      type: 'video',
      clips: [
        {
          asset: 'lower',
          at: 122,
          sourceOut: 64,
          visual: { scale: 0.82, x: -24, y: 16 },
        },
      ],
    },
    { type: 'video', clips: [{ asset: 'logo', at: 0, duration: 240 }] },
  ],
});

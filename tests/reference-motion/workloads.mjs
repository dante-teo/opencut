import { execFileSync } from 'node:child_process';
import * as console from 'node:console';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { URL, fileURLToPath } from 'node:url';

const root = new URL(
  '../fixtures/generated/reference-motion/workloads/',
  import.meta.url,
);
await mkdir(root, { recursive: true });
const water = { kind: 'video', path: '../assets/water.mp4' };
const base = ({ seconds, width = 1920, height = 1080 } = {}) => ({
  canvas: {
    width,
    height,
    frameRate: 30,
    durationFrames: seconds * 30,
    backgroundColor: '#132638',
  },
  assets: { water },
  tracks: [
    {
      type: 'video',
      id: 'footage',
      clips: [
        {
          asset: 'water',
          at: 0,
          sourceIn: 60,
          sourceOut: 60 + Math.min(seconds, 20) * 30,
          visual: { fit: 'cover' },
        },
      ],
    },
  ],
});
const editorial = base({ seconds: 180 });
editorial.tracks[0].clips = Array.from({ length: 128 }, (_, i) => {
  const at = Math.round((5400 * i) / 128);
  const count = Math.round((5400 * (i + 1)) / 128) - at;
  return {
    id: 'cut-' + i,
    asset: 'water',
    at,
    sourceIn: (i * 7) % 480,
    sourceOut: ((i * 7) % 480) + count,
    visual: { fit: 'cover' },
  };
});
editorial.subtitles = {
  style: { fontSize: 45, stroke: { color: '#101d2b', width: 2 } },
  cues: Array.from({ length: 512 }, (_, i) => ({
    id: 'cue-' + i,
    text: `站点 ${i + 1} · Station ${i + 1}`,
    start: { numerator: Math.round((5400 * i) / 512), denominator: 30 },
    end: { numerator: Math.round((5400 * (i + 1)) / 512), denominator: 30 },
  })),
};
const sustained = base({ seconds: 60 });
sustained.version = 3;
sustained.tracks[0].clips = Array.from({ length: 3 }, (_, i) => ({
  asset: 'water',
  at: i * 600,
  sourceIn: 60,
  sourceOut: 660,
}));
for (const [i, color] of [
  '#56e0d1',
  '#fa9c65',
  '#a39ffc',
  '#28535f',
  '#487a8c',
].entries()) {
  const asset = 'panel-' + i;
  sustained.assets[asset] = {
    kind: 'graphic',
    renderer: 'scene',
    width: 256,
    height: 144,
    durationFrames: 1800,
    scene: {
      version: 1,
      units: 'px',
      children: [
        {
          type: 'rect',
          id: 'panel',
          x: 0,
          y: 14,
          width:
            i < 3
              ? {
                  keys: [
                    { at: 0, value: 16 },
                    { at: 90 + i * 18, value: 238 },
                  ],
                  cycle: { mode: 'ping-pong', duration: 90 + i * 18 },
                }
              : 238,
          height: 99,
          fill: color,
          radius: 18,
        },
        {
          type: 'text',
          id: 'index',
          x: 18,
          y: 26,
          width: 180,
          height: 70,
          size: 35,
          color: '#ffffff',
          content: `Channel ${i + 1}`,
        },
      ],
    },
  };
  sustained.tracks.push({
    type: 'video',
    id: asset + '-track',
    clips: [
      {
        asset,
        at: 0,
        sourceOut: 1800,
        visual: { scale: 0.15, x: -690 + i * 340, y: 310 },
      },
    ],
  });
}
const noise = fileURLToPath(new URL('cache-noise.png', root));
if (!existsSync(noise))
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-n',
    '-f',
    'lavfi',
    '-i',
    'color=c=gray:s=1920x1080,format=gbrp,noise=alls=100:allf=u',
    '-frames:v',
    '1',
    '-threads',
    '1',
    noise,
  ]);
const cacheLimit = {
  ...base({ seconds: 3.2 }),
  version: 3,
  assets: {
    noise: {
      kind: 'graphic',
      renderer: 'scene',
      durationFrames: 96,
      resources: { sample: 'cache-noise.png' },
      scene: {
        version: 1,
        units: 'px',
        children: [
          {
            type: 'image',
            id: 'noise',
            resource: 'sample',
            width: 1920,
            height: 1080,
          },
          {
            type: 'rect',
            id: 'marker',
            x: {
              keys: [
                { at: 0, value: 20 },
                { at: 95, value: 1800 },
              ],
            },
            y: 50,
            width: 72,
            height: 72,
            fill: '#00ee88',
          },
        ],
      },
    },
  },
  tracks: [
    {
      type: 'video',
      id: 'cache-frames',
      clips: [{ asset: 'noise', at: 0, sourceOut: 96 }],
    },
  ],
};
const jobs = {
  editorial,
  sustained,
  'cache-limit': cacheLimit,
  'uhd-wide': base({ seconds: 10, width: 3840, height: 2160 }),
  'uhd-tall': base({ seconds: 10, width: 2160, height: 3840 }),
  ordinary: base({ seconds: 6 }),
};
for (const [name, video] of Object.entries(jobs)) {
  await writeFile(
    new URL(name + '.video.json', root),
    JSON.stringify(video, null, 2) + '\n',
  );
  if (name === 'ordinary')
    await writeFile(
      new URL(name + '.video.ts', root),
      'export default ' + JSON.stringify(video) + ';\n',
    );
}
console.log(fileURLToPath(root));

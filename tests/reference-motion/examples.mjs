import * as console from 'node:console';
import { readFile, writeFile } from 'node:fs/promises';
import { URL, fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';

const project = new URL('../../examples/motion/', import.meta.url);
const source = '../../tests/fixtures/generated/reference-motion/assets/';
const captions = JSON.parse(
  await readFile(new URL('./field-captions.json', import.meta.url), 'utf8'),
);
const ink = '#eaf5f1';
const sea = '#54e1cc';
const midnight = '#101d2b';
const curve = { type: 'cubic-bezier', x1: 0.32, y1: 0, x2: 0.18, y2: 1 };
const motion = (from, to, start, end, easing = curve) => ({
  keys: [
    { at: start, value: from, easing },
    { at: end, value: to },
  ],
});
const rect = (id, x, y, width, height, fill, extra = {}) => ({
  id,
  type: 'rect',
  x,
  y,
  width,
  height,
  fill,
  ...extra,
});
const text = (id, content, x, y, size, width, height, extra = {}) => ({
  id,
  type: 'text',
  content,
  width,
  height,
  x,
  y,
  size,
  color: ink,
  font: 'reference',
  overflow: 'fit',
  minSize: Math.min(26, size),
  ...extra,
});
const label = (id, content, x, y, extra = {}) =>
  text(id, content, x, y, 26, 1600, 38, { color: sea, ...extra });
const path = (id, d, stroke, strokeWidth = 3, extra = {}) => ({
  id,
  type: 'path',
  d,
  stroke,
  strokeWidth,
  ...extra,
});
const group = (id, children, extra = {}) => ({
  id,
  type: 'group',
  children,
  ...extra,
});
const grad = (angle, ...colors) => ({
  angle,
  stops: colors.map((color, i) => ({ color, offset: i / (colors.length - 1) })),
});
const scene = (durationFrames, children, extra = {}) => ({
  kind: 'graphic',
  renderer: 'scene',
  durationFrames,
  scene: { version: 1, units: 'px', children },
  resources: { reference: source + 'font.ttf' },
  ...extra,
});
const track = (id, clips, type = 'video', extra = {}) => ({
  id,
  type,
  clips,
  ...extra,
});
const clip = (id, asset, at, sourceOut, sourceIn = 0, extra = {}) => ({
  id,
  asset,
  at,
  sourceIn,
  sourceOut,
  ...extra,
});
const media = (filename, kind = 'video') => ({ kind, path: source + filename });
const video = (name, durationFrames, assets, tracks, extra = {}) => ({
  version: 3,
  name,
  canvas: {
    width: 1920,
    height: 1080,
    frameRate: 30,
    durationFrames,
    backgroundColor: midnight,
  },
  assets,
  tracks,
  ...extra,
});

function timedCaption({ words, zh }, index) {
  let english = '';
  const highlight = words.map(([start, end, word]) => {
    if (english) english += ' ';
    const from = english.length;
    english += word;
    return {
      from,
      to: english.length,
      start: (start - 10) * 30,
      end: (end - 10) * 30,
      background: sea,
      color: midnight,
    };
  });
  const first = highlight[0].start;
  const last = Math.min(900, highlight.at(-1).end + 4.8);
  return group(
    'caption-' + index,
    [
      text('english-' + index, english, 86, 1380, 55, 908, 156, {
        align: 'center',
        lineHeight: 1.12,
        weight: 800,
        highlight,
        effects: { shadow: { x: 0, y: 3, blur: 6, color: '#00101c' } },
      }),
      text('chinese-' + index, zh, 86, 1547, 43, 908, 68, {
        color: '#d7eae4',
        align: 'center',
        weight: 500,
      }),
    ],
    { timing: { at: first, in: first, duration: last - first } },
  );
}

const FieldNotes = video(
  'Field Notes',
  900,
  {
    speaker: media('speaker.mp4'),
    scenery: media('water.mp4'),
    speech: media('speech-padded.wav', 'audio'),
    score: media('score.wav', 'audio'),
    captions: scene(900, [
      rect(
        'shadow-gradient',
        0,
        943,
        1080,
        977,
        grad(180, '#08162800', '#081628e6'),
      ),
      label('masthead', 'FIELD NOTES / 国家公园', 86, 104, {
        color: ink,
        width: 908,
      }),
      rect('masthead-rule', 86, 149, motion(0, 270, 0, 42), 6, sea),
      group(
        'lower-third',
        [
          rect('lower-card', 86, 1120, 661, 159, '#112233e8'),
          rect('lower-rule', 86, 1120, 8, 159, sea),
          text('speaker-name', 'Barack Obama', 120, 1137, 54, 575, 72, {
            weight: 800,
          }),
          text(
            'speaker-detail',
            'White House archive · 白宫档案',
            120,
            1210,
            31,
            575,
            46,
            { color: sea },
          ),
        ],
        {
          timing: { at: 45, duration: 120 },
          x: motion(-34, 0, 0, 16),
          opacity: {
            keys: [
              { at: 0, value: 0, easing: curve },
              { at: 11, value: 1 },
              { at: 106, value: 1, easing: curve },
              { at: 119, value: 0 },
            ],
          },
        },
      ),
      ...captions.map(timedCaption),
      rect('progress-rail', 86, 1797, 908, 4, '#ffffff40'),
      rect('progress', 86, 1797, motion(1, 908, 0, 899, 'linear'), 4, sea),
    ]),
  },
  [
    track('speaker-track', [
      clip('talking-head', 'speaker', 0, 1200, 300, {
        visual: { fit: 'cover' },
      }),
    ]),
    track('b-roll', [
      clip('first-b-roll', 'scenery', 240, 150, 30, {
        visual: { fit: 'cover' },
      }),
      clip('second-b-roll', 'scenery', 540, 390, 240, {
        visual: { fit: 'cover' },
      }),
    ]),
    track('graphics', [clip('field-graphics', 'captions', 0, 900)]),
    track('speech-track', [clip('dialogue', 'speech', 0, 1200, 300)], 'audio', {
      audioRole: 'dialogue',
    }),
    track(
      'score-track',
      [
        clip('music', 'score', 0, 900, 0, {
          volume: 0.48,
          fadeIn: 25,
          fadeOut: 50,
        }),
      ],
      'audio',
      { audioRole: 'music' },
    ),
  ],
  {
    canvas: {
      width: 1080,
      height: 1920,
      frameRate: 30,
      durationFrames: 900,
      backgroundColor: midnight,
    },
  },
);

function device(id, title, detail, x, y, angle, accent, width) {
  return group(
    id,
    [
      rect(
        id + '-shell',
        0,
        0,
        width,
        340,
        grad(160, accent + '70', '#18254a', '#09152b'),
        { radius: 28 },
      ),
      rect(id + '-edge', 0, 0, width, 3, accent, { radius: 3 }),
      label(id + '-label', detail, 44, 38, {
        color: accent,
        width: width - 88,
      }),
      text(id + '-name', title, 44, 108, 83, width - 88, 108, { weight: 900 }),
      path(
        id + '-trace',
        'M44 281 C138 302 156 218 245 255 S394 287 534 219',
        accent,
        5,
      ),
    ],
    {
      x,
      y,
      perspective: 950,
      rotateY: angle,
      rotateX: 6,
      origin: [width / 2, 170],
      effects: { shadow: { x: 0, y: 58, blur: 45, color: '#03061bba' } },
    },
  );
}

const prismDuration = 345;
const prismNodes = [
  rect('backing', 0, 0, 1920, 1080, grad(130, '#35436d', '#1b2347', '#121128')),
  rect('gradient-lens', 0, 0, 1920, 1080, grad(120, '#44cabc44', '#b752df65'), {
    mask: {
      type: 'ellipse',
      x: 1075,
      y: 691,
      radiusX: motion(0, 864, 0, 54),
      radiusY: 616,
    },
  }),
  label('product-label', 'PRISM SYSTEMS / PRODUCT STUDY', 0, 101, {
    align: 'center',
    width: 1920,
  }),
  text('product-title', 'See the current.', 0, 142, 109, 1920, 155, {
    align: 'center',
    weight: 900,
    kinetic: { unit: 'grapheme', stagger: 2, duration: 18, offsetY: 45 },
  }),
  device('side', 'Flow', '02 / MONITOR', 990, 410, -22, '#a39ffc', 580),
  device(
    'lead',
    'Prism',
    '01 / CONTROL',
    motion(320, 610, 0, 90, {
      type: 'spring',
      mass: 1,
      stiffness: 175,
      damping: 13,
      duration: 3,
    }),
    460,
    18,
    '#72ffe5',
    700,
  ),
];
const Prism = video(
  'Prism',
  600,
  {
    prismMotion: scene(90, prismNodes, {
      motionBlur: { samples: 8, shutterAngle: 180 },
    }),
    prism: scene(prismDuration, prismNodes),
    scenery: media('water.mp4'),
    outro: scene(276, [
      rect('grade', 0, 0, 1920, 1080, '#13122c52'),
      group(
        'outro-title',
        [
          label('outro-tag', 'PRISM / 2026', 132, 819),
          text('outro-copy', 'Find the flow.', 132, 861, 76, 910, 115, {
            weight: 850,
          }),
        ],
        {
          opacity: motion(0, 1, 0, 41),
          effects: { shadow: { x: 0, y: 4, blur: 12, color: '#020b1a' } },
        },
      ),
    ]),
  },
  [
    track('product-cut', [
      clip('product-motion', 'prismMotion', 0, 90),
      clip('product', 'prism', 90, 330, 90),
      clip('water', 'scenery', 330, 285, 15),
    ]),
    track('end-card', [clip('outro-placement', 'outro', 324, 276)]),
  ],
  {
    transitions: [
      {
        id: 'product-to-water',
        kind: 'cross-dissolve',
        from: 'product',
        to: 'water',
        frames: 30,
        style: {
          kind: 'wipe',
          direction: 'left',
          easing: { type: 'cubic-bezier', x1: 0.32, y1: 0, x2: 0.18, y2: 1 },
        },
      },
    ],
  },
);

function chart(values) {
  const baseline = 790;
  const stations = [
    'North pass',
    'Estuary',
    'International catchment intake',
    'South basin',
  ];
  const points = values.map((value, i) => [
    362 + i * 330,
    baseline - value * 4.8,
  ]);
  const line = points
    .map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y - 28}`)
    .join(' ');
  return [
    ...[0, 25, 50, 75, 100].flatMap((n) => [
      path('grid-' + n, `M212 ${baseline - n * 4.8} H1700`, '#ffffff26', 2),
      text('tick-' + n, String(n), 125, baseline - n * 4.8 - 17, 26, 62, 36, {
        color: '#a2bcc8',
        align: 'right',
      }),
    ]),
    ...points.flatMap(([x, y], i) => {
      const start = 38 + i * 21;
      const height = motion(0, baseline - y, start, start + 122);
      return [
        rect(
          'bar-' + i,
          x - 68,
          motion(baseline, y, start, start + 122),
          136,
          height,
          i === 3 ? '#a4f0d7' : '#258f98',
          { radius: 9 },
        ),
        text(
          'counter-' + i,
          undefined,
          x - 80,
          motion(735, y - 55, start, start + 122),
          37,
          160,
          48,
          {
            counter: { value: motion(0, values[i], start, start + 122) },
            align: 'center',
          },
        ),
        text('station-' + i, stations[i], x - 145, 829, 31, 290, 91, {
          align: 'center',
          color: '#b7d2d7',
          weight: 500,
        }),
      ];
    }),
    path('trend', line, '#ffc984', 7, { draw: motion(0, 1, 220, 389) }),
    group(
      'callout',
      [
        path(
          'leader',
          `M${points[3][0]} ${points[3][1] - 28} l85 -80 h150`,
          '#ffcb87',
        ),
        text(
          'highest',
          'Highest intake',
          points[3][0] + 92,
          points[3][1] - 146,
          24,
          220,
          42,
          { color: '#ffcb87' },
        ),
      ],
      { opacity: motion(0, 1, 356, 395) },
    ),
  ];
}

const Waterline = video(
  'Waterline',
  600,
  {
    chart: scene(600, [
      rect('reading-background', 0, 0, 1920, 1080, '#102234'),
      label('reading-tag', 'COMMUNITY WATER / FIELD INDEX', 130, 86),
      text('reading-title', 'Waterline', 130, 126, 96, 1120, 118, {
        weight: 850,
      }),
      text(
        'reading-subtitle',
        'Normalized intake readings by station',
        130,
        247,
        39,
        1130,
        55,
        { color: '#97b9c2', weight: 500 },
      ),
      group('stations', chart([24, 45, 72, 90])),
      label('reading-source', 'SOURCE / SYNTHETIC STATION DATA', 130, 968),
    ]),
  },
  [track('graphics', [clip('readings', 'chart', 0, 600)])],
);

function signalScene(pitch) {
  const markerTimes = [45, 135, 255].flatMap((beat) =>
    Array.from({ length: 8 }, (_, i) => ({
      numerator: beat + i,
      denominator: 30,
    })),
  );
  return video(
    'Signal',
    450,
    {
      tone: media(`signal-${pitch}.wav`, 'audio'),
      displays: scene(
        450,
        [
          rect('signal-background', 0, 0, 1920, 1080, '#141425'),
          label('signal-label', 'LAB / AUDIO TELEMETRY', 132, 94, {
            color: '#ffbf83',
          }),
          text('signal-title', 'Signal', 132, 134, 92, 970, 124, {
            weight: 900,
          }),
          text(
            'signal-tone',
            `${pitch} Hz test tone · 48 kHz PCM`,
            132,
            254,
            36,
            1260,
            65,
            { color: '#a4adc8' },
          ),
          rect('wave-panel', 132, 363, 1656, 290, '#23243e', { radius: 24 }),
          {
            id: 'wave',
            type: 'audio',
            mode: 'waveform',
            x: 156,
            y: 374,
            width: 1608,
            height: 264,
            color: sea,
            gain: 3.2,
          },
          {
            id: 'bins',
            type: 'audio',
            mode: 'spectrum',
            x: 132,
            y: 719,
            width: 1656,
            height: 190,
            color: '#ffbf83',
            gain: 5.6,
            timing: { at: 15 },
          },
          {
            id: 'beat-cell',
            type: 'audio',
            mode: 'beat',
            x: 1694,
            y: 124,
            width: 52,
            height: 52,
            color: '#ffad73',
          },
          label('signal-offset', 'TRIM 01.000 S / OFFSET 00.500 S', 132, 953),
        ],
        {
          audioAnalysis: {
            version: 1,
            source: 'mix',
            window: 2048,
            hop: 256,
            waveform: 192,
            bins: 48,
            beats: markerTimes,
          },
        },
      ),
    },
    [
      track('monitor', [clip('signal-graphics', 'displays', 0, 450)]),
      track(
        'source',
        [clip('signal-tone', 'tone', 15, 465, 30, { volume: 0.7 })],
        'audio',
      ),
    ],
  );
}

const Relay = video(
  'Relay',
  300,
  {
    scenery: media('water.mp4'),
    relay: {
      kind: 'graphic',
      renderer: 'lottie',
      path: source + 'relay.json',
      durationFrames: 360,
      outOfRange: 'hold',
    },
    titles: scene(300, [
      rect('relay-grade', 0, 0, 1920, 1080, '#101d2b59'),
      label('relay-first', 'VECTOR TELEMETRY / 1×', 132, 860, {
        timing: { at: 0, duration: 150 },
      }),
      label('relay-second', 'VECTOR TELEMETRY / 1.5×', 132, 860, {
        timing: { at: 150, duration: 150 },
      }),
      text('relay-title', 'Relay', 132, 905, 76, 740, 112, { weight: 850 }),
    ]),
  },
  [
    track('background', [clip('water', 'scenery', 0, 390, 90)]),
    track('titles-track', [clip('relay-labels', 'titles', 0, 300)]),
    track('vector', [
      clip('first-beacon', 'relay', 0, 174, 24),
      clip('second-beacon', 'relay', 150, 297, 72, {
        speed: { numerator: 3, denominator: 2 },
      }),
    ]),
  ],
);

function orbit(axis) {
  return {
    keys: Array.from({ length: 17 }, (_, i) => {
      const angle = -0.61 + (1.35 * i) / 16;
      return { at: (299 * i) / 16, value: 5.4 * Math[axis](angle) };
    }),
  };
}
const Parallax = video(
  'Parallax',
  300,
  {
    scenery: media('water.mp4'),
    model: {
      kind: 'graphic',
      renderer: 'three',
      path: source + 'parallax.glb',
      durationFrames: 300,
      scene: {
        version: 1,
        camera: {
          position: [orbit('sin'), 1.7, orbit('cos')],
          target: [0, -0.02, 0],
          fov: 40,
        },
        lights: [
          {
            type: 'directional',
            color: '#fff2df',
            intensity: 2.6,
            position: [2, 4, 5],
          },
          { type: 'ambient', color: '#c4e9ff', intensity: 2 },
        ],
      },
    },
    titles: scene(300, [
      rect('parallax-grade', 0, 0, 1920, 1080, '#101d2b75'),
      label('parallax-tag', 'VOLUME STUDIES / 01', 133, 106),
      text('parallax-title', 'Parallax', 133, 147, 82, 910, 128, {
        weight: 850,
      }),
    ]),
  },
  [
    track('background', [clip('water', 'scenery', 0, 540, 240)]),
    track('titles-track', [clip('parallax-labels', 'titles', 0, 300)]),
    track('depth', [clip('model-3d', 'model', 0, 300)]),
  ],
);

async function writeDefinition(name, code) {
  const filepath = fileURLToPath(new URL(name + '.video.ts', project));
  const config = await resolveConfig(filepath);
  await writeFile(filepath, await format(code, { ...config, filepath }));
}

for (const [name, composition] of Object.entries({
  'field-notes': FieldNotes,
  prism: Prism,
  relay: Relay,
  parallax: Parallax,
}))
  await writeDefinition(
    name,
    `
    import { defineVideo } from '@opencut/sdk';
    export default defineVideo(${JSON.stringify(composition)});
  `,
  );

await writeDefinition(
  'waterline',
  `
  import { defineVideo, videoParams, type VideoDefinition } from '@opencut/sdk';
  const composition = ${JSON.stringify(Waterline)};
  export default defineVideo(
    {
      bars: videoParams
        .array(videoParams.json())
        .min(1)
        .default(${JSON.stringify(chart([24, 45, 72, 90]))}),
    },
    ({ bars }) => {
      const data = structuredClone(composition);
      Object.assign(data.assets.chart.scene.children[4]!, { children: bars });
      return data as VideoDefinition;
    },
  );
`,
);

const lowTone = source + 'signal-220.wav';
const highTone = source + 'signal-880.wav';
await writeDefinition(
  'signal',
  `
  import { defineVideo, videoParams, type VideoDefinition } from '@opencut/sdk';
  const composition = ${JSON.stringify(signalScene(220))};
  export default defineVideo(
    {
      audio: videoParams.enum(${JSON.stringify([lowTone, highTone])}).default(${JSON.stringify(lowTone)}),
      description: videoParams.string().default('220 Hz test tone · 48 kHz PCM'),
    },
    ({ audio, description }) => {
      const data = structuredClone(composition);
      data.assets.tone.path = audio;
      Object.assign(data.assets.displays.scene.children[3]!, { content: description });
      return data as VideoDefinition;
    },
  );
`,
);

await writeFile(
  new URL('waterline-alt.params.json', project),
  JSON.stringify({ bars: chart([35, 55, 65, 80]) }, null, 2) + '\n',
);
await writeFile(
  new URL('signal-alt.params.json', project),
  JSON.stringify(
    {
      audio: highTone,
      description: '880 Hz test tone · 48 kHz PCM',
    },
    null,
    2,
  ) + '\n',
);
console.log(fileURLToPath(project));

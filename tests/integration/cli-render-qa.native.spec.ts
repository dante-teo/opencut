import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fixtureDirectory } from '../fixture-paths.js';
import {
  command,
  decodeFrames,
  ffmpeg,
  verifyVideoTimestamps,
} from './media-comparison.js';

await mkdir(fixtureDirectory, { recursive: true });

const cli = fileURLToPath(
  new URL('../../apps/cli/dist/index.js', import.meta.url),
);
const run = (...args: string[]) =>
  spawnSync(process.execPath, [cli, ...args, '--json'], {
    encoding: 'utf8',
    timeout: 90_000,
    env: {
      ...process.env,
      NODE_NO_WARNINGS: '1',
      XDG_CACHE_HOME: join(
        dirname(
          args.find(
            (value) => value.endsWith('.video.ts') || value.endsWith('.mp4'),
          )!,
        ),
        'test-cache',
      ),
    },
  });
function json(...args: string[]) {
  const result = run(...args);
  assert.equal(result.status, 0, result.stderr);
  return {
    data: JSON.parse(result.stdout),
    progress: result.stderr
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  };
}

const colors = [
  '0x101010',
  '0x707070',
  '0xeeeeee',
  '0xb04020',
  '0x359354',
  '0x243591',
];
function patches(directory: string, rate = 60, frames = 40) {
  const path = join(directory, 'patches.mov');
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `color=s=192x256:r=${rate},format=rgb24`,
    '-vf',
    colors
      .map(
        (color, i) =>
          `drawbox=x=${(i % 3) * 64}:y=${Math.floor(i / 3) * 128}:w=64:h=128:color=${color}:t=fill`,
      )
      .join(',') +
      ',scale=in_range=pc:out_range=pc:out_color_matrix=bt709,format=yuv444p,setparams=range=pc:colorspace=bt709:color_primaries=bt709:color_trc=bt709',
    '-frames:v',
    String(frames),
    '-c:v',
    'libx264',
    '-crf',
    '0',
    path,
  ]);
  return path;
}
function colorInfo(path: string) {
  return JSON.parse(
    command('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=color_range,color_space,color_primaries,color_transfer,pix_fmt',
      '-of',
      'json',
      path,
    ]).toString(),
  ).streams[0];
}
const expected = {
  pix_fmt: 'yuv420p',
  color_range: 'tv',
  color_space: 'bt709',
  color_transfer: 'bt709',
  color_primaries: 'bt709',
};
const raw = (path: string) =>
  ffmpeg([
    '-i',
    path,
    '-c:v',
    'rawvideo',
    '-threads',
    '1',
    '-pix_fmt',
    'yuv420p',
    '-f',
    'rawvideo',
    'pipe:1',
  ]);
function worst(a: Buffer, b: Buffer) {
  assert.equal(a.length, b.length);
  let max = 0;
  for (let i = 0; i < a.length; i++)
    max = Math.max(max, Math.abs(a[i]! - b[i]!));
  return max;
}

test('limited BT.709 picture stays continuous across cache and bounded picture seams', async (t) => {
  const directory = await mkdtemp(join(fixtureDirectory, 'cli-weak-seams-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  patches(directory);
  const definition = join(directory, 'seams.video.ts');
  const recipe = join(directory, 'recipes');
  const cache = join(directory, 'pictures');
  const base = {
    canvas: { width: 192, height: 256, frameRate: 60, durationFrames: 40 },
    assets: { shot: { path: 'patches.mov', kind: 'video' } },
    tracks: [
      {
        type: 'video',
        clips: [{ id: 'full-shot', asset: 'shot', at: 0, sourceOut: 40 }],
      },
    ],
  };
  const write = (count: number) =>
    writeFile(
      definition,
      'export default ' +
        JSON.stringify({
          ...base,
          tracks: [
            ...base.tracks,
            ...(count
              ? [
                  {
                    type: 'text',
                    clips: Array.from({ length: count }, (_, i) => ({
                      at: i + 4,
                      duration: 1,
                      text: { content: 'invisible' },
                      visual: { opacity: 0 },
                    })),
                  },
                ]
              : []),
          ],
        }),
    );
  const render = (name: string, ...extra: string[]) =>
    json(
      'render',
      definition,
      '--output',
      join(directory, name + '.mp4'),
      '--recipe-cache',
      recipe,
      '--codec',
      'hevc',
      ...extra,
    );
  await write(0);
  const baseRender = render('unsegmented');
  assert.ok(!baseRender.data.pictureRanges);
  await write(1);
  const cold = render('segmented', '--picture-cache', cache);
  const warm = render('cache-hit', '--picture-cache', cache);
  assert.deepEqual(
    cold.data.pictureRanges.map(
      ({ startFrame }: { startFrame: number }) => startFrame,
    ),
    [0, 4, 5],
  );
  assert.ok(
    warm.data.pictureRanges.every(
      ({ status }: { status: string }) => status === 'reused',
    ),
  );
  assert.deepEqual(raw(cold.data.path), raw(warm.data.path));
  await write(34);
  const bounded = render('bounded');
  assert.ok(bounded.data.pictureRanges.length > 1);
  const frames = [
    ...new Set([
      3,
      4,
      5,
      ...bounded.data.pictureRanges
        .slice(1)
        .flatMap(({ startFrame }: { startFrame: number }) => [
          startFrame - 1,
          startFrame,
        ]),
    ]),
  ];
  const reference = decodeFrames(baseRender.data.path, frames, 192, 256);
  for (const result of [baseRender, cold, warm, bounded]) {
    assert.deepEqual(colorInfo(result.data.path), expected);
    const decoded = decodeFrames(result.data.path, frames, 192, 256);
    for (const frame of frames)
      assert.ok(
        worst(reference.get(frame)!, decoded.get(frame)!) <= 4,
        `RGB error at frame ${frame}`,
      );
    for (const frame of [
      4,
      ...bounded.data.pictureRanges
        .slice(1)
        .map(({ startFrame }: { startFrame: number }) => startFrame),
    ])
      assert.ok(
        worst(decoded.get(frame - 1)!, decoded.get(frame)!) <= 4,
        `RGB seam at ${frame}`,
      );
  }
  const picture = join(cache, 'picture-v1');
  let losslessFrame: Buffer | undefined;
  let intermediate = '';
  for (const key of (await readdir(picture)).filter((item) =>
    /^[a-f0-9]{64}$/.test(item),
  )) {
    intermediate = join(picture, key, 'media.mkv');
    assert.deepEqual(colorInfo(intermediate), expected);
    const bytes = raw(intermediate);
    const stride = (192 * 256 * 3) / 2;
    for (let i = 0; i < bytes.length; i += stride) {
      const frame = bytes.subarray(i, i + stride);
      losslessFrame ??= frame;
      assert.deepEqual(frame, losslessFrame);
    }
  }
  assert.ok(losslessFrame);
  // Recreate the 0.6.0 transport and compare metadata and the pixel payload.
  const legacy = join(directory, 'legacy.nut');
  ffmpeg(['-i', intermediate, '-c:v', 'copy', legacy]);
  const legacyColor = colorInfo(legacy);
  assert.deepEqual(raw(legacy), raw(intermediate));
  t.diagnostic(
    `Legacy NUT probe returned ${JSON.stringify(legacyColor)}. Lossless stage bytes were exact.`,
  );
  const progressed = new Set(cold.progress.map(({ stage }) => stage));
  for (const stage of ['composition', 'encoding', 'verification'])
    assert.ok(progressed.has(stage));
});

test('hardware delivery exercises limited BT.709 at 2160×3840, 60 fps and separates encoded cache settings', async (t) => {
  if (process.platform !== 'darwin')
    return t.skip('VideoToolbox requires macOS');
  const probe = spawnSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=s=2160x3840:r=60',
    '-frames:v',
    '2',
    '-c:v',
    'hevc_videotoolbox',
    '-allow_sw',
    '0',
    '-f',
    'null',
    '-',
  ]);
  if (probe.status !== 0) return t.skip('HEVC hardware session unavailable');
  const directory = await mkdtemp(join(fixtureDirectory, 'hardware-4k60-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  patches(directory, 60, 8);
  const definition = join(directory, 'hardware.video.ts');
  await writeFile(
    definition,
    'export default ' +
      JSON.stringify({
        canvas: { width: 192, height: 256, frameRate: 60, durationFrames: 8 },
        assets: { shot: { path: 'patches.mov', kind: 'video' } },
        tracks: [
          { type: 'video', clips: [{ asset: 'shot', at: 0, sourceOut: 8 }] },
          {
            type: 'text',
            clips: [
              {
                at: 4,
                duration: 1,
                text: { content: 'hidden' },
                visual: { opacity: 0 },
              },
            ],
          },
        ],
      }),
  );
  const cache = join(directory, 'pictures');
  const output = join(directory, 'hardware.mp4');
  const shared = [
    '--codec',
    'hevc',
    '--width',
    '2160',
    '--height',
    '3840',
    '--fps',
    '60',
    '--picture-cache',
    cache,
    '--recipe-cache',
    join(directory, 'recipes'),
  ];
  const rendered = json(
    'render',
    definition,
    '--output',
    output,
    '--encoder',
    'videotoolbox',
    '--picture-version',
    'save',
    ...shared,
  ).data;
  assert.equal(rendered.encoder.name, 'hevc_videotoolbox');
  assert.equal(rendered.encoder.settings.allowSoftware, false);
  assert.deepEqual([rendered.width, rendered.height], [2160, 3840]);
  assert.deepEqual(colorInfo(output), expected);
  verifyVideoTimestamps(output, { numerator: 60, denominator: 1 }, 8);
  const decoded = ffmpeg([
    '-i',
    output,
    '-vf',
    "select='between(n,3,4)',scale=192:256",
    '-fps_mode',
    'passthrough',
    '-c:v',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    '-threads',
    '1',
    '-f',
    'rawvideo',
    '-',
  ]);
  const stride = 192 * 256 * 3;
  assert.equal(decoded.length, stride * 2);
  assert.ok(worst(decoded.subarray(0, stride), decoded.subarray(stride)) <= 8);
  const reused = json(
    'render',
    definition,
    '--output',
    join(directory, 'reused.mp4'),
    '--encoder',
    'auto',
    '--picture-version',
    rendered.pictureVersion.id,
    ...shared,
  ).data;
  assert.equal(reused.pictureVersion.status, 'reused');
  const mismatch = run(
    'render',
    definition,
    '--output',
    join(directory, 'mismatch.mp4'),
    '--picture-version',
    rendered.pictureVersion.id,
    ...shared,
  );
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /video export settings changed/);
});

test('source framing resolves left-anchored pixels in preview and export and keeps legacy crop semantics', async (t) => {
  const directory = await mkdtemp(join(fixtureDirectory, 'source-framing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'asymmetric.png');
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'color=red:s=120x160,drawbox=x=90:y=0:w=30:h=160:color=blue:t=fill',
    '-frames:v',
    '1',
    '-threads',
    '1',
    source,
  ]);
  const definition = join(directory, 'framing.video.ts');
  const frame = join(directory, 'preview.png');
  const output = join(directory, 'export.mp4');
  const window = { x: 0, y: 0, width: 90, height: 160 };
  const write = (visual: object) =>
    writeFile(
      definition,
      'export default ' +
        JSON.stringify({
          canvas: { width: 90, height: 160, frameRate: 24, durationFrames: 4 },
          assets: { source: { path: 'asymmetric.png', kind: 'image' } },
          tracks: [
            {
              type: 'video',
              clips: [{ asset: 'source', at: 0, duration: 4, visual }],
            },
          ],
        }),
    );
  await write({ fit: 'cover', sourceWindow: window });
  const inspect = () =>
    json('timeline', 'inspect', definition, '--frame', '0').data.visualClips[0];
  const framing = inspect().framing;
  assert.deepEqual(framing.sourceWindow, window);
  assert.deepEqual(framing.destinationBounds, window);
  assert.deepEqual(framing.visibleSourceRegion.polygon, [
    { x: 0, y: 0 },
    { x: 90, y: 0 },
    { x: 90, y: 160 },
    { x: 0, y: 160 },
  ]);
  json('preview', 'frame', definition, '--output', frame, '--frame', '0');
  json(
    'render',
    definition,
    '--output',
    output,
    '--recipe-cache',
    join(directory, 'recipes'),
  );
  for (const image of [frame, output]) {
    const buffer = decodeFrames(image, [0], 90, 160).get(0)!;
    const i = (80 * 90 + 86) * 3;
    assert.ok(buffer[i]! > 220 && buffer[i + 2]! < 30);
  }
  await write({ fit: 'cover', sourceWindow: window, rotation: 30 });
  assert.ok(inspect().framing.visibleSourceRegion.polygon.length > 4);
  await write({
    fit: 'cover',
    crop: { left: 0.1, top: 0, right: 0, bottom: 0 },
  });
  const legacy = inspect().framing;
  assert.equal(legacy.sourceWindow.width, 120);
  assert.equal(legacy.destinationBounds.x, 9);
  assert.ok(legacy.visibleSourceRegion.polygon[0].x > 9);
  const legacyImage = join(directory, 'legacy.png');
  json('preview', 'frame', definition, '--output', legacyImage, '--frame', '0');
  const legacyPixels = decodeFrames(legacyImage, [0], 90, 160).get(0)!;
  assert.ok(legacyPixels[(80 * 90 + 4) * 3]! < 20);
  assert.ok(legacyPixels[(80 * 90 + 86) * 3 + 2]! > 220);
  for (const visual of [
    { fit: 'cover', sourceWindow: { ...window, x: 31 } },
    { sourceWindow: window },
    { fit: 'cover', sourceWindow: { ...window, x: -1 } },
  ]) {
    await write(visual);
    const error = run(
      'validate',
      definition,
      '--recipe-cache',
      join(directory, 'recipes'),
    );
    assert.equal(error.status, 1);
    assert.match(error.stderr, /sourceWindow/);
  }
});

test('contact sheets sample both sides of cuts and read the finished MP4 independently of source files', async (t) => {
  const directory = await mkdtemp(join(fixtureDirectory, 'frame-qa-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const definition = join(directory, 'qa.video.ts');
  const image = join(directory, 'shot.png');
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'color=red:s=128x128',
    '-frames:v',
    '1',
    '-threads',
    '1',
    image,
  ]);
  await writeFile(
    definition,
    'export default ' +
      JSON.stringify({
        canvas: { width: 128, height: 128, frameRate: 24, durationFrames: 12 },
        assets: { shot: { kind: 'image', path: 'shot.png' } },
        subtitles: {
          style: {},
          cues: [
            {
              id: 'caption-cue',
              text: 'A caption',
              start: { numerator: 1, denominator: 4 },
              end: { numerator: 7, denominator: 24 },
            },
          ],
        },
        tracks: [
          {
            type: 'video',
            clips: [
              { asset: 'shot', id: 'outgoing', at: 0, duration: 6 },
              {
                asset: 'shot',
                id: 'incoming',
                at: 6,
                duration: 6,
                visual: { x: 70 },
              },
            ],
          },
        ],
      }),
  );
  const output = join(directory, 'edit.mp4');
  const report = json(
    'render',
    definition,
    '--output',
    output,
    '--recipe-cache',
    join(directory, 'recipes'),
    '--picture-cache',
    join(directory, 'pictures'),
  ).data;
  const reportPath = join(directory, 'report.json');
  await writeFile(reportPath, JSON.stringify(report));
  const sheet = json(
    'preview',
    'contact-sheet',
    definition,
    '--output',
    join(directory, 'definition.png'),
    '--around',
    'cuts,captions,picture',
    '--render-report',
    reportPath,
    '--from',
    '4',
    '--to',
    '7',
    '--frames',
    '6,6',
  ).data;
  assert.deepEqual(
    sheet.samples.map(({ frame }: { frame: number }) => frame),
    [5, 6],
  );
  assert.deepEqual(sheet.samples[0].clipIds, ['outgoing']);
  assert.deepEqual(sheet.samples[1].clipIds, ['incoming']);
  assert.ok(
    sheet.samples[1].requests.some(
      ({ reason, id }: { reason: string; id: string }) =>
        reason === 'caption-start' && id === 'caption-cue',
    ),
  );
  assert.ok(
    sheet.samples[1].requests.some(
      ({ reason }: { reason: string }) => reason === 'caption-end',
    ),
  );
  assert.equal(
    sheet.samples[1].requests.filter(
      ({ reason }: { reason: string }) => reason === 'frame',
    ).length,
    1,
  );
  assert.deepEqual(
    JSON.parse(await readFile(sheet.manifestPath, 'utf8')),
    sheet,
  );
  await rm(image);
  const reportOnly = json(
    'preview',
    'contact-sheet',
    output,
    '--output',
    join(directory, 'report-only.png'),
    '--around',
    'cuts,picture',
    '--render-report',
    reportPath,
    '--from',
    '4',
    '--to',
    '7',
  ).data;
  assert.deepEqual(reportOnly.samples[1].clipIds, ['incoming']);
  const decoded = json(
    'preview',
    'contact-sheet',
    output,
    '--output',
    join(directory, 'export.png'),
    '--around',
    'cuts,picture',
    '--definition',
    definition,
    '--render-report',
    reportPath,
    '--from',
    '4',
    '--to',
    '7',
    '--timestamps',
    '1/4',
  ).data;
  assert.deepEqual(
    decoded.samples.map(({ frame }: { frame: number }) => frame),
    [5, 6],
  );
  assert.equal(decoded.input.kind, 'mp4');
  assert.deepEqual(decoded.samples[1].time, { numerator: 1, denominator: 4 });
  assert.deepEqual(decoded.samples[1].clipIds, ['incoming']);
  const mp4Pixels = decodeFrames(output, [5, 6], 128, 128);
  const sheetPixels = decodeFrames(
    decoded.path,
    [0],
    decoded.width,
    decoded.height,
  ).get(0)!;
  for (const [i, frame] of [5, 6].entries()) {
    const offset = (64 * decoded.width + i * decoded.cellWidth + 40) * 3;
    assert.ok(
      worst(
        sheetPixels.subarray(offset, offset + 3),
        mp4Pixels
          .get(frame)!
          .subarray((64 * 128 + 40) * 3, (64 * 128 + 40) * 3 + 3),
      ) <= 2,
    );
  }
  const rejected = run(
    'preview',
    'contact-sheet',
    output,
    '--frames',
    '12',
    '--output',
    join(directory, 'out-of-range.png'),
  );
  assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /outside/);
});

test('MP4 timestamps select by variable-frame-rate presentation time', async (t) => {
  const directory = await mkdtemp(join(fixtureDirectory, 'vfr-frame-qa-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const media = join(directory, 'vfr.mp4');
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=128x128:rate=10:duration=1',
    '-vf',
    "select='eq(n,0)+eq(n,1)+eq(n,4)+eq(n,7)'",
    '-fps_mode',
    'passthrough',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    media,
  ]);
  const { data } = json(
    'preview',
    'contact-sheet',
    media,
    '--output',
    join(directory, 'vfr.png'),
    '--timestamps',
    '0.3,0.4,0.5,0.7',
  );
  assert.deepEqual(
    data.samples.map(({ frame, time }: { frame: number; time: unknown }) => [
      frame,
      time,
    ]),
    [
      [1, { numerator: 1, denominator: 10 }],
      [2, { numerator: 2, denominator: 5 }],
      [3, { numerator: 7, denominator: 10 }],
    ],
  );
  assert.equal(data.samples[1].requests.length, 2);
});

test('dependency inspection reads nested graphic resources and known artifacts without tree changes', async (t) => {
  const directory = await mkdtemp(join(fixtureDirectory, 'dependencies-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cache = join(directory, 'cache');
  patches(directory, 60, 8);
  const definition = join(directory, 'deps.video.ts');
  await writeFile(
    join(directory, 'badge.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>',
  );
  const config = {
    canvas: { width: 192, height: 256, frameRate: 60, durationFrames: 8 },
    assets: {
      shot: {
        kind: 'video',
        path: 'patches.mov',
        recipe: [{ type: 'resize', width: 96, height: 128 }],
      },
      same: { kind: 'video', path: 'patches.mov' },
      badge: {
        kind: 'graphic',
        renderer: 'svg',
        path: 'badge.svg',
        width: 16,
        height: 16,
      },
    },
    tracks: [
      { type: 'video', clips: [{ asset: 'shot', at: 0, sourceOut: 8 }] },
      {
        type: 'video',
        clips: [
          { asset: 'badge', at: 0, duration: 8, visual: { scale: 0.25 } },
        ],
      },
    ],
  };
  await writeFile(definition, 'export default ' + JSON.stringify(config));
  const output = join(directory, 'export.mp4');
  const rendered = json(
    'render',
    definition,
    '--output',
    output,
    '--recipe-cache',
    cache,
    '--picture-cache',
    cache,
  );
  assert.ok(
    rendered.progress.some(
      ({ stage, status }) => stage === 'recipe' && status === 'completed',
    ),
  );
  assert.ok(
    rendered.progress.some(
      ({ stage, clipId }) => stage === 'graphics' && clipId,
    ),
  );
  const renderReport = join(directory, 'render.json');
  await writeFile(renderReport, JSON.stringify(rendered.data));
  await writeFile(
    join(directory, 'Card.tsx'),
    "import './card.css'; export default function Card() { return <div>Card</div> }",
  );
  await writeFile(join(directory, 'card.css'), "@import './inner.css';");
  await writeFile(
    join(directory, 'inner.css'),
    "div { background: url('./texture.png'); }",
  );
  const texture = join(directory, 'texture.png');
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'color=green:s=16x16',
    '-frames:v',
    '1',
    '-threads',
    '1',
    texture,
  ]);
  await writeFile(join(directory, 'unknown.mp4'), 'unknown provenance');
  await writeFile(
    definition,
    'export default ' +
      JSON.stringify({
        ...config,
        assets: {
          ...config.assets,
          missing: { kind: 'audio', path: 'missing.wav' },
          card: {
            kind: 'graphic',
            renderer: 'react',
            path: 'Card.tsx',
            durationFrames: 8,
          },
          missingCard: {
            kind: 'graphic',
            renderer: 'react',
            path: 'missing.tsx',
            durationFrames: 8,
          },
        },
      }),
  );
  const tree = async () => {
    const files = (
      await readdir(directory, { recursive: true, withFileTypes: true })
    )
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .sort();
    return Promise.all(
      files.map(async (path) => [
        path,
        (await readFile(path)).toString('base64'),
      ]),
    );
  };
  const before = await tree();
  const result = json(
    'inspect',
    'dependencies',
    definition,
    '--recipe-cache',
    cache,
    '--artifact-root',
    directory,
    '--render-report',
    renderReport,
  ).data;
  const get = (file: string) =>
    result.files.find(
      ({ relativePath }: { relativePath: string }) => relativePath === file,
    );
  for (const file of ['card.css', 'inner.css', 'texture.png'])
    assert.ok(get(file)?.roles.includes('graphic-dependency'), file);
  assert.deepEqual(get('patches.mov').roles, ['media', 'picture-input']);
  assert.equal(
    get('patches.mov').references.filter(
      ({ role }: { role: string }) => role === 'media',
    ).length,
    2,
  );
  assert.equal(get('missing.wav').status, 'missing');
  assert.equal(get('missing.tsx').status, 'missing');
  assert.deepEqual(get('unknown.mp4').roles, ['unclassified']);
  assert.deepEqual(get('export.mp4').roles, ['export']);
  assert.ok(
    result.files.some(({ roles }: { roles: string[] }) =>
      roles.includes('cache-media'),
    ),
  );
  assert.deepEqual(await tree(), before);

  const unresolved = join(directory, 'unresolved.video.ts');
  await writeFile(
    unresolved,
    "import './missing-module.ts'; export default {};",
  );
  const partial = json(
    'inspect',
    'dependencies',
    unresolved,
    '--recipe-cache',
    cache,
  ).data;
  assert.equal(partial.definitionEvaluated, false);
  assert.deepEqual(
    partial.files.find(
      ({ relativePath }: { relativePath: string }) =>
        relativePath === 'missing-module.ts',
    ).roles,
    ['definition-module'],
  );
  assert.equal(
    partial.files.find(
      ({ relativePath }: { relativePath: string }) =>
        relativePath === 'missing-module.ts',
    ).status,
    'missing',
  );
});

test('MP4 boundary QA samples rendered cuts and captions on a different delivery frame rate', async (t) => {
  const directory = await mkdtemp(
    join(fixtureDirectory, 'resampled-frame-qa-'),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const definition = join(directory, 'edit.video.ts');
  const exportPath = join(directory, 'edit.mp4');
  const reportPath = join(directory, 'render.json');
  const cut = { numerator: 1, denominator: 20 };
  const start = { numerator: 11, denominator: 100 };
  const end = { numerator: 17, denominator: 100 };
  await writeFile(
    definition,
    'export default ' +
      JSON.stringify({
        canvas: { width: 96, height: 96, frameRate: 24, durationFrames: 6 },
        tracks: [
          {
            type: 'text',
            clips: [
              {
                id: 'outgoing',
                at: 0,
                duration: cut,
                text: { content: '.', canvasFill: '#ff0000' },
              },
              {
                id: 'incoming',
                at: cut,
                duration: { numerator: 1, denominator: 5 },
                text: { content: '.', canvasFill: '#0000ff' },
              },
            ],
          },
        ],
        subtitles: {
          style: {},
          cues: [{ id: 'caption', text: 'CAP', start, end }],
        },
      }),
  );
  const report = json(
    'render',
    definition,
    '--fps',
    '60',
    '--output',
    exportPath,
  ).data;
  await writeFile(reportPath, JSON.stringify(report));
  const sheet = json(
    'preview',
    'contact-sheet',
    exportPath,
    '--render-report',
    reportPath,
    '--around',
    'cuts,captions',
    '--from',
    '2',
    '--to',
    '14',
    '--output',
    join(directory, 'report.png'),
  ).data;
  const frames = [4, 5, 7, 8, 12, 13];
  assert.deepEqual(
    sheet.samples.map(({ frame }: { frame: number }) => frame),
    frames,
  );
  assert.deepEqual(sheet.samples[0].clipIds, ['outgoing']);
  assert.deepEqual(sheet.samples[1].clipIds, ['incoming']);
  assert.deepEqual(sheet.samples[1].requests[0], {
    reason: 'cut',
    side: 'at-or-after',
    requestedTime: cut,
    adjacentClipIds: { before: ['outgoing'], at: ['incoming'] },
  });
  assert.equal(sheet.samples[3].requests[0].reason, 'caption-start');
  assert.deepEqual(sheet.samples[3].requests[0].requestedTime, start);
  assert.equal(sheet.samples[5].requests[0].reason, 'caption-end');
  const pixels = decodeFrames(exportPath, frames, 96, 96);
  assert.ok(pixels.get(4)![0]! > 200 && pixels.get(5)![2]! > 200);
  const countWhite = (frame: number) => {
    const data = pixels.get(frame)!;
    let count = 0;
    for (let i = 0; i < data.length; i += 3)
      if (data[i]! > 210 && data[i + 1]! > 210 && data[i + 2]! > 210) count++;
    return count;
  };
  assert.ok(countWhite(8) > countWhite(7));
  assert.ok(countWhite(12) > countWhite(13));
  const fromDefinition = json(
    'preview',
    'contact-sheet',
    exportPath,
    '--definition',
    definition,
    '--around',
    'cuts,captions',
    '--from',
    '2',
    '--to',
    '14',
    '--output',
    join(directory, 'definition.png'),
  ).data;
  assert.deepEqual(fromDefinition.samples, sheet.samples);
});

test('report fingerprints follow unchanged copies and reject an overwritten export of the same length', async (t) => {
  const directory = await mkdtemp(join(fixtureDirectory, 'export-identity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = join(directory, 'first.video.ts');
  const second = join(directory, 'second.video.ts');
  const cache = join(directory, 'recipes');
  const exportPath = join(directory, 'delivery.mp4');
  const moved = join(directory, 'moved.mp4');
  const reportPath = join(directory, 'render.json');
  const write = (file: string, backgroundColor: string) =>
    writeFile(
      file,
      'export default ' +
        JSON.stringify({
          canvas: {
            width: 64,
            height: 64,
            frameRate: 24,
            durationFrames: 4,
            backgroundColor,
          },
          tracks: [],
        }),
    );
  await Promise.all([write(first, '#ff0000'), write(second, '#0000ff')]);
  const initial = json(
    'render',
    first,
    '--output',
    exportPath,
    '--recipe-cache',
    cache,
  ).data;
  await writeFile(reportPath, JSON.stringify(initial));
  assert.match(initial.outputFingerprint.sha256, /^[0-9a-f]{64}$/);
  const inventory = (definition: string, ...extra: string[]) =>
    json(
      'inspect',
      'dependencies',
      definition,
      '--recipe-cache',
      cache,
      ...extra,
    ).data.files.find(
      ({ resolvedPath }: { resolvedPath: string }) =>
        resolvedPath === exportPath,
    );
  assert.deepEqual(inventory(first).roles, ['export']);
  await copyFile(exportPath, moved);
  json(
    'preview',
    'contact-sheet',
    moved,
    '--render-report',
    reportPath,
    '--frames',
    '0',
    '--output',
    join(directory, 'moved.png'),
  );
  const replacement = json(
    'render',
    second,
    '--output',
    exportPath,
    '--overwrite',
    '--recipe-cache',
    cache,
  ).data;
  assert.equal(initial.frameCount, replacement.frameCount);
  assert.notEqual(
    initial.outputFingerprint.sha256,
    replacement.outputFingerprint.sha256,
  );
  const sheet = join(directory, 'mismatched.png');
  const rejected = run(
    'preview',
    'contact-sheet',
    exportPath,
    '--render-report',
    reportPath,
    '--frames',
    '0',
    '--output',
    sheet,
  );
  assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /Render report does not match this MP4/);
  assert.ok(
    !(await readdir(directory)).some((name) =>
      name.startsWith('mismatched.png'),
    ),
  );
  const stale = inventory(first, '--render-report', reportPath);
  assert.deepEqual(stale.roles, ['unverified-export']);
  assert.ok(
    stale.references.some(
      ({ owner }: { owner: string }) => owner === reportPath,
    ),
  );
  assert.deepEqual(inventory(second).roles, ['export']);
});

test('dependency inspection traces nested project modules resolved through package imports', async (t) => {
  const directory = await mkdtemp(
    join(fixtureDirectory, 'alias-dependencies-'),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const definitions = join(directory, 'definitions');
  await mkdir(definitions);
  const definition = join(definitions, 'edit.video.ts');
  await Promise.all([
    writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        type: 'module',
        imports: { '#timings': './timings.ts' },
      }),
    ),
    writeFile(
      join(directory, 'timings.ts'),
      "export { durationFrames } from './cadence.ts';",
    ),
    writeFile(
      join(directory, 'cadence.ts'),
      'export const durationFrames = 4;',
    ),
    writeFile(
      definition,
      "import { durationFrames } from '#timings'; export default { canvas: { width: 64, height: 64, frameRate: 24, durationFrames }, tracks: [] };",
    ),
  ]);
  const { data } = json(
    'inspect',
    'dependencies',
    definition,
    '--artifact-root',
    directory,
  );
  const refs = (relativePath: string) =>
    data.files.find(
      (file: { relativePath: string }) => file.relativePath === relativePath,
    ).references;
  assert.deepEqual(refs('../timings.ts'), [
    { role: 'definition-module', owner: 'edit.video.ts', direct: true },
  ]);
  assert.deepEqual(refs('../cadence.ts'), [
    { role: 'definition-module', owner: '../timings.ts', direct: false },
  ]);
});

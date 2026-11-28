import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  access,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { probeMedia } from '@opencut/sdk';
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
const run = (...args: string[]) => runCli(args);
const runCli = (args: string[], environment: NodeJS.ProcessEnv = {}) =>
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
      ...environment,
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
      'stream=color_range,color_space,color_primaries,color_transfer,chroma_location,pix_fmt',
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
  chroma_location: 'center',
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

test('layout assertions check subtitle ink and panel placement and stop a failing render', async (t) => {
  const directory = await mkdtemp(join(fixtureDirectory, 'layout-assertions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  patches(directory, 24, 12);
  const definition = join(directory, 'layout.video.ts');
  const output = join(directory, 'layout.mp4');
  const write = (x: number, rotation = 0) =>
    writeFile(
      definition,
      'export default ' +
        JSON.stringify({
          canvas: {
            width: 192,
            height: 256,
            frameRate: 24,
            durationFrames: 12,
          },
          assets: { shot: { path: 'patches.mov', kind: 'video' } },
          tracks: [
            {
              type: 'video',
              clips: [
                {
                  id: 'shot-clip',
                  asset: 'shot',
                  at: 0,
                  sourceOut: 12,
                  visual: { fit: 'cover', rotation },
                },
              ],
            },
            {
              id: 'panels',
              type: 'text',
              clips: [
                {
                  id: 'panel',
                  at: 0,
                  duration: 12,
                  text: {
                    content: 'Hello',
                    fontSize: 18,
                    wrapWidth: 110,
                    alignment: 'left',
                    background: { color: '#333333', padding: 4 },
                  },
                },
              ],
            },
          ],
          transitions: [
            { id: 'fade-in', kind: 'fade-in', clipId: 'shot-clip', frames: 3 },
          ],
          subtitles: {
            style: {
              x,
              y: 96,
              fontSize: 24,
              stroke: null,
              background: { color: '#000000', padding: 4 },
            },
            cues: [
              {
                id: 'dialogue',
                text: '你好',
                start: { numerator: 0, denominator: 1 },
                end: { numerator: 1, denominator: 2 },
              },
            ],
          },
          layoutAssertions: [
            {
              id: 'dialogue-anchor',
              kind: 'bottom-center',
              target: { subtitles: true },
              bottom: 32,
              tolerance: 0,
            },
            {
              id: 'caption-ink',
              kind: 'glyphs-centered',
              target: { subtitles: true },
              tolerance: 7,
            },
            {
              id: 'panel-ink',
              kind: 'glyphs-centered',
              target: { track: 'panels' },
              tolerance: 3,
              required: false,
            },
            {
              id: 'full-shot',
              kind: 'covers-canvas',
              target: { clip: 'shot-clip' },
            },
          ],
        }),
    );
  await write(0);
  const { layout } = json('validate', definition).data;
  assert.equal(layout.ok, true);
  const [anchor, ink, panel, shot] = layout.checks;
  assert.deepEqual(
    [anchor.objectId, anchor.framesChecked, anchor.deviationPixels],
    ['dialogue', 12, 0],
  );
  assert.ok(ink.referenceBounds.right > ink.actualBounds.right);
  assert.equal(panel.passed, false);
  assert.ok(panel.deviationPixels > 20);
  assert.equal(shot.passed, true);
  assert.equal(shot.framesChecked, 11);
  await write(-20, 12);
  const validate = run('validate', definition);
  assert.equal(validate.status, 1, validate.stderr);
  const failed = JSON.parse(validate.stdout).layout.checks;
  assert.equal(failed[0].deviationPixels, 20);
  assert.equal(failed[3].passed, false, 'rotated corners do not cover canvas');
  const render = run('render', definition, '--output', output);
  assert.equal(render.status, 1);
  assert.equal(JSON.parse(render.stderr).error.code, 'LAYOUT_ASSERTION_FAILED');
  await assert.rejects(readFile(output), { code: 'ENOENT' });
});

test('coverage assertions report an animated shot off-canvas during a fade', async (t) => {
  const directory = await mkdtemp(join(fixtureDirectory, 'fade-coverage-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  patches(directory, 24, 3);
  const definition = join(directory, 'coverage.video.ts');
  await writeFile(
    definition,
    'export default ' +
      JSON.stringify({
        canvas: { width: 192, height: 256, frameRate: 24, durationFrames: 3 },
        assets: { source: { path: 'patches.mov', kind: 'video' } },
        tracks: [
          {
            type: 'video',
            clips: [
              {
                id: 'shot',
                asset: 'source',
                at: 0,
                sourceOut: 3,
                visual: { fit: 'cover' },
                keyframes: {
                  x: [
                    {
                      time: { numerator: 0, denominator: 1 },
                      value: 500,
                      easing: 'linear',
                    },
                    {
                      time: { numerator: 1, denominator: 12 },
                      value: 0,
                      easing: 'linear',
                    },
                  ],
                },
              },
            ],
          },
        ],
        transitions: [
          { id: 'fade-in', kind: 'fade-in', clipId: 'shot', frames: 3 },
        ],
        layoutAssertions: [
          { id: 'coverage', kind: 'covers-canvas', target: { clip: 'shot' } },
        ],
      }),
  );
  const result = run('validate', definition);
  assert.equal(result.status, 1, result.stderr);
  const { checks } = JSON.parse(result.stdout).layout;
  assert.equal(checks[0].passed, false);
  assert.equal(checks[0].frame, 1);
  assert.equal(checks[0].framesChecked, 2);
});

test('render plan leaves cold caches untouched and predicts exact warm recipe and picture reuse', async (t) => {
  const directory = await mkdtemp(join(fixtureDirectory, 'render-plan-qa-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  patches(directory, 24, 12);
  const definition = join(directory, 'cache.video.ts');
  const output = join(directory, 'planned.mp4');
  await writeFile(
    definition,
    'export default ' +
      JSON.stringify({
        canvas: { width: 192, height: 256, frameRate: 24, durationFrames: 18 },
        assets: {
          derived: {
            path: 'patches.mov',
            kind: 'video',
            recipe: [
              { type: 'crop', x: 0, y: 0, width: 128, height: 192 },
              { type: 'resize', width: 96, height: 128 },
            ],
          },
          original: { path: 'patches.mov', kind: 'video' },
        },
        tracks: [
          {
            type: 'video',
            clips: [
              { id: 'direct', asset: 'original', at: 0, sourceOut: 6 },
              { id: 'derived-clip', asset: 'derived', at: 6, sourceOut: 6 },
              { id: 'repeat', asset: 'original', at: 12, sourceOut: 6 },
            ],
          },
        ],
      }),
  );
  const args = [
    definition,
    '--output',
    output,
    '--recipe-cache',
    join(directory, 'recipes'),
    '--picture-cache',
    join(directory, 'picture'),
  ];
  const before = await readdir(directory);
  const cold = json('render', 'plan', ...args).data;
  assert.deepEqual(await readdir(directory), before);
  assert.deepEqual(
    cold.recipes.map(({ reason }: { reason: string }) => reason),
    ['entry-missing', 'upstream-step-needs-build'],
  );
  assert.deepEqual(
    cold.pictureRanges.map(({ reason }: { reason: string }) => reason),
    [
      'entry-missing',
      'recipe-artifact-needed-for-key',
      'scheduled-earlier-range',
    ],
  );
  const scaled = json(
    'render',
    'plan',
    ...args,
    '--width',
    '288',
    '--height',
    '384',
    '--fps',
    '48',
  ).data;
  assert.deepEqual(scaled.composition, {
    width: 192,
    height: 256,
    frameRate: { numerator: 24, denominator: 1 },
    frameCount: 18,
    durationSeconds: 0.75,
  });
  assert.deepEqual(scaled.delivery, {
    width: 288,
    height: 384,
    frameRate: { numerator: 48, denominator: 1 },
    frameCount: 36,
    durationSeconds: 0.75,
  });
  assert.ok(
    scaled.shots.every(
      ({
        compositionMethod,
        method,
      }: {
        compositionMethod: string;
        method: string;
      }) => compositionMethod === 'native' && method === 'frame-repetition',
    ),
  );
  assert.ok(cold.storage.peakScratchBytes > 0);
  assert.ok(cold.storage.filesystems[0].freeBytes > 0);
  const rendered = json('render', ...args, '--picture-version', 'save').data;
  const warm = json('render', 'plan', ...args, '--overwrite').data;
  assert.ok(
    warm.recipes.every(({ status }: { status: string }) => status === 'reuse'),
  );
  assert.ok(
    warm.pictureRanges.every(
      ({ status }: { status: string }) => status === 'reuse',
    ),
  );
  assert.equal(warm.pictureRanges[0].key, cold.pictureRanges[0].key);
  assert.ok(warm.storage.peakScratchBytes < cold.storage.peakScratchBytes);
  const saved = json(
    'render',
    'plan',
    ...args,
    '--overwrite',
    '--picture-version',
    rendered.pictureVersion.id,
  ).data;
  assert.equal(saved.savedPicture.status, 'reuse');
});

test('render plan rejects overwriting an original used exclusively by a recipe', async (t) => {
  const directory = await mkdtemp(
    join(fixtureDirectory, 'plan-protect-input-'),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = join(directory, 'original.mp4');
  const alias = join(directory, 'alias.mp4');
  ffmpeg(['-i', patches(directory, 24, 6), '-c', 'copy', original]);
  await link(original, alias);
  const before = await readFile(original);
  const definition = join(directory, 'protected.video.ts');
  await writeFile(
    definition,
    'export default ' +
      JSON.stringify({
        canvas: { width: 192, height: 256, frameRate: 24, durationFrames: 6 },
        assets: {
          derived: {
            path: 'original.mp4',
            kind: 'video',
            recipe: [{ type: 'resize', width: 96, height: 128 }],
          },
        },
        tracks: [
          { type: 'video', clips: [{ asset: 'derived', at: 0, sourceOut: 6 }] },
        ],
      }),
  );
  const cache = join(directory, 'recipes');
  const args = [definition, '--recipe-cache', cache];
  const rejected = (output: string) => {
    const result = run(
      'render',
      'plan',
      ...args,
      '--output',
      output,
      '--overwrite',
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(
      JSON.parse(result.stderr).error.message,
      /must not replace input .*original\.mp4/,
    );
  };
  rejected(original);
  assert.ok(!(await readdir(directory)).includes('recipes'));
  json('render', ...args, '--output', join(directory, 'delivery.mp4'));
  rejected(alias);
  assert.deepEqual(await readFile(original), before);
});

test('render plan checks the FFmpeg encoders used by the planned picture and audio', async (t) => {
  const directory = await mkdtemp(join(fixtureDirectory, 'plan-encoders-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, 'bin');
  await mkdir(bin);
  const realFfmpeg = command('which', ['ffmpeg']).toString().trim();
  await writeFile(
    join(bin, 'ffmpeg'),
    `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "-encoders" ]; then
    "$OPENCUT_TEST_REAL_FFMPEG" "$@" | awk '$2 != ENVIRON["OPENCUT_TEST_MISSING_ENCODER"]'
    exit
  fi
done
exec "$OPENCUT_TEST_REAL_FFMPEG" "$@"
`,
    { mode: 0o755 },
  );
  const definition = join(directory, 'encoders.video.ts');
  const write = (rotation: number) =>
    writeFile(
      definition,
      'export default ' +
        JSON.stringify({
          canvas: { width: 96, height: 128, frameRate: 24, durationFrames: 3 },
          tracks: [
            {
              type: 'text',
              clips: [
                {
                  at: 0,
                  duration: 3,
                  visual: { rotation },
                  text: { content: 'OpenCut' },
                },
              ],
            },
          ],
        }),
    );
  const plan = (encoder: string, ...extra: string[]) =>
    runCli(
      [
        'render',
        'plan',
        definition,
        '--output',
        join(directory, 'delivery.mp4'),
        ...extra,
      ],
      {
        PATH: [bin, process.env.PATH].join(delimiter),
        OPENCUT_TEST_REAL_FFMPEG: realFfmpeg,
        OPENCUT_TEST_MISSING_ENCODER: encoder,
      },
    );
  const missing = (encoder: string, ...extra: string[]) => {
    const result = plan(encoder, ...extra);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(
      JSON.parse(result.stderr).error.message,
      `Required encoder '${encoder}' is unavailable in this FFmpeg installation.`,
    );
  };
  await write(0);
  missing('libx264');
  missing('aac');
  const direct = plan('ffv1');
  assert.equal(direct.status, 0, direct.stderr);
  const cacheArgs = ['--picture-cache', join(directory, 'pictures')];
  missing('ffv1', ...cacheArgs);
  json(
    'render',
    definition,
    '--output',
    join(directory, 'warm.mp4'),
    ...cacheArgs,
  );
  const warm = plan('ffv1', ...cacheArgs);
  assert.equal(warm.status, 0, warm.stderr);
  assert.equal(JSON.parse(warm.stdout).pictureRanges[0].status, 'reuse');
  await write(12);
  missing('ffv1');
});

test('export verification publishes paired samples, checks boundary luma and compares packet payloads', async (t) => {
  const directory = await mkdtemp(
    join(fixtureDirectory, 'export-verification-'),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const preview = join(directory, 'approved.mp4');
  const delivery = join(directory, 'delivery.mp4');
  const broken = join(directory, 'broken.mp4');
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'color=c=gray:s=96x128:r=24:d=0.5',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=0.5',
    '-c:v',
    'libx264',
    '-c:a',
    'aac',
    preview,
  ]);
  ffmpeg([
    '-i',
    preview,
    '-map',
    '0',
    '-c',
    'copy',
    '-metadata',
    'title=Delivery',
    delivery,
  ]);
  const passedPath = join(directory, 'passed');
  const passed = json(
    'verify',
    'export',
    delivery,
    '--against',
    preview,
    '--audio-master',
    preview,
    '--output',
    passedPath,
    '--frames',
    '0,11',
    '--boundaries',
    '6',
  ).data;
  assert.equal(passed.ok, true);
  assert.deepEqual(
    passed.samples.map(({ frame }: { frame: number }) => frame),
    [0, 5, 6, 11],
  );
  assert.equal(passed.audio.tracks[0].firstMismatch, null);
  assert.ok(
    (await readFile(join(passedPath, passed.samples[0].image))).length > 0,
  );
  assert.equal(JSON.parse(await readFile(passed.path, 'utf8')).ok, true);

  ffmpeg([
    '-i',
    preview,
    '-vf',
    "drawbox=c=white:t=fill:enable='gte(n,6)'",
    '-af',
    'volume=0.5',
    '-c:v',
    'libx264',
    '-c:a',
    'aac',
    broken,
  ]);
  const failed = run(
    'verify',
    'export',
    broken,
    '--against',
    preview,
    '--audio-master',
    preview,
    '--output',
    join(directory, 'failed'),
    '--frames',
    '0',
    '--boundaries',
    '6',
  );
  assert.equal(failed.status, 1, failed.stderr);
  const report = JSON.parse(failed.stdout);
  assert.equal(report.boundaries[0].passed, false);
  assert.ok(report.boundaries[0].maxRegionLumaChangeError > 80);
  assert.equal(report.audio.passed, false);
  assert.equal(JSON.parse(await readFile(report.path, 'utf8')).ok, false);

  await t.test(
    'rejects a video delay with unchanged pictures and audio packets',
    async () => {
      const delayed = join(directory, 'delayed.mp4');
      ffmpeg([
        '-itsoffset',
        '0.5',
        '-i',
        preview,
        '-i',
        preview,
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-c',
        'copy',
        delayed,
      ]);
      const result = run(
        'verify',
        'export',
        delayed,
        '--against',
        preview,
        '--audio-master',
        preview,
        '--output',
        join(directory, 'delayed-report'),
        '--frames',
        '0,11',
      );
      assert.equal(result.status, 1, result.stderr);
      const delayedReport = JSON.parse(result.stdout);
      assert.equal(delayedReport.timing.firstTimingMismatch, 0);
      assert.equal(delayedReport.timing.passed, false);
      assert.equal(
        delayedReport.timing.exportStartSeconds -
          delayedReport.timing.previewStartSeconds,
        0.5,
      );
      assert.ok(
        delayedReport.samples.every(
          ({ passed }: { passed: boolean }) => passed,
        ),
      );
      assert.equal(delayedReport.audio.passed, true);
    },
  );
});

test('export verification pairs 30 and 60 fps by time and detects unsampled clock and audio shifts', async (t) => {
  const directory = await mkdtemp(
    join(fixtureDirectory, 'cross-rate-verification-'),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const preview = join(directory, 'approved.mp4');
  const delivery = join(directory, 'delivery.mp4');
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'color=c=gray:s=96x128:r=30:d=1',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=1',
    '-vf',
    "drawbox=c=white:t=fill:enable='gte(n,15)'",
    '-c:v',
    'libx264',
    '-c:a',
    'aac',
    preview,
  ]);
  ffmpeg([
    '-i',
    preview,
    '-vf',
    'fps=60,scale=192:256',
    '-c:v',
    'libx264',
    '-c:a',
    'copy',
    delivery,
  ]);
  const verify = (file: string, name: string, ...flags: string[]) =>
    run(
      'verify',
      'export',
      file,
      '--against',
      preview,
      '--audio-master',
      preview,
      '--expect-fps',
      '60',
      '--timestamps',
      '0.1,0.5',
      '--output',
      join(directory, name),
      ...flags,
    );
  const verified = verify(delivery, 'pass', '--boundary-timestamps', '0.5');
  assert.equal(verified.status, 0, verified.stderr || verified.stdout);
  const report = JSON.parse(verified.stdout);
  assert.deepEqual(
    report.samples.map(
      (sample: {
        frame: number;
        previewFrame: number;
        timeSeconds: number;
      }) => [sample.frame, sample.previewFrame, sample.timeSeconds],
    ),
    [
      [6, 3, 0.1],
      [29, 14, 29 / 60],
      [30, 15, 0.5],
    ],
  );
  assert.deepEqual(report.boundaries[0].reasons, ['requested-timestamp']);
  assert.equal(report.timing.exportFrames, 60);
  assert.equal(report.audio.content.passed, true);
  assert.equal(report.audio.timing.passed, true);

  const irregular = join(directory, 'irregular.mp4');
  ffmpeg([
    '-i',
    delivery,
    '-vf',
    "settb=1/6000,setpts='PTS+if(eq(N,17),10,0)'",
    '-fps_mode',
    'passthrough',
    '-enc_time_base:v',
    '1/6000',
    '-c:v',
    'libx264',
    '-c:a',
    'copy',
    irregular,
  ]);
  const badClock = verify(irregular, 'clock-failure');
  assert.equal(badClock.status, 1, badClock.stderr || badClock.stdout);
  const clockReport = JSON.parse(badClock.stdout);
  assert.ok(
    clockReport.samples.every(({ passed }: { passed: boolean }) => passed),
  );
  assert.equal(clockReport.timing.passed, false);
  assert.ok([16, 17].includes(clockReport.timing.firstTimingMismatch));

  const shifted = join(directory, 'shifted-audio.mp4');
  ffmpeg([
    '-itsoffset',
    '0.125',
    '-i',
    delivery,
    '-i',
    delivery,
    '-map',
    '1:v:0',
    '-map',
    '0:a:0',
    '-c',
    'copy',
    shifted,
  ]);
  const badAudio = verify(shifted, 'audio-timing-failure');
  assert.equal(badAudio.status, 1, badAudio.stderr || badAudio.stdout);
  const audioReport = JSON.parse(badAudio.stdout);
  assert.equal(audioReport.timing.passed, true);
  assert.equal(audioReport.audio.content.passed, true);
  assert.equal(audioReport.audio.timing.passed, false);
  const mismatch = audioReport.audio.tracks[0].timing.firstMismatch;
  assert.equal(mismatch.packet, 0);
  assert.ok(
    Math.abs(
      mismatch.actualTimeSeconds - mismatch.expectedTimeSeconds - 0.125,
    ) < 0.002,
  );
});

test('export verification accepts the renderer’s rounded delivery duration', async (t) => {
  const directory = await mkdtemp(
    join(fixtureDirectory, 'rounded-export-verification-'),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const definition = join(directory, 'rounded.video.ts');
  await writeFile(
    definition,
    'export default ' +
      JSON.stringify({
        canvas: { width: 96, height: 128, frameRate: 24, durationFrames: 37 },
        tracks: [
          {
            type: 'video',
            clips: [{ at: 0, duration: 37, text: { content: '37 frames' } }],
          },
        ],
      }),
  );
  const preview = join(directory, 'approved.mp4');
  const delivery = join(directory, 'delivery.mp4');
  json('render', definition, '--output', preview);
  json('render', definition, '--output', delivery, '--fps', '60');
  const result = json(
    'verify',
    'export',
    delivery,
    '--against',
    preview,
    '--expect-fps',
    '60',
    '--output',
    join(directory, 'report'),
  ).data;
  assert.equal(result.timing.expectedFrames, 93);
  assert.equal(result.timing.exportFrames, 93);
  assert.equal(result.timing.previewDurationSeconds, 37 / 24);
  assert.equal(result.timing.expectedDurationSeconds, 93 / 60);
  assert.equal(result.timing.passed, true);
});

test('export verification validates reported cadence, snaps quantized frames, and rejects a shifted preview', async (t) => {
  const directory = await mkdtemp(
    join(fixtureDirectory, 'quantized-export-verification-'),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const preview = join(directory, 'approved.mp4');
  const quantized = join(directory, 'quantized.mp4');
  const shifted = join(directory, 'shifted-preview.mp4');
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'color=c=gray:s=96x128:r=30:d=0.2',
    '-vf',
    "drawbox=c=white:t=fill:enable='gte(n,1)'",
    '-c:v',
    'libx264',
    '-bf',
    '0',
    '-video_track_timescale',
    '30000',
    preview,
  ]);
  ffmpeg([
    '-i',
    preview,
    '-c',
    'copy',
    '-video_track_timescale',
    '1000',
    quantized,
  ]);
  for (const reference of [preview, quantized]) {
    const report = json(
      'verify',
      'export',
      quantized,
      '--against',
      reference,
      '--frames',
      '1',
      '--boundary-timestamps',
      '1/30',
      '--output',
      join(directory, reference === preview ? 'pair' : 'self'),
    ).data;
    assert.deepEqual(report.timing.expectedFrameRate, {
      numerator: 30,
      denominator: 1,
    });
    assert.equal(
      report.samples.find(({ frame }: { frame: number }) => frame === 1)
        .previewFrame,
      1,
    );
    assert.equal(report.boundaries[0].frame, 1);
    assert.equal(report.timing.passed, true);
  }
  ffmpeg([
    '-itsoffset',
    '0.1',
    '-i',
    preview,
    '-map',
    '0:v:0',
    '-c',
    'copy',
    shifted,
  ]);
  const result = run(
    'verify',
    'export',
    preview,
    '--against',
    shifted,
    '--frames',
    '1',
    '--output',
    join(directory, 'shifted-report'),
  );
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.samples[0].passed, true);
  assert.equal(report.timing.firstTimingMismatch, 0);
  assert.ok(Math.abs(report.timing.previewStartSeconds - 0.1) < 0.000001);
  assert.equal(report.timing.passed, false);
});

test('picture-clock trim keeps the covering frame and picture duration when audio leads', async (t) => {
  const directory = await mkdtemp(
    join(fixtureDirectory, 'picture-clock-trim-'),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'camera.mov');
  ffmpeg([
    '-itsoffset',
    '0.2',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=96x128:r=24:d=2',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=2.2',
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c:v',
    'libx264',
    '-c:a',
    'pcm_f32le',
    '-video_track_timescale',
    '24000',
    source,
  ]);
  const original = await probeMedia(source);
  assert.ok(
    (original.video?.startTimeSeconds ?? NaN) -
      (original.audio?.startTimeSeconds ?? NaN) >
      0.15,
  );
  const definition = join(directory, 'trim.video.ts');
  const cache = join(directory, 'cache');
  await writeFile(
    definition,
    'export default ' +
      JSON.stringify({
        canvas: { width: 96, height: 128, frameRate: 30, durationFrames: 29 },
        assets: {
          camera: {
            path: 'camera.mov',
            kind: 'video',
            recipe: [
              { type: 'trim', clock: 'picture', start: 31 / 30, end: 2 },
            ],
          },
        },
        tracks: [
          { type: 'video', clips: [{ at: 0, asset: 'camera', sourceOut: 29 }] },
        ],
      }),
  );
  const { data } = json(
    'render',
    definition,
    '--recipe-cache',
    cache,
    '--output',
    join(directory, 'delivery.mp4'),
  );
  const trim = join(cache, data.recipeProcessing.at(-1).key, 'media.mov');
  const { video, audio } = await probeMedia(trim);
  assert.ok(Math.abs((video?.durationSeconds ?? NaN) - 29 / 30) < 0.000001);
  assert.equal(video?.startTimeSeconds, 0);
  assert.ok(Math.abs(audio?.startTimeSeconds ?? NaN) < 1 / 48000);
  const sourceFrames = decodeFrames(source, [24, 25], 96, 128);
  assert.notDeepEqual(sourceFrames.get(24), sourceFrames.get(25));
  const cutFrames = decodeFrames(trim, [0, 1], 96, 128);
  assert.deepEqual(cutFrames.get(0), sourceFrames.get(24));
  assert.deepEqual(cutFrames.get(1), sourceFrames.get(25));
});

test('4K60 delivery renders a scaled backdrop blur above 48 pixels', async (t) => {
  const directory = await mkdtemp(join(fixtureDirectory, '4k60-blur-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  patches(directory, 30, 2);
  await writeFile(
    join(directory, 'glass.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="400"><rect width="200" height="400" fill="white" fill-opacity="0.35"/></svg>',
  );
  const variant = join(directory, 'delivery.video.ts');
  await writeFile(
    variant,
    `import { create4K60Delivery } from '@opencut/sdk';
export default create4K60Delivery(${JSON.stringify({
      canvas: { width: 1080, height: 1920, frameRate: 30, durationFrames: 2 },
      assets: {
        picture: { path: 'patches.mov', kind: 'video' },
        glass: {
          path: 'glass.svg',
          kind: 'graphic',
          renderer: 'svg',
          width: 200,
          height: 400,
        },
      },
      tracks: [
        {
          id: 'picture-track',
          type: 'video',
          clips: [{ asset: 'picture', at: 0, sourceOut: 2 }],
        },
        {
          id: 'glass-track',
          type: 'video',
          clips: [{ asset: 'glass', at: 0, duration: 2 }],
        },
      ],
      visualGroups: [
        { id: 'blur-group', tracks: ['glass-track'], backdropBlur: 40 },
      ],
    })});\n`,
  );
  const output = join(directory, 'master.mp4');
  const { data } = json(
    'render',
    variant,
    '--output',
    output,
    '--encoder',
    'software',
    '--quality',
    'fast',
  );
  assert.equal(data.width, 2160);
  assert.equal(data.height, 3840);
  assert.equal(data.frameCount, 4);
  assert.deepEqual(data.frameRate, { numerator: 60, denominator: 1 });
  ffmpeg(['-i', output, '-f', 'null', '-']);
});

test('4K60 delivery plan distinguishes shot interpolation, native frames, and repetition', async (t) => {
  try {
    await access(resolve('packages/media/dist/video-interpolate'));
  } catch {
    return t.skip('Build the macOS VideoToolbox interpolation worker.');
  }
  const directory = await mkdtemp(join(fixtureDirectory, '4k60-preset-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  patches(directory, 30, 18);
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'color=c=gray:s=96x128:r=60:d=0.5',
    '-c:v',
    'libx264',
    join(directory, 'native.mp4'),
  ]);
  const shots = [0, 150, 300, 450, 600, 750, 900, 1050, 1188].map((at, i) => ({
    at,
    id: `shot-${i + 1}`,
    asset: 'camera',
    sourceIn: 3,
    sourceOut: 9,
  }));
  const approved = join(directory, 'approved.video.ts');
  const variant = join(directory, 'delivery.video.ts');
  await writeFile(
    approved,
    'export default ' +
      JSON.stringify({
        canvas: {
          width: 1080,
          height: 1920,
          frameRate: 30,
          durationFrames: 1623,
        },
        assets: {
          camera: { path: 'patches.mov', kind: 'video' },
          native: { path: 'native.mp4', kind: 'video' },
        },
        tracks: [
          {
            type: 'video',
            clips: [
              ...shots,
              { id: 'native-shot', asset: 'native', at: 1200, sourceOut: 6 },
              { id: 'repeated', asset: 'camera', at: 1210, sourceOut: 6 },
            ],
          },
        ],
      }),
  );
  await writeFile(
    variant,
    `import approved from './approved.video.ts';
import { create4K60Delivery } from '@opencut/sdk';
export default create4K60Delivery(approved, ${JSON.stringify({
      interpolateShots: shots.map(({ id }) => id),
      nativeSources: ['native'],
    })});\n`,
  );
  const plan = json(
    'render',
    'plan',
    variant,
    '--output',
    join(directory, 'master.mp4'),
  ).data;
  assert.deepEqual(plan.composition, {
    width: 2160,
    height: 3840,
    frameRate: { numerator: 60, denominator: 1 },
    frameCount: 3246,
    durationSeconds: 54.1,
  });
  assert.deepEqual(plan.delivery, plan.composition);
  assert.equal(plan.recipes.length, 18);
  const byId = new Map<
    string,
    { method: string; startFrame: number; startSeconds: number }
  >(plan.shots.map((shot: { clipId: string }) => [shot.clipId, shot]));
  assert.equal(byId.get('shot-9')?.method, 'interpolation');
  assert.equal(byId.get('shot-9')?.startFrame, 2376);
  assert.equal(byId.get('shot-9')?.startSeconds, 39.6);
  assert.equal(byId.get('native-shot')?.method, 'native');
  assert.equal(byId.get('repeated')?.method, 'frame-repetition');
});

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
  const reportPath = join(directory, 'bounded.render.json');
  await writeFile(reportPath, JSON.stringify(bounded.data));
  const verification = json(
    'verify',
    'export',
    bounded.data.path,
    '--against',
    baseRender.data.path,
    '--render-report',
    reportPath,
    '--output',
    join(directory, 'verification'),
  ).data;
  for (const { startFrame } of bounded.data.pictureRanges.slice(1))
    assert.ok(
      verification.boundaries.some(
        ({ frame, reasons }: { frame: number; reasons: string[] }) =>
          frame === startFrame && reasons.includes('picture-range'),
      ),
    );
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
  assert.equal(get('unknown.mp4').classification, 'unclassified');
  assert.equal(get('export.mp4').classification, 'delivery');
  assert.ok(result.byteTotals.regenerableCache > 0);
  assert.equal(result.byteTotals.deliveries, (await readFile(output)).length);
  assert.ok(
    result.files.some(({ roles }: { roles: string[] }) =>
      roles.includes('cache-media'),
    ),
  );
  assert.deepEqual(await tree(), before);

  await t.test(
    'rejects same-size replacements and symlinks as cache artifacts',
    async () => {
      const recipe = rendered.progress.find(
        ({ stage, status }) => stage === 'recipe' && status === 'completed',
      );
      const media = join(cache, recipe.key, 'media.' + recipe.format);
      const original = await readFile(media);
      const replacement = Buffer.from(original);
      replacement[0] = replacement[0]! ^ 1;
      const sibling = join(dirname(media), 'media.mp4');
      assert.notEqual(sibling, media);
      await writeFile(sibling, replacement);
      const inspect = (...options: string[]) =>
        json(
          'inspect',
          'dependencies',
          definition,
          '--recipe-cache',
          cache,
          ...options,
        ).data.files;
      const classify = (
        files: { relativePath: string; classification: string }[],
        path: string,
      ) =>
        files.find(
          ({ relativePath }) => relativePath === relative(directory, path),
        )?.classification;
      const scanned = inspect('--artifact-root', cache);
      assert.equal(classify(scanned, media), 'regenerable-cache');
      assert.equal(classify(scanned, sibling), 'unclassified');

      await writeFile(media, replacement);
      assert.equal(classify(inspect(), media), 'unclassified');
      assert.equal(
        classify(inspect('--artifact-root', cache), media),
        'unclassified',
      );

      const unrelated = join(directory, 'unrelated.mov');
      await writeFile(unrelated, original);
      await rm(media);
      await symlink(unrelated, media);
      const alias = inspect().find(
        ({ resolvedPath }: { resolvedPath: string }) =>
          resolvedPath === unrelated,
      );
      assert.equal(alias.classification, 'unclassified');
      assert.equal(alias.regenerable, false);
    },
  );

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
  const exportDirectory = join(directory, 'exports');
  const exportPath = join(exportDirectory, 'delivery.mp4');
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
  await mkdir(exportDirectory);
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
  const staleReport = json(
    'inspect',
    'dependencies',
    first,
    '--recipe-cache',
    cache,
    '--render-report',
    reportPath,
  ).data;
  assert.ok(
    staleReport.diagnostics.some(
      (item: { code: string; reason: string }) =>
        item.code === 'RENDER_REPORT_OUTPUT_UNVERIFIABLE' &&
        item.reason === 'fingerprint-mismatch',
    ),
  );
  const inspectReport = (file: string) =>
    run(
      'inspect',
      'dependencies',
      file,
      '--recipe-cache',
      cache,
      '--render-report',
      reportPath,
    );
  const mismatch = inspectReport(second);
  assert.equal(mismatch.status, 1);
  assert.equal(
    JSON.parse(mismatch.stderr).error.code,
    'RENDER_REPORT_TIMELINE_MISMATCH',
  );
  const assertUnreachableExport = (status: string) => {
    const rejectedPath = inspectReport(first);
    assert.equal(rejectedPath.status, 0, rejectedPath.stderr);
    const result = JSON.parse(rejectedPath.stdout);
    const exportEntry = result.files.find(
      ({ resolvedPath }: { resolvedPath: string }) =>
        resolvedPath === exportPath,
    );
    assert.equal(exportEntry.status, status);
    assert.deepEqual(exportEntry.roles, ['unverified-export']);
    // Both the historical build and the supplied report should still contribute.
    assert.equal(exportEntry.references.length, 2);
    assert.ok(
      result.diagnostics.some(
        ({ code, reason }: { code: string; reason: string }) =>
          code === 'RENDER_REPORT_OUTPUT_UNVERIFIABLE' &&
          reason === 'missing-or-unreadable-output',
      ),
    );
  };
  await rename(exportDirectory, join(directory, 'archived-exports'));
  await writeFile(exportDirectory, 'A file now occupies the former directory.');
  assertUnreachableExport('missing');
  await rm(exportDirectory);
  await symlink(exportDirectory, exportDirectory);
  assertUnreachableExport('unreadable');

  await writeFile(reportPath, '{invalid JSON');
  const unsupported = inspectReport(first);
  assert.equal(unsupported.status, 1);
  assert.equal(
    JSON.parse(unsupported.stderr).error.code,
    'UNSUPPORTED_RENDER_REPORT',
  );
});

test('cleanup plan identifies project-only, shared and unowned recipe directories without writing', async (t) => {
  const directory = await mkdtemp(join(fixtureDirectory, 'cleanup-plan-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cache = join(directory, 'recipes');
  patches(directory, 60, 4);
  const first = join(directory, 'first.video.ts');
  const second = join(directory, 'second.video.ts');
  const output = join(directory, 'delivery.mp4');
  const resize = (width: number) => ({
    kind: 'video',
    path: 'patches.mov',
    recipe: [{ type: 'resize', width, height: 64 }],
  });
  const write = (
    file: string,
    assets: Record<string, ReturnType<typeof resize>>,
  ) =>
    writeFile(
      file,
      'export default ' +
        JSON.stringify({
          canvas: { width: 64, height: 64, frameRate: 60, durationFrames: 4 },
          assets,
          tracks: Object.keys(assets).map((asset) => ({
            type: 'video',
            clips: [{ asset, at: 0, sourceOut: 4 }],
          })),
        }),
    );
  await write(first, { exclusive: resize(48), shared: resize(64) });
  await write(second, { shared: resize(64) });
  const built = json(
    'render',
    first,
    '--recipe-cache',
    cache,
    '--output',
    output,
  ).data;
  const other = json(
    'render',
    second,
    '--recipe-cache',
    cache,
    '--output',
    join(directory, 'other.mp4'),
  ).data;
  const shared = other.recipeProcessing[0].key;
  const exclusive = built.recipeProcessing.find(
    ({ key }: { key: string }) => key !== shared,
  );
  const unknown = join(cache, '0'.repeat(64));
  await mkdir(unknown);
  await writeFile(join(unknown, 'unexplained'), 'test');
  const recipeDir = join(cache, exclusive.key);
  const receipt = join(recipeDir, 'result.json');
  const before = await readFile(receipt);
  const inspectArgs = [
    'inspect',
    'dependencies',
    first,
    '--recipe-cache',
    cache,
    '--cleanup-plan',
  ];
  const inspect = () => json(...inspectArgs).data.cleanupPlan;
  const preload = join(directory, 'count-cache-reads.mjs');
  const payload = join(recipeDir, `media.${exclusive.format}`);
  await writeFile(
    preload,
    `
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const { open, readFile } = fs;
let reads = 0;
let receiptReads = 0;
fs.open = (path, ...args) => {
  if (path === ${JSON.stringify(payload)}) reads++;
  return open(path, ...args);
};
fs.readFile = async (path, ...args) => {
  const data = await readFile(path, ...args);
  if (process.env.OPENCUT_TEST_CHANGE_RECEIPT !== '1' ||
      path !== ${JSON.stringify(receipt)} || ++receiptReads !== 2) return data;
  return JSON.stringify({ ...JSON.parse(data), sha256: '0'.repeat(64) });
};
syncBuiltinESMExports();
process.on('exit', () => console.error(JSON.stringify({ payloadReads: reads })));
`,
  );
  const measured = runCli(inspectArgs, {
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
  });
  assert.equal(measured.status, 0, measured.stderr);
  assert.deepEqual(JSON.parse(measured.stderr), { payloadReads: 1 });
  const plan = JSON.parse(measured.stdout).cleanupPlan;
  assert.equal(plan.eligible.length, 1);
  assert.equal(plan.eligible[0].path, recipeDir);
  assert.ok(plan.eligible[0].bytes > before.length);
  assert.ok(
    plan.keep.some(
      ({ path, reason }: { path: string; reason: string }) =>
        path === join(cache, shared) &&
        reason === 'referenced-by-another-timeline',
    ),
  );
  assert.ok(plan.keep.some(({ path }: { path: string }) => path === output));
  assert.deepEqual(plan.uncertain, [
    {
      path: unknown,
      bytes: 4,
      reason: 'no-build-ownership-record',
      referencedBy: [],
    },
  ]);
  assert.deepEqual(await readFile(receipt), before);
  const changedReceipt = runCli(inspectArgs, {
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
    OPENCUT_TEST_CHANGE_RECEIPT: '1',
  });
  assert.equal(changedReceipt.status, 0, changedReceipt.stderr);
  assert.deepEqual(JSON.parse(changedReceipt.stderr), { payloadReads: 2 });
  assert.equal(
    JSON.parse(changedReceipt.stdout).cleanupPlan.eligible.length,
    0,
  );
  await writeFile(join(recipeDir, 'unexplained'), 'extra');
  assert.equal(inspect().eligible.length, 0);
  assert.ok(
    inspect().uncertain.some(
      ({ path, reason }: { path: string; reason: string }) =>
        path === recipeDir && reason === 'unverified-cache-directory',
    ),
  );
  await rm(join(recipeDir, 'unexplained'));
  const corrupt = await readFile(payload);
  corrupt[0] = corrupt[0]! ^ 1;
  await writeFile(payload, corrupt);
  assert.equal(inspect().eligible.length, 0);
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

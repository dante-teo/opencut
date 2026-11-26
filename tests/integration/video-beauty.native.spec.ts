import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { VideoDefinition, VideoRecipe } from '@opencut/sdk';
import { fixtureDirectory } from '../fixture-paths.js';

const exec = promisify(execFile);
const cli = fileURLToPath(
  new URL('../../apps/cli/dist/index.js', import.meta.url),
);
const python = process.env.OPENCUT_BEAUTY_PYTHON;
const models = process.env.OPENCUT_BEAUTY_MODELS;
const face = join(fixtureDirectory, 'beauty-dev', 'face.mp4');
const limbMotion = join(
  fixtureDirectory,
  'beauty-dev',
  'length-dev',
  'wide.mp4',
);
const heldOut = join(
  fixtureDirectory,
  'beauty-dev',
  'held-out',
  'held-out.mp4',
);
const fullBody = join(
  fixtureDirectory,
  'beauty-dev',
  'held-out',
  'full-body',
  'source.mp4',
);
const fullBodyOriginal = join(
  fixtureDirectory,
  'beauty-dev',
  'held-out',
  'full-body',
  'jumping-jacks.webm',
);
const fullBodyDefinition = fileURLToPath(
  new URL('../fixtures/beauty-full-body.video.ts', import.meta.url),
);
const portraits = join(
  fixtureDirectory,
  'beauty-dev',
  'held-out',
  'production-corpus',
  'combined-portrait-candidates',
);
const studioPortrait = join(portraits, 'studio-source.mp4');
const studioContext = join(portraits, 'studio-context.mp4');
const walking = join(
  fixtureDirectory,
  'beauty-dev',
  'held-out',
  'production-corpus',
  'walking-source.mp4',
);
const walkingAnnotations = new URL(
  '../fixtures/beauty-walking-anchors.json',
  import.meta.url,
);
const sourceId = 'source';
type BeautyEffect = Extract<
  VideoRecipe[number],
  { type: 'beauty' }
>['effects'][number];
const env = { ...process.env };
delete env.OPENCUT_BEAUTY_PYTHON;
delete env.OPENCUT_BEAUTY_MODELS;

async function scratch(t: TestContext) {
  await mkdir(fixtureDirectory, { recursive: true });
  const directory = await mkdtemp(join(fixtureDirectory, 'beauty-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function ffmpeg(...args: string[]) {
  return exec('ffmpeg', ['-nostdin', '-hide_banner', '-v', 'error', ...args], {
    timeout: 30_000,
  });
}

async function command(
  args: string[],
  runtime = process.env,
  timeout = 90_000,
) {
  const { stdout } = await exec(process.execPath, [cli, ...args, '--json'], {
    env: runtime,
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

function step(
  analysisRef: string,
  parameters: NonNullable<BeautyEffect['parameters']>,
): VideoRecipe {
  return [
    {
      type: 'beauty',
      analysisRef,
      effects: [
        {
          type: 'beauty',
          version: 1,
          id: 'skin',
          target: { assetId: sourceId, shotId: 'shot-1', trackId: 'person-1' },
          timeRange: { start: 0, end: 0.4 },
          parameters,
        },
      ],
    },
  ];
}

async function definition(
  directory: string,
  name: string,
  recipe?: VideoRecipe,
  clip: { sourceIn?: number; sourceOut?: number } = {},
) {
  const file = join(directory, name + '.video.ts');
  const project: VideoDefinition = {
    canvas: { width: 320, height: 180, frameRate: 24 },
    assets: {
      [sourceId]: {
        kind: 'video',
        path: 'source.mp4',
        ...(recipe && { recipe }),
      },
    },
    tracks: [
      {
        type: 'video',
        clips: [{ asset: sourceId, at: 0, sourceOut: 9, ...clip }],
      },
    ],
  };
  await writeFile(file, 'export default ' + JSON.stringify(project) + ';\n', {
    flag: 'wx',
  });
  return file;
}

test('neutral beauty bypasses model setup, analysis, and frame changes', async (t) => {
  const dir = await scratch(t);
  const source = join(dir, 'source.mp4');
  await ffmpeg(
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=24',
    '-frames:v',
    '12',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    source,
  );
  const [plain, neutral] = await Promise.all([
    definition(dir, 'plain'),
    definition(dir, 'neutral', step('a'.repeat(64), { skinBrighten: 0 })),
  ]);
  const output = join(dir, 'plain.mp4');
  const bypass = join(dir, 'neutral.mp4');
  const cache = join(dir, 'cache');
  const controls = ['--encoder', 'software', '--recipe-cache', cache];
  const result = await command(
    ['render', neutral, '--output', bypass, ...controls],
    env,
  );
  await command(['render', plain, '--output', output, ...controls], env);
  assert.equal(result.beauty, undefined);
  assert.equal(result.recipeProcessing, undefined);
  assert.equal(existsSync(join(cache, 'beauty-analysis-v1')), false);
  const [original, processed] = await Promise.all([
    ffmpeg('-i', output, '-map', '0:v:0', '-f', 'framemd5', '-'),
    ffmpeg('-i', bypass, '-map', '0:v:0', '-f', 'framemd5', '-'),
  ]);
  assert.equal(original.stdout, processed.stdout);
  const active = await definition(
    dir,
    'active',
    step('a'.repeat(64), { skinBrighten: 0.2 }),
  );
  await assert.rejects(
    command(['beauty', 'validate', active, '--recipe-cache', cache], env),
    (error: unknown) =>
      String((error as { stderr?: string }).stderr).includes(
        'missing, incomplete, or corrupt',
      ),
  );
  await assert.rejects(command(['beauty', 'preflight'], env), { code: 1 });
});

test(
  'synthetic pixels, geometry, reconstruction, and crossings',
  {
    skip:
      !python && 'Set OPENCUT_BEAUTY_PYTHON to the pinned optional runtime.',
  },
  async () => {
    const tests = fileURLToPath(
      new URL('../fixtures/beauty-effects.py', import.meta.url),
    );
    const { stderr } = await exec(python!, [tests], {
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      timeout: 30_000,
    });
    assert.match(stderr, /\bOK\b/);
  },
);

test(
  'local inference, concurrent cache reuse, track binding, preview parity and quality evidence',
  {
    skip:
      (!python || !models || !existsSync(face)) &&
      'Set up the beauty runtime and run bash tests/fixtures/prepare-beauty.sh.',
    timeout: 150_000,
  },
  async (t) => {
    const dir = await scratch(t);
    const source = join(dir, 'source.mp4');
    const cache = join(dir, 'cache');
    const cacheArgs = ['--recipe-cache', cache];
    await ffmpeg(
      '-i',
      face,
      '-vf',
      "fps=24,select='not(eq(mod(n,4),3))',scale=320:180",
      '-fps_mode',
      'passthrough',
      '-t',
      '0.5',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      source,
    );
    const analyze = ['beauty', 'analyze', source, ...cacheArgs];
    const [a, b] = await Promise.all([command(analyze), command(analyze)]);
    assert.equal(a.id, b.id);
    assert.deepEqual([a.cache, b.cache].sort(), ['built', 'hit']);
    assert.equal(a.summary.tracks[0].trackId, 'person-1');
    assert.ok(a.summary.tracks[0].faceIntervals.length);
    const file = await definition(
      dir,
      'beauty',
      step(a.id, { skinBrighten: 0.35 }),
      { sourceIn: 1 },
    );
    const preview = join(dir, 'preview.mp4');
    const final = join(dir, 'final.mp4');
    const validation = await command([
      'beauty',
      'validate',
      file,
      ...cacheArgs,
    ]);
    assert.equal(validation.bindings[0].status, 'bound');
    const previewed = await command([
      'preview',
      'clip',
      file,
      '--from',
      '0',
      '--to',
      '8',
      '--quality',
      'quality',
      '--output',
      preview,
      ...cacheArgs,
    ]);
    const rendered = await command([
      'render',
      file,
      '--encoder',
      'software',
      '--quality',
      'quality',
      '--output',
      final,
      ...cacheArgs,
    ]);
    assert.equal(rendered.frameCount, 8);
    assert.equal(previewed.beauty[0].recipeKey, rendered.beauty[0].recipeKey);
    const planArgs = [
      'render',
      'plan',
      file,
      '--quality',
      'quality',
      '--encoder',
      'software',
      '--output',
      join(dir, 'planned.mp4'),
      ...cacheArgs,
    ];
    const cached = await command(planArgs);
    assert.equal(cached.recipes[0].status, 'reuse');
    const otherBudget = await command([
      ...planArgs,
      '--recipe-memory-bytes',
      '536870912',
    ]);
    assert.equal(otherBudget.recipes[0].status, 'rebuild');

    const mismatch = join(dir, 'wrong-runtime.json');
    await writeFile(
      mismatch,
      JSON.stringify({
        runtime: { ...a.identity.runtime, python: '0.0.0' },
        output: join(dir, 'wrong-runtime.mov'),
      }),
    );
    await assert.rejects(
      exec(
        python!,
        [
          fileURLToPath(
            new URL(
              '../../packages/media/native/beauty/worker.py',
              import.meta.url,
            ),
          ),
          'render',
          mismatch,
        ],
        {
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
          timeout: 20_000,
        },
      ),
      /Beauty runtime differs from the analysis runtime/,
    );
    assert.equal(existsSync(join(dir, 'wrong-runtime.mov')), false);
    const comparison = await exec(
      'ffmpeg',
      [
        '-nostdin',
        '-hide_banner',
        '-i',
        preview,
        '-i',
        final,
        '-lavfi',
        'psnr',
        '-f',
        'null',
        '-',
      ],
      { timeout: 20_000 },
    );
    const average = comparison.stderr.match(/average:(inf|[0-9.]+)/)?.[1];
    assert.ok(
      average && (average === 'inf' || Number(average) >= 35),
      comparison.stderr,
    );

    assert.equal(rendered.beauty[0].quality.sourceTiming, 'passed');
    assert.ok(rendered.beauty[0].metrics.changedPixels > 0);
    const evidence = await command([
      'beauty',
      'evaluate',
      source,
      '--from',
      '0',
      '--to',
      '8',
      '--result',
      rendered.beauty[0].recipeKey,
      '--output',
      join(dir, 'evidence'),
      ...cacheArgs,
    ]);
    assert.equal(evidence.checks.outsideInfluenceUnchanged, 'passed');
    assert.equal(evidence.checks.visualAcceptance, 'not-evaluated');
    assert.ok(existsSync(evidence.comparisonVideo));
    assert.ok(
      evidence.artifacts.some(
        ({ kind }: { kind: string }) => kind === 'face-skin',
      ),
    );
    const evaluationArgs = [
      'beauty',
      'evaluate',
      source,
      '--from',
      '0',
      '--to',
      '8',
      '--result',
      rendered.beauty[0].recipeKey,
      ...cacheArgs,
    ];
    await assert.rejects(
      command([
        ...evaluationArgs,
        '--output',
        join(dir, 'gate'),
        '--require-visual',
      ]),
      (error: unknown) => {
        const failed = error as { code?: number; stdout?: string };
        return (
          failed.code === 1 &&
          JSON.parse(failed.stdout ?? '{}').checks?.visualAcceptance ===
            'not-evaluated'
        );
      },
    );

    const protectedRecipe = step(a.id, { skinBrighten: 0.35 });
    const blocked = protectedRecipe[0];
    assert.ok(blocked?.type === 'beauty');
    blocked.effects[0]!.protectedRegions = [
      { x: 0, y: 0, width: 1, height: 1 },
    ];
    const protectedDefinition = await definition(
      dir,
      'protected',
      protectedRecipe,
    );
    const blockedPath = join(dir, 'blocked.mp4');
    await assert.rejects(
      command([
        'render',
        protectedDefinition,
        '--output',
        blockedPath,
        ...cacheArgs,
      ]),
      (error: unknown) =>
        String((error as { stderr?: string }).stderr).includes(
          'BEAUTY_COVERAGE_FAILED',
        ),
    );
    assert.equal(existsSync(blockedPath), false);
    await appendFile(a.database, 'corruption');
    await assert.rejects(command(['beauty', 'inspect', a.id, ...cacheArgs]), {
      code: 1,
    });
    const rebuilt = await command(analyze);
    assert.equal(rebuilt.id, a.id);
    assert.equal(rebuilt.cache, 'built');
    await appendFile(source, 'source revision');
    await assert.rejects(
      command(['beauty', 'validate', file, ...cacheArgs]),
      (error: unknown) =>
        String((error as { stderr?: string }).stderr).includes(
          'different source bytes',
        ),
    );
  },
);

test(
  'real moving head, arm and leg edits have measured geometric response',
  {
    skip:
      (!python || !models || !existsSync(face) || !existsSync(limbMotion)) &&
      'Set up the beauty runtime and run bash tests/fixtures/prepare-beauty.sh --held-out.',
    timeout: 150_000,
  },
  async (t) => {
    const dir = await scratch(t);
    const cases = [
      { original: face, effects: { headReduce: 0.15 } },
      { original: limbMotion, effects: { armLength: 0.25, legLength: 0.25 } },
    ] as const;
    for (const [index, sample] of cases.entries()) {
      const work = join(dir, String(index));
      await mkdir(work);
      const source = join(work, 'source.mp4');
      const cache = join(work, 'cache');
      const cacheArgs = ['--recipe-cache', cache];
      await ffmpeg(
        '-i',
        sample.original,
        '-vf',
        'fps=24',
        '-frames:v',
        '12',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-an',
        source,
      );
      const analysis = await command([
        'beauty',
        'analyze',
        source,
        ...cacheArgs,
      ]);
      for (const [parameter, strength] of Object.entries(sample.effects)) {
        const recipe = step(analysis.id, { [parameter]: strength });
        const geometry = recipe[0];
        assert.ok(geometry?.type === 'beauty');
        geometry.acceptance = 'allow-limitations';
        const file = await definition(work, parameter, recipe);
        const result = await command([
          'render',
          file,
          '--encoder',
          'software',
          '--output',
          join(work, parameter + '.mp4'),
          ...cacheArgs,
        ]);
        const render = result.beauty[0];
        assert.ok(render.metrics.changedFrames > 0);
        const observed = render.intervals.filter(
          (item: { parameter: string; measurement?: unknown }) =>
            item.parameter === parameter && item.measurement,
        );
        assert.ok(observed.length, parameter);
        assert.ok(
          observed.every(
            (item: { measurement: { min: number } }) =>
              item.measurement.min > 0,
          ),
          parameter,
        );
        const evidence = await command([
          'beauty',
          'evaluate',
          source,
          '--result',
          render.recipeKey,
          '--from',
          '0',
          '--to',
          '12',
          '--output',
          join(work, parameter + '-evidence'),
          ...cacheArgs,
        ]);
        assert.equal(evidence.checks.outsideInfluenceUnchanged, 'passed');
        assert.equal(evidence.checks.geometryBounds, 'passed');
        assert.equal(evidence.checks.visualAcceptance, 'not-evaluated');
      }
    }
  },
);

test(
  'full-body motion retains measured head, arm, and leg response on every frame',
  {
    skip:
      (!python || !models || !existsSync(fullBody)) &&
      'Set up the beauty runtime and run bash tests/fixtures/prepare-beauty.sh --held-out.',
    timeout: 240_000,
  },
  async (t) => {
    const dir = await scratch(t);
    const cacheArgs = ['--recipe-cache', join(dir, 'cache')];
    const analysis = await command([
      'beauty',
      'analyze',
      fullBody,
      ...cacheArgs,
    ]);
    const params = join(dir, 'params.json');
    await writeFile(
      params,
      JSON.stringify({ analysisRef: analysis.id, diagnostic: true }),
    );
    const result = await command(
      [
        'render',
        fullBodyDefinition,
        '--params',
        params,
        '--quality',
        'quality',
        '--encoder',
        'software',
        '--output',
        join(dir, 'full-body.mp4'),
        ...cacheArgs,
      ],
      process.env,
      180_000,
    );
    const report = result.beauty[0];
    assert.equal(report.frames, 54);
    assert.equal(report.metrics.changedFrames, 54);
    assert.equal(report.quality.sourceTiming, 'passed');
    assert.equal(report.quality.geometryBounds, 'passed');
    for (const name of ['headReduce', 'armLength', 'legLength']) {
      const intervals = report.intervals.filter(
        (item: { parameter: string }) => item.parameter === name,
      );
      assert.ok(intervals.length > 0, name);
      assert.equal(
        intervals.reduce(
          (
            total: number,
            item: { measurement?: { min: number; samples: number } },
          ) => {
            assert.ok(item.measurement && item.measurement.min > 0, name);
            return total + item.measurement.samples;
          },
          0,
        ),
        54,
        name,
      );
    }
  },
);

test(
  'verified original context retains full requested strength on the held-out excerpt',
  {
    skip:
      (!python ||
        !models ||
        !existsSync(fullBody) ||
        !existsSync(fullBodyOriginal)) &&
      'Set up the beauty runtime and run bash tests/fixtures/prepare-beauty.sh --held-out.',
    timeout: 240_000,
  },
  async (t) => {
    const dir = await scratch(t);
    const cacheArgs = ['--recipe-cache', join(dir, 'cache')];
    const analysis = await command([
      'beauty',
      'analyze',
      fullBody,
      '--context-source',
      fullBodyOriginal,
      '--context-start',
      '0.6',
      ...cacheArgs,
    ]);
    assert.equal(analysis.identity.context.start, 0.6);
    assert.notEqual(
      analysis.identity.sourceSha256,
      analysis.identity.context.sourceSha256,
    );
    const params = join(dir, 'params.json');
    await writeFile(params, JSON.stringify({ analysisRef: analysis.id }));
    const output = join(dir, 'strict.mp4');
    const result = await command(
      [
        'render',
        fullBodyDefinition,
        '--params',
        params,
        '--quality',
        'quality',
        '--encoder',
        'software',
        '--output',
        output,
        ...cacheArgs,
      ],
      process.env,
      180_000,
    );
    const report = result.beauty[0];
    assert.equal(report.status, 'completed');
    assert.equal(result.frameCount, 54);
    assert.equal(existsSync(output), true);
    for (const interval of report.intervals) {
      assert.equal(interval.status, 'applied');
      assert.equal(interval.frames, 54);
      assert.ok(interval.measurement.min > 0);
    }
    assert.equal(report.intervals.length, 3);
    assert.equal(report.reconstruction.length, 1);
    assert.equal(
      report.reconstruction[0].temporalPixels,
      report.metrics.temporalPixels,
    );
    assert.ok(report.reconstruction[0].sample.temporalPixels > 0);
    const evidence = await command([
      'beauty',
      'evaluate',
      fullBody,
      '--result',
      report.recipeKey,
      '--from',
      '0',
      '--to',
      '54',
      '--output',
      join(dir, 'evidence'),
      ...cacheArgs,
    ]);
    assert.equal(evidence.checks.sourceTiming, 'passed');
    assert.equal(evidence.checks.geometryBounds, 'passed');
    assert.equal(evidence.checks.outsideInfluenceUnchanged, 'passed');
    assert.ok(
      evidence.artifacts.some(
        (artifact: { kind: string }) =>
          artifact.kind === 'reconstructed-background',
      ),
    );
  },
);

test(
  'visible-result accepts sustained, independently measured cheek and head changes',
  {
    skip:
      (!python ||
        !models ||
        !existsSync(studioPortrait) ||
        !existsSync(studioContext)) &&
      'Set up beauty and run bash tests/fixtures/prepare-beauty.sh --portrait-geometry.',
    timeout: 360_000,
  },
  async (t) => {
    const dir = await scratch(t);
    const source = join(dir, 'source.mp4');
    await symlink(studioPortrait, source);
    const cacheArgs = ['--recipe-cache', join(dir, 'cache')];
    const analysis = await command([
      'beauty',
      'analyze',
      source,
      '--context-source',
      studioContext,
      '--context-start',
      '4.8',
      ...cacheArgs,
    ]);
    const recipe = step(analysis.id, {
      faceSlim: 0.32,
      headReduce: 0.28,
      eyeEnlarge: 0.1,
    });
    const beauty = recipe[0];
    assert.ok(beauty?.type === 'beauty');
    beauty.acceptance = 'visible-result';
    beauty.effects[0]!.timeRange.end = 1.8;
    const file = await definition(dir, 'visible-portrait', recipe, {
      sourceOut: 43,
    });
    const output = join(dir, 'visible.mp4');
    const rendered = await command(
      [
        'render',
        file,
        '--quality',
        'quality',
        '--encoder',
        'software',
        '--output',
        output,
        ...cacheArgs,
      ],
      process.env,
      300_000,
    );
    const report = rendered.beauty[0];
    assert.equal(existsSync(output), true);
    assert.equal(report.quality.sourceTiming, 'passed');
    assert.equal(report.quality.geometryBounds, 'passed');
    assert.equal(report.visibleResult.status, 'passed');
    assert.deepEqual(report.visibleResult.unavailableControls, []);
    assert.equal(report.visibleResult.controls.length, 2);
    for (const result of report.visibleResult.controls) {
      assert.equal(result.frames, 45);
      assert.equal(result.missingFrames, 0, result.parameter);
      assert.equal(result.status, 'passed', result.parameter);
    }
    const eyes = report.intervals.find(
      (item: { parameter: string }) => item.parameter === 'eyeEnlarge',
    );
    assert.equal(eyes.status, 'applied');
    assert.equal(eyes.frames, 45);
  },
);

test(
  'held-out crop fails both coverage policies when the tracked region is unavailable',
  {
    skip:
      (!python || !models || !existsSync(heldOut)) &&
      'Set up the beauty runtime and run bash tests/fixtures/prepare-beauty.sh --held-out.',
    timeout: 90_000,
  },
  async (t) => {
    const dir = await scratch(t);
    const source = join(dir, 'source.mp4');
    const cache = join(dir, 'cache');
    const cacheArgs = ['--recipe-cache', cache];
    await symlink(heldOut, source);
    const analysis = await command(['beauty', 'analyze', source, ...cacheArgs]);
    const recipe = step(analysis.id, {
      bodySlim: 0.16,
      waistSlim: 0.12,
      legSlim: 0.1,
      legLength: 0.08,
      armSlim: 0.1,
    });
    const geometry = recipe[0];
    assert.ok(geometry?.type === 'beauty');
    const effect = geometry.effects[0]!;
    effect.target.trackId = 'person-2';
    effect.timeRange.end = 59 / 30;
    effect.failurePolicy = { trackingUncertain: 'bypass' };
    for (const acceptance of ['complete-coverage', 'visible-result'] as const) {
      geometry.acceptance = acceptance;
      const file = await definition(dir, acceptance, recipe, { sourceOut: 47 });
      const output = join(dir, acceptance + '.mp4');
      await assert.rejects(
        command([
          'render',
          file,
          '--encoder',
          'software',
          '--output',
          output,
          ...cacheArgs,
        ]),
        (error: unknown) => {
          const failed = error as { code?: number; stderr?: string };
          if (failed.code !== 1) return false;
          const line = failed.stderr?.trim().split('\n').at(-1);
          const result = JSON.parse(line ?? '{}');
          assert.equal(result.error.code, 'BEAUTY_COVERAGE_FAILED');
          const intervals = result.beauty.intervals.filter(
            (interval: { parameter: string }) =>
              interval.parameter === 'legLength',
          );
          assert.ok(intervals.length);
          assert.ok(
            intervals.every(
              (interval: { status: string; reason: string }) =>
                interval.status === 'bypassed' &&
                ['track-not-visible', 'region-not-visible'].includes(
                  interval.reason,
                ),
            ),
          );
          if (acceptance === 'visible-result') {
            assert.equal(result.beauty.visibleResult.status, 'failed');
            assert.deepEqual(
              result.beauty.visibleResult.controls.map(
                ({
                  parameter,
                  frames,
                  missingFrames,
                }: {
                  parameter: string;
                  frames: number;
                  missingFrames: number;
                }) => [parameter, frames, missingFrames],
              ),
              [['legLength', 59, 59]],
            );
          }
          return true;
        },
      );
      assert.equal(existsSync(output), false);
    }
  },
);

test(
  'annotated crossing protects the other person and explicitly restores the original tracks',
  {
    skip:
      (!python || !models || !existsSync(walking)) &&
      'Set up beauty and run bash tests/fixtures/prepare-beauty.sh --acceptance-corpus.',
    timeout: 150_000,
  },
  async (t) => {
    const dir = await scratch(t);
    const source = join(dir, 'source.mp4');
    await symlink(walking, source);
    const annotations = JSON.parse(await readFile(walkingAnnotations, 'utf8'));
    const edit = join(dir, 'corrections.json');
    await writeFile(edit, JSON.stringify(annotations.corrections));
    const cacheArgs = ['--recipe-cache', join(dir, 'cache')];
    const analysis = await command([
      'beauty',
      'analyze',
      source,
      '--edit',
      edit,
      ...cacheArgs,
    ]);
    assert.deepEqual(
      analysis.summary.correctionsApplied,
      annotations.corrections.map((entry: object) => ({
        ...entry,
        reassociated: true,
      })),
    );
    const [width, height] = analysis.summary.analysisSize;
    const db = new DatabaseSync(analysis.database, { readOnly: true });
    try {
      const findPose = db.prepare(
        'SELECT body FROM people WHERE frame = ? AND track = ?',
      );
      for (const { frame, trackId, anchor } of annotations.visible) {
        const row = findPose.get(frame, trackId);
        assert.equal(
          typeof row?.body,
          'string',
          `Missing ${trackId} at ${frame}`,
        );
        const pose = JSON.parse(String(row?.body)) as [
          number,
          number,
          number,
        ][];
        const torso = [11, 12, 23, 24].map((joint) => pose[joint]!);
        assert.ok(torso.every((joint) => joint[2] > 0.5));
        const x = torso.reduce((sum, joint) => sum + joint[0], 0) / (4 * width);
        const y =
          torso.reduce((sum, joint) => sum + joint[1], 0) / (4 * height);
        assert.ok(
          Math.hypot(x - anchor[0], y - anchor[1]) < 0.04,
          `Wrong person at frame ${frame}`,
        );
      }
      const observation = db.prepare(
        'SELECT ambiguous FROM frames WHERE frame = ?',
      );
      for (const frame of annotations.overlapFrames) {
        assert.equal(observation.get(frame)?.ambiguous, 1);
        assert.equal(findPose.get(frame, 'person-1'), undefined);
      }
    } finally {
      db.close();
    }
    const recipe = step(analysis.id, { bodySlim: 0.16, legSlim: 0.14 });
    const beauty = recipe[0];
    assert.ok(beauty?.type === 'beauty');
    beauty.acceptance = 'allow-limitations';
    const effect = beauty.effects[0]!;
    effect.timeRange = { start: 3, end: 6.28 };
    effect.failurePolicy = { trackingUncertain: 'bypass' };
    const project = await definition(dir, 'crossing', recipe, {
      sourceIn: 73,
      sourceOut: 161,
    });
    const rendered = await command([
      'render',
      project,
      '--output',
      join(dir, 'output.mp4'),
      ...cacheArgs,
    ]);
    const report = rendered.beauty[0];
    assert.ok(report.metrics.changedFrames > 0);
    for (const frame of annotations.overlapFrames) {
      const at = report.intervals.filter(
        (effect: { intervals: { startFrame: number; endFrame: number }[] }) =>
          effect.intervals.some(
            (range) => range.startFrame <= frame && frame < range.endFrame,
          ),
      );
      assert.equal(at.length, 2);
      assert.ok(
        at.every(
          (effect: { status: string; reason: string }) =>
            effect.status === 'bypassed' &&
            effect.reason === 'ambiguous-association',
        ),
      );
    }
    const evidence = await command([
      'beauty',
      'evaluate',
      source,
      '--result',
      report.recipeKey,
      '--from',
      '73',
      '--to',
      '161',
      '--output',
      join(dir, 'evidence'),
      ...cacheArgs,
    ]);
    assert.equal(evidence.checks.nonTargetPeopleUnchanged, 'passed');
    assert.ok(evidence.metrics.nonTargetPersonPixels > 0);
    assert.equal(evidence.metrics.changedNonTargetPersonPixels, 0);
  },
);

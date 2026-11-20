import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { arch, platform, release } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { run } from 'node:test';
import {
  generatedFixtures,
  resolveFixtureDirectory,
} from '../tests/fixture-paths.js';

const require = createRequire(import.meta.url);
const results = resolve('conformance-results');
await mkdir(results, { recursive: true });
const output = await mkdtemp(join(results, 'run-'));
const report = join(output, 'report.json');
const cases: {
  name: string;
  file: string | undefined;
  status: 'passed' | 'failed' | 'skipped' | 'todo';
  detail?: string;
}[] = [];
const measurements: unknown[] = [];
const issues: string[] = [];
let hardware: unknown;
let ffmpeg: string | undefined;
let desktop: unknown;
let scratch: string | undefined;

function execute(
  executable: string,
  args: string[],
  { allowFailure = false }: { allowFailure?: boolean } = {},
) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 ** 2,
    timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0)
    throw new Error(`${executable}: ${result.stderr || result.stdout}`);
  return result;
}

try {
  ffmpeg = execute('ffmpeg', ['-version']).stdout.split('\n')[0];
  hardware = JSON.parse(
    execute(process.execPath, [
      'apps/cli/dist/index.js',
      'system',
      'inspect',
      '--json',
    ]).stdout,
  ).videoToolbox;
  const generated = resolveFixtureDirectory(generatedFixtures);
  await mkdir(generated, { recursive: true });
  scratch = await mkdtemp(join(generated, 'conformance-'));
  const fixtures = join(scratch, 'media');
  const examples = join(scratch, 'definitions');
  Object.assign(process.env, {
    OPENCUT_TEST_FIXTURES: fixtures,
    OPENCUT_TEST_EXAMPLES: examples,
    OPENCUT_CONFORMANCE_ARTIFACTS: output,
    XDG_CACHE_HOME: join(scratch, 'cache'),
    TMPDIR: join(scratch, 'tmp'),
  });
  await mkdir(process.env.TMPDIR!);
  execute(process.execPath, [
    '--import',
    'tsx',
    'scripts/fixtures.ts',
    'generate',
  ]);
  await mkdir(examples);
  for (const name of [
    'showcase.video.ts',
    'review.video.ts',
    'review-title.ts',
    'recipes.video.ts',
  ]) {
    const original = await readFile(join('examples/video', name), 'utf8');
    await writeFile(
      join(examples, name),
      original.replaceAll(
        '../../tests/fixtures/generated',
        relative(examples, fixtures),
      ),
    );
  }

  const files = [
    'video-definition',
    'graphics-qualification',
    'video-graphics',
    'definition-runtime',
    'video-watch',
    'video-recipes',
    'video-interpolation',
    'video-enhancement',
    'video-conformance',
    'ai-conformance',
  ].map((name) => resolve('tests/integration', name + '.native.spec.ts'));
  for await (const event of run({ files, concurrency: 1 })) {
    if (
      event.type === 'test:diagnostic' &&
      event.data.message.startsWith('measurement ')
    ) {
      measurements.push(
        JSON.parse(event.data.message.slice('measurement '.length)),
      );
    }
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const { name, file, skip, todo, details } = event.data;
    const error = 'error' in details ? (details.error as Error) : undefined;
    const status = skip
      ? 'skipped'
      : todo
        ? 'todo'
        : event.type === 'test:fail'
          ? 'failed'
          : 'passed';
    const detail = [
      skip,
      todo,
      error?.message,
      error?.cause instanceof Error && error.cause.message,
    ]
      .filter((value): value is string => typeof value === 'string')
      .join('\n');
    cases.push({
      name,
      file: file && relative(process.cwd(), file),
      status,
      ...(detail && { detail }),
    });
    process.stdout.write(`${status} ${name}${detail ? `: ${detail}` : ''}\n`);
  }

  const result = execute(
    process.execPath,
    [
      require.resolve('@playwright/test/cli'),
      'test',
      'video-definition-review.spec.ts',
      '--reporter=json',
      '--output',
      join(output, 'desktop-artifacts'),
    ],
    { allowFailure: true },
  );
  await writeFile(join(output, 'desktop.json'), result.stdout);
  desktop = {
    report: 'desktop.json',
    exitCode: result.status,
    ...(result.stderr.trim() && { stderr: result.stderr.trim() }),
  };
  if (result.status !== 0)
    issues.push('Electron definition review failed. See desktop.json.');
  else {
    const { stats } = JSON.parse(result.stdout);
    desktop = { report: 'desktop.json', exitCode: 0, stats };
  }
} catch (error) {
  issues.push(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
} finally {
  if (scratch) {
    try {
      await rm(scratch, { recursive: true, force: true });
    } catch (error) {
      issues.push(
        `Cannot clean the temporary conformance workspace: ${String(error)}`,
      );
    }
  }
  const failed =
    issues.length > 0 ||
    !cases.length ||
    cases.some(({ status }) => status === 'failed' || status === 'todo');
  await writeFile(
    report,
    JSON.stringify(
      {
        version: 1,
        status: failed
          ? 'failed'
          : cases.some(({ status }) => status === 'skipped')
            ? 'passed-with-skips'
            : 'passed',
        host: {
          platform: platform(),
          arch: arch(),
          release: release(),
          ffmpeg,
          videoToolbox: hardware,
        },
        cases,
        measurements,
        desktop,
        issues,
      },
      null,
      2,
    ) + '\n',
  );
  for (const issue of issues) process.stderr.write(issue + '\n');
  process.stdout.write(
    `Conformance report: ${relative(process.cwd(), report)}\n`,
  );
  if (failed) process.exitCode = 1;
}

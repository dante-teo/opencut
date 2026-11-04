import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { cpus, release, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { planProjectRender, serializeProject } from '@opencut/core';
import {
  auditMedia,
  auditProjects,
  generateAuditMedia,
} from './t21-projects.js';

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--headless'))
  throw new Error('Usage: pnpm audit:t21 [--headless]');
await mkdir('tests/fixtures/generated', { recursive: true });
const directory = await mkdtemp(resolve('tests/fixtures/generated/t21-'));
const results: Record<string, unknown> = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  directory,
  environment: {
    platform: process.platform,
    arch: process.arch,
    release: release(),
    node: process.version,
    cpu: cpus()[0]?.model,
    logicalCPUs: cpus().length,
    totalMemoryGiB: totalmem() / 2 ** 30,
  },
  liveTimelinePlayback: {
    status: 'not-measured',
    reason:
      'This source/export baseline does not measure T24 playback; use the timeline-playback desktop tests.',
  },
};
let failed = false;
const sourceHashes = new Map<string, string>();
async function sha256(file: string) {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}
function command(command: string, argv: string[]) {
  const result = spawnSync(command, argv, {
    encoding: 'utf8',
    timeout: 600_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${command}: ${result.error?.message ?? result.stderr ?? result.signal}`,
    );
  return result.stdout;
}
async function stage(name: string, action: () => Promise<unknown>) {
  try {
    results[name] = { status: 'measured', result: await action() };
  } catch (error) {
    failed = true;
    results[name] = { status: 'failed', reason: String(error) };
  }
  await writeFile(
    join(directory, 'baseline.json'),
    JSON.stringify(results, null, 2) + '\n',
  );
}
results.revision = command('git', ['rev-parse', 'HEAD']).trim();
results.workingTree = command('git', ['status', '--short']);
results.harnessSha256 = Object.fromEntries(
  await Promise.all(
    [
      'scripts/t21.ts',
      'scripts/t21-projects.ts',
      'tests/desktop/t21.perf.ts',
      'playwright.t21.config.ts',
      'apps/desktop/src/renderer/preview.ts',
    ].map(async (file) => [file, await sha256(file)]),
  ),
);

const projects = auditProjects();
await stage('projects', async () => {
  for (const [name, project] of Object.entries(projects))
    await writeFile(
      join(directory, `${name}.opencut.json`),
      serializeProject(project),
      { flag: 'wx' },
    );
  return Object.fromEntries(
    Object.entries(projects).map(([name, project]) => [
      name,
      {
        clips: project.clips.length,
        tracks: project.tracks.length,
        plan: planProjectRender(project),
      },
    ]),
  );
});
const tools = Object.fromEntries(
  ['ffmpeg', 'ffprobe'].map((tool) => {
    const result = spawnSync(tool, ['-version'], { encoding: 'utf8' });
    return [
      tool,
      {
        available: !result.error && result.status === 0,
        version: result.stdout?.split('\n')[0] ?? null,
        reason: result.error?.message ?? result.stderr,
      },
    ];
  }),
);
results.tools = tools;
const mediaAvailable = Object.values(tools).every((tool) => tool.available);
if (mediaAvailable) {
  await stage('media', async () => {
    generateAuditMedia((args, file) => {
      command('ffmpeg', [
        '-v',
        'error',
        '-nostdin',
        '-n',
        ...args,
        join(directory, file),
      ]);
    });
    return Promise.all(
      auditMedia.map(async (file) => ({
        file,
        sha256: await sha256(join(directory, file)),
        metadata: JSON.parse(
          command('ffprobe', [
            '-v',
            'error',
            '-show_streams',
            '-show_format',
            '-of',
            'json',
            join(directory, file),
          ]),
        ) as unknown,
      })),
    );
  });
  for (const file of auditMedia) {
    const bytes = await readFile(join(directory, file)).catch(() => null);
    if (bytes)
      sourceHashes.set(file, createHash('sha256').update(bytes).digest('hex'));
  }
  for (const name of Object.keys(projects))
    await stage(`export-${name}`, async () => {
      const started = performance.now();
      const output = command(process.execPath, [
        'apps/cli/dist/index.js',
        'project',
        'render',
        join(directory, `${name}.opencut.json`),
        '--output',
        join(directory, `${name}.mp4`),
        '--quality',
        'draft',
        '--json',
      ]);
      const events = output
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { event: string });
      if (events.at(-1)?.event !== 'completed')
        throw new Error('No completed export event');
      return {
        wallMs: performance.now() - started,
        sha256: await sha256(join(directory, `${name}.mp4`)),
        completed: events.at(-1),
      };
    });
} else {
  results.media = {
    status: 'unavailable',
    reason:
      'FFmpeg/ffprobe missing; install manually and rerun. Portable offline projects and render plans remain available.',
  };
  for (const name of Object.keys(projects))
    results[`export-${name}`] = {
      status: 'unavailable',
      reason: 'Media prerequisites unavailable.',
    };
}
if (args.includes('--headless'))
  results.desktop = {
    status: 'unavailable',
    reason:
      'Explicit --headless fallback; no playback, seek, CPU or memory measurements claimed.',
  };
else {
  await stage('desktop', async () => {
    const result = spawnSync(
      'pnpm',
      ['exec', 'playwright', 'test', '--config', 'playwright.t21.config.ts'],
      {
        encoding: 'utf8',
        timeout: 300_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, OPENCUT_T21_DIR: directory },
      },
    );
    await writeFile(
      join(directory, 'desktop.log'),
      `${result.stdout}\n${result.stderr}`,
    );
    const report = await readFile(join(directory, 'desktop.json'), 'utf8').then(
      (text) => JSON.parse(text) as unknown,
      () => null,
    );
    if (result.error || result.status !== 0) {
      results.desktopEvidence = report;
      throw new Error(
        `Desktop benchmark failed; see desktop.log. ${result.error?.message ?? `Exit ${result.status}`}`,
      );
    }
    return report;
  });
}
if (sourceHashes.size)
  await stage('sourceIntegrity', async () => {
    for (const [file, before] of sourceHashes) {
      const after = await sha256(join(directory, file));
      if (before !== after)
        throw new Error(`Generated source changed: ${file}`);
    }
    return { checkedFiles: sourceHashes.size, unchanged: true };
  });
else
  results.sourceIntegrity = {
    status: 'unavailable',
    reason: 'No generated sources to compare.',
  };
results.status = failed
  ? 'failed'
  : args.includes('--headless') || !mediaAvailable
    ? 'partial'
    : 'complete-with-known-timeline-gap';
await writeFile(
  join(directory, 'baseline.json'),
  JSON.stringify(results, null, 2) + '\n',
);
console.log(
  `T21 ${String(results.status)}: ${join(directory, 'baseline.json')}`,
);
if (failed) process.exitCode = 1;

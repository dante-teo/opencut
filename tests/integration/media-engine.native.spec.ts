import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fixtureDirectory } from '../fixture-paths.js';

const cli = fileURLToPath(
  new URL('../../apps/cli/dist/index.js', import.meta.url),
);
const engine = fileURLToPath(
  new URL('../../packages/media/dist/opencut-media-engine', import.meta.url),
);
const sample = fileURLToPath(
  new URL('../distribution/smoke.video.ts', import.meta.url),
);

test('native media jobs reject an incompatible protocol before opening inputs', () => {
  const { status, stdout, stderr } = spawnSync(
    engine,
    [
      '--job',
      JSON.stringify({
        protocol: 0,
        release: 'incompatible',
        job: { kind: 'countVideo', path: '/path-that-must-not-be-opened' },
      }),
    ],
    { encoding: 'utf8', timeout: 5000 },
  );
  assert.equal(status, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /Incompatible OpenCut media engine/);
});

function hasExited(pid: number) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    throw error;
  }
}

async function awaitCondition<T>(check: () => T | Promise<T>) {
  const deadline = Date.now() + 10_000;
  do {
    const result = await check();
    if (result) return result;
    await delay(25);
  } while (Date.now() < deadline);
  assert.fail('Timed out waiting for the native media job to change state.');
}

test(
  'the public render kills native verification on interrupt and owner exit',
  { timeout: 45_000 },
  async (t) => {
    const lookup = spawnSync('which', ['ffprobe'], { encoding: 'utf8' });
    assert.equal(lookup.status, 0, lookup.stderr);
    const realProbe = lookup.stdout.trim();
    await mkdir(fixtureDirectory, { recursive: true });
    const directory = await mkdtemp(join(fixtureDirectory, 'engine-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await writeFile(
      join(directory, 'ffprobe'),
      `#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('-count_frames')) {
  writeFileSync(process.env.OPENCUT_TEST_COUNT_PID, String(process.pid));
  setInterval(() => {}, 1000);
} else {
  process.stdout.write(execFileSync(process.env.OPENCUT_TEST_REAL_FFPROBE, args, { stdio: ['ignore', 'pipe', 'inherit'] }));
}
`,
      { mode: 0o755 },
    );
    const output = join(directory, '旧版.mp4');
    const previous = spawnSync(
      process.execPath,
      [cli, 'render', sample, '-o', output, '--json'],
      { encoding: 'utf8', timeout: 30_000 },
    );
    assert.equal(previous.status, 0, previous.stderr);
    const original = await readFile(output);
    for (const termination of ['SIGINT', 'SIGKILL'] as const) {
      const marker = join(directory, `probe-${termination}`);
      const cliProcess = spawn(
        process.execPath,
        [cli, 'render', sample, '-o', output, '--overwrite', '--json'],
        {
          stdio: ['ignore', 'ignore', 'pipe'],
          env: {
            ...process.env,
            PATH: [directory, process.env.PATH ?? ''].join(delimiter),
            OPENCUT_TEST_COUNT_PID: marker,
            OPENCUT_TEST_REAL_FFPROBE: realProbe,
            XDG_CACHE_HOME: join(directory, 'cache'),
          },
        },
      );
      let diagnostic = '';
      cliProcess.stderr.setEncoding('utf8').on('data', (data: string) => {
        diagnostic = (diagnostic + data).slice(-4096);
      });
      const closed = once(cliProcess, 'close');
      let probePid: number | undefined;
      try {
        probePid = await awaitCondition(async () => {
          const pid = await readFile(marker, 'utf8').catch(() => '');
          if (cliProcess.exitCode !== null)
            assert.fail(`OpenCut exited before verification: ${diagnostic}`);
          return Number(pid);
        });
        assert.ok(Number.isSafeInteger(probePid) && probePid > 1);
        assert.equal(cliProcess.kill(termination), true);
        const [code, signal] = await closed;
        if (termination === 'SIGINT') {
          assert.equal(code, 130, diagnostic);
          assert.match(diagnostic, /cancelled/i);
        } else assert.equal(signal, 'SIGKILL');
        await awaitCondition(() => hasExited(probePid!));
        assert.equal((await stat(output)).size, original.length);
        assert.deepEqual(await readFile(output), original);
      } finally {
        cliProcess.kill('SIGKILL');
        if (probePid !== undefined && !hasExited(probePid))
          process.kill(probePid, 'SIGKILL');
        await closed;
      }
    }
  },
);

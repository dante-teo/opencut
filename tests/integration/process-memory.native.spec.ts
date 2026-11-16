import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const exec = promisify(execFile);
const helper = fileURLToPath(
  new URL('../../packages/media/dist/process-memory', import.meta.url),
);

test(
  'macOS RSS helper totals the detached recipe group and tolerates exited PIDs',
  {
    skip: process.platform !== 'darwin',
  },
  async () => {
    const child = spawn('/bin/sh', ['-c', '/bin/sleep 10 & echo "$!"; wait'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const exit = once(child, 'exit');
    const signal = AbortSignal.timeout(5_000);
    async function rss(mode: 'pids' | 'group', ...pids: number[]) {
      const { stdout } = await exec(helper, [mode, ...pids.map(String)], {
        signal,
      });
      assert.match(stdout.trim(), /^\d+$/);
      return Number(stdout);
    }
    assert.ok(child.pid);
    const leader = child.pid;
    try {
      const [chunk] = await once(child.stdout, 'data', { signal });
      const worker = Number(chunk.toString().trim());
      assert.ok(Number.isSafeInteger(worker) && worker > 1);
      const single = await rss('pids', leader);
      const both = await rss('pids', leader, worker);
      const group = await rss('group', leader);
      assert.ok(single > 0 && both > single && group > single);
      assert.ok(Math.abs(group - both) <= 1024 * 1024);
    } finally {
      process.kill(-leader, 'SIGTERM');
      await exit;
    }
    assert.equal(await rss('pids', leader), 0);
  },
);

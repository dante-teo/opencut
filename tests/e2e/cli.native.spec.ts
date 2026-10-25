import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const generated = new URL('../fixtures/generated/', import.meta.url);
const directories = async () =>
  (
    await readdir(generated).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    })
  )
    .filter((name) => name.startsWith('t14-e2e-'))
    .sort();

test(
  'CLI-only editing/export succeeds twice in isolated fresh projects and cleans artifacts',
  { timeout: 240000 },
  async () => {
    const before = await directories();
    const projects: string[] = [];
    const hashes: string[] = [];
    for (let i = 0; i < 2; i++) {
      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'scripts/cli-e2e.ts'],
        {
          cwd: root,
          encoding: 'utf8',
          timeout: 110000,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      const report = JSON.parse(result.stdout) as {
        outputHash: string;
        project: string;
        directory: string;
        retained: boolean;
        durationSeconds: number;
        frameCount: number;
        cliProcesses: number;
      };
      assert.equal(report.retained, false);
      assert.equal(report.durationSeconds, 18);
      assert.equal(report.frameCount, 540);
      assert.ok(report.cliProcesses > 40);
      projects.push(report.project);
      assert.match(report.outputHash, /^[a-f0-9]{64}$/);
      hashes.push(report.outputHash);
      await assert.rejects(access(report.directory), { code: 'ENOENT' });
      assert.deepEqual(await directories(), before);
    }
    assert.notEqual(projects[0], projects[1]);
    assert.equal(
      hashes[0],
      hashes[1],
      'Repeated exports differ with the same fixtures and toolchain',
    );
  },
);

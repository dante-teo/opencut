import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
const execute = promisify(execFile);
const entry = resolve('apps/cli/dist/index.js');
let directory: string;
beforeEach(async () => {
  await mkdir(resolve('tests/fixtures/generated'), { recursive: true });
  directory = await mkdtemp(resolve('tests/fixtures/generated/t25-cli-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
it('manages persisted cache limits and cleanup through clean CLI JSON, without media tools', async () => {
  const run = async (...args: string[]) =>
    JSON.parse(
      (
        await execute(process.execPath, [
          entry,
          '--json',
          'cache',
          ...args,
          '--directory',
          directory,
        ])
      ).stdout,
    ) as {
      event: string;
      result: {
        limits: { diskBytes: number; memoryBytes: number };
        diskBytes: number;
        entries: unknown[];
      };
    };
  expect((await run('status')).event).toBe('result');
  expect(
    (await run('configure', '--disk-mib', '8', '--memory-mib', '1')).result
      .limits,
  ).toEqual({ diskBytes: 8 * 1024 ** 2, memoryBytes: 1024 ** 2 });
  expect((await run('status')).result.limits.memoryBytes).toBe(1024 ** 2);
  expect((await run('cleanup')).result.entries).toEqual([]);
  expect((await run('clear')).result.diskBytes).toBe(0);
});
it.each([
  ['configure', '--disk-mib', '0', '--memory-mib', '1'],
  ['frame', 'source.mp4'],
  ['status', '--regenerate'],
])('rejects invalid cache arguments %j', async (...args) => {
  const error = await execute(process.execPath, [
    entry,
    'cache',
    ...args,
    '--directory',
    directory,
    '--json',
  ]).catch((error: { code: number; stdout: string; stderr: string }) => error);
  expect(error).toMatchObject({ code: 2, stdout: '' });
});
it('documents proxy progress, cancellation and cache management', async () => {
  const result = await execute(process.execPath, [
    entry,
    'cache',
    '--help',
    '--json',
  ]);
  expect(JSON.parse(result.stdout).help).toContain('SIGINT/SIGTERM');
});

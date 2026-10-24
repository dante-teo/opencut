import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { getApplicationInfo } from '@opencut/core';

const entry = fileURLToPath(
  new URL('../../apps/cli/dist/index.js', import.meta.url),
);
const run = (...args: string[]) =>
  spawnSync(process.execPath, [entry, ...args], {
    encoding: 'utf8',
    cwd: tmpdir(),
  });

describe('standalone built CLI', () => {
  it.each([[], ['--help'], ['-h']])('prints help for %j', (...args) => {
    const result = run(...args);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Usage: opencut');
    expect(result.stdout).toContain('not implemented yet');
  });

  it('has a working executable entry point', () => {
    const result =
      process.platform === 'win32'
        ? run('--version')
        : spawnSync(entry, ['--version'], { encoding: 'utf8', cwd: tmpdir() });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${getApplicationInfo().version}\n`);
  });

  it.each(['--version', '-v'])('prints the core version for %s', (arg) => {
    const result = run(arg);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${getApplicationInfo().version}\n`);
    expect(result.stderr).toBe('');
  });

  it.each([['--unknown'], ['render'], ['--version=no'], ['--no-version']])(
    'rejects unsupported arguments %j',
    (...args) => {
      const result = run(...args);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('opencut:');
      expect(result.stderr).toContain('--help');
    },
  );
});

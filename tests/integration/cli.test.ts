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
  it.each([[], ['--help'], ['-h'], ['--help', '--version']])(
    'prints help for %j',
    (...args) => {
      const result = run(...args);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('Usage: opencut');
      expect(result.stdout).toContain('not implemented yet');
    },
  );

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

  it('prints clean JSON for help and version', () => {
    expect(JSON.parse(run('--version', '--json').stdout)).toEqual(
      getApplicationInfo(),
    );
    expect(JSON.parse(run('--help', '--json').stdout).help).toContain(
      'Usage: opencut',
    );
  });

  it.each(['create', 'info', 'validate'])(
    'provides scoped help for project %s',
    (command) => {
      const result = run('project', command, '--help');
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain(
        `Usage: opencut project ${command} <project-file>`,
      );
    },
  );

  it('preserves repeated boolean options', () => {
    const result = run('-v', '--version');
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

  it.each([
    ['probe'],
    ['probe', 'a.mp4', 'extra'],
    ['probe', 'a.mp4', '--output', 'out.png'],
    ['extract-frame', 'a.mp4'],
    ['extract-frame', 'a.mp4', '--timestamp', 'NaN', '--output', 'out.png'],
    ['extract-frame', 'a.mp4', '--timestamp=-1', '--output', 'out.png'],
    ['extract-frame', 'a.mp4', '--timestamp', '1', '--output', 'out.jpg'],
    ['--json'],
    ['--version', 'probe', 'a.mp4'],
    ['compose', 'one.mp4', '--music', 'music.wav', '--output', 'out.mp4'],
    ['compose', 'a.mp4', 'b.mp4', '--output', 'out.mp4'],
    [
      'compose',
      'a.mp4',
      'b.mp4',
      '--music',
      'music.wav',
      '--output',
      'out.png',
    ],
    [
      'compose',
      'a.mp4',
      'b.mp4',
      '--music',
      'music.wav',
      '--output',
      'out.mp4',
      '--width',
      '321',
    ],
    [
      'compose',
      'a.mp4',
      'b.mp4',
      '--music',
      'music.wav',
      '--output',
      'out.mp4',
      '--fps',
      '29.97',
    ],
    [
      'compose',
      'a.mp4',
      'b.mp4',
      '--music',
      'music.wav',
      '--output',
      'out.mp4',
      '--music-volume',
      'NaN',
    ],
    [
      'compose',
      'a.mp4',
      'b.mp4',
      '--music',
      'music.wav',
      '--output',
      'out.mp4',
      '--clip-volume',
      '2',
    ],
    [
      'compose',
      'a.mp4',
      'b.mp4',
      '--music',
      'music.wav',
      '--output',
      'out.mp4',
      '--timestamp',
      '0',
    ],
    ['probe', 'a.mp4', '--width', '640'],
    [
      'extract-frame',
      'a.mp4',
      '--timestamp',
      '0',
      '--output',
      'out.png',
      '--music',
      'music.wav',
    ],
    ['--version', '--fps', '30'],
  ])('rejects invalid media arguments %j', (...args) => {
    const result = run(...args);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('--help');
  });

  it('reports missing media files with a runtime exit code, including in JSON mode', () => {
    const result = run('probe', '/opencut-nonexistent-input.mp4', '--json');
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Cannot read media file');
  });

  it('explains missing ffprobe without launching Electron', () => {
    const result = spawnSync(
      process.execPath,
      [entry, 'probe', entry, '--json'],
      {
        encoding: 'utf8',
        env: { ...process.env, PATH: '' },
        cwd: tmpdir(),
      },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain("'ffprobe' was not found on PATH");
  });
});

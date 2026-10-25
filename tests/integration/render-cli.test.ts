import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createProject, serializeProject } from '@opencut/core';

const entry = fileURLToPath(
  new URL('../../apps/cli/dist/index.js', import.meta.url),
);
const run = (...args: string[]) =>
  spawnSync(process.execPath, [entry, ...args], {
    encoding: 'utf8',
    cwd: tmpdir(),
    env: { ...process.env, PATH: '' },
  });
describe('standalone project render command', () => {
  it.each([
    ['project', 'render'],
    ['project', 'render', 'project.json'],
    ['project', 'render', 'project.json', '--output', 'out.mov'],
    ['project', 'render', 'project.json', 'extra', '--output', 'out.mp4'],
    ['project', 'render', 'project.json', '--output', 'out.mp4', '--fps', '30'],
    [
      'project',
      'render',
      'project.json',
      '--output',
      'out.mp4',
      '--music',
      'music.wav',
    ],
    ['project', 'render', 'project.json', '--output', 'out.mp4', '--dry-run'],
  ])('rejects invalid arguments %j', (...args) => {
    const result = run(...args, '--json');
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('opencut:');
  });

  it('reports invalid timelines, missing sources and tools without modifying the saved project', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opencut-render-cli-'));
    const path = join(dir, 'project.json');
    const output = join(dir, 'out.mp4');
    try {
      const project = createProject({ name: 'Offline' });
      await writeFile(path, serializeProject(project));
      let result = run('project', 'render', path, '--output', output, '--json');
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('exactly one video track');
      project.tracks = [{ id: 'v', name: 'Video', type: 'video' }];
      project.assets = [
        {
          id: 's',
          name: 'Source',
          mediaTypes: ['video'],
          file: { type: 'relative', path: 'source.mp4' },
        },
      ];
      project.clips = [
        {
          id: 'clip',
          assetId: 's',
          trackId: 'v',
          timelineStart: { numerator: 0, denominator: 1 },
          sourceIn: { numerator: 0, denominator: 1 },
          sourceOut: { numerator: 1, denominator: 1 },
        },
      ];
      const snapshot = serializeProject(project);
      await writeFile(path, snapshot);
      result = run('project', 'render', path, '--output', output, '--json');
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain("Clip 'clip'");
      expect(result.stderr).toContain('Cannot read media file');
      await writeFile(join(dir, 'source.mp4'), 'sentinel');
      result = run('project', 'render', path, '--output', output, '--json');
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain("'ffprobe' was not found");
      project.assets[0]!.file = {
        type: 'absolute',
        path:
          process.platform === 'win32'
            ? '/foreign/source.mp4'
            : 'C:/foreign/source.mp4',
      };
      await writeFile(path, serializeProject(project));
      const foreign = run(
        'project',
        'render',
        path,
        '--output',
        output,
        '--json',
      );
      expect(foreign.status).toBe(1);
      expect(foreign.stdout).toBe('');
      expect(foreign.stderr).toContain('different operating system');
      await writeFile(path, snapshot);
      expect(await readFile(path, 'utf8')).toBe(snapshot);
      expect(await readFile(join(dir, 'source.mp4'), 'utf8')).toBe('sentinel');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

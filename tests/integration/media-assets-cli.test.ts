import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProject, serializeProject } from '@opencut/core';

const entry = fileURLToPath(
  new URL('../../apps/cli/dist/index.js', import.meta.url),
);
let directory: string;
let path: string;
beforeEach(async () => {
  directory = await realpath(
    await mkdtemp(join(tmpdir(), 'opencut-media-cli-')),
  );
  path = join(directory, 'project.json');
  const project = createProject({ name: 'Assets' });
  project.assets = [
    {
      id: 'offline',
      name: 'Offline',
      file: { type: 'relative', path: 'missing.mp4' },
      mediaTypes: ['video'],
    },
  ];
  await writeFile(path, serializeProject(project));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const run = (...args: string[]) =>
  spawnSync(process.execPath, [entry, ...args], {
    cwd: directory,
    encoding: 'utf8',
    env: { ...process.env, PATH: '' },
  });

describe('standalone media asset CLI without media tools', () => {
  it('resolves list, info and validation against a symlinked project directory target', async () => {
    const physical = join(directory, 'work', 'project');
    const media = join(directory, 'work', 'media');
    const links = join(directory, 'links');
    await mkdir(physical, { recursive: true });
    await mkdir(media);
    await mkdir(join(links, 'media'), { recursive: true });
    await symlink(physical, join(links, 'project'), 'dir');
    const source = join(media, 'source.txt');
    await writeFile(source, 'original source sentinel');
    await writeFile(
      join(links, 'media', 'source.txt'),
      'different source sentinel',
    );
    const project = createProject({ name: 'Directory alias' });
    project.assets = [
      {
        id: 'source',
        name: 'Source',
        file: { type: 'relative', path: '../media/source.txt' },
        mediaTypes: ['audio'],
      },
    ];
    const physicalPath = join(physical, 'project.json');
    const aliasPath = join(links, 'project', 'project.json');
    const before = serializeProject(project);
    await writeFile(physicalPath, before);
    const list = run('media', 'list', aliasPath, '--json');
    expect(list.status).toBe(0);
    expect(list.stderr).toBe('');
    expect(JSON.parse(list.stdout).assets[0].source).toMatchObject({
      path: source,
      status: 'available',
    });
    const info = run('media', 'info', aliasPath, 'source', '--json');
    expect(info.status).toBe(0);
    expect(info.stderr).toBe('');
    expect(JSON.parse(info.stdout).source).toMatchObject({
      path: source,
      status: 'available',
    });
    const validation = run('project', 'validate', aliasPath, '--json');
    expect(validation.status).toBe(0);
    expect(validation.stderr).toBe('');
    expect(JSON.parse(validation.stdout)).toMatchObject({
      valid: true,
      media: [{ path: source, status: 'available' }],
    });
    expect(await readFile(physicalPath, 'utf8')).toBe(before);
    expect(await readFile(source, 'utf8')).toBe('original source sentinel');
  });

  it('lists and inspects offline assets with clean JSON and no writes', async () => {
    const before = await readFile(path, 'utf8');
    const listed = run('media', 'list', 'project.json', '--json');
    expect(listed.status).toBe(0);
    expect(listed.stderr).toBe('');
    const list = JSON.parse(listed.stdout);
    expect(list.path).toBe(path);
    expect(list.assets).toHaveLength(1);
    expect(list.assets[0]).toMatchObject({
      asset: { id: 'offline' },
      source: { status: 'missing', path: join(directory, 'missing.mp4') },
      referencedBy: [],
    });
    const info = run('--json', 'media', 'info', './project.json', 'offline');
    expect(info.status).toBe(0);
    expect(info.stderr).toBe('');
    expect(JSON.parse(info.stdout)).toEqual({ path, ...list.assets[0] });
    const text = run('media', 'info', path, 'offline');
    expect(text.status).toBe(0);
    expect(text.stdout).toContain('offline');
    expect(text.stdout).toContain('[missing]');
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('removes an unreferenced asset atomically and reports missing IDs consistently', async () => {
    const removed = run('media', 'remove', 'project.json', 'offline', '--json');
    expect(removed.status).toBe(0);
    expect(removed.stderr).toBe('');
    expect(JSON.parse(removed.stdout)).toEqual({
      path,
      removedAssetId: 'offline',
    });
    expect(
      JSON.parse(run('media', 'list', path, '--json').stdout).assets,
    ).toEqual([]);
    for (const command of ['info', 'remove']) {
      const result = run('media', command, path, 'offline', '--json');
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('does not exist');
    }
    expect(await readdir(directory)).toEqual(['project.json']);
  });

  it('refuses referenced assets before saving or consulting media tools', async () => {
    const project = JSON.parse(await readFile(path, 'utf8'));
    project.tracks = [{ id: 'track', name: 'Video', type: 'video' }];
    project.clips = [
      {
        id: 'clip',
        assetId: 'offline',
        trackId: 'track',
        timelineStart: { numerator: 0, denominator: 1 },
        sourceIn: { numerator: 0, denominator: 1 },
        sourceOut: { numerator: 1, denominator: 1 },
      },
    ];
    await writeFile(path, serializeProject(project));
    const before = await readFile(path, 'utf8');
    const result = run('media', 'remove', path, 'offline', '--json');
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('referenced by timeline clips: clip');
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('reports missing sources and missing ffprobe without modifying the project or source', async () => {
    const before = await readFile(path, 'utf8');
    const missing = run('media', 'import', path, 'missing.mp4', '--json');
    expect(missing.status).toBe(1);
    expect(missing.stdout).toBe('');
    expect(missing.stderr).toContain('missing');
    await writeFile(join(directory, 'sentinel.txt'), 'preserve this');
    const noTool = run('media', 'import', path, 'sentinel.txt', '--json');
    expect(noTool.status).toBe(1);
    expect(noTool.stdout).toBe('');
    expect(noTool.stderr).toContain("'ffprobe' was not found");
    expect(await readFile(path, 'utf8')).toBe(before);
    expect(await readFile(join(directory, 'sentinel.txt'), 'utf8')).toBe(
      'preserve this',
    );
  });

  it.each([
    ['media'],
    ['media', 'unknown', 'project.json'],
    ['media', 'list'],
    ['media', 'list', 'project.json', 'extra'],
    ['media', 'import', 'project.json'],
    ['media', 'info', 'project.json'],
    ['media', 'remove', 'project.json'],
    ['media', 'list', 'project.json', '--name', 'bad'],
    ['media', 'list', 'project.json', '--version'],
    ['media', 'import', 'project.json', 'source.mp4', '--output', 'bad'],
    ['media', 'info', 'project.json', 'offline', '--fps', '24'],
    ['media', 'list', 'project\n.json'],
  ])('rejects malformed arguments: %j', (...args) => {
    const result = run(...args, '--json');
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('opencut:');
  });

  it.each(['import', 'list', 'info', 'remove'])(
    'shows scoped %s help as JSON without tools',
    (command) => {
      const result = run('media', command, '--help', '--json');
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout).help).toContain(
        `Usage: opencut media ${command}`,
      );
    },
  );
});

import { spawnSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
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
beforeEach(async () => {
  directory = await realpath(
    await mkdtemp(join(tmpdir(), 'opencut-project-cli-')),
  );
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

describe('standalone project CLI without media tools', () => {
  it('creates, reads back and validates a default project using relative paths', async () => {
    const path = join(directory, '日本語 #1%.opencut.json');
    const result = run(
      'project',
      'create',
      './日本語 #1%.opencut.json',
      '--name',
      'My project',
      '--json',
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const created = JSON.parse(result.stdout);
    const project = JSON.parse(await readFile(path, 'utf8'));
    expect(created).toEqual({
      path,
      schemaVersion: 1,
      metadata: project.metadata,
      settings: {
        width: 1920,
        height: 1080,
        frameRate: { numerator: 30, denominator: 1 },
      },
      statistics: { assets: 0, tracks: 0, clips: 0 },
    });
    const info = run('--json', 'project', 'info', path);
    expect(info.status).toBe(0);
    expect(info.stderr).toBe('');
    expect(JSON.parse(info.stdout)).toEqual(created);
    const validated = run('project', 'validate', path, '--json');
    expect(validated.status).toBe(0);
    expect(validated.stderr).toBe('');
    expect(JSON.parse(validated.stdout)).toEqual({
      path,
      valid: true,
      structureValid: true,
      issues: [],
      media: [],
    });
  });

  it.each(['24', '30000/1001'])(
    'preserves custom dimensions and %s fps',
    async (fps) => {
      const result = run(
        'project',
        'create',
        'custom.json',
        '--name',
        'Custom',
        '--width',
        '641',
        '--height',
        '361',
        '--fps',
        fps,
        '--json',
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      const [numerator, denominator = 1] = fps.split('/').map(Number);
      expect(JSON.parse(result.stdout).settings).toEqual({
        width: 641,
        height: 361,
        frameRate: { numerator, denominator },
      });
      expect(
        JSON.parse(await readFile(join(directory, 'custom.json'), 'utf8'))
          .settings,
      ).toEqual(JSON.parse(result.stdout).settings);
    },
  );

  it('prints human-readable creation, info and validation results', () => {
    for (const args of [
      ['create', 'human.json', '--name', 'Human'],
      ['info', 'human.json'],
      ['validate', 'human.json'],
    ]) {
      const result = run('project', ...args);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain(join(directory, 'human.json'));
    }
    expect(run('project', 'info', 'human.json').stdout).toContain(
      'Assets: 0; tracks: 0; clips: 0',
    );
  });

  it('uses the last value of repeated options, matching existing media commands', () => {
    const result = run(
      'project',
      'create',
      'overridden.json',
      '--name',
      'First',
      '--name',
      'Last',
      '--fps',
      '30',
      '--fps',
      '24',
      '--json',
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      metadata: { name: 'Last' },
      settings: { frameRate: { numerator: 24, denominator: 1 } },
    });
  });

  it('supports filenames beginning with a dash after the option terminator', () => {
    const result = run(
      'project',
      'create',
      '--name',
      'Dash',
      '--json',
      '--',
      '-project.json',
    );
    expect(result.status).toBe(0);
    expect(run('project', 'info', '--json', '--', '-project.json').status).toBe(
      0,
    );
  });

  it.each([
    ['project'],
    ['project', 'delete', 'new.json'],
    ['project', 'toString', 'new.json'],
    ['project', 'create'],
    ['project', 'create', 'new.json'],
    ['project', 'create', 'new.json', '--name', ' '],
    ['project', 'create', 'new.json', '--name', 'Name', 'extra'],
    ['project', 'create', '', '--name', 'Name'],
    ['project', 'create', 'bad\n.json', '--name', 'Name'],
    ['project', 'info', 'new.json', '--width', '10'],
    ['project', 'validate', 'new.json', '--name', 'Name'],
    [
      'project',
      'create',
      'new.json',
      '--name',
      'Name',
      '--output',
      'other.json',
    ],
    ['project', 'create', 'new.json', '--name', 'Name', '--force'],
    ['project', 'info', 'new.json', '--version'],
    ['probe', 'new.json', '--name', 'Name'],
  ])(
    'rejects invalid command arguments %j without creating files',
    async (...args) => {
      const result = run(...args, '--json');
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('--help');
      expect(await readdir(directory)).toEqual([]);
    },
  );

  it.each([
    ['width', '0'],
    ['height', '-1'],
    ['width', '2.5'],
    ['width', '9007199254740992'],
    ['height', 'NaN'],
    ['width', ''],
    ['fps', '0'],
    ['fps', '30/0'],
    ['fps', '0/1'],
    ['fps', '29.97'],
    ['fps', '1/2/3'],
    ['fps', 'NaN'],
    ['fps', '1e2'],
    ['fps', '9007199254740992/1'],
    ['fps', '1/9007199254740992'],
  ])('rejects --%s=%s before writing', async (option, value) => {
    const result = run(
      'project',
      'create',
      'new.json',
      '--name',
      'Invalid',
      `--${option}=${value}`,
      '--json',
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`--${option}`);
    expect(await readdir(directory)).toEqual([]);
  });

  it('refuses existing files, directories, symlinks, dangling symlinks and absent parents', async () => {
    await writeFile(join(directory, 'source.txt'), 'preserve this');
    await mkdir(join(directory, 'folder'));
    await symlink('source.txt', join(directory, 'linked.json'));
    await symlink('absent.txt', join(directory, 'dangling.json'));
    for (const destination of [
      'source.txt',
      'folder',
      'linked.json',
      'dangling.json',
      'absent/new.json',
    ]) {
      const result = run(
        'project',
        'create',
        destination,
        '--name',
        'Conflict',
        '--json',
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(
        'use a new file in an existing writable directory',
      );
    }
    expect(await readFile(join(directory, 'source.txt'), 'utf8')).toBe(
      'preserve this',
    );
    expect((await readdir(directory)).sort()).toEqual([
      'dangling.json',
      'folder',
      'linked.json',
      'source.txt',
    ]);
  });

  it.each(['info', 'validate'])(
    'reports missing project files for %s',
    (command) => {
      const result = run('project', command, 'missing.json', '--json');
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Cannot read project file');
    },
  );

  it.each([
    ['{broken', 'invalid_json', ''],
    ['{"schemaVersion":2}', 'unsupported_version', '/schemaVersion'],
    ['{"schemaVersion":1}', 'invalid_type', '/metadata'],
  ])('reports invalid data as JSON for %s', async (json, code, path) => {
    await writeFile(join(directory, 'invalid.json'), json);
    const result = run('project', 'validate', 'invalid.json', '--json');
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      valid: false,
      structureValid: false,
      media: [],
      issues: expect.arrayContaining([expect.objectContaining({ code, path })]),
    });
    expect(result.stderr).toContain('opencut:');
    expect(run('project', 'info', 'invalid.json', '--json').status).toBe(1);
    expect(await readFile(join(directory, 'invalid.json'), 'utf8')).toBe(json);
  });

  it('validates internal references and reports collection counts from a populated project', async () => {
    const project = createProject({ name: 'Populated' });
    project.assets.push({
      id: 'asset',
      name: 'Source',
      mediaTypes: ['video'],
      file: { type: 'relative', path: 'source.txt' },
    });
    project.tracks.push({ id: 'track', name: 'Video', type: 'video' });
    project.clips.push({
      id: 'clip',
      assetId: 'asset',
      trackId: 'track',
      timelineStart: { numerator: 0, denominator: 1 },
      sourceIn: { numerator: 0, denominator: 1 },
      sourceOut: { numerator: 1, denominator: 1 },
    });
    await writeFile(join(directory, 'source.txt'), 'read-only sentinel');
    const path = join(directory, 'populated.json');
    await writeFile(path, serializeProject(project));
    expect(
      JSON.parse(run('project', 'info', path, '--json').stdout).statistics,
    ).toEqual({ assets: 1, tracks: 1, clips: 1 });
    expect(run('project', 'validate', path).status).toBe(0);
    project.clips[0]!.assetId = 'absent';
    const json = JSON.stringify(project);
    await writeFile(path, json);
    const result = run('project', 'validate', path, '--json');
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).issues).toContainEqual(
      expect.objectContaining({
        path: '/clips/0/assetId',
        code: 'invalid_reference',
      }),
    );
    expect(result.stderr).toContain("Asset 'absent' does not exist");
    expect(await readFile(path, 'utf8')).toBe(json);
    expect(await readFile(join(directory, 'source.txt'), 'utf8')).toBe(
      'read-only sentinel',
    );
  });

  it('anchors media to the project directory and distinguishes offline data from invalid structure', async () => {
    await mkdir(join(directory, 'bundle'));
    await writeFile(
      join(directory, 'bundle', 'source.txt'),
      'read-only sentinel',
    );
    const project = createProject({ name: 'Offline' });
    project.assets = ['source.txt', 'missing.txt', '.'].map((path, i) => ({
      id: `asset-${i}`,
      name: path,
      mediaTypes: ['audio'],
      file: { type: 'relative', path },
    }));
    const path = join(directory, 'bundle', 'project.json');
    const json = serializeProject(project);
    await writeFile(path, json);
    expect(run('project', 'info', path, '--json').status).toBe(0);
    const result = run('project', 'validate', path, '--json');
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      valid: false,
      structureValid: true,
      issues: [],
    });
    expect(
      report.media.map((asset: { status: string }) => asset.status),
    ).toEqual(['available', 'missing', 'not_file']);
    expect(report.media[0].path).toBe(join(directory, 'bundle', 'source.txt'));
    expect(result.stderr).toContain('missing.txt');
    expect(await readFile(path, 'utf8')).toBe(json);
    expect(
      await readFile(join(directory, 'bundle', 'source.txt'), 'utf8'),
    ).toBe('read-only sentinel');
  });
});

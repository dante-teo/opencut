import { spawnSync } from 'node:child_process';
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createProject,
  deserializeProject,
  projectSnapshot,
  serializeProject,
} from '@opencut/core';

const entry = fileURLToPath(
  new URL('../../apps/cli/dist/index.js', import.meta.url),
);
let directory: string;
let path: string;
const run = (...args: string[]) =>
  spawnSync(process.execPath, [entry, ...args], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, PATH: '' },
  });
function json(...args: string[]) {
  const result = run(...args, '--json');
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout);
}
const batch = async (value: unknown) =>
  writeFile(join(directory, 'batch.json'), JSON.stringify(value));
const operations = [
  { type: 'track.add', id: 'v1', name: 'Video', mediaType: 'video' },
  {
    type: 'clip.add',
    id: 'c1',
    assetId: 'asset',
    trackId: 'v1',
    at: 0,
    in: 0,
    out: 90,
  },
  { type: 'clip.split', id: 'c1', at: 30, rightId: 'right' },
];
beforeEach(async () => {
  directory = await realpath(
    await mkdtemp(join(tmpdir(), 'opencut-edit-cli-')),
  );
  path = join(directory, 'project.json');
  const project = createProject({
    name: 'History',
    createdAt: '2020-01-01T00:00:00.000Z',
  });
  project.assets = [
    {
      id: 'asset',
      name: 'Offline',
      file: { type: 'relative', path: 'source.mp4' },
      mediaTypes: ['video'],
    },
  ];
  await writeFile(path, serializeProject(project));
  await writeFile(join(directory, 'source.mp4'), 'original media sentinel');
  await batch({ expectedRevision: 0, label: 'Add sequence', operations });
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('built transaction CLI without media tools or Electron', () => {
  it('commits one batch, inspects persistent history and exactly undoes/redoes across CLI processes', async () => {
    const original = projectSnapshot(
      deserializeProject(await readFile(path, 'utf8')),
    );
    expect(json('edit', 'history', path)).toEqual({
      path,
      revision: 0,
      undo: [],
      redo: [],
    });
    const applied = json('edit', 'apply', 'project.json', 'batch.json');
    expect(applied).toMatchObject({
      path,
      baseRevision: 0,
      revision: 1,
      dryRun: false,
      changed: true,
      undo: [{ label: 'Add sequence' }],
      redo: [],
    });
    expect(applied.results).toHaveLength(3);
    const after = projectSnapshot(
      deserializeProject(await readFile(path, 'utf8')),
    );
    expect(after.clips.map((clip) => clip.id)).toEqual(['c1', 'right']);
    expect(json('edit', 'history', path).undo).toHaveLength(1);
    expect(
      json('edit', 'undo', path, '--expected-revision', '1').revision,
    ).toBe(2);
    expect(
      projectSnapshot(deserializeProject(await readFile(path, 'utf8'))),
    ).toEqual(original);
    expect(json('edit', 'history', path).redo).toHaveLength(1);
    expect(
      json('edit', 'redo', path, '--expected-revision', '2').revision,
    ).toBe(3);
    expect(
      projectSnapshot(deserializeProject(await readFile(path, 'utf8'))),
    ).toEqual(after);
    expect(await readFile(join(directory, 'source.mp4'), 'utf8')).toBe(
      'original media sentinel',
    );
    expect((await readdir(directory)).sort()).toEqual([
      'batch.json',
      'project.json',
      'source.mp4',
    ]);
  });

  it('includes individual track, clip and media commands in one history and clears the redo branch', async () => {
    json('edit', 'apply', path, 'batch.json');
    json('clip', 'remove', path, 'right', '--expected-revision', '1');
    expect(json('edit', 'history', path)).toMatchObject({
      revision: 2,
      undo: [{ label: 'Add sequence' }, { label: 'clip remove' }],
    });
    json('edit', 'undo', path);
    expect(json('timeline', 'list', path).tracks[0].clips).toHaveLength(2);
    json('clip', 'move', path, 'c1', '--at', '0');
    expect(json('edit', 'history', path).redo).toHaveLength(1);
    json('track', 'add', path, '--name', 'Music', '--type', 'audio');
    expect(json('edit', 'history', path).redo).toEqual([]);
    const failedRedo = run('edit', 'redo', path, '--json');
    expect(failedRedo.status).toBe(1);
    expect(failedRedo.stdout).toBe('');
    json('clip', 'remove', path, 'c1');
    json('clip', 'remove', path, 'right');
    json('media', 'remove', path, 'asset');
    expect(json('media', 'list', path).assets).toEqual([]);
    const history = json('edit', 'history', path);
    expect(history.undo.at(-1).label).toBe('media remove');
    json('edit', 'undo', path);
    expect(json('media', 'list', path).assets[0].asset.id).toBe('asset');
    expect(await readFile(join(directory, 'source.mp4'), 'utf8')).toBe(
      'original media sentinel',
    );
  });

  it('previews apply/undo/redo and individual edits without changing bytes, timestamps or history', async () => {
    const unchanged = async (action: () => void) => {
      const bytes = await readFile(path, 'utf8');
      const mtime = (await stat(path)).mtimeMs;
      action();
      expect(await readFile(path, 'utf8')).toBe(bytes);
      expect((await stat(path)).mtimeMs).toBe(mtime);
    };
    await unchanged(() => {
      expect(
        json('edit', 'apply', path, 'batch.json', '--dry-run'),
      ).toMatchObject({ dryRun: true, revision: 1, baseRevision: 0 });
      json(
        'track',
        'add',
        path,
        '--name',
        'Preview',
        '--type',
        'video',
        '--dry-run',
      );
      json('media', 'remove', path, 'asset', '--dry-run');
    });
    json('edit', 'apply', path, 'batch.json');
    await unchanged(() => {
      json('edit', 'undo', path, '--dry-run');
    });
    json('edit', 'undo', path);
    await unchanged(() => {
      json('edit', 'redo', path, '--dry-run');
    });
    expect(json('edit', 'history', path)).toMatchObject({
      revision: 2,
      undo: [],
      redo: [{ label: 'Add sequence' }],
    });
  });

  it.each([false, true])(
    'keeps cancelling batches unchanged across reloads (redo available: %s)',
    async (hasRedo) => {
      if (hasRedo) {
        json('edit', 'apply', path, 'batch.json');
        json('edit', 'undo', path);
      }
      const history = json('edit', 'history', path);
      const bytes = await readFile(path, 'utf8');
      const modified = (await stat(path)).mtimeMs;
      await batch({
        expectedRevision: history.revision,
        operations: [
          {
            type: 'track.add',
            id: 'temporary',
            name: 'Temporary',
            mediaType: 'video',
          },
          { type: 'track.remove', id: 'temporary' },
        ],
      });
      for (const flags of [[], ['--dry-run']]) {
        const result = json('edit', 'apply', path, 'batch.json', ...flags);
        expect(result).toMatchObject({
          ...history,
          baseRevision: history.revision,
          changed: false,
          dryRun: flags.length > 0,
        });
        expect(result.results).toHaveLength(2);
        expect(await readFile(path, 'utf8')).toBe(bytes);
        expect((await stat(path)).mtimeMs).toBe(modified);
        expect(json('edit', 'history', path)).toEqual(history);
      }
      if (hasRedo) {
        const redone = json(
          'edit',
          'redo',
          path,
          '--expected-revision',
          String(history.revision),
        );
        expect(redone.undo.at(-1)).toEqual(history.redo.at(-1));
        expect(
          json('timeline', 'list', path).tracks[0].clips.map(
            (clip: { id: string }) => clip.id,
          ),
        ).toEqual(['c1', 'right']);
      }
    },
  );

  it('rejects stale batch/individual/undo/redo revisions without overwriting newer edits', async () => {
    json('edit', 'apply', path, 'batch.json');
    const unchanged = await readFile(path, 'utf8');
    for (const args of [
      ['edit', 'apply', path, 'batch.json'],
      ['edit', 'apply', path, 'batch.json', '--dry-run'],
      ['edit', 'undo', path, '--expected-revision', '0'],
      ['edit', 'redo', path, '--expected-revision', '0'],
      ['clip', 'remove', path, 'c1', '--expected-revision', '0'],
      ['media', 'remove', path, 'asset', '--expected-revision', '0'],
    ]) {
      const result = run(...args, '--json');
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain('revision conflict');
      expect(result.stdout).toBe('');
      expect(await readFile(path, 'utf8')).toBe(unchanged);
    }
  });

  it.each([
    {
      expectedRevision: 0,
      operations: [...operations, { type: 'clip.remove', id: 'absent' }],
    },
    { expectedRevision: 0, operations: [] },
    { expectedRevision: 0, operations: [{ type: 'clip.move', id: 'c1' }] },
    { expectedRevision: 0, operations: [{ type: 'unknown' }] },
    { expectedRevision: 0, operations: [{ ...operations[0], typo: true }] },
    { operations },
  ])('rolls back invalid batches: %j', async (value) => {
    await batch(value);
    const before = await readFile(path, 'utf8');
    const result = run('edit', 'apply', path, 'batch.json', '--json');
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('opencut:');
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('handles unreadable/malformed batch files and empty history as runtime errors', async () => {
    const before = await readFile(path, 'utf8');
    await writeFile(join(directory, 'batch.json'), '{broken');
    for (const args of [
      ['edit', 'apply', path, 'batch.json'],
      ['edit', 'apply', path, 'missing.json'],
      ['edit', 'undo', path],
      ['edit', 'redo', path],
    ]) {
      const result = run(...args, '--json');
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('opencut:');
    }
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it.each([
    ['edit'],
    ['edit', 'unknown', 'project.json'],
    ['edit', 'apply', 'project.json'],
    ['edit', 'undo', 'project.json', 'extra'],
    ['edit', 'history', 'project.json', '--dry-run'],
    ['edit', 'history', 'project.json', '--expected-revision', '0'],
    ['edit', 'undo', 'project.json', '--at', '0'],
    ['edit', 'undo', 'project.json', '--expected-revision', '0.5'],
    ['edit', 'redo', 'project.json', '--expected-revision', '9007199254740992'],
    ['edit', 'apply', 'project.json', 'batch.json', '--expected-revision', '1'],
    ['timeline', 'list', 'project.json', '--dry-run'],
    ['project', 'info', 'project.json', '--expected-revision', '0'],
    ['media', 'list', 'project.json', '--dry-run'],
    ['--version', '--dry-run'],
  ])('rejects malformed or inapplicable CLI arguments %j', async (...args) => {
    const before = await readFile(path, 'utf8');
    const result = run(...args, '--json');
    expect(result.status, result.stderr).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('--help');
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('provides scoped help and readable history/edit results', () => {
    expect(json('edit', '--help').help).toContain('expectedRevision');
    expect(json('edit', 'apply', '--help').help).toContain('PROJECT frame');
    expect(run('edit', 'apply', path, 'batch.json').stdout).toContain(
      'Saved edit apply',
    );
    expect(run('edit', 'history', path).stdout).toContain('Add sequence');
    expect(run('edit', 'undo', path, '--dry-run').stdout).toContain(
      'Validated edit undo',
    );
  });
});

import { spawnSync } from 'node:child_process';
import {
  link,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addTimes,
  createProject,
  deserializeProject,
  frameTime,
  serializeProject,
} from '@opencut/core';
import type { TimelineClip, Track } from '@opencut/core';

const entry = fileURLToPath(
  new URL('../../apps/cli/dist/index.js', import.meta.url),
);
const rate = { numerator: 30000, denominator: 1001 };
const at = (frame: number) => frameTime(frame, rate);
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
const add = (trackId = 'v1', start = '0', end = '60'): TimelineClip =>
  json(
    'clip',
    'add',
    'project.json',
    'av',
    '--track',
    trackId,
    '--at',
    start,
    '--in',
    '15',
    '--out',
    end,
  ).clip;

beforeEach(async () => {
  directory = await realpath(
    await mkdtemp(join(tmpdir(), 'opencut-timeline-cli-')),
  );
  path = join(directory, 'project.json');
  const project = createProject({
    name: 'Timeline',
    createdAt: '2020-01-01T00:00:00.000Z',
    settings: { width: 1920, height: 1080, frameRate: rate },
  });
  project.assets = [
    {
      id: 'av',
      name: 'Offline AV',
      file: { type: 'relative', path: 'missing.mp4' },
      mediaTypes: ['video', 'audio'],
      duration: at(300),
    },
    {
      id: 'sound',
      name: 'Audio',
      file: { type: 'relative', path: 'sentinel.wav' },
      mediaTypes: ['audio'],
      duration: at(300),
    },
    {
      id: 'unknown',
      name: 'Unknown',
      file: { type: 'relative', path: 'image.png' },
      mediaTypes: ['video'],
    },
  ];
  project.tracks = [
    { id: 'v1', name: 'Video', type: 'video' },
    { id: 'a1', name: 'Audio', type: 'audio' },
  ];
  await writeFile(path, serializeProject(project));
  await writeFile(join(directory, 'sentinel.wav'), 'original source sentinel');
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('built timeline CLI without Electron or media tools', () => {
  it('configures visual properties and canvas offline and rejects invalid or misplaced options without writes', async () => {
    const clip = add();
    const changed = json(
      'clip',
      'visual',
      path,
      clip.id,
      '--x=-10.5',
      '--y',
      '12',
      '--scale',
      '0.75',
      '--fit',
      'cover',
      '--opacity',
      '0.5',
    );
    expect(changed.clip.visual).toEqual({
      x: -10.5,
      y: 12,
      scale: 0.75,
      opacity: 0.5,
      fit: 'cover',
    });
    const canvas = json(
      'canvas',
      'set',
      path,
      '--width',
      '1080',
      '--height',
      '1920',
      '--background-color',
      '#123ABC',
    );
    expect(canvas.settings).toMatchObject({
      width: 1080,
      height: 1920,
      backgroundColor: '#123ABC',
    });
    const before = await readFile(path, 'utf8');
    const invalid = [
      ['clip', 'visual', path, clip.id],
      ...[
        ['x', 'NaN'],
        ['y', '32769'],
        ['scale', '0'],
        ['opacity', '1.01'],
        ['fit', 'fill'],
      ].map(([key, value]) => [
        'clip',
        'visual',
        path,
        clip.id,
        `--${key}`,
        value!,
      ]),
      ['canvas', 'set', path],
      ['canvas', 'set', path, '--width', '0'],
      ['canvas', 'set', path, '--background-color', 'red'],
      ['clip', 'audio', path, clip.id, '--opacity', '0.5'],
      ['project', 'info', path, '--fit', 'contain'],
    ];
    for (const args of invalid) {
      const result = run(...args, '--json');
      expect(result.status, result.stderr).toBe(2);
      expect(result.stdout).toBe('');
      expect(await readFile(path, 'utf8')).toBe(before);
    }
  });

  it('configures clip gains and muting through add/audio, dry-run, history and batches', async () => {
    const clip = json(
      'clip',
      'add',
      path,
      'sound',
      '--track',
      'a1',
      '--at',
      '0',
      '--in',
      '0',
      '--out',
      '60',
      '--volume',
      '0.25',
      '--muted',
      'true',
    ).clip;
    expect(clip).toMatchObject({ volume: 0.25, muted: true });
    const before = await readFile(path, 'utf8');
    json('clip', 'audio', path, clip.id, '--volume', '0.5', '--dry-run');
    expect(await readFile(path, 'utf8')).toBe(before);
    const unmuted = json(
      'clip',
      'audio',
      path,
      clip.id,
      '--muted',
      'false',
    ).clip;
    expect(unmuted).toMatchObject({ volume: 0.25, muted: false });
    json('edit', 'undo', path);
    expect(
      deserializeProject(await readFile(path, 'utf8')).clips[0],
    ).toMatchObject({ volume: 0.25, muted: true });
    json('edit', 'redo', path);
    const revision = json('edit', 'history', path).revision;
    const batch = join(directory, 'audio.json');
    await writeFile(
      batch,
      JSON.stringify({
        expectedRevision: revision,
        operations: [
          { type: 'clip.audio', id: clip.id, volume: 0.75 },
          {
            type: 'clip.add',
            id: 'new',
            assetId: 'av',
            trackId: 'v1',
            at: 0,
            in: 0,
            out: 60,
            muted: true,
            volume: 0.5,
          },
        ],
      }),
    );
    json('edit', 'apply', path, batch);
    expect(
      deserializeProject(await readFile(path, 'utf8')).clips.map((clip) => [
        clip.volume,
        clip.muted,
      ]),
    ).toEqual([
      [0.75, false],
      [0.5, true],
    ]);
    const saved = await readFile(path, 'utf8');
    json(
      'clip',
      'audio',
      path,
      clip.id,
      '--volume',
      '0.75',
      '--muted',
      'false',
    );
    expect(await readFile(path, 'utf8')).toBe(saved);
    for (const args of [
      [],
      ['--volume', '-1'],
      ['--volume', '1.1'],
      ['--volume', 'NaN'],
      ['--volume', '1e-1'],
      ['--muted', 'yes'],
    ]) {
      expect(run('clip', 'audio', path, clip.id, ...args).status).toBe(2);
      expect(await readFile(path, 'utf8')).toBe(saved);
    }
    expect(
      run(
        'clip',
        'audio',
        path,
        clip.id,
        '--volume',
        '0.3',
        '--expected-revision',
        '0',
      ).status,
    ).toBe(1);
    expect(await readFile(path, 'utf8')).toBe(saved);
  });

  it('performs the full editing lifecycle with exact JSON, stable IDs and persisted reloads', async () => {
    const track: Track = json(
      'track',
      'add',
      'project.json',
      '--type',
      'video',
      '--name',
      'Second video',
    ).track;
    expect(track.id).toMatch(/^[0-9a-f-]{36}$/);
    const audio: Track = json(
      'track',
      'add',
      path,
      '--type',
      'audio',
      '--name',
      'Music',
    ).track;
    expect(audio.type).toBe('audio');
    const original = add();
    expect(original.sourceIn).toEqual(at(15));
    expect(original.sourceOut).toEqual(at(60));
    const moved = json(
      'clip',
      'move',
      path,
      original.id,
      '--track',
      track.id,
      '--at',
      '30',
    ).clip;
    expect(moved).toEqual({
      ...original,
      trackId: track.id,
      timelineStart: at(30),
    });
    const trimmed = json(
      'clip',
      'trim',
      path,
      original.id,
      '--in',
      '30',
      '--out',
      '90',
    ).clip;
    expect(trimmed.timelineStart).toEqual(at(30));
    const split = json('clip', 'split', path, original.id, '--at', '45');
    expect(split.left.id).toBe(original.id);
    expect(split.right.id).not.toBe(original.id);
    expect(split.left.sourceOut).toEqual(at(45));
    expect(split.right.sourceIn).toEqual(at(45));
    expect(split.right.sourceOut).toEqual(at(90));
    expect(split.right.timelineStart).toEqual(at(45));
    const list = json('--json', 'timeline', 'list', './project.json');
    expect(list.path).toBe(path);
    expect(list.duration).toEqual(at(90));
    const clips = list.tracks.find(
      (entry: Track) => entry.id === track.id,
    ).clips;
    expect(clips.map((clip: TimelineClip) => clip.id)).toEqual([
      original.id,
      split.right.id,
    ]);
    expect(addTimes(clips[0].duration, clips[1].duration)).toEqual(at(60));
    expect(clips[0].timelineEnd).toEqual(clips[1].timelineStart);
    const loaded = deserializeProject(await readFile(path, 'utf8'));
    expect(loaded.clips).toEqual([split.left, split.right]);
    expect(loaded.metadata.updatedAt > loaded.metadata.createdAt).toBe(true);
    expect(json('project', 'info', path).statistics).toEqual({
      assets: 3,
      tracks: 4,
      clips: 2,
    });
    expect(json('media', 'info', path, 'av').referencedBy).toEqual([
      original.id,
      split.right.id,
    ]);
    json('clip', 'remove', path, original.id);
    expect(
      json('timeline', 'list', path).tracks.find(
        (entry: Track) => entry.id === track.id,
      ).clips[0].timelineStart,
    ).toEqual(at(45));
    json('clip', 'remove', path, split.right.id);
    expect(json('track', 'remove', path, track.id)).toEqual({
      path,
      removedTrackId: track.id,
    });
    json('track', 'remove', path, audio.id);
    expect(json('timeline', 'list', path).duration).toEqual(at(0));
    expect((await readdir(directory)).sort()).toEqual([
      'project.json',
      'sentinel.wav',
    ]);
    expect(await readFile(join(directory, 'sentinel.wav'), 'utf8')).toBe(
      'original source sentinel',
    );
  });

  it('supports track-only and time-only moves and one-sided trims without ripple', () => {
    const first = add();
    const second = add('v1', '100', '45');
    const moved = json('clip', 'move', path, first.id, '--track', 'a1').clip;
    expect(moved.timelineStart).toEqual(at(0));
    expect(
      json('clip', 'move', path, first.id, '--at', '10').clip.trackId,
    ).toBe('a1');
    expect(
      json('clip', 'trim', path, first.id, '--in', '20').clip.sourceOut,
    ).toEqual(at(60));
    expect(
      json('clip', 'trim', path, first.id, '--out', '65').clip.sourceIn,
    ).toEqual(at(20));
    expect(json('timeline', 'list', path).tracks[0].clips[0]).toMatchObject(
      second,
    );
  });

  it('accepts explicit unknown-duration ranges without probing or requiring online media', () => {
    const result = json(
      'clip',
      'add',
      path,
      'unknown',
      '--track',
      'v1',
      '--at',
      '0',
      '--in',
      '0',
      '--out',
      '1000',
    );
    expect(result.clip.sourceOut).toEqual(at(1000));
  });

  it('lists human-readable track/clip timing and preserves bytes/mtime for listing and equivalent edits', async () => {
    const clip = add();
    const before = await readFile(path, 'utf8');
    const modified = (await stat(path)).mtimeMs;
    const text = run('timeline', 'list', path);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain('Track: v1 (video, Video)');
    expect(text.stdout).toContain(`Clip: ${clip.id}; asset av; timeline`);
    json('timeline', 'list', path);
    json('clip', 'move', path, clip.id, '--at', '0', '--track', 'v1');
    json('clip', 'trim', path, clip.id, '--in', '15', '--out', '60');
    expect(await readFile(path, 'utf8')).toBe(before);
    expect((await stat(path)).mtimeMs).toBe(modified);
  });

  it('rejects missing IDs, incompatible media, source bounds, overlaps, invalid splits and populated tracks without writing', async () => {
    const clip = add();
    add('v1', '100', '45');
    const before = await readFile(path, 'utf8');
    const invalid = [
      ['track', 'remove', path, 'v1'],
      ['track', 'remove', path, 'missing'],
      ['clip', 'remove', path, 'missing'],
      [
        'clip',
        'add',
        path,
        'missing',
        '--track',
        'v1',
        '--at',
        '0',
        '--in',
        '0',
        '--out',
        '1',
      ],
      [
        'clip',
        'add',
        path,
        'av',
        '--track',
        'missing',
        '--at',
        '0',
        '--in',
        '0',
        '--out',
        '1',
      ],
      [
        'clip',
        'add',
        path,
        'sound',
        '--track',
        'v1',
        '--at',
        '0',
        '--in',
        '0',
        '--out',
        '1',
      ],
      [
        'clip',
        'add',
        path,
        'av',
        '--track',
        'a1',
        '--at',
        '0',
        '--in',
        '0',
        '--out',
        '301',
      ],
      [
        'clip',
        'add',
        path,
        'av',
        '--track',
        'v1',
        '--at',
        '44',
        '--in',
        '0',
        '--out',
        '1',
      ],
      ['clip', 'move', path, clip.id, '--at', '99'],
      ['clip', 'move', path, clip.id, '--track', 'missing'],
      ['clip', 'trim', path, clip.id, '--out', '116'],
      ['clip', 'trim', path, clip.id, '--out', '301'],
      ['clip', 'trim', path, clip.id, '--in', '60'],
      ['clip', 'split', path, clip.id, '--at', '0'],
      ['clip', 'split', path, clip.id, '--at', '45'],
      ['clip', 'move', path, clip.id, '--at', '9007199254740991'],
      ['media', 'remove', path, 'av'],
    ];
    for (const args of invalid) {
      const result = run(...args, '--json');
      expect(result.status, `${args.join(' ')}: ${result.stderr}`).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('opencut:');
      expect(await readFile(path, 'utf8')).toBe(before);
      expect((await readdir(directory)).sort()).toEqual([
        'project.json',
        'sentinel.wav',
      ]);
    }
  });

  it('allows exact touching boundaries, cross-track overlap and exact known source duration', () => {
    add();
    const adjacent = add('v1', '45', '300');
    expect(adjacent.sourceOut).toEqual(at(300));
    expect(add('a1').timelineStart).toEqual(at(0));
  });

  it('guards locked/symlinked/hard-linked files and preserves the original project and lock', async () => {
    const before = await readFile(path, 'utf8');
    const alias = join(directory, 'alias.json');
    await symlink(path, alias);
    let result = run(
      'track',
      'add',
      alias,
      '--type',
      'video',
      '--name',
      'Fail',
      '--json',
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('symlinks and hard links');
    const hard = join(directory, 'hard.json');
    await link(path, hard);
    result = run('track', 'remove', path, 'v1', '--json');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('symlinks and hard links');
    await rm(hard);
    await writeFile(`${path}.lock`, 'another writer');
    result = run('track', 'remove', path, 'v1', '--json');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('locked');
    expect(await readFile(`${path}.lock`, 'utf8')).toBe('another writer');
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it.each(['{malformed', JSON.stringify({ schemaVersion: 999 })])(
    'refuses malformed/unsupported documents without writing',
    async (document) => {
      await writeFile(path, document);
      const result = run(
        'track',
        'add',
        path,
        '--type',
        'video',
        '--name',
        'Fail',
        '--json',
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(await readFile(path, 'utf8')).toBe(document);
      expect((await readdir(directory)).sort()).toEqual([
        'project.json',
        'sentinel.wav',
      ]);
    },
  );

  it.each([
    ['timeline'],
    ['timeline', 'unknown', 'project.json'],
    ['timeline', 'list'],
    ['timeline', 'list', 'project.json', 'extra'],
    ['timeline', 'list', 'project.json', '--at', '0'],
    ['track', 'add', 'project.json'],
    ['track', 'add', 'project.json', '--type', 'subtitle', '--name', 'Bad'],
    ['track', 'add', 'project.json', '--type', 'audio', '--name', ' '],
    ['track', 'remove', 'project.json'],
    ['clip', 'add', 'project.json', 'av'],
    ['clip', 'move', 'project.json', 'id'],
    ['clip', 'trim', 'project.json', 'id'],
    ['clip', 'split', 'project.json', 'id'],
    ['clip', 'remove', 'project.json', 'id', '--at', '0'],
    ['clip', 'move', 'project.json', 'id', '--at', '-1'],
    ['clip', 'move', 'project.json', 'id', '--at', '0.5'],
    ['clip', 'move', 'project.json', 'id', '--at', '1/30'],
    ['clip', 'move', 'project.json', 'id', '--at', '1e2'],
    ['clip', 'move', 'project.json', 'id', '--at', 'NaN'],
    ['clip', 'move', 'project.json', 'id', '--at', '9007199254740992'],
    ['clip', 'move', 'project.json', 'id', '--track', ''],
    ['timeline', 'list', 'project\n.json'],
    ['clip', 'remove', 'project.json', 'bad\nid'],
    ['timeline', 'list', 'project.json', '--version'],
    ['timeline', 'list', 'project.json', '--unknown'],
    ['project', 'info', 'project.json', '--at', '0'],
    ['probe', 'sentinel.wav', '--track', 'v1'],
    ['--version', '--in', '0'],
    ['--version', '--volume', '0.5'],
    ['probe', 'sentinel.wav', '--muted', 'true'],
  ])(
    'rejects invalid arguments %j without changing project bytes',
    async (...args) => {
      const before = await readFile(path, 'utf8');
      const result = run(...args, '--json');
      expect(result.status, result.stderr).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('--help');
      expect(await readFile(path, 'utf8')).toBe(before);
    },
  );

  it.each([
    ['timeline'],
    ['timeline', 'list'],
    ['track'],
    ['track', 'add'],
    ['track', 'remove'],
    ['clip'],
    ['clip', 'add'],
    ['clip', 'move'],
    ['clip', 'trim'],
    ['clip', 'split'],
    ['clip', 'remove'],
  ])('provides discoverable help %j', (...args) => {
    const result = json(...args, '--help');
    expect(result.help).toContain('Usage: opencut timeline list');
    expect(result.help).toContain('PROJECT frame rate');
  });
});

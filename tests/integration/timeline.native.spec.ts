import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { deserializeProject, frameTime, listTimeline } from '@opencut/core';
import type { MediaAsset, TimelineClip, Track } from '@opencut/core';
import { requireTool } from '../../scripts/fixture-lib.js';

const entry = fileURLToPath(
  new URL('../../apps/cli/dist/index.js', import.meta.url),
);
const generated = fileURLToPath(
  new URL('../fixtures/generated/', import.meta.url),
);
const hash = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');

test('native T08 edits imported video/audio/image assets and preserves sources', async () => {
  requireTool('ffprobe');
  const files = ['video-short.mp4', 'audio-tone.wav', 'still.png'];
  const before = await Promise.all(
    files.map((file) => hash(join(generated, file))),
  );
  const directory = await mkdtemp(join(generated, 't08-'));
  const path = join(directory, 'project.json');
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [entry, ...args, '--json'], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 15000,
    });
  function json(...args: string[]) {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    return JSON.parse(result.stdout);
  }
  try {
    json(
      'project',
      'create',
      path,
      '--name',
      'Native timeline',
      '--fps',
      '30000/1001',
    );
    const video: Track = json(
      'track',
      'add',
      path,
      '--type',
      'video',
      '--name',
      'Video',
    ).track;
    const audio: Track = json(
      'track',
      'add',
      path,
      '--type',
      'audio',
      '--name',
      'Audio',
    ).track;
    for (const file of files) {
      const imported: MediaAsset = json(
        'media',
        'import',
        path,
        join(generated, file),
      ).asset;
      const track = imported.mediaTypes.includes('video') ? video : audio;
      const clip: TimelineClip = json(
        'clip',
        'add',
        path,
        imported.id,
        '--track',
        track.id,
        '--at',
        '30',
        '--in',
        '15',
        '--out',
        '59',
      ).clip;
      const split = json('clip', 'split', path, clip.id, '--at', '45');
      assert.equal(split.left.id, clip.id);
      assert.deepEqual(
        split.left.sourceOut,
        frameTime(30, { numerator: 30000, denominator: 1001 }),
      );
      assert.deepEqual(split.left.sourceOut, split.right.sourceIn);
      assert.deepEqual(split.right.sourceOut, clip.sourceOut);
      assert.equal(json('project', 'validate', path).valid, true);
      const snapshot = await readFile(path, 'utf8');
      const invalid = run('clip', 'move', path, split.right.id, '--at', '44');
      assert.equal(invalid.status, 1);
      assert.equal(invalid.stdout, '');
      assert.match(invalid.stderr, /overlaps/);
      assert.equal(await readFile(path, 'utf8'), snapshot);
      const loaded = deserializeProject(snapshot);
      assert.deepEqual(json('timeline', 'list', path), {
        path,
        ...listTimeline(loaded),
      });
      json('clip', 'move', path, split.right.id, '--at', '90');
      json('clip', 'trim', path, split.right.id, '--out', '45');
      json('clip', 'remove', path, split.left.id);
      json('clip', 'remove', path, split.right.id);
      json('media', 'remove', path, imported.id);
    }
    json('track', 'remove', path, video.id);
    json('track', 'remove', path, audio.id);
    const loaded = deserializeProject(await readFile(path, 'utf8'));
    assert.deepEqual(loaded.clips, []);
    assert.deepEqual(loaded.tracks, []);
    assert.deepEqual(loaded.assets, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
    for (const [index, file] of files.entries())
      assert.equal(
        await hash(join(generated, file)),
        before[index],
        `Source changed: ${file}`,
      );
  }
});

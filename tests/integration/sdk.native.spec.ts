import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { openProject } from '@opencut/sdk';
import { requireTool, runTool } from '../../scripts/fixture-lib.js';

test('T30 documented scripts create, inspect, preview and render from original media', async (t) => {
  requireTool('ffmpeg');
  requireTool('ffprobe');
  const root = resolve('tests/fixtures/generated');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 't30-native-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'source.mp4');
  const still = join(directory, 'source.png');
  const title = join(directory, 'title.json');
  const cut = join(directory, 'cut.json');
  const png = join(directory, 'frame.png');
  const mp4 = join(directory, 'review.mp4');
  const sheet = join(directory, 'sheet.png');
  const node = (...args: string[]) => {
    const result = spawnSync(process.execPath, args, {
      encoding: 'utf8',
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  runTool('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=160x90:r=30:d=2',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=660:sample_rate=48000:duration=2',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    source,
  ]);
  runTool('ffmpeg', [
    '-v',
    'error',
    '-i',
    source,
    '-frames:v',
    '1',
    '-threads',
    '1',
    still,
  ]);
  const original = await readFile(source);
  assert.equal(
    node('examples/scripts/title-card.ts', title, still).revision,
    1,
  );
  const titleEditor = await openProject(title);
  assert.deepEqual(titleEditor.project.inspect().duration, {
    numerator: 3,
    denominator: 2,
  });
  const cli = 'apps/cli/dist/index.js';
  const failedPath = join(directory, 'failed.json');
  const failed = spawnSync(
    process.execPath,
    [
      cli,
      'run',
      'examples/scripts/rough-cut.ts',
      '--project',
      failedPath,
      '--create',
      'Failed cut',
      '--json',
      '--',
      source,
      join(directory, 'missing.mp4'),
    ],
    { encoding: 'utf8', timeout: 60_000 },
  );
  assert.equal(failed.status, 1, failed.stderr);
  assert.equal(JSON.parse(failed.stderr).error.code, 'SOURCE_UNAVAILABLE');
  await assert.rejects(readFile(failedPath), { code: 'ENOENT' });
  const rough = node(
    cli,
    'run',
    'examples/scripts/rough-cut.ts',
    '--project',
    cut,
    '--create',
    'Rough cut',
    '--json',
    '--',
    source,
    source,
  );
  assert.equal(rough.revision, 1);
  assert.equal(rough.result.shots, 2);
  const editor = await openProject(cut);
  assert.equal(editor.project.inspect().assets.length, 1);
  assert.equal(editor.project.history().undo.length, 1);
  const before = await readFile(cut);
  const review = node(
    cli,
    'run',
    'examples/scripts/review-and-export.ts',
    '--project',
    cut,
    '--expected-revision',
    '1',
    '--json',
    '--',
    '30',
    png,
    mp4,
  );
  assert.equal(review.changed, false);
  assert.equal(review.result.timeline.activeClips[0].id, 'shot-2');
  assert.equal(review.result.preview.width, 320);
  assert.equal(review.result.video.frameCount, 60);
  const probe = node(cli, 'probe', mp4, '--json');
  assert.equal(probe.video.codec, 'h264');
  assert.equal(probe.audio.codec, 'aac');
  assert.equal(probe.durationSeconds, 2);
  const image = node(cli, 'probe', png, '--json');
  assert.equal(image.video.codec, 'png');
  assert.equal(image.video.width, 320);
  editor.project.apply({ type: 'canvas.set', width: 320, height: 180 });
  const contactSheet = await editor.project.previewContactSheet(
    [0, 59],
    sheet,
    { columns: 2, maxDimension: 160 },
  );
  assert.equal(contactSheet.tileWidth, 160);
  assert.equal(contactSheet.columns, 2);
  assert.equal(node(cli, 'probe', sheet, '--json').video.width, 320);
  await assert.rejects(editor.project.render(mp4), /Refusing to overwrite/);
  assert.deepEqual(await readFile(cut), before);
  assert.deepEqual(await readFile(source), original);
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compileVideo } from '@opencut/sdk';
import { serializeProject } from '@opencut/core';
import { requireTool, runTool } from '../../scripts/fixture-lib.js';
import type { Probe } from '../../scripts/fixture-lib.js';

const entry = fileURLToPath(
  new URL('../../apps/cli/dist/index.js', import.meta.url),
);
const generated = fileURLToPath(
  new URL('../fixtures/generated/', import.meta.url),
);
const example = (extension: string) =>
  fileURLToPath(
    new URL(
      `../../examples/video/showcase.video.${extension}`,
      import.meta.url,
    ),
  );
const hash = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');

test('T44 public CLI renders equivalent 20-second definitions and legacy projects', async () => {
  requireTool('ffmpeg');
  requireTool('ffprobe');
  const directory = await mkdtemp(join(generated, 't44-'));
  const sources = [
    example('ts'),
    example('json'),
    join(generated, 'video-long.mp4'),
    join(generated, 'audio-tone.wav'),
    join(generated, 'still.png'),
  ];
  const before = await Promise.all(sources.map(hash));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [entry, ...args, '--json'], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 30_000,
    });
  const cli = (...args: string[]) => {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  try {
    const { path: tsPath, ...ts } = cli('inspect', example('ts'));
    const { path: jsonPath, ...json } = cli('inspect', example('json'));
    assert.notEqual(tsPath, jsonPath);
    assert.deepEqual(ts, json);
    const alias = join(directory, 'alias.video.json');
    await symlink(example('json'), alias, 'file');
    assert.deepEqual(cli('inspect', alias), { path: jsonPath, ...json });
    await rm(alias);
    for (const extension of ['ts', 'json']) {
      cli('validate', example(extension));
      cli('render', example(extension), '--output', `${extension}.mp4`);
      for (const frame of [30, 96, 414, 479])
        cli(
          'preview',
          'frame',
          example(extension),
          '--frame',
          String(frame),
          '--output',
          `${extension}-${frame}.png`,
        );
    }
    assert.equal(
      await hash(join(directory, 'ts.mp4')),
      await hash(join(directory, 'json.mp4')),
    );
    for (const frame of [30, 96, 414, 479])
      assert.equal(
        await hash(join(directory, `ts-${frame}.png`)),
        await hash(join(directory, `json-${frame}.png`)),
      );
    assert.notEqual(
      await hash(join(directory, 'ts-96.png')),
      await hash(join(directory, 'ts-479.png')),
    );
    const probe: Probe = JSON.parse(
      runTool('ffprobe', [
        '-v',
        'error',
        '-count_frames',
        '-show_streams',
        '-show_format',
        '-of',
        'json',
        join(directory, 'ts.mp4'),
      ]),
    );
    const video = probe.streams?.find(
      ({ codec_type }) => codec_type === 'video',
    );
    const audio = probe.streams?.find(
      ({ codec_type }) => codec_type === 'audio',
    );
    assert.equal(video?.codec_name, 'h264');
    assert.equal(video.width, 320);
    assert.equal(video.height, 180);
    assert.equal(video.avg_frame_rate, '24/1');
    assert.equal(video.nb_read_frames, '480');
    assert.equal(Number(probe.format?.duration), 20);
    assert.equal(audio?.codec_name, 'aac');
    assert.equal(Number(audio.duration), 20);

    for (const frame of [30, 96, 414, 479]) {
      const preview = decodeRgb(join(directory, `ts-${frame}.png`));
      const rendered = decodeRgb(join(directory, 'ts.mp4'), frame);
      assert.equal(preview.length, 320 * 180 * 3);
      assert.equal(rendered.length, preview.length);
      const error =
        preview.reduce(
          (sum, value, index) => sum + Math.abs(value - rendered[index]!),
          0,
        ) / preview.length;
      assert.ok(error < 10, `Frame ${frame} mean RGB error: ${error}`);
    }

    const tooLong = JSON.parse(await readFile(example('json'), 'utf8'));
    tooLong.assets.camera.path = '../video-long.mp4';
    tooLong.assets.music.path = '../audio-tone.wav';
    tooLong.assets.still.path = '../still.png';
    tooLong.tracks[0].clips[1].sourceOut = 132;
    await writeFile(
      join(directory, 'invalid.video.json'),
      JSON.stringify(tooLong),
    );
    const invalid = run(
      'render',
      'invalid.video.json',
      '--output',
      'invalid.mp4',
    );
    assert.equal(invalid.status, 1, invalid.stderr);
    assert.match(invalid.stderr, /Out point exceeds the duration/);
    assert.ok(!(await readdir(directory)).includes('invalid.mp4'));

    const replaced = run('render', example('json'), '--output', 'ts.mp4');
    assert.equal(replaced.status, 1, replaced.stderr);
    assert.match(replaced.stderr, /Refusing to overwrite/);
    assert.equal(
      await hash(join(directory, 'ts.mp4')),
      await hash(join(directory, 'json.mp4')),
    );
    assert.equal((await readdir(directory)).length, 11);

    const project = structuredClone(
      (await compileVideo(example('json'))).project,
    );
    delete project.settings.durationFrames;
    for (const asset of project.assets)
      asset.file.path = join(
        '..',
        asset.file.path.split('/').at(-1)!,
      ).replaceAll('\\', '/');
    const legacy = join(directory, 'legacy.video.json');
    const original = serializeProject(project);
    await writeFile(legacy, original);
    const legacyPreview = cli(
      'preview',
      'frame',
      legacy,
      '--frame',
      '96',
      '--output',
      'legacy.png',
    );
    assert.equal(legacyPreview.projectPath, legacy);
    assert.equal(
      await hash(join(directory, 'legacy.png')),
      await hash(join(directory, 'json-96.png')),
    );
    const legacyRender = run(
      'project',
      'render',
      legacy,
      '--output',
      'legacy.mp4',
    );
    assert.equal(legacyRender.status, 0, legacyRender.stderr);
    const result = JSON.parse(legacyRender.stdout.trim().split('\n').at(-1)!);
    assert.equal(result.event, 'completed');
    assert.equal(result.frameCount, 456);
    assert.equal(await readFile(legacy, 'utf8'), original);
    assert.deepEqual(await Promise.all(sources.map(hash)), before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function decodeRgb(path: string, frame?: number) {
  const result = spawnSync('ffmpeg', [
    '-v',
    'error',
    '-i',
    path,
    ...(frame === undefined ? [] : ['-vf', `select=eq(n\\,${frame})`]),
    '-frames:v',
    '1',
    '-pix_fmt',
    'rgb24',
    '-f',
    'rawvideo',
    '-',
  ]);
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
}

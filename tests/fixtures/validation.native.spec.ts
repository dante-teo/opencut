import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  fixtures,
  requireTool,
  runTool,
  validateFixture,
} from '../../scripts/fixture-lib.js';
import type { Probe } from '../../scripts/fixture-lib.js';

test('rejects a truncated MP4 even when its header still declares all frames', () => {
  requireTool('ffmpeg');
  requireTool('ffprobe');
  const fixture = fixtures.find((item) => item.file === 'video-medium.mp4');
  assert(fixture, 'Missing medium fixture');
  const directory = mkdtempSync(join(tmpdir(), 'opencut-fixture-regression-'));
  try {
    const intact = join(directory, 'intact.mp4');
    const truncated = join(directory, 'truncated.mp4');
    runTool('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-n',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=30',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=1000:sample_rate=48000',
      '-t',
      '3',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-threads:v',
      '1',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-ac',
      '1',
      '-movflags',
      '+faststart',
      intact,
    ]);
    assert.doesNotThrow(() => validateFixture(fixture, intact));
    const bytes = readFileSync(intact);
    writeFileSync(truncated, bytes.subarray(0, Math.floor(bytes.length / 2)));

    const header = JSON.parse(
      runTool('ffprobe', [
        '-v',
        'error',
        '-show_streams',
        '-show_format',
        '-of',
        'json',
        truncated,
      ]),
    ) as Probe;
    assert.equal(
      header.streams?.find((stream) => stream.codec_type === 'video')
        ?.nb_frames,
      '90',
    );
    assert.throws(
      () => validateFixture(fixture, truncated),
      /ffprobe failed|readable frame count/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

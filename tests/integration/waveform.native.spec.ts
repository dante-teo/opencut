import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { waveformImage } from '../../packages/media/src/waveform.js';
import { runMediaTool } from '../../packages/media/src/process.js';

test('waveform pixels preserve delayed stream silence, source trims, and an audio tail', async () => {
  await mkdir(resolve('tests/fixtures/generated'), { recursive: true });
  const directory = await mkdtemp(
    resolve('tests/fixtures/generated/waveform-'),
  );
  try {
    const source = join(directory, 'delayed.mp4');
    await runMediaTool('ffmpeg', [
      '-v',
      'error',
      '-nostdin',
      '-n',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=160x90:r=30:d=4',
      '-itsoffset',
      '1',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=1',
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-threads',
      '1',
      '-c:a',
      'aac',
      source,
    ]);
    const before = await readFile(source);
    async function pixels(start: number, duration: number) {
      const png = join(directory, `wave-${start}.png`);
      await writeFile(png, await waveformImage(source, start, duration, 400));
      return runMediaTool('ffmpeg', [
        '-v',
        'error',
        '-nostdin',
        '-i',
        png,
        '-pix_fmt',
        'rgb24',
        '-f',
        'rawvideo',
        'pipe:1',
      ]);
    }
    function energy(bytes: Buffer, from: number, to: number) {
      let value = 0;
      for (let y = 0; y < 32; y++)
        for (let x = from; x < to; x++) value += bytes[(y * 400 + x) * 3 + 1]!;
      return value / ((to - from) * 32);
    }
    const all = await pixels(0, 4);
    assert.ok(
      energy(all, 120, 180) > energy(all, 10, 80) + 10,
      'leading stream offset must remain silent',
    );
    assert.ok(
      energy(all, 120, 180) > energy(all, 240, 380) + 10,
      'waveform must not stretch audio into a silent tail',
    );
    const trimmed = await pixels(1.5, 2);
    assert.ok(
      energy(trimmed, 10, 70) > energy(trimmed, 150, 380) + 10,
      'trimmed source range must retain the audio end',
    );
    assert.deepEqual(await readFile(source), before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

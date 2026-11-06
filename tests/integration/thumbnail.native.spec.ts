import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { MediaCache, ThumbnailCache } from '../../packages/media/src/index.js';
import { runMediaTool } from '../../packages/media/src/process.js';

test('small thumbnails preserve originals, use VideoToolbox on macOS, and measure cold/warm decode cost', async () => {
  await mkdir(resolve('tests/fixtures/generated'), { recursive: true });
  const directory = await mkdtemp(
    resolve('tests/fixtures/generated/thumbnail-'),
  );
  try {
    const source = join(directory, '4k.mp4');
    await runMediaTool('ffmpeg', [
      '-v',
      'error',
      '-nostdin',
      '-n',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=3840x2160:r=30:d=8',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '28',
      '-threads',
      '2',
      source,
    ]);
    const before = await readFile(source);
    const samples = [0, 0.9, 1.8, 2.7, 3.6, 4.5, 5.4, 6.3];
    const legacy = new MediaCache(join(directory, 'legacy-cache'));
    const oldStart = performance.now();
    for (const at of samples) await legacy.frame(source, at);
    const oldMs = performance.now() - oldStart;
    const results: Record<string, unknown> = {};
    for (const hardware of [false, true]) {
      if (hardware && process.platform !== 'darwin') continue;
      const cache = new ThumbnailCache();
      const start = performance.now();
      const decoded = [];
      for (const at of samples)
        decoded.push(await cache.get(source, at, { hardware }));
      const elapsedMs = performance.now() - start;
      const warmStart = performance.now();
      for (const at of samples) await cache.get(source, at, { hardware });
      const warmMs = performance.now() - warmStart;
      for (const item of decoded) {
        assert.equal(item.bytes[0], 255);
        assert.ok(item.bytes.length < 256 * 1024);
      }
      if (hardware)
        assert.ok(
          decoded.every((item) => item.decoder === 'videotoolbox'),
          'hardware fixture unexpectedly fell back',
        );
      results[hardware ? 'videotoolbox' : 'software'] = {
        elapsedMs,
        warmMs,
        speedup: oldMs / elapsedMs,
      };
    }
    for (const hardware of [false, true]) {
      if (hardware && process.platform !== 'darwin') continue;
      const cache = new ThumbnailCache();
      const start = performance.now();
      for (const at of [0, 3.6])
        await cache.get(source, at, { hardware, count: 4, interval: 0.9 });
      const elapsedMs = performance.now() - start;
      results[hardware ? 'videotoolboxBatch' : 'softwareBatch'] = {
        elapsedMs,
        speedup: oldMs / elapsedMs,
      };
    }
    if (process.platform === 'darwin') {
      // Verify actual decoder selection, beyond a compiled-in capability list.
      const trace = await promisify(execFile)(
        'ffmpeg',
        [
          '-v',
          'debug',
          '-nostdin',
          '-hwaccel',
          'videotoolbox',
          '-i',
          source,
          '-frames:v',
          '1',
          '-f',
          'null',
          '-',
        ],
        { maxBuffer: 1024 * 1024 },
      );
      const evidence = trace.stderr
        .split('\n')
        .filter((line) =>
          /Format videotoolbox_vld|requires hwaccel|Selecting decoder/.test(
            line,
          ),
        );
      assert.ok(
        evidence.some((line) => /videotoolbox_vld/.test(line)),
        'missing hardware pixel-format selection',
      );
      console.log('VideoToolbox decoder trace', evidence);
    }
    console.log(
      'Timeline thumbnail benchmark',
      JSON.stringify({
        arch: process.arch,
        source: 'synthetic 4K H.264, 30fps, 8s',
        samples: samples.length,
        legacyMs: oldMs,
        ...results,
      }),
    );
    assert.deepEqual(await readFile(source), before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('batched thumbnail samples do not show transitions before their source times', async () => {
  await mkdir(resolve('tests/fixtures/generated'), { recursive: true });
  const directory = await mkdtemp(
    resolve('tests/fixtures/generated/thumbnail-timing-'),
  );
  try {
    const source = join(directory, 'transitions.mp4');
    const inputs = [
      ['red', 0.5],
      ['lime', 0.9],
      ['blue', 0.9],
      ['yellow', 1.7],
    ] as const;
    await runMediaTool('ffmpeg', [
      '-v',
      'error',
      '-nostdin',
      '-n',
      ...inputs.flatMap(([color, duration]) => [
        '-f',
        'lavfi',
        '-i',
        `color=c=${color}:s=640x360:r=30:d=${duration}`,
      ]),
      '-filter_complex',
      '[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0[v]',
      '-map',
      '[v]',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-threads',
      '2',
      '-pix_fmt',
      'yuv420p',
      source,
    ]);
    const before = await readFile(source);
    const expected = [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [255, 255, 0],
    ];
    for (const hardware of process.platform === 'darwin'
      ? [false, true]
      : [false]) {
      const cache = new ThumbnailCache();
      for (const start of [0, 0.2]) {
        const { bytes } = await cache.get(source, start, {
          hardware,
          count: 4,
          interval: 0.9,
        });
        const image = join(directory, `strip-${hardware}-${start}.jpg`);
        await writeFile(image, bytes);
        const pixels = await runMediaTool('ffmpeg', [
          '-v',
          'error',
          '-nostdin',
          '-i',
          image,
          '-pix_fmt',
          'rgb24',
          '-f',
          'rawvideo',
          'pipe:1',
        ]);
        assert.equal(pixels.length, 576 * 80 * 3);
        for (const [tile, color] of expected.entries()) {
          const offset = (40 * 576 + tile * 144 + 72) * 3;
          for (let channel = 0; channel < 3; channel++)
            assert.ok(
              Math.abs(pixels[offset + channel]! - color[channel]!) < 30,
              `sample ${start + tile * 0.9}s, hardware=${hardware}: expected ${color}, got ${[...pixels.subarray(offset, offset + 3)]}`,
            );
        }
        assert.deepEqual(
          (
            await cache.get(source, start, {
              hardware,
              count: 4,
              interval: 0.9,
            })
          ).bytes,
          bytes,
        );
      }
    }
    assert.deepEqual(await readFile(source), before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

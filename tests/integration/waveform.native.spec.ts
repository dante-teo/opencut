import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { MediaCache } from '../../packages/media/src/cache.js';
import { runMediaTool } from '../../packages/media/src/process.js';

test('source waveform preserves delay, peaks across channels, chunk timing and silence, with bounded cache reuse', async () => {
  await mkdir(resolve('tests/fixtures/generated'), { recursive: true });
  const directory = await mkdtemp(
    resolve('tests/fixtures/generated/waveform-'),
  );
  try {
    const source = join(directory, 'delayed.mkv');
    const replacement = join(directory, 'replacement.mkv');
    const tone =
      'if(between(t\\,0.25\\,1.75)+between(t\\,16.5\\,17.5)\\,0.7*sin(2*PI*440*t)\\,0)';
    const video = [
      '-v',
      'error',
      '-nostdin',
      '-n',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=160x90:r=5:d=40',
    ];
    const encode = ['-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1'];
    await runMediaTool('ffmpeg', [
      ...video,
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=48000:d=40',
      '-itsoffset',
      '1',
      '-f',
      'lavfi',
      '-i',
      'aevalsrc=' + tone + '|-' + tone + ':s=48000:d=20',
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-map',
      '2:a',
      '-disposition:a:0',
      '0',
      '-disposition:a:1',
      'default',
      ...encode,
      '-c:a',
      'pcm_s16le',
      source,
    ]);
    await runMediaTool('ffmpeg', [...video, ...encode, replacement]);
    const before = await readFile(source);
    const cache = new MediaCache(join(directory, 'cache'));
    const started = performance.now();
    const first = (await cache.waveform(source, 0))!;
    const coldMs = performance.now() - started;
    assert.equal(first.length, 1600);
    assert.ok(first.slice(0, 120).every((peak) => peak === 0));
    assert.ok(first.slice(130, 250).every((peak) => peak >= 170));
    assert.ok(first.slice(300).every((peak) => peak === 0));

    const next = (await cache.waveform(source, 16))!;
    assert.ok(next.slice(0, 145).every((peak) => peak === 0));
    assert.ok(next.slice(155, 245).every((peak) => peak >= 170));
    assert.ok(next.slice(255).every((peak) => peak === 0));
    const tail = await cache.waveform(source, 32);
    assert.ok(tail?.every((peak) => peak === 0));
    const warmStarted = performance.now();
    assert.equal(await cache.waveform(source, 0), first);
    const warmMs = performance.now() - warmStarted;
    const status = await cache.status();
    assert.equal(status.hits, 1);
    assert.equal(status.misses, 3);
    assert.equal(status.memoryBytes, 4800);
    assert.equal(status.diskBytes, 0);
    assert.deepEqual(await readFile(source), before);
    await assert.rejects(cache.waveform(source, 1), /Invalid waveform chunk/);
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(cache.waveform(source, 0, abort.signal), /cancelled/);

    await rename(replacement, source);
    assert.equal(await cache.waveform(source, 0), null);
    assert.equal((await cache.status()).misses, 4);
    await cache.clear();
    assert.equal((await cache.status()).memoryBytes, 0);
    console.log(
      JSON.stringify({
        coldMs,
        warmMs,
        chunkSeconds: 16,
        peakBytes: first.length,
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('waveforms reuse memory when the disk cache cannot initialize', async () => {
  await mkdir(resolve('tests/fixtures/generated'), { recursive: true });
  const directory = await mkdtemp(
    resolve('tests/fixtures/generated/waveform-fallback-'),
  );
  try {
    const source = join(directory, 'tone.wav');
    await runMediaTool('ffmpeg', [
      '-v',
      'error',
      '-nostdin',
      '-n',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=1',
      '-c:a',
      'pcm_s16le',
      source,
    ]);
    const occupied = join(directory, 'occupied');
    await mkdir(occupied);
    const sentinel = join(occupied, 'keep.txt');
    await writeFile(sentinel, 'unrelated data');
    const malformed = new MediaCache(join(directory, 'malformed'));
    await malformed.status();
    const config = join(malformed.directory, 'config.json');
    await writeFile(config, '{');

    for (const [cache, failure] of [
      [new MediaCache(occupied), /dedicated empty cache directory/],
      [malformed, SyntaxError],
    ] as const) {
      await assert.rejects(cache.status(), failure);
      const peaks = await cache.waveform(source, 0);
      assert.equal(peaks?.length, 1600);
      assert.ok(peaks?.subarray(0, 100).every((peak) => peak > 0));
      assert.equal(await cache.waveform(source, 0), peaks);
      await assert.rejects(cache.status(), failure);
    }
    assert.equal(await readFile(sentinel, 'utf8'), 'unrelated data');
    assert.equal(await readFile(config, 'utf8'), '{');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

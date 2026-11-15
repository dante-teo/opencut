import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  copyFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fixtures, requireTool } from '../../scripts/fixture-lib.js';
import type { MediaMetadata } from '../../packages/media/src/probe.js';
import type { FrameResult } from '../../packages/media/src/frame.js';

const entry = fileURLToPath(
  new URL('../../apps/cli/dist/index.js', import.meta.url),
);
const generated = fileURLToPath(
  new URL('../fixtures/generated/', import.meta.url),
);

test(
  'SIGTERM stops frame decoding without publishing a PNG',
  { skip: process.platform === 'win32' },
  async (t) => {
    requireTool('ffprobe');
    const directory = await mkdtemp(join(generated, 'cancel-frame-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const decoder = `
    setTimeout(() => {
      const fs = require('node:fs');
      fs.writeFileSync('decoder-finished', '');
      process.stdout.write(fs.readFileSync(${JSON.stringify(join(generated, 'still.png'))}));
    }, 1500);
  `;
    const preload = `
    import { createRequire, syncBuiltinESMExports } from 'node:module';
    const subprocess = createRequire(import.meta.url)('node:child_process');
    const { execFile } = subprocess;
    subprocess.execFile = (command, args, ...rest) => {
      if (command !== 'ffmpeg') return execFile(command, args, ...rest);
      const child = execFile(process.execPath, ['-e', ${JSON.stringify(decoder)}], ...rest);
      process.stderr.write('decoder started\\n');
      return child;
    };
    syncBuiltinESMExports();
  `;
    const mock = join(directory, 'mock-decoder.mjs');
    await writeFile(mock, preload);
    const child = spawn(
      process.execPath,
      [
        '--import',
        mock,
        entry,
        'extract-frame',
        join(generated, 'video-short.mp4'),
        '--timestamp',
        '0',
        '--output',
        'frame.png',
      ],
      { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    let diagnostics = '';
    let cancelled = false;
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      diagnostics += chunk;
      if (!cancelled && diagnostics.includes('decoder started')) {
        cancelled = true;
        child.kill('SIGTERM');
      }
    });
    try {
      const [code] = await once(child, 'close', {
        signal: AbortSignal.timeout(10_000),
      });
      assert.ok(cancelled, diagnostics);
      assert.equal(code, 143, diagnostics);
      assert.equal(output, '');
      assert.deepEqual(await readdir(directory), ['mock-decoder.mjs']);
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
    }
  },
);

test('native T02 CLI against existing synthetic fixtures', async (t) => {
  requireTool('ffmpeg');
  requireTool('ffprobe');
  // Never generate over an existing fixture. New test outputs stay in an owned
  // subdirectory of generated/ and are removed even when an assertion fails.
  const directory = await mkdtemp(join(generated, 't02-'));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [entry, ...args], {
      encoding: 'utf8',
      cwd: directory,
      timeout: 15_000,
    });
  try {
    for (const fixture of fixtures) {
      await t.test(`probes ${fixture.file} as JSON`, () => {
        const result = run('probe', join(generated, fixture.file), '--json');
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, '');
        const media = JSON.parse(result.stdout) as MediaMetadata;
        assert.equal(media.hasAudio, Boolean(fixture.audio));
        assert.equal(
          media.streams.length,
          Number(Boolean(fixture.video)) + Number(Boolean(fixture.audio)),
        );
        if (fixture.durationSeconds !== undefined) {
          assert(
            Math.abs(Number(media.durationSeconds) - fixture.durationSeconds) <
              0.1,
          );
        }
        if (fixture.video) {
          assert.equal(media.video?.width, fixture.video.width);
          assert.equal(media.video.height, fixture.video.height);
          assert.equal(media.video.codec, fixture.video.codec);
          if (fixture.video.frameRate)
            assert.equal(media.video.frameRate, fixture.video.frameRate);
        } else assert.equal(media.video, null);
        if (fixture.audio) {
          assert.equal(media.audio?.codec, fixture.audio.codec);
          assert.equal(media.audio.sampleRate, fixture.audio.sampleRate);
          assert.equal(media.audio.channels, fixture.audio.channels);
        } else assert.equal(media.audio, null);
      });
    }

    await t.test(
      'extracts a decodable PNG at the requested time with literal paths',
      async () => {
        const input = "-clip $(literal); 'quote'.mp4";
        const output = "-frame $(literal); 'quote'.png";
        await copyFile(
          join(generated, 'video-short.mp4'),
          join(directory, input),
        );
        const result = run(
          'extract-frame',
          '--timestamp',
          '0.51',
          `--output=${output}`,
          '--json',
          '--',
          input,
        );
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, '');
        const frame = JSON.parse(result.stdout) as FrameResult;
        assert.equal(frame.path, join(directory, output));
        assert.equal(frame.sourcePath, join(directory, input));
        assert.equal(frame.timestampSeconds, 0.51);
        const bytes = await readFile(frame.path);
        assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
        assert.equal(bytes.readUInt32BE(16), 320);
        assert.equal(bytes.readUInt32BE(20), 180);
        const actual = spawnSync('ffmpeg', [
          '-v',
          'error',
          '-i',
          frame.path,
          '-frames:v',
          '1',
          '-pix_fmt',
          'rgb24',
          '-f',
          'rawvideo',
          'pipe:1',
        ]);
        // Independent sequential decode and timestamp selection, rather than the
        // implementation's input seek, verifies which source frame was extracted.
        const expected = spawnSync('ffmpeg', [
          '-v',
          'error',
          '-i',
          frame.sourcePath,
          '-vf',
          'select=gte(t\\,0.51)',
          '-frames:v',
          '1',
          '-pix_fmt',
          'rgb24',
          '-f',
          'rawvideo',
          'pipe:1',
        ]);
        assert.equal(actual.status, 0, actual.stderr.toString());
        assert.equal(expected.status, 0, expected.stderr.toString());
        assert.equal(actual.stdout.length, 320 * 180 * 3);
        assert.deepEqual(actual.stdout, expected.stdout);
        const again = run(
          'extract-frame',
          join(directory, input),
          '--timestamp',
          '0',
          '--output',
          frame.path,
        );
        assert.equal(again.status, 1);
        assert.match(again.stderr, /Refusing to overwrite/);
        assert.deepEqual(await readFile(frame.path), bytes);
      },
    );

    await t.test(
      'extracts timestamp zero from video and still images',
      async () => {
        for (const input of ['video-medium.mp4', 'still.png']) {
          const output = join(directory, `${input}.png`);
          const result = run(
            'extract-frame',
            join(generated, input),
            '--timestamp',
            '0',
            '--output',
            output,
          );
          assert.equal(result.status, 0, result.stderr);
          assert.match(result.stdout, /Saved frame at 0s/);
          assert.equal(
            (await readFile(output)).subarray(0, 8).toString('hex'),
            '89504e470d0a1a0a',
          );
        }
      },
    );

    await t.test(
      'accepts tiny decimal timestamps without exponential notation',
      () => {
        const result = run(
          'extract-frame',
          join(generated, 'video-short.mp4'),
          '--timestamp',
          '0.0000001',
          '--output',
          join(directory, 'tiny-timestamp.png'),
          '--json',
        );
        assert.equal(result.status, 0, result.stderr);
        assert.equal(
          (JSON.parse(result.stdout) as FrameResult).timestampSeconds,
          0.0000001,
        );
      },
    );

    await t.test(
      'extracts delayed video relative to the input start',
      async () => {
        for (const inputOffset of [0, 10]) {
          const input = join(directory, `delayed-${inputOffset}.mp4`);
          const generation = spawnSync(
            'ffmpeg',
            [
              '-v',
              'error',
              '-nostdin',
              '-n',
              '-f',
              'lavfi',
              '-i',
              'sine=frequency=440:duration=7',
              '-itsoffset',
              '5',
              '-i',
              join(generated, 'video-short.mp4'),
              '-map',
              '1:v:0',
              '-map',
              '0:a:0',
              '-c:v',
              'copy',
              '-c:a',
              'aac',
              '-output_ts_offset',
              String(inputOffset),
              '-movflags',
              '+faststart',
              input,
            ],
            { encoding: 'utf8', timeout: 15_000 },
          );
          assert.equal(generation.status, 0, generation.stderr);
          const probed = run('probe', input, '--json');
          assert.equal(probed.status, 0, probed.stderr);
          const media = JSON.parse(probed.stdout) as MediaMetadata;
          assert.notEqual(media.startTimeSeconds, null);
          assert.notEqual(media.video?.startTimeSeconds, null);
          assert.notEqual(media.video?.durationSeconds, null);
          const inputStart = Number(media.startTimeSeconds);
          const videoStart = Number(media.video?.startTimeSeconds);
          const duration = Number(media.video?.durationSeconds);
          assert(Math.abs(inputStart - inputOffset) < 0.1);
          assert(Math.abs(videoStart - inputStart - 5) < 0.1);
          assert.equal(duration, 2);
          const output = join(directory, `delayed-${inputOffset}.png`);
          const extracted = run(
            'extract-frame',
            input,
            '--timestamp',
            '5.5',
            '--output',
            output,
            '--json',
          );
          assert.equal(extracted.status, 0, extracted.stderr);
          const expected = spawnSync(
            'ffmpeg',
            [
              '-v',
              'error',
              '-nostdin',
              '-i',
              input,
              '-ss',
              '5.5',
              '-map',
              '0:0',
              '-frames:v',
              '1',
              '-c:v',
              'png',
              '-f',
              'image2pipe',
              'pipe:1',
            ],
            { timeout: 15_000 },
          );
          assert.equal(expected.status, 0, expected.stderr.toString());
          assert.equal(
            expected.stdout.subarray(0, 8).toString('hex'),
            '89504e470d0a1a0a',
          );
          assert.deepEqual(await readFile(output), expected.stdout);
          const rejected = run(
            'extract-frame',
            input,
            '--timestamp',
            String(videoStart - inputStart + duration),
            '--output',
            join(directory, `past-end-${inputOffset}.png`),
          );
          assert.equal(rejected.status, 1);
          assert.match(rejected.stderr, /out of range/);
        }
      },
    );

    await t.test('prints human-readable probe results', () => {
      const result = run('probe', join(generated, 'video-medium.mp4'));
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /640x360, 30 fps/);
      assert.match(result.stdout, /Audio: aac/);
    });

    await t.test(
      'rejects invalid files, audio-only extraction, invalid ranges and destinations',
      async () => {
        const invalid = join(directory, 'invalid.mp4');
        await writeFile(invalid, 'not media');
        const probe = run('probe', invalid, '--json');
        assert.equal(probe.status, 1);
        assert.equal(probe.stdout, '');
        assert.match(probe.stderr, /ffprobe failed/);
        for (const [file, timestamp, message] of [
          ['audio-tone.wav', '0', /no video stream/],
          ['video-short.mp4', '2', /out of range/],
          ['video-short.mp4', '50', /out of range/],
          ['video-short.mp4', '1.999', /no PNG frame/],
        ] as const) {
          const output = join(directory, `invalid-${file}-${timestamp}.png`);
          const result = run(
            'extract-frame',
            join(generated, file),
            '--timestamp',
            timestamp,
            '--output',
            output,
          );
          assert.equal(result.status, 1, result.stderr);
          assert.equal(result.stdout, '');
          assert.match(result.stderr, message);
          await assert.rejects(readFile(output), { code: 'ENOENT' });
        }
        const result = run(
          'extract-frame',
          join(generated, 'video-short.mp4'),
          '--timestamp',
          '0',
          '--output',
          join(directory, 'missing', 'frame.png'),
        );
        assert.equal(result.status, 1);
        assert.match(result.stderr, /Cannot create frame output/);
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

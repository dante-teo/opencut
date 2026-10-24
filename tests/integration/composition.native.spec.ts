import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  fixtures,
  requireTool,
  runTool,
  validateFixture,
} from '../../scripts/fixture-lib.js';
import type { CompositionResult } from '../../packages/media/src/compose.js';

const entry = fileURLToPath(
  new URL('../../apps/cli/dist/index.js', import.meta.url),
);
const generated = fileURLToPath(
  new URL('../fixtures/generated/', import.meta.url),
);
const fixture = (name: string) => join(generated, name);

function decode(file: string, args: string[]): Buffer {
  const result = spawnSync(
    'ffmpeg',
    ['-v', 'error', '-nostdin', '-xerror', '-i', file, ...args, 'pipe:1'],
    {
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
    },
  );
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(result.stderr.length, 0);
  return result.stdout;
}

function audio(file: string): Buffer {
  return decode(file, ['-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le']);
}

// Project decoded PCM onto a known fixture frequency. This checks that original
// sound and music survived the mix, and locates pulses independently of metadata.
function tone(samples: Buffer, start: number, frequency: number): number {
  const count = 2400;
  const offset = Math.round(start * 48000);
  let real = 0;
  let imaginary = 0;
  for (let i = 0; i < count; i++) {
    const value = samples.readFloatLE((offset + i) * 4);
    const angle = (2 * Math.PI * frequency * i) / 48000;
    real += value * Math.cos(angle);
    imaginary += value * Math.sin(angle);
  }
  return (2 * Math.hypot(real, imaginary)) / count;
}

function frame(file: string, time: number): Buffer {
  return decode(file, [
    '-ss',
    String(time),
    '-frames:v',
    '1',
    '-vf',
    'scale=64:36:force_original_aspect_ratio=decrease,pad=64:36:(ow-iw)/2:(oh-ih)/2',
    '-pix_fmt',
    'rgb24',
    '-f',
    'rawvideo',
  ]);
}

test('native T03 composition using existing synthetic fixtures', async (t) => {
  requireTool('ffmpeg');
  requireTool('ffprobe');
  const hashes = async () =>
    Promise.all(
      fixtures.map(async ({ file }) =>
        createHash('sha256')
          .update(await readFile(fixture(file)))
          .digest('hex'),
      ),
    );
  const before = await hashes();
  const directory = await mkdtemp(join(generated, 't03-'));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [entry, ...args], {
      encoding: 'utf8',
      cwd: directory,
      timeout: 60_000,
    });
  const compose = (output: string, clips: string[], extra: string[] = []) => {
    const result = run(
      'compose',
      ...clips,
      '--music',
      fixture('audio-tone.wav'),
      '--output',
      output,
      '--width',
      '640',
      '--height',
      '360',
      '--fps',
      '30',
      '--json',
      ...extra,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    return JSON.parse(result.stdout) as CompositionResult;
  };
  try {
    await t.test(
      'concatenates silent/mono/stereo clips with different sizes and rates; music loops',
      async () => {
        const output = join(directory, 'mixed.mp4');
        const clips = [
          'video-short.mp4',
          'video-medium.mp4',
          'video-long.mp4',
        ].map(fixture);
        const result = compose(output, clips);
        assert.equal(result.path, output);
        assert.equal(result.metadata.path, output);
        assert.deepEqual(result.clipPaths, clips);
        assert.equal(result.durationSeconds, 10);
        validateFixture(
          {
            file: output,
            durationSeconds: 10,
            video: { codec: 'h264', width: 640, height: 360, frameRate: 30 },
            audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
            toneHz: null,
          },
          output,
        );
        runTool('ffmpeg', [
          '-v',
          'error',
          '-nostdin',
          '-xerror',
          '-i',
          output,
          '-f',
          'null',
          '-',
        ]);
        for (const [index, start] of [0, 2, 5].entries()) {
          const actual = frame(output, start + 0.5);
          const expected = frame(clips[index]!, 0.5);
          assert.equal(actual.length, 64 * 36 * 3);
          const difference =
            actual.reduce(
              (sum, value, i) => sum + Math.abs(value - expected[i]!),
              0,
            ) / actual.length;
          assert(
            difference < 15,
            `clip ${index} order/letterboxing mismatch: ${difference}`,
          );
        }
        const samples = audio(output);
        assert(Math.abs(samples.length / 4 / 48000 - 10) < 0.05);
        for (const time of [0.025, 2.025, 5.025, 8.025, 9.8]) {
          assert(tone(samples, time, 880) > 0.01, `music missing at ${time}s`);
        }
        assert(
          tone(samples, 0.025, 1000) < 0.005,
          'silent clip acquired original audio',
        );
        for (const [time, frequency] of [
          [2.025, 1000],
          [3.025, 1000],
          [5.025, 440],
          [8.025, 440],
        ] as const) {
          assert(
            tone(samples, time, frequency) > 0.015,
            `original tone missing at ${time}s`,
          );
          assert(
            tone(samples, time + 0.3, frequency) < 0.005,
            `pulse shifted at ${time}s`,
          );
        }
        // Independent visual marker at the first frame after a clip boundary.
        const marker = frame(output, 2.033);
        const off = frame(output, 2.333);
        const brightness = (pixels: Buffer) =>
          (pixels[0]! + pixels[1]! + pixels[2]!) / 3;
        assert(
          brightness(marker) > 180 && brightness(off) < 150,
          'video sync marker moved',
        );
      },
    );

    await t.test('supports music-only audio and silent music gains', () => {
      const clips = [fixture('video-medium.mp4'), fixture('video-short.mp4')];
      const onlyMusic = compose(join(directory, 'music-only.mp4'), clips, [
        '--clip-volume',
        '0',
      ]);
      const musicSamples = audio(onlyMusic.path);
      assert(tone(musicSamples, 0.025, 880) > 0.01);
      assert(tone(musicSamples, 0.025, 1000) < 0.005);
      const onlyClips = compose(join(directory, 'clips-only.mp4'), clips, [
        '--music-volume',
        '0',
      ]);
      const clipSamples = audio(onlyClips.path);
      assert(tone(clipSamples, 0.025, 1000) > 0.015);
      assert(tone(clipSamples, 0.025, 880) < 0.005);
      assert(tone(clipSamples, 3.025, 1000) < 0.005);
    });

    await t.test(
      'retains one frame per short clip when reducing the frame rate',
      () => {
        const clips = [
          join(directory, 'one-frame-60fps.mp4'),
          join(directory, 'one-frame-120fps.mp4'),
        ];
        for (const [index, input] of clips.entries()) {
          runTool('ffmpeg', [
            '-v',
            'error',
            '-nostdin',
            '-n',
            '-ss',
            String(index + 0.5),
            '-i',
            fixture(index === 0 ? 'video-short.mp4' : 'video-medium.mp4'),
            '-map',
            '0:v:0',
            '-frames:v',
            '1',
            '-r',
            String(index === 0 ? 60 : 120),
            '-c:v',
            'libx264',
            '-pix_fmt',
            'yuv420p',
            input,
          ]);
        }
        for (const fps of [1, 30]) {
          const output = join(directory, `short-clips-${fps}fps.mp4`);
          const result = compose(output, clips, ['--fps', String(fps)]);
          assert.equal(result.durationSeconds, 2 / fps);
          validateFixture(
            {
              file: output,
              durationSeconds: 2 / fps,
              video: { codec: 'h264', width: 640, height: 360, frameRate: fps },
              audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
              toneHz: null,
            },
            output,
          );
          for (const [index, input] of clips.entries()) {
            const actual = frame(output, index / fps);
            const expected = frame(input, 0);
            assert.equal(actual.length, expected.length);
            const difference =
              actual.reduce(
                (sum, value, i) => sum + Math.abs(value - expected[i]!),
                0,
              ) / actual.length;
            assert(
              difference < 15,
              `short clip ${index} was lost or reordered at ${fps} fps`,
            );
          }
        }
      },
    );

    await t.test(
      'preserves gaps in music timestamps and keeps music through the output tail',
      () => {
        for (const gapSeconds of [0.08, 1]) {
          const music = join(directory, `gapped-music-${gapSeconds}.mka`);
          // Drop 10ms packets without resetting PTS. Include a gap below the
          // resampler's default 100ms threshold, plus later audio and a loop.
          runTool('ffmpeg', [
            '-v',
            'error',
            '-nostdin',
            '-n',
            '-i',
            fixture('audio-tone.wav'),
            '-af',
            `asetnsamples=n=480:p=0,aselect='lt(t,1)+gte(t,${1 + gapSeconds})'`,
            '-c:a',
            'pcm_s16le',
            music,
          ]);
          const packets = JSON.parse(
            runTool('ffprobe', [
              '-v',
              'error',
              '-show_packets',
              '-show_entries',
              'packet=pts_time,duration_time',
              '-of',
              'json',
              music,
            ]),
          ) as { packets: { pts_time: string; duration_time: string }[] };
          assert(
            packets.packets.some(
              (packet, index, all) =>
                index > 0 &&
                Math.abs(
                  Number(packet.pts_time) -
                    Number(all[index - 1]!.pts_time) -
                    Number(all[index - 1]!.duration_time) -
                    gapSeconds,
                ) < 0.002,
            ),
            `derived music fixture has no ${gapSeconds}s timestamp gap`,
          );
          const output = join(directory, `gapped-music-${gapSeconds}.mp4`);
          compose(
            output,
            [fixture('video-short.mp4'), fixture('video-medium.mp4')],
            ['--music', music, '--clip-volume', '0'],
          );
          validateFixture(
            {
              file: output,
              durationSeconds: 5,
              video: { codec: 'h264', width: 640, height: 360, frameRate: 30 },
              audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
              toneHz: null,
            },
            output,
          );
          const samples = audio(output);
          assert(
            tone(samples, 1.01, 880) < 0.005,
            `${gapSeconds}s music timestamp gap was compressed`,
          );
          for (const time of [0.3, 1.3 + gapSeconds, 3.3, 4.8]) {
            assert(
              tone(samples, time, 880) > 0.01,
              `music missing or shifted at ${time}s`,
            );
          }
        }
      },
    );

    await t.test(
      'selects default audio among multiple streams and pads a short original track',
      () => {
        const input = join(directory, "-clip $(literal); 'quote'.mp4");
        runTool('ffmpeg', [
          '-v',
          'error',
          '-nostdin',
          '-n',
          '-i',
          fixture('video-long.mp4'),
          '-i',
          fixture('video-medium.mp4'),
          '-map',
          '0:v:0',
          '-map',
          '0:a:0',
          '-map',
          '1:a:0',
          '-c',
          'copy',
          '-disposition:a:0',
          '0',
          '-disposition:a:1',
          'default',
          input,
        ]);
        const output = join(directory, "-output $(literal); 'quote'.mp4");
        compose(output, [input, fixture('video-short.mp4')]);
        const samples = audio(output);
        assert(
          tone(samples, 0.025, 1000) > 0.015,
          'default audio was not selected',
        );
        assert(
          tone(samples, 0.025, 440) < 0.005,
          'unselected audio leaked into mix',
        );
        assert(
          tone(samples, 3.025, 1000) < 0.005,
          'short original audio was not padded',
        );
        assert(tone(samples, 3.025, 880) > 0.01);
        const trimmed = compose(
          join(directory, 'trimmed-music.mp4'),
          [fixture('video-short.mp4'), fixture('video-short.mp4')],
          ['--music', fixture('video-long.mp4')],
        );
        assert.equal(
          trimmed.metadata.durationSeconds,
          4,
          'long background audio extended composition',
        );
      },
    );

    await t.test(
      'keeps delayed/early audio aligned with fractional-rate video and nonzero starts',
      () => {
        for (const delay of [0.5, -0.5]) {
          const input = join(directory, `offset-${delay}.mp4`);
          runTool('ffmpeg', [
            '-v',
            'error',
            '-nostdin',
            '-n',
            '-itsoffset',
            String(Math.max(0, -delay)),
            '-i',
            fixture('video-short.mp4'),
            '-itsoffset',
            String(Math.max(0, delay)),
            '-i',
            fixture('video-medium.mp4'),
            '-map',
            '0:v:0',
            '-map',
            '1:a:0',
            '-c:v',
            'libx264',
            '-vf',
            'fps=30000/1001',
            '-fps_mode',
            'passthrough',
            '-c:a',
            'aac',
            '-ar',
            '44100',
            '-ac',
            '1',
            '-output_ts_offset',
            '10',
            input,
          ]);
          const probe = run('probe', input, '--json');
          assert.equal(probe.status, 0, probe.stderr);
          const metadata = JSON.parse(
            probe.stdout,
          ) as CompositionResult['metadata'];
          assert(
            Math.abs(
              metadata.audio!.startTimeSeconds! -
                metadata.video!.startTimeSeconds! -
                delay,
            ) < 0.05,
            `derived fixture timing: ${JSON.stringify(metadata)}`,
          );
          assert.equal(metadata.audio?.sampleRate, 44100);
          assert.equal(metadata.video?.frameRateRatio, '30000/1001');
          const result = compose(
            join(directory, `aligned-${delay}.mp4`),
            [fixture('video-short.mp4'), input],
            ['--fps', '24'],
          );
          assert(Math.abs(result.durationSeconds - 4) < 0.05);
          const samples = audio(result.path);
          assert(
            tone(samples, 2.525, 1000) > 0.015,
            `offset ${delay} lost pulse timing`,
          );
          assert(
            tone(samples, 2.225, 1000) < 0.005,
            `offset ${delay} moved pulse`,
          );
        }
      },
    );

    await t.test(
      'refuses files, source aliases and symlinks without changing sources',
      async () => {
        const source = fixture('video-short.mp4');
        const alias = join(directory, 'alias.mp4');
        await symlink(source, alias);
        const existing = join(directory, 'existing.mp4');
        await copyFile(source, existing);
        const dangling = join(directory, 'dangling.mp4');
        await symlink(join(directory, 'missing.mp4'), dangling);
        for (const output of [source, alias, existing, dangling]) {
          const result = run(
            'compose',
            source,
            fixture('video-medium.mp4'),
            '--music',
            fixture('audio-tone.wav'),
            '--output',
            output,
          );
          assert.equal(result.status, 1);
          assert.equal(result.stdout, '');
          assert.match(result.stderr, /Refusing to overwrite/);
        }
        assert.deepEqual(await readFile(existing), await readFile(source));
      },
    );

    await t.test(
      'fails actionably for unusable inputs and missing output directories',
      async () => {
        for (const [first, music, output, error] of [
          ['audio-tone.wav', 'audio-tone.wav', 'no-video.mp4', /timed video/],
          ['still.png', 'audio-tone.wav', 'still.mp4', /duration|timed video/],
          [
            'video-short.mp4',
            'video-short.mp4',
            'no-music.mp4',
            /no audio stream/,
          ],
          [
            'video-short.mp4',
            'audio-tone.wav',
            'missing/output.mp4',
            /existing writable directory/,
          ],
        ] as const) {
          const result = run(
            'compose',
            fixture(first),
            fixture('video-medium.mp4'),
            '--music',
            fixture(music),
            '--output',
            join(directory, output),
            '--json',
          );
          assert.equal(result.status, 1);
          assert.equal(result.stdout, '');
          assert.match(result.stderr, error);
          await assert.rejects(readFile(join(directory, output)), {
            code: 'ENOENT',
          });
        }
        assert(
          !(await readdir(directory)).some((file) =>
            file.startsWith('.opencut-compose-'),
          ),
        );
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    assert.deepEqual(await hashes(), before, 'base fixture bytes changed');
  }
});

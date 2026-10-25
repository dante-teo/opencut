import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  addClip,
  createProject,
  frameTime,
  serializeProject,
  setClipAudio,
  splitClip,
  trimClip,
} from '@opencut/core';
import type { FrameRate, Project } from '@opencut/core';
import { requireTool, runTool } from '../../scripts/fixture-lib.js';

const entry = fileURLToPath(
  new URL('../../apps/cli/dist/index.js', import.meta.url),
);
const generated = fileURLToPath(
  new URL('../fixtures/generated/', import.meta.url),
);
const rate = { numerator: 30, denominator: 1 };
const fixtures = [
  'video-medium.mp4',
  'video-long.mp4',
  'video-short.mp4',
  'audio-tone.wav',
];
const hash = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
function example(frameRate: FrameRate = rate): Project {
  const project = createProject({
    name: 'T11 audio render',
    settings: { width: 160, height: 90, frameRate },
  });
  project.assets = fixtures.map((name, i) => ({
    id: `asset${i}`,
    name,
    mediaTypes: i === 2 ? ['video'] : i === 3 ? ['audio'] : ['video', 'audio'],
    file: { type: 'relative', path: `../${name}` },
  }));
  project.tracks = [
    { id: 'video', name: 'Video', type: 'video' },
    { id: 'music', name: 'Music', type: 'audio' },
    { id: 'other', name: 'Other audio', type: 'audio' },
  ];
  return project;
}
function add(
  project: Project,
  id: string,
  assetId: string,
  trackId: string,
  start: number,
  sourceIn: number,
  sourceOut: number,
  volume = 1,
) {
  const at = (n: number) => frameTime(n, project.settings.frameRate);
  return addClip(project, {
    id,
    assetId,
    trackId,
    timelineStart: at(start),
    sourceIn: at(sourceIn),
    sourceOut: at(sourceOut),
    volume,
  }).project;
}
function pcm(file: string): Float32Array {
  const result = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-nostdin',
      '-xerror',
      '-i',
      file,
      '-map',
      '0:a:0',
      '-ac',
      '1',
      '-ar',
      '48000',
      '-f',
      'f32le',
      'pipe:1',
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(result.stderr.length, 0);
  const bytes = result.stdout;
  return Float32Array.from({ length: bytes.length / 4 }, (_, i) =>
    bytes.readFloatLE(i * 4),
  );
}
function rms(samples: Float32Array, start: number, length = 0.04) {
  const window = samples.subarray(
    Math.round(start * 48000),
    Math.round((start + length) * 48000),
  );
  assert.ok(window.length > 0);
  return Math.sqrt(
    window.reduce((sum, value) => sum + value * value, 0) / window.length,
  );
}
function tone(samples: Float32Array, hz: number, start: number, length = 0.04) {
  const window = samples.subarray(
    Math.round(start * 48000),
    Math.round((start + length) * 48000),
  );
  let real = 0,
    imaginary = 0;
  for (const [i, value] of window.entries()) {
    real += value * Math.cos((2 * Math.PI * hz * i) / 48000);
    imaginary += value * Math.sin((2 * Math.PI * hz * i) / 48000);
  }
  return (2 * Math.hypot(real, imaginary)) / window.length;
}

test('native T11 audio rendering through the built CLI', async (t) => {
  requireTool('ffmpeg');
  requireTool('ffprobe');
  const before = await Promise.all(
    fixtures.map((file) => hash(join(generated, file))),
  );
  const directory = await mkdtemp(join(generated, 't11-'));
  const path = join(directory, 'project.json');
  const render = async (project: Project, name: string) => {
    const snapshot = serializeProject(project);
    await writeFile(path, snapshot);
    const output = join(directory, `${name}.mp4`);
    const result = spawnSync(
      process.execPath,
      [entry, 'project', 'render', path, '--output', output, '--json'],
      { encoding: 'utf8', timeout: 120000 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(await readFile(path, 'utf8'), snapshot);
    const events = result.stdout
      .trim()
      .split('\n')
      .map((line: string) => JSON.parse(line));
    const report = events.at(-1);
    assert.equal(report.event, 'completed');
    assert.ok(
      events.some((event: { event: string }) => event.event === 'progress'),
    );
    const probe = JSON.parse(
      runTool('ffprobe', [
        '-v',
        'error',
        '-count_frames',
        '-show_streams',
        '-show_format',
        '-of',
        'json',
        output,
      ]),
    );
    const video = probe.streams.find(
      (s: { codec_type: string }) => s.codec_type === 'video',
    );
    const audio = probe.streams.find(
      (s: { codec_type: string }) => s.codec_type === 'audio',
    );
    assert.equal(probe.streams.length, 2);
    assert.equal(video.codec_name, 'h264');
    assert.equal(Number(video.nb_read_frames), report.frameCount);
    assert.equal(audio.codec_name, 'aac');
    assert.equal(audio.sample_rate, '48000');
    assert.equal(audio.channels, 2);
    assert.equal(Number(audio.start_time), 0);
    assert.ok(
      Math.abs(Number(audio.duration) - report.durationSeconds) < 0.0011,
    );
    assert.ok(
      Math.abs(Number(video.duration) - Number(audio.duration)) < 0.0011,
    );
    const samples = pcm(output);
    // AAC decoding may expose up to one padded 1024-sample packet at EOF.
    assert.ok(
      Math.abs(samples.length - Math.round(report.durationSeconds * 48000)) <
        1024,
    );
    return { output, report, samples };
  };
  try {
    await t.test(
      'mixes original audio with two simultaneous tracks, retains silence and extends black video',
      async () => {
        let project = add(example(), 'v', 'asset0', 'video', 15, 0, 60);
        project = add(project, 'bg', 'asset3', 'music', 30, 15, 75, 0.4);
        project = add(project, 'second', 'asset1', 'other', 45, 0, 30, 0.5);
        const { samples, report, output } = await render(project, 'overlap');
        assert.equal(report.frameCount, 90);
        assert.ok(rms(samples, 0.2) < 0.00001, 'leading silence');
        assert.ok(tone(samples, 1000, 0.54) > 0.06, 'original video audio');
        assert.ok(tone(samples, 880, 1.25) > 0.035, 'independent music');
        for (const [hz, minimum] of [
          [1000, 0.06],
          [880, 0.035],
          [440, 0.035],
        ]) {
          assert.ok(tone(samples, hz!, 1.54) > minimum!, `mixed ${hz} Hz`);
        }
        assert.ok(
          tone(samples, 880, 2.7) > 0.035,
          'music continues after video',
        );
        const black = spawnSync('ffmpeg', [
          '-v',
          'error',
          '-i',
          output,
          '-vf',
          'select=eq(n\\,80)',
          '-frames:v',
          '1',
          '-an',
          '-pix_fmt',
          'rgb24',
          '-f',
          'rawvideo',
          'pipe:1',
        ]);
        assert.equal(black.status, 0, black.stderr.toString());
        assert.equal(black.stdout.length, 160 * 90 * 3);
        assert.ok(
          black.stdout.every((n) => n <= 2),
          'audio tail has black video',
        );
      },
    );

    await t.test(
      'uses stable linear gains, mute overrides volume, and missing video audio is silence',
      async () => {
        const base = add(
          add(example(), 'v', 'asset2', 'video', 0, 0, 60),
          'bg',
          'asset3',
          'music',
          0,
          0,
          60,
        );
        const full = await render(base, 'gain-full');
        const half = await render(
          setClipAudio(base, 'bg', { volume: 0.5 }).project,
          'gain-half',
        );
        const ratio = rms(half.samples, 0.4, 0.2) / rms(full.samples, 0.4, 0.2);
        assert.ok(Math.abs(ratio - 0.5) < 0.03, `half gain ratio ${ratio}`);
        const pair = add(
          setClipAudio(base, 'bg', { volume: 0.25 }).project,
          'bg2',
          'asset3',
          'other',
          0,
          0,
          60,
          0.25,
        );
        const mixed = await render(pair, 'gain-pair');
        assert.ok(
          Math.abs(
            rms(mixed.samples, 0.4, 0.2) / rms(half.samples, 0.4, 0.2) - 1,
          ) < 0.03,
          'mix does not normalize active inputs',
        );
        for (const [name, options] of [
          ['muted', { muted: true }],
          ['zero', { volume: 0 }],
        ] as const) {
          const silent = await render(
            setClipAudio(base, 'bg', options).project,
            name,
          );
          assert.ok(rms(silent.samples, 0.4, 0.2) < 0.00001, name);
        }
        const original = add(example(), 'v', 'asset0', 'video', 0, 0, 60);
        const muted = await render(
          setClipAudio(original, 'v', { muted: true }).project,
          'original-muted',
        );
        assert.ok(rms(muted.samples, 0.03) < 0.00001, 'video audio mute');
        const silent = await render(
          add(example(), 'v', 'asset2', 'video', 0, 0, 30),
          'no-audio',
        );
        assert.ok(rms(silent.samples, 0.1) < 0.00001, 'no-audio asset');
      },
    );

    await t.test(
      'preserves trim/split synchronization and interior gaps with visual/audio markers',
      async () => {
        let project = add(example(), 'v', 'asset0', 'video', 9, 0, 90);
        project = trimClip(project, 'v', {
          sourceIn: frameTime(15, rate),
          sourceOut: frameTime(75, rate),
        }).project;
        const whole = await render(project, 'sync-whole');
        project = splitClip(project, 'v', frameTime(30, rate), 'right').project;
        const split = await render(project, 'sync-split');
        assert.equal(split.report.frameCount, 69);
        for (const start of [0.05, 0.4, 0.65, 1.3, 1.65, 2.1])
          assert.ok(rms(split.samples, start) < 0.001, `silent at ${start}`);
        for (const start of [0.82, 1.82]) {
          assert.ok(rms(split.samples, start) > 0.04, `pulse at ${start}`);
          assert.ok(
            Math.abs(rms(split.samples, start) - rms(whole.samples, start)) <
              0.001,
          );
        }
        const visual = spawnSync('ffmpeg', [
          '-v',
          'error',
          '-i',
          split.output,
          '-vf',
          'crop=4:4:1:1,format=gray',
          '-an',
          '-f',
          'rawvideo',
          'pipe:1',
        ]);
        assert.equal(visual.status, 0, visual.stderr.toString());
        for (const n of [24, 54]) {
          const frame = visual.stdout.subarray(n * 16, (n + 1) * 16);
          assert.ok(
            frame.reduce((sum, value) => sum + value, 0) / 16 > 240,
            `visual flash at ${n}`,
          );
        }
        let gaps = add(example(), 'v', 'asset2', 'video', 0, 0, 60);
        gaps = add(gaps, 'a', 'asset3', 'music', 6, 15, 24);
        gaps = add(gaps, 'b', 'asset3', 'music', 36, 0, 9);
        const result = await render(gaps, 'audio-gaps');
        for (const start of [0.05, 0.7, 1.7])
          assert.ok(rms(result.samples, start) < 0.00001);
        for (const start of [0.25, 1.25])
          assert.ok(tone(result.samples, 880, start) > 0.08);

        // A separately placed audio-track clip must use the same trimmed source
        // mapping as original video audio, including after an independent split.
        let independent = add(
          example(),
          'silent-video',
          'asset2',
          'video',
          0,
          0,
          60,
        );
        independent = add(independent, 'sound', 'asset0', 'music', 9, 0, 90);
        independent = trimClip(independent, 'sound', {
          sourceIn: frameTime(15, rate),
          sourceOut: frameTime(75, rate),
        }).project;
        independent = splitClip(
          independent,
          'sound',
          frameTime(30, rate),
          'sound-right',
        ).project;
        const audioTrack = await render(independent, 'audio-track-sync');
        for (const start of [0.82, 1.82])
          assert.ok(rms(audioTrack.samples, start) > 0.04);
        for (const start of [0.4, 0.65, 1.3, 2.1])
          assert.ok(rms(audioTrack.samples, start) < 0.001);
      },
    );

    await t.test(
      'keeps fractional-rate one-frame audio splits aligned without cumulative drift',
      async () => {
        const fractional = { numerator: 30000, denominator: 1001 };
        let project = add(
          example(fractional),
          'v',
          'asset0',
          'video',
          2,
          7,
          67,
        );
        const whole = await render(project, 'fraction-whole');
        for (let n = 1; n < 60; n++)
          project = splitClip(
            project,
            n === 1 ? 'v' : `p${n - 1}`,
            frameTime(n + 2, fractional),
            `p${n}`,
          ).project;
        const split = await render(project, 'fraction-split');
        assert.equal(split.report.frameCount, 62);
        let difference = 0;
        const length = Math.min(
          whole.samples.length,
          split.samples.length,
          96000,
        );
        for (let i = 0; i < length; i++)
          difference += (whole.samples[i]! - split.samples[i]!) ** 2;
        assert.ok(
          Math.sqrt(difference / length) < 0.002,
          'fractional audio remains equivalent',
        );
        assert.ok(
          rms(split.samples, 0.86) > 0.04,
          'pulse follows source trim and timeline position without drift',
        );
      },
    );

    await t.test(
      'preserves relative stream delays and nonzero container timestamps after trimming',
      async () => {
        const delayed = join(directory, 'delayed-source.mp4');
        runTool('ffmpeg', [
          '-v',
          'error',
          '-nostdin',
          '-n',
          '-i',
          join(generated, 'video-medium.mp4'),
          '-itsoffset',
          '0.25',
          '-i',
          join(generated, 'audio-tone.wav'),
          '-map',
          '0:v:0',
          '-map',
          '1:a:0',
          '-c',
          'copy',
          '-t',
          '3',
          '-output_ts_offset',
          '5',
          delayed,
        ]);
        let project = add(example(), 'v', 'asset0', 'video', 3, 0, 30);
        project.assets[0]!.file = { type: 'absolute', path: delayed };
        const result = await render(project, 'delayed');
        assert.ok(rms(result.samples, 0.15) < 0.00001, 'audio delay is silent');
        assert.ok(
          tone(result.samples, 880, 0.4) > 0.08,
          'delayed audio begins at timeline 0.35',
        );
        project = trimClip(project, 'v', {
          sourceIn: frameTime(6, rate),
        }).project;
        const trimmed = await render(project, 'delayed-trim');
        assert.ok(
          rms(trimmed.samples, 0.105, 0.025) < 0.00001,
          'remaining 50 ms delay',
        );
        assert.ok(tone(trimmed.samples, 880, 0.2) > 0.08);

        const early = join(directory, 'early-source.mov');
        runTool('ffmpeg', [
          '-v',
          'error',
          '-nostdin',
          '-n',
          '-itsoffset',
          '0.2',
          '-i',
          join(generated, 'video-medium.mp4'),
          '-i',
          join(generated, 'audio-tone.wav'),
          '-map',
          '0:v:0',
          '-map',
          '1:a:0',
          '-c:v',
          'copy',
          '-c:a',
          'pcm_s16le',
          '-af',
          'atrim=duration=0.4,aresample=44100',
          '-output_ts_offset',
          '5',
          early,
        ]);
        project = add(example(), 'v', 'asset0', 'video', 3, 0, 30);
        project.assets[0]!.file = { type: 'absolute', path: early };
        const short = await render(project, 'early-short-audio');
        assert.ok(
          tone(short.samples, 880, 0.13) > 0.08,
          'early audio is trimmed to video origin and resampled from 44.1 kHz',
        );
        assert.ok(
          rms(short.samples, 0.5) < 0.00001,
          'short original audio pads with silence',
        );
      },
    );

    await t.test(
      'rejects stale audio bounds and audio tracks whose source lost its stream',
      async () => {
        for (const missing of [false, true]) {
          let project = add(example(), 'v', 'asset2', 'video', 0, 0, 30);
          project = add(
            project,
            'bg',
            'asset3',
            'music',
            0,
            0,
            missing ? 30 : 150,
          );
          if (missing) project.assets[3]!.file.path = '../video-short.mp4';
          await writeFile(path, serializeProject(project));
          const result = spawnSync(
            process.execPath,
            [
              entry,
              'project',
              'render',
              path,
              '--output',
              join(directory, 'invalid.mp4'),
            ],
            { encoding: 'utf8' },
          );
          assert.equal(result.status, 1);
          assert.match(
            result.stderr,
            missing ? /requires an audio stream/ : /current audio duration/,
          );
          await assert.rejects(readFile(join(directory, 'invalid.mp4')));
        }
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    assert.deepEqual(
      await Promise.all(fixtures.map((file) => hash(join(generated, file)))),
      before,
      'Source fixtures changed',
    );
  }
});

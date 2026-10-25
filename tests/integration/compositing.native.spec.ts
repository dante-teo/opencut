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
  splitClip,
} from '@opencut/core';
import type { ClipVisualOptions, Project } from '@opencut/core';
import { requireTool, runTool } from '../../scripts/fixture-lib.js';

const entry = fileURLToPath(
  new URL('../../apps/cli/dist/index.js', import.meta.url),
);
const generated = fileURLToPath(
  new URL('../fixtures/generated/', import.meta.url),
);
const rate = { numerator: 30, denominator: 1 };
const hash = async (file: string) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
function decode(file: string, audio = false): Buffer {
  const result = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-nostdin',
      '-xerror',
      '-i',
      file,
      ...(audio
        ? ['-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le']
        : ['-an', '-pix_fmt', 'rgb24', '-f', 'rawvideo']),
      'pipe:1',
    ],
    { maxBuffer: 32 * 1024 * 1024, timeout: 60000 },
  );
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(result.stderr.length, 0);
  return result.stdout;
}
function pixel(
  bytes: Buffer,
  width: number,
  height: number,
  frame: number,
  x: number,
  y: number,
  expected: number[],
) {
  const offset = ((frame * height + y) * width + x) * 3;
  const actual = [...bytes.subarray(offset, offset + 3)];
  assert.equal(actual.length, 3);
  assert.ok(
    actual.every((value, i) => Math.abs(value - expected[i]!) < 12),
    `frame ${frame}, (${x},${y}): ${actual} expected ${expected}`,
  );
}
function tone(bytes: Buffer, hz: number, seconds: number): number {
  const start = Math.round(seconds * 48000);
  const count = 4800;
  let real = 0,
    imaginary = 0;
  for (let i = 0; i < count; i++) {
    const value = bytes.readFloatLE((start + i) * 4);
    real += value * Math.cos((2 * Math.PI * hz * i) / 48000);
    imaginary += value * Math.sin((2 * Math.PI * hz * i) / 48000);
  }
  return (2 * Math.hypot(real, imaginary)) / count;
}
function add(
  project: Project,
  id: string,
  assetId: string,
  trackId: string,
  at: number,
  sourceIn: number,
  sourceOut: number,
  visual?: ClipVisualOptions,
) {
  const time = (frame: number) => frameTime(frame, project.settings.frameRate);
  return addClip(project, {
    id,
    assetId,
    trackId,
    timelineStart: time(at),
    sourceIn: time(sourceIn),
    sourceOut: time(sourceOut),
    volume: 0.5,
    ...(visual ? { visual } : {}),
  }).project;
}

test('native T12 visual compositing through the built CLI', async (t) => {
  requireTool('ffmpeg');
  requireTool('ffprobe');
  const directory = await mkdtemp(join(generated, 't12-'));
  const projectFile = join(directory, 'project.json');
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [entry, ...args], {
      encoding: 'utf8',
      timeout: 120000,
    });
  const names = [
    'red.mp4',
    'blue.mp4',
    'alpha.png',
    'bars.mp4',
    'alpha.mov',
    'anamorphic.mp4',
  ];
  const generate = (...args: string[]) =>
    runTool('ffmpeg', ['-v', 'error', '-nostdin', '-n', ...args]);
  try {
    for (const [color, hz] of [
      ['red', 440],
      ['blue', 880],
    ] as const)
      generate(
        '-f',
        'lavfi',
        '-i',
        `color=c=${color}:s=160x90:r=30:d=1`,
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=${hz}:sample_rate=48000:duration=1`,
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        join(directory, `${color}.mp4`),
      );
    generate(
      '-f',
      'lavfi',
      '-i',
      "nullsrc=s=80x40,format=rgba,geq=r=255:g=255:b=255:a='if(lt(X,40),0,128)'",
      '-frames:v',
      '1',
      join(directory, 'alpha.png'),
    );
    generate(
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=160x90:r=30:d=1,drawbox=x=0:y=0:w=40:h=90:c=blue:t=fill,drawbox=x=120:y=0:w=40:h=90:c=lime:t=fill',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      join(directory, 'bars.mp4'),
    );
    generate(
      '-loop',
      '1',
      '-framerate',
      '30',
      '-i',
      join(directory, 'alpha.png'),
      '-t',
      '1',
      '-c:v',
      'qtrle',
      '-pix_fmt',
      'argb',
      join(directory, 'alpha.mov'),
    );
    generate(
      '-i',
      join(directory, 'bars.mp4'),
      '-vf',
      'setsar=2',
      '-an',
      '-c:v',
      'libx264',
      join(directory, 'anamorphic.mp4'),
    );
    const before = await Promise.all(
      names.map((name) => hash(join(directory, name))),
    );
    function example(width = 160, height = 90): Project {
      const project = createProject({
        name: 'T12 native composition',
        settings: {
          width,
          height,
          frameRate: rate,
          backgroundColor: '#123456',
        },
      });
      project.assets = names.map((name, i) => ({
        id: `a${i}`,
        name,
        mediaTypes: ['video'],
        file: { type: 'relative', path: name },
      }));
      project.tracks = [
        { id: 'base', name: 'Base', type: 'video' },
        { id: 'top', name: 'Top', type: 'video' },
      ];
      return project;
    }
    const render = async (project: Project, name: string) => {
      const snapshot = serializeProject(project);
      await writeFile(projectFile, snapshot);
      const output = join(directory, `${name}.mp4`);
      const result = run(
        'project',
        'render',
        projectFile,
        '--output',
        output,
        '--json',
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(await readFile(projectFile, 'utf8'), snapshot);
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
      const [video, audio] = probe.streams;
      assert.equal(probe.streams.length, 2);
      assert.equal(video.codec_name, 'h264');
      assert.equal(video.pix_fmt, 'yuv420p');
      assert.equal(video.width, project.settings.width);
      assert.equal(video.height, project.settings.height);
      assert.equal(video.sample_aspect_ratio, '1:1');
      assert.equal(
        video.avg_frame_rate,
        `${report.frameRate.numerator}/${report.frameRate.denominator}`,
      );
      assert.equal(Number(video.nb_read_frames), report.frameCount);
      assert.equal(Number(video.start_time), 0);
      assert.equal(audio.codec_name, 'aac');
      assert.equal(audio.sample_rate, '48000');
      assert.equal(audio.channels, 2);
      assert.equal(Number(audio.start_time), 0);
      assert.ok(
        Math.abs(Number(video.duration) - report.durationSeconds) < 0.000002,
      );
      assert.ok(
        Math.abs(Number(audio.duration) - report.durationSeconds) < 0.0011,
      );
      const bytes = decode(output);
      assert.equal(
        bytes.length,
        report.frameCount * video.width * video.height * 3,
      );
      return { bytes, output, report };
    };
    await t.test(
      'overlapping video tracks, position, scale, exclusive boundaries and reversed track ordering',
      async () => {
        let project = add(example(), 'red', 'a0', 'base', 0, 0, 30);
        project = add(project, 'blue', 'a1', 'top', 6, 0, 12, {
          scale: 0.5,
          x: 30,
          y: -10,
          fit: 'stretch',
        });
        project.clips.reverse();
        const { bytes } = await render(project, 'layering');
        for (const n of [0, 5, 18, 29])
          pixel(bytes, 160, 90, n, 110, 30, [255, 0, 0]);
        for (const n of [6, 17]) {
          pixel(bytes, 160, 90, n, 110, 30, [0, 0, 255]);
          pixel(bytes, 160, 90, n, 20, 30, [255, 0, 0]);
          pixel(bytes, 160, 90, n, 110, 70, [255, 0, 0]);
        }
        project.tracks.reverse();
        const reversed = await render(project, 'reversed');
        pixel(reversed.bytes, 160, 90, 10, 110, 30, [255, 0, 0]);
      },
    );
    await t.test(
      'opacity blends video and overlapping original audio is mixed once per clip with unchanged gains',
      async () => {
        let project = add(example(), 'red', 'a0', 'base', 0, 0, 30);
        const base = await render(project, 'audio-base');
        project = add(project, 'blue', 'a1', 'top', 6, 0, 12, { opacity: 0.5 });
        const blended = await render(project, 'opacity');
        pixel(blended.bytes, 160, 90, 10, 80, 40, [127, 0, 127]);
        pixel(blended.bytes, 160, 90, 18, 80, 40, [255, 0, 0]);
        const baseline = decode(base.output, true),
          mixed = decode(blended.output, true);
        const amplitude = tone(baseline, 440, 0.3);
        assert.ok(amplitude > 0.02);
        assert.ok(
          Math.abs(tone(mixed, 440, 0.3) / amplitude - 1) < 0.05,
          'Original audio gain must not double',
        );
        assert.ok(tone(mixed, 880, 0.3) > 0.02);
        assert.ok(tone(mixed, 880, 0.7) < 0.002);
        project.clips[1]!.visual!.opacity = 0;
        const transparent = await render(project, 'zero-opacity');
        pixel(transparent.bytes, 160, 90, 10, 80, 40, [255, 0, 0]);
        assert.ok(
          tone(decode(transparent.output, true), 880, 0.3) > 0.02,
          'Visual opacity must not mute audio',
        );
      },
    );
    await t.test(
      'transparent and partially transparent PNG duration, source range, opacity multiplication and splits',
      async () => {
        let project = add(example(), 'red', 'a0', 'base', 0, 0, 30);
        project = add(project, 'image', 'a2', 'top', 5, 90, 96, {
          fit: 'stretch',
          scale: 0.5,
        });
        project = splitClip(
          project,
          'image',
          frameTime(8, rate),
          'image-right',
        ).project;
        const result = await render(project, 'image');
        for (const n of [4, 11])
          pixel(result.bytes, 160, 90, n, 100, 45, [255, 0, 0]);
        for (const n of [5, 7, 8, 10]) {
          pixel(result.bytes, 160, 90, n, 55, 45, [255, 0, 0]);
          pixel(result.bytes, 160, 90, n, 100, 45, [255, 128, 128]);
        }
        project.clips
          .filter((clip) => clip.assetId === 'a2')
          .forEach((clip) => {
            clip.visual!.opacity = 0.5;
          });
        const faded = await render(project, 'image-opacity');
        pixel(faded.bytes, 160, 90, 6, 100, 45, [255, 64, 64]);
      },
    );
    await t.test(
      'alpha-bearing video overlays and non-square source pixel normalization',
      async () => {
        let project = add(example(), 'red', 'a0', 'base', 0, 0, 30);
        project = add(project, 'alpha-video', 'a4', 'top', 6, 2, 8, {
          opacity: 0.5,
        });
        const alpha = await render(project, 'alpha-video');
        pixel(alpha.bytes, 160, 90, 6, 120, 45, [255, 64, 64]);
        pixel(alpha.bytes, 160, 90, 11, 30, 45, [255, 0, 0]);
        pixel(alpha.bytes, 160, 90, 12, 120, 45, [255, 0, 0]);
        const squarePixels = await render(
          add(example(100, 100), 'normal', 'a3', 'base', 0, 0, 3),
          'normal-sar',
        );
        const anamorphic = await render(
          add(example(100, 100), 'wide', 'a5', 'base', 0, 0, 3),
          'anamorphic-render',
        );
        pixel(squarePixels.bytes, 100, 100, 1, 50, 30, [255, 0, 0]);
        pixel(anamorphic.bytes, 100, 100, 1, 50, 30, [18, 52, 86]);
        pixel(anamorphic.bytes, 100, 100, 1, 50, 50, [255, 0, 0]);
      },
    );
    await t.test(
      'portrait, landscape and square canvases with contain, cover and stretch',
      async () => {
        for (const [width, height] of [
          [90, 160],
          [160, 90],
          [100, 100],
        ] as const) {
          for (const fit of ['contain', 'cover', 'stretch'] as const) {
            const project = add(
              example(width, height),
              'bars',
              'a3',
              'base',
              1,
              0,
              3,
              { fit },
            );
            const { bytes } = await render(
              project,
              `aspect-${width}-${height}-${fit}`,
            );
            pixel(bytes, width, height, 0, 4, 4, [18, 52, 86]);
            pixel(
              bytes,
              width,
              height,
              1,
              Math.floor(width / 2),
              Math.floor(height / 2),
              [255, 0, 0],
            );
            if (height >= width) {
              pixel(
                bytes,
                width,
                height,
                1,
                15,
                4,
                fit === 'contain'
                  ? [18, 52, 86]
                  : fit === 'cover'
                    ? [255, 0, 0]
                    : [0, 0, 255],
              );
            }
          }
        }
      },
    );
    await t.test(
      'fractional-rate one-frame image overlay, background gaps and audio tail',
      async () => {
        const project = example();
        project.settings.frameRate = { numerator: 30000, denominator: 1001 };
        project.tracks.push({ id: 'audio', name: 'Audio tail', type: 'audio' });
        project.assets[0]!.mediaTypes.push('audio');
        let p = add(project, 'image', 'a2', 'top', 1, 50, 51, {
          fit: 'stretch',
        });
        p = add(p, 'audio-tail', 'a0', 'audio', 4, 0, 2);
        const { bytes, report } = await render(p, 'fractional-image');
        assert.equal(report.frameCount, 6);
        for (const n of [0, 2, 3, 4, 5])
          pixel(bytes, 160, 90, n, 120, 45, [18, 52, 86]);
        pixel(bytes, 160, 90, 1, 120, 45, [137, 154, 171]);
      },
    );
    await t.test(
      'image import and visual/canvas CLI mutations preserve history, dry run and undo',
      async () => {
        const initial = example();
        initial.assets = initial.assets.filter((asset) => asset.id !== 'a2');
        await writeFile(projectFile, serializeProject(initial));
        const imported = run(
          'media',
          'import',
          projectFile,
          join(directory, 'alpha.png'),
          '--json',
        );
        assert.equal(imported.status, 0, imported.stderr);
        const asset = JSON.parse(imported.stdout).asset;
        assert.equal(asset.metadata.kind, 'image');
        const added = run(
          'clip',
          'add',
          projectFile,
          asset.id,
          '--track',
          'top',
          '--at',
          '3',
          '--in',
          '0',
          '--out',
          '12',
          '--scale',
          '0.5',
          '--json',
        );
        assert.equal(added.status, 0, added.stderr);
        const id = JSON.parse(added.stdout).clip.id;
        let result = run(
          'clip',
          'visual',
          projectFile,
          id,
          '--x=-20',
          '--opacity',
          '0.5',
          '--json',
        );
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout).clip.visual, {
          x: -20,
          scale: 0.5,
          opacity: 0.5,
        });
        const beforeCanvas = await readFile(projectFile, 'utf8');
        result = run(
          'canvas',
          'set',
          projectFile,
          '--width',
          '90',
          '--height',
          '160',
          '--background-color',
          '#ABCDEF',
          '--dry-run',
          '--json',
        );
        assert.equal(result.status, 0, result.stderr);
        assert.equal(await readFile(projectFile, 'utf8'), beforeCanvas);
        result = run(
          'canvas',
          'set',
          projectFile,
          '--width',
          '90',
          '--height',
          '160',
          '--background-color',
          '#ABCDEF',
          '--json',
        );
        assert.equal(result.status, 0, result.stderr);
        const configured = JSON.parse(await readFile(projectFile, 'utf8'));
        assert.equal(configured.settings.backgroundColor, '#ABCDEF');
        result = run('edit', 'undo', projectFile, '--json');
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(
          JSON.parse(await readFile(projectFile, 'utf8')).settings,
          example().settings,
        );
      },
    );
    assert.deepEqual(
      await Promise.all(names.map((name) => hash(join(directory, name)))),
      before,
      'Fixture sources changed',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

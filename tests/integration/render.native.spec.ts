import {
  addFixtureClip,
  renderFixture,
  splitFixtureClip,
} from './render-fixture.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createProject, frameTime } from '@opencut/core';
import type { FrameRate, Project } from '@opencut/core';
import { requireTool, runTool } from '../../scripts/fixture-lib.js';

const generated = fileURLToPath(
  new URL('../fixtures/generated/', import.meta.url),
);
const hash = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
const width = 160;
const height = 90;
const frameBytes = width * height * 3;
const rate30 = { numerator: 30, denominator: 1 };

function example(rate: FrameRate = rate30): Project {
  const project = createProject({
    name: 'T10 native render',
    settings: { width, height, frameRate: rate },
  });
  project.assets = [
    'video-medium.mp4',
    'video-long.mp4',
    'video-short.mp4',
    'still.png',
  ].map((name, i) => ({
    id: `asset${i}`,
    name,
    mediaTypes: ['video'],
    file: { type: 'relative', path: `../${name}` },
  }));
  project.tracks = [{ id: 'video', name: 'Video', type: 'video' }];
  return project;
}
function add(
  project: Project,
  id: string,
  assetId: string,
  at: number,
  sourceIn: number,
  sourceOut: number,
) {
  const time = (n: number) => frameTime(n, project.settings.frameRate);
  return addFixtureClip(project, {
    id,
    assetId,
    trackId: 'video',
    timelineStart: time(at),
    sourceIn: time(sourceIn),
    sourceOut: time(sourceOut),
  });
}
function pixels(file: string, filter?: string): Buffer {
  const result = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-nostdin',
      '-xerror',
      '-i',
      file,
      '-an',
      ...(filter ? ['-vf', filter] : []),
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      'pipe:1',
    ],
    { maxBuffer: 64 * 1024 * 1024, timeout: 60000 },
  );
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(result.stderr.length, 0);
  return result.stdout;
}
function frame(buffer: Buffer, n: number): Buffer {
  return buffer.subarray(n * frameBytes, (n + 1) * frameBytes);
}
function close(actual: Buffer, expected: Buffer, label: string): void {
  assert.equal(actual.length, expected.length, label);
  assert.ok(actual.length > 0, label);
  let error = 0;
  for (let i = 0; i < actual.length; i++)
    error += Math.abs(actual[i]! - expected[i]!);
  assert.ok(
    // T26 composes in RGB before tagged BT.709 H.264. The additional chroma
    // conversion allows <6/255 versus the directly decoded source reference.
    error / actual.length < 6,
    `${label}: mean pixel error ${error / actual.length}`,
  );
}
const fit = `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;

// Independently probe and decode every output.
test('native T10 saved timeline rendering', async (t) => {
  requireTool('ffmpeg');
  requireTool('ffprobe');
  const files = [
    'video-medium.mp4',
    'video-long.mp4',
    'video-short.mp4',
    'still.png',
  ];
  const before = await Promise.all(
    files.map((file) => hash(join(generated, file))),
  );
  const directory = await mkdtemp(join(generated, 't10-'));
  const projectFile = join(directory, 'project.json');
  const render = async (
    project: Project,
    name: string,
    location = projectFile,
  ) => {
    const snapshot = structuredClone(project);
    const output = join(directory, name);
    const report = await renderFixture(project, location, output);
    assert.deepEqual(project, snapshot);
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
    assert.equal(probe.streams.length, 2);
    assert.equal(probe.streams[1].codec_name, 'aac');
    const video = probe.streams[0];
    assert.equal(video.codec_name, 'h264');
    assert.equal(video.width, width);
    assert.equal(video.height, height);
    assert.equal(Number(video.nb_read_frames), report.frameCount);
    assert.ok(
      Math.abs(Number(video.duration) - report.durationSeconds) < 0.000002,
    );
    assert.ok(
      Math.abs(Number(probe.format.duration) - report.durationSeconds) < 0.0011,
    );
    assert.equal(
      video.avg_frame_rate,
      `${report.frameRate.numerator}/${report.frameRate.denominator}`,
    );
    return { output, report, decoded: pixels(output), probe };
  };
  try {
    await t.test(
      'renders sorted, trimmed, split clips and exact black-gap boundaries at different source rates',
      async () => {
        let project = add(example(), 'first', 'asset0', 5, 7, 50);
        Object.assign(
          project.clips.find((clip) => clip.id === 'first')!,
          {
            sourceOut: frameTime(47, rate30),
          },
        );
        splitFixtureClip(project, 'first', frameTime(18, rate30), 'right');
        project = add(project, 'long', 'asset1', 52, 10, 40);
        project = add(project, 'short', 'asset2', 82, 0, 15);
        project.clips.reverse();
        const { decoded, report } = await render(project, 'ordered.mp4');
        assert.equal(report.frameCount, 97);
        assert.equal(decoded.length, 97 * frameBytes);
        for (const n of [0, 4, 45, 51])
          assert.ok(
            frame(decoded, n).every((v) => v <= 2),
            `Gap frame ${n}`,
          );
        // At matching rates compare directly to independently decoded original source
        // frame indices: in=7, exclusive out=47, split at output frame 18.
        const medium = pixels(join(generated, 'video-medium.mp4'), fit);
        for (const n of [5, 17, 18, 44])
          close(
            frame(decoded, n),
            frame(medium, n + 2),
            `Trim/split frame ${n}`,
          );
        const long = pixels(join(generated, 'video-long.mp4'), `${fit},fps=30`);
        for (const n of [52, 81])
          close(frame(decoded, n), frame(long, n - 42), `Second clip ${n}`);
        const short = pixels(
          join(generated, 'video-short.mp4'),
          `${fit},fps=30`,
        );
        for (const n of [82, 96])
          close(frame(decoded, n), frame(short, n - 82), `Third clip ${n}`);
        await assert.rejects(
          renderFixture(project, projectFile, join(directory, 'ordered.mp4')),
          /overwrite/,
        );
      },
    );

    await t.test(
      'keeps 32 one-frame split clips equivalent to one clip at 30000/1001 without timestamp drift',
      async () => {
        const rate = { numerator: 30000, denominator: 1001 };
        const whole = add(example(rate), 'whole', 'asset2', 0, 9, 41);
        const unsplit = await render(whole, 'whole.mp4');
        const split = structuredClone(whole);
        for (let i = 1; i < 32; i++)
          splitFixtureClip(
            split,
            i === 1 ? 'whole' : `part${i - 1}`,
            frameTime(i, rate),
            `part${i}`,
          );
        const result = await render(split, 'split.mp4');
        assert.equal(result.report.frameCount, 32);
        assert.equal(result.report.durationSeconds, (32 * 1001) / 30000);
        for (let i = 0; i < 32; i++)
          close(
            frame(result.decoded, i),
            frame(unsplit.decoded, i),
            `Fractional split frame ${i}`,
          );
        const timestamps = JSON.parse(
          runTool('ffprobe', [
            '-v',
            'error',
            '-select_streams',
            'v:0',
            '-show_frames',
            '-show_entries',
            'frame=pts',
            '-of',
            'json',
            result.output,
          ]),
        ).frames;
        for (let i = 0; i < 32; i++) assert.equal(timestamps[i].pts, i * 1001);
      },
    );

    await t.test(
      'renders one-frame clips at the supported 1/120 fps extremes',
      async () => {
        for (const fps of [1, 120]) {
          const project = add(
            example({ numerator: fps, denominator: 1 }),
            'single',
            'asset2',
            0,
            0,
            1,
          );
          const result = await render(project, `one-frame-${fps}.mp4`);
          assert.equal(result.report.frameCount, 1);
          assert.equal(result.decoded.length, frameBytes);
        }
      },
    );

    await t.test(
      'normalizes nonzero video timestamps and preserves fractional-rate gaps',
      async () => {
        const delayed = join(directory, 'offset.mp4');
        runTool('ffmpeg', [
          '-v',
          'error',
          '-nostdin',
          '-n',
          '-i',
          join(generated, 'video-medium.mp4'),
          '-map',
          '0:v:0',
          '-c',
          'copy',
          '-output_ts_offset',
          '5',
          delayed,
        ]);
        const rate = { numerator: 24000, denominator: 1001 };
        const project = add(
          add(example(rate), 'one', 'asset0', 1, 2, 7),
          'two',
          'asset0',
          9,
          11,
          17,
        );
        const normal = await render(project, 'normal.mp4');
        project.assets[0]!.file = { type: 'absolute', path: delayed };
        const offset = await render(project, 'offset-render.mp4');
        assert.equal(offset.report.frameCount, 15);
        close(offset.decoded, normal.decoded, 'Nonzero source timestamps');
        for (const n of [0, 6, 7, 8])
          assert.ok(frame(offset.decoded, n).every((v) => v <= 2));
      },
    );

    await t.test(
      'rejects missing media, stale bounds and invalid data without outputs',
      async () => {
        const base = add(example(), 'clip', 'asset0', 0, 0, 30);
        const cases: Array<[Project, RegExp]> = [];
        let p = structuredClone(base);
        p.assets[0]!.file.path = 'missing.mp4';
        cases.push([p, /clip.*cannot read\/probe.*Restore/i]);
        p = structuredClone(base);
        p.clips[0]!.sourceOut = frameTime(1000, rate30);
        cases.push([p, /current video duration/]);
        p = structuredClone(base);
        p.settings.width = 161;
        cases.push([p, /even dimensions/]);
        p = structuredClone(base);
        p.clips.push({ ...p.clips[0]!, id: 'overlap' });
        cases.push([p, /overlaps/]);
        for (const [index, [project, error]] of cases.entries()) {
          const output = join(directory, `invalid${index}.mp4`);
          await assert.rejects(
            renderFixture(project, projectFile, output),
            error,
          );
          assert.ok(
            !(await readdir(directory)).includes(`invalid${index}.mp4`),
          );
        }
        assert.ok(
          !(await readdir(directory)).some((name) =>
            name.startsWith('.opencut-render-'),
          ),
        );
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    assert.deepEqual(
      await Promise.all(files.map((file) => hash(join(generated, file)))),
      before,
      'Original fixtures changed',
    );
  }
});

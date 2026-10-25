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
import {
  addClip,
  createProject,
  frameTime,
  serializeProject,
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
  return addClip(project, {
    id,
    assetId,
    trackId: 'video',
    timelineStart: time(at),
    sourceIn: time(sourceIn),
    sourceOut: time(sourceOut),
  }).project;
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
    error / actual.length < 5,
    `${label}: mean pixel error ${error / actual.length}`,
  );
}
const fit = `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;

// Every subtest invokes the built standalone CLI and independently probes/decodes its output.
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
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [entry, ...args], {
      encoding: 'utf8',
      cwd: directory,
      timeout: 120000,
    });
  const render = async (
    project: Project,
    name: string,
    location = projectFile,
  ) => {
    await writeFile(projectFile, serializeProject(project));
    const snapshot = await readFile(projectFile, 'utf8');
    const output = join(directory, name);
    const result = run(
      'project',
      'render',
      location,
      '--output',
      output,
      '--json',
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(await readFile(projectFile, 'utf8'), snapshot);
    const report = JSON.parse(result.stdout);
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
        project = trimClip(project, 'first', {
          sourceOut: frameTime(47, rate30),
        }).project;
        project = splitClip(
          project,
          'first',
          frameTime(18, rate30),
          'right',
        ).project;
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
        const repeated = run(
          'project',
          'render',
          projectFile,
          '--output',
          join(directory, 'ordered.mp4'),
        );
        assert.equal(repeated.status, 1);
        assert.match(repeated.stderr, /overwrite/);
      },
    );

    await t.test(
      'keeps 32 one-frame split clips equivalent to one clip at 30000/1001 without timestamp drift',
      async () => {
        const rate = { numerator: 30000, denominator: 1001 };
        const whole = add(example(rate), 'whole', 'asset2', 0, 9, 41);
        const unsplit = await render(whole, 'whole.mp4');
        let split = whole;
        for (let i = 1; i < 32; i++)
          split = splitClip(
            split,
            i === 1 ? 'whole' : `part${i - 1}`,
            frameTime(i, rate),
            `part${i}`,
          ).project;
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
      'uses the physical project directory through an alias, ignoring unused offline assets',
      async () => {
        const alias = join(directory, 'alias');
        await symlink(directory, alias, 'dir');
        const project = add(example(), 'clip', 'asset0', 0, 0, 2);
        project.assets.push({
          id: 'offline',
          name: 'Unused',
          mediaTypes: ['video'],
          file: { type: 'relative', path: 'missing.mp4' },
        });
        const result = await render(
          project,
          'alias.mp4',
          join(alias, 'project.json'),
        );
        assert.equal(result.report.frameCount, 2);
        assert.equal(result.report.projectPath, projectFile);
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
      'rejects missing media, stale bounds, stills, invalid data and unsupported tracks without outputs',
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
        p.clips[0]!.assetId = 'asset3';
        cases.push([p, /timed video/]);
        p = structuredClone(base);
        p.tracks.push({ id: 'extra', name: 'Extra', type: 'video' });
        cases.push([p, /exactly one video track/]);
        p = structuredClone(base);
        p.settings.width = 161;
        cases.push([p, /even dimensions/]);
        p = structuredClone(base);
        p.clips.push({ ...p.clips[0]!, id: 'overlap' });
        cases.push([p, /overlaps/]);
        p = structuredClone(base);
        p.clips[0]!.sourceIn = { numerator: 1, denominator: 1000 };
        cases.push([p, /between project frames/]);
        for (const [index, [project, error]] of cases.entries()) {
          await writeFile(projectFile, JSON.stringify(project));
          const output = join(directory, `invalid${index}.mp4`);
          const result = run(
            'project',
            'render',
            projectFile,
            '--output',
            output,
            '--json',
          );
          assert.equal(result.status, 1, result.stderr);
          assert.equal(result.stdout, '');
          assert.match(result.stderr, error);
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

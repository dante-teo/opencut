import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
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
import {
  addClip,
  createProject,
  frameTime,
  serializeProject,
} from '@opencut/core';
import { renderProjectFile } from '@opencut/core/node';
import { requireTool, runTool } from '../../scripts/fixture-lib.js';

const entry = fileURLToPath(
  new URL('../../apps/cli/dist/index.js', import.meta.url),
);
const generated = fileURLToPath(
  new URL('../fixtures/generated/', import.meta.url),
);
const rate = { numerator: 30, denominator: 1 };
interface Event {
  event: string;
  phase?: string;
  percent?: number;
  processedFrames?: number;
  totalFrames?: number;
  elapsedSeconds?: number;
  remainingSeconds?: number | null;
  quality?: string;
  resolution?: string;
}
const events = (stdout: string): Event[] =>
  stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Event);
const hash = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
function example(source: string, width = 320, height = 180, frames = 30) {
  const project = createProject({
    name: 'T13 render jobs',
    settings: { width, height, frameRate: rate },
  });
  project.assets = [
    {
      id: 'asset',
      name: 'Source',
      mediaTypes: ['video'],
      file: { type: 'absolute', path: source },
    },
  ];
  project.tracks = [{ id: 'track', name: 'Visual', type: 'video' }];
  return addClip(project, {
    id: 'clip',
    assetId: 'asset',
    trackId: 'track',
    timelineStart: frameTime(0, rate),
    sourceIn: frameTime(0, rate),
    sourceOut: frameTime(frames, rate),
  }).project;
}

test('native T13 render jobs, progress, cancellation and publication', async (t) => {
  requireTool('ffmpeg');
  requireTool('ffprobe');
  const fixtures = ['video-medium.mp4', 'still.png'];
  const before = await Promise.all(
    fixtures.map((file) => hash(join(generated, file))),
  );
  const directory = await mkdtemp(join(generated, 't13-'));
  const projectFile = join(directory, 'project.json');
  const source = join(generated, fixtures[0]!);
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [entry, ...args], {
      encoding: 'utf8',
      timeout: 120000,
    });
  const clean = async () =>
    assert.ok(
      !(await readdir(directory)).some((name) =>
        name.startsWith('.opencut-render-'),
      ),
    );
  try {
    await t.test(
      'renders all quality/resolution presets with valid JSONL and independently decodable MP4s',
      async () => {
        for (const [
          quality,
          resolution,
          width,
          height,
          expectedWidth,
          expectedHeight,
        ] of [
          ['draft', '720p', 320, 180, 1280, 720],
          ['balanced', 'project', 320, 180, 320, 180],
          ['high', '1080p', 180, 320, 1080, 1920],
          ['draft', '720p', 1248, 702, 1280, 720],
          ['high', '1080p', 704, 396, 1920, 1080],
        ] as const) {
          const project = serializeProject(example(source, width, height));
          await writeFile(projectFile, project);
          const output = join(directory, `${quality}-${width}x${height}.mp4`);
          const result = run(
            'project',
            'render',
            projectFile,
            '--output',
            output,
            '--quality',
            quality,
            '--resolution',
            resolution,
            '--json',
          );
          assert.equal(result.status, 0, result.stderr);
          assert.equal(result.stderr, '');
          const lines = events(result.stdout);
          const progress = lines.filter((event) => event.event === 'progress');
          assert.ok(progress.length >= 3);
          assert.equal(progress[0]!.processedFrames, 0);
          assert.equal(progress.at(-1)!.phase, 'verifying');
          assert.equal(progress.at(-1)!.percent, 100);
          let previousFrames = 0;
          let previousElapsed = 0;
          for (const event of progress) {
            assert.ok(
              event.processedFrames! >= previousFrames &&
                event.processedFrames! <= 30,
            );
            assert.ok(event.elapsedSeconds! >= previousElapsed);
            assert.ok(
              event.remainingSeconds === null || event.remainingSeconds! >= 0,
            );
            assert.equal(event.percent, (event.processedFrames! / 30) * 100);
            previousFrames = event.processedFrames!;
            previousElapsed = event.elapsedSeconds!;
          }
          assert.equal(lines.at(-1)!.event, 'completed');
          assert.equal(lines.at(-1)!.quality, quality);
          assert.equal(lines.at(-1)!.resolution, resolution);
          const probe = JSON.parse(
            runTool('ffprobe', [
              '-v',
              'error',
              '-count_frames',
              '-show_streams',
              '-of',
              'json',
              output,
            ]),
          );
          assert.equal(probe.streams[0].width, expectedWidth);
          assert.equal(probe.streams[0].height, expectedHeight);
          assert.equal(Number(probe.streams[0].nb_read_frames), 30);
          assert.equal(probe.streams[0].codec_name, 'h264');
          assert.equal(probe.streams[1].codec_name, 'aac');
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
          assert.equal(await readFile(projectFile, 'utf8'), project);
          await clean();
        }
      },
    );

    await t.test(
      'refuses conflicts and atomically replaces only on explicit success; human progress goes to stderr',
      async () => {
        await writeFile(projectFile, serializeProject(example(source)));
        const output = join(directory, 'replace.mp4');
        await writeFile(output, 'previous export');
        const refused = run(
          'project',
          'render',
          projectFile,
          '--output',
          output,
          '--json',
        );
        assert.equal(refused.status, 1);
        assert.equal(events(refused.stdout).at(-1)!.event, 'failed');
        assert.equal(await readFile(output, 'utf8'), 'previous export');
        const rendered = run(
          'project',
          'render',
          projectFile,
          '--output',
          output,
          '--overwrite',
        );
        assert.equal(rendered.status, 0, rendered.stderr);
        assert.match(rendered.stdout, /^Saved 30 frames/);
        assert.match(rendered.stderr, /rendering:.*frames.*elapsed.*remaining/);
        assert.match(rendered.stderr, /verifying:/);
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
        await clean();
      },
    );

    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      await t.test(
        `${signal} stops a live FFmpeg child and cleans temporary output`,
        async () => {
          await writeFile(
            projectFile,
            serializeProject(
              example(join(generated, 'still.png'), 1920, 1080, 18000),
            ),
          );
          const output = join(directory, `${signal}.mp4`);
          const replace = signal === 'SIGTERM';
          if (replace) await writeFile(output, 'preserved export');
          const child = spawn(
            process.execPath,
            [
              entry,
              'project',
              'render',
              projectFile,
              '--output',
              output,
              '--json',
              ...(replace ? ['--overwrite'] : []),
            ],
            { stdio: ['ignore', 'pipe', 'pipe'] },
          );
          let stdout = '';
          let stderr = '';
          let pending = '';
          let sent = false;
          let subprocesses: number[] = [];
          const timeout = setTimeout(() => child.kill('SIGKILL'), 30000);
          child.stdout.setEncoding('utf8');
          child.stderr.setEncoding('utf8');
          child.stderr.on('data', (chunk: string) => {
            stderr += chunk;
          });
          child.stdout.on('data', (chunk: string) => {
            stdout += chunk;
            pending += chunk;
            let end: number;
            while ((end = pending.indexOf('\n')) !== -1) {
              const event = JSON.parse(pending.slice(0, end)) as Event;
              pending = pending.slice(end + 1);
              if (
                !sent &&
                event.phase === 'rendering' &&
                event.processedFrames! > 0 &&
                event.percent! < 100
              ) {
                const children = spawnSync('ps', ['-axo', 'pid=,ppid=,comm='], {
                  encoding: 'utf8',
                });
                subprocesses = children.stdout
                  .trim()
                  .split('\n')
                  .map((line) => line.trim().split(/\s+/))
                  .filter(
                    (fields) =>
                      Number(fields[1]) === child.pid &&
                      fields.slice(2).join(' ').includes('ffmpeg'),
                  )
                  .map((fields) => Number(fields[0]));
                sent = child.kill(signal);
              }
            }
          });
          try {
            const status = await new Promise<number | null>(
              (resolve, reject) => {
                child.on('error', reject);
                child.on('close', (code) => resolve(code));
              },
            );
            assert.ok(
              sent,
              'No live progress was observed before cancellation',
            );
            assert.ok(subprocesses.length > 0, 'No FFmpeg child was observed');
            assert.equal(status, signal === 'SIGINT' ? 130 : 143, stderr);
            assert.equal(events(stdout).at(-1)!.event, 'cancelled');
            assert.ok(
              !events(stdout).some((event) => event.event === 'completed'),
            );
            assert.match(stderr, /cancelled/i);
            for (const pid of subprocesses)
              assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
            if (replace)
              assert.equal(await readFile(output, 'utf8'), 'preserved export');
            else await assert.rejects(readFile(output), { code: 'ENOENT' });
            await clean();
          } finally {
            clearTimeout(timeout);
            if (child.exitCode === null && child.signalCode === null)
              child.kill('SIGKILL');
          }
        },
      );
    }

    await t.test(
      'keeps FFmpeg diagnostics and previous output when encoding fails after probing',
      async () => {
        const copy = join(directory, 'copy.mp4');
        await writeFile(projectFile, serializeProject(example(copy)));
        for (const overwrite of [false, true]) {
          await copyFile(source, copy);
          const output = join(
            directory,
            overwrite ? 'failed-existing.mp4' : 'failed-new.mp4',
          );
          if (overwrite) await writeFile(output, 'preserved export');
          await assert.rejects(
            renderProjectFile(projectFile, output, {
              overwrite,
              onProgress: (event) => {
                if (event.phase === 'rendering' && event.processedFrames === 0)
                  writeFileSync(copy, 'corrupt temporary copy after preflight');
              },
            }),
            /ffmpeg failed:.*(?:moov atom|Invalid data|Error opening)/s,
          );
          if (overwrite)
            assert.equal(await readFile(output, 'utf8'), 'preserved export');
          else await assert.rejects(readFile(output), { code: 'ENOENT' });
          await clean();
        }
      },
    );

    await t.test(
      'never replaces a source or saved project under --overwrite',
      async () => {
        const copy = join(directory, 'protected.mp4');
        await copyFile(source, copy);
        const original = await hash(copy);
        const project = serializeProject(example(copy));
        await writeFile(projectFile, project);
        const result = run(
          'project',
          'render',
          projectFile,
          '--output',
          copy,
          '--overwrite',
          '--json',
        );
        assert.equal(result.status, 1);
        assert.match(result.stderr, /source media/);
        assert.equal(await hash(copy), original);
        const disguisedProject = join(directory, 'project.mp4');
        await writeFile(disguisedProject, project);
        const refused = run(
          'project',
          'render',
          disguisedProject,
          '--output',
          disguisedProject,
          '--overwrite',
          '--json',
        );
        assert.equal(refused.status, 1);
        assert.match(refused.stderr, /project file/);
        assert.equal(await readFile(disguisedProject, 'utf8'), project);
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    assert.deepEqual(
      await Promise.all(fixtures.map((file) => hash(join(generated, file)))),
      before,
      'Original fixtures changed',
    );
  }
});

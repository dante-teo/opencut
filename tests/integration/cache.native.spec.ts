import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { MediaCache, probeMedia } from '../../packages/media/src/index.js';
import { runMediaTool } from '../../packages/media/src/process.js';
import { auditProjects } from '../../scripts/t21-projects.js';
import { serializeProject } from '@opencut/core';
import { renderProjectFile } from '@opencut/core/node';

const root = resolve('tests/fixtures/generated');
test('native proxies preserve VFR PTS and AAC samples, cancel cleanly, and never enter export', async () => {
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 't25-native-'));
  const source = join(directory, 'source.mp4');
  const cache = new MediaCache(join(directory, 'cache'));
  try {
    await runMediaTool('ffmpeg', [
      '-v',
      'error',
      '-nostdin',
      '-n',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1920x1080:rate=30',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-t',
      '3',
      '-vf',
      "select='if(lt(t,1),1,not(mod(n,2)))'",
      '-fps_mode',
      'vfr',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-threads',
      '2',
      '-c:a',
      'aac',
      source,
    ]);
    const original = await readFile(source);
    const progress: number[] = [];
    const proxy = await cache.generateProxy(source, {
      onProgress: (event) => progress.push(event.percent),
    });
    assert.equal(proxy.proxy, true);
    assert(progress.length >= 2);
    assert.equal((await probeMedia(proxy.path)).video?.width, 960);
    const audio = (path: string) =>
      runMediaTool('ffmpeg', [
        '-v',
        'error',
        '-i',
        path,
        '-map',
        '0:a:0',
        '-f',
        'f32le',
        'pipe:1',
      ]);
    assert.deepEqual(
      await audio(source),
      await audio(proxy.path),
      'copied AAC decodes to identical samples',
    );
    const pts = (path: string) =>
      runMediaTool('ffprobe', [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'frame=best_effort_timestamp_time',
        '-of',
        'csv=p=0',
        path,
      ]);
    assert.deepEqual(
      (await pts(source)).toString().replace(/,.*/g, ''),
      (await pts(proxy.path)).toString().replace(/,.*/g, ''),
    );
    const controller = new AbortController();
    await assert.rejects(
      cache.generateProxy(source, {
        force: true,
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }),
      /cancelled/,
    );
    assert(
      !(await readdir(join(directory, 'cache'))).some((name) =>
        name.startsWith('partial-'),
      ),
    );
    // Exercise subprocess cancellation after FFmpeg has begun producing progress.
    const child = spawn(
      process.execPath,
      [
        'apps/cli/dist/index.js',
        'cache',
        'proxy',
        source,
        '--directory',
        join(directory, 'cli-cache'),
        '--json',
      ],
      { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('"progress"')) child.kill('SIGINT');
    });
    const code = await new Promise((r) => child.on('close', r));
    assert.equal(code, 130);
    assert(
      !(await readdir(join(directory, 'cli-cache'))).some((name) =>
        name.startsWith('partial-'),
      ),
    );
    // Export is independent of cache: even a corrupted cache cannot reduce export dimensions.
    await writeFile(proxy.path, 'corrupted');
    assert.equal((await cache.select(source)).proxy, false);
    const project = auditProjects().cuts!;
    project.settings.width = 1920;
    project.settings.height = 1080;
    project.assets = [project.assets[0]!];
    project.clips = [
      { ...project.clips[0]!, sourceOut: { numerator: 2, denominator: 1 } },
    ];
    const path = join(directory, 'export.json');
    await writeFile(path, serializeProject(project));
    const exported = join(directory, 'export.mp4');
    await renderProjectFile(path, exported);
    assert.equal((await probeMedia(exported)).video?.width, 1920);
    assert.deepEqual(await readFile(source), original);
    assert.equal(
      spawnSync(
        process.execPath,
        [
          'apps/cli/dist/index.js',
          'cache',
          'status',
          '--directory',
          join(directory, 'cache'),
          '--json',
        ],
        { encoding: 'utf8' },
      ).status,
      0,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('cached PNGs match the covering decoded frame at CFR/VFR boundaries and inside frame intervals', async () => {
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 't25-frame-interval-'));
  const cache = new MediaCache(join(directory, 'cache'));
  try {
    for (const variable of [false, true]) {
      const source = join(directory, variable ? 'vfr.mp4' : 'cfr.mp4');
      await runMediaTool('ffmpeg', [
        '-v',
        'error',
        '-nostdin',
        '-n',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x180:rate=30',
        '-t',
        '1',
        ...(variable ? ['-vf', "select='not(eq(n,1)+eq(n,2))'"] : []),
        '-fps_mode',
        'vfr',
        '-c:v',
        'libx264',
        '-g',
        '10',
        '-bf',
        '3',
        '-threads',
        '2',
        source,
      ]);
      const samples: [number, number][] = variable
        ? [
            [0.01, 0],
            [0.075, 0],
            [0.1, 1],
            [0.100001, 1],
            [0.34, 8],
            [0.999, 27],
          ]
        : [
            [0.01, 0],
            [0.0333332, 0],
            [1 / 30, 1],
            [0.033334, 1],
            [0.075, 2],
            [0.34, 10],
            [0.999, 29],
          ];
      for (const [timestamp, index] of samples) {
        // Independent oracle decodes from frame zero and selects by frame index, without seeking.
        const expected = await runMediaTool('ffmpeg', [
          '-v',
          'error',
          '-nostdin',
          '-threads',
          '2',
          '-i',
          source,
          '-map',
          '0:v:0',
          '-vf',
          `select=eq(n\\,${index}),scale=640:360:force_original_aspect_ratio=decrease`,
          '-frames:v',
          '1',
          '-threads',
          '1',
          '-c:v',
          'png',
          '-f',
          'image2pipe',
          'pipe:1',
        ]);
        assert.deepEqual(
          await cache.frame(source, timestamp),
          expected,
          `${variable ? 'VFR' : 'CFR'} at ${timestamp}s should display decoded frame ${index}`,
        );
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

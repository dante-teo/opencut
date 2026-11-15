import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { batchRenderVideo, renderVideo } from '@opencut/sdk';
import type {
  VideoBatchOptions,
  VideoBatchProgress,
  VideoBatchResult,
  VideoVariant,
} from '@opencut/sdk';
import { fixtureDirectory, videoExample } from '../fixture-paths.js';

const entry = fileURLToPath(
  new URL('../../apps/cli/dist/index.js', import.meta.url),
);
const exec = promisify(execFile);
const example = videoExample('short-batch.video.ts');
const variants = videoExample('short-batch.variants.json');
const inputs = async () =>
  JSON.parse(await readFile(variants, 'utf8')) as VideoVariant[];
const scratch = () => mkdtemp(join(fixtureDirectory, 't52-'));
const eventsOf = (text: string) =>
  text
    .split('\n')
    .filter((line) => line.startsWith('{"event":"batch-progress"'))
    .map((line) => JSON.parse(line) as VideoBatchProgress);

const finished = (
  events: readonly VideoBatchProgress[],
  status: 'completed' | 'cache-hit',
) =>
  events.filter((e) => e.status === 'recipe' && e.progress.status === status)
    .length;

async function probe(path: string) {
  const { stdout } = await exec('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-count_frames',
    '-show_entries',
    'stream=width,height,duration,nb_read_frames:format_tags=opencut_build',
    '-of',
    'json',
    path,
  ]);
  return JSON.parse(stdout) as {
    streams: [
      {
        width: number;
        height: number;
        duration: string;
        nb_read_frames: string;
      },
    ];
    format: { tags: { opencut_build: string } };
  };
}

async function audioHash(path: string) {
  const { stdout } = await exec('ffmpeg', [
    '-v',
    'error',
    '-i',
    path,
    '-map',
    '0:a:0',
    '-f',
    'hash',
    '-',
  ]);
  return stdout.trim();
}

test(
  'T52 CLI and SDK render independent variants with bounded jobs, shared recipes and verified metadata',
  {
    timeout: 30_000,
    skip: process.platform !== 'darwin' && process.platform !== 'linux',
  },
  async (t) => {
    const directory = await scratch();
    t.after(() => rm(directory, { recursive: true, force: true }));
    const cacheDirectory = join(directory, 'opencut', 'recipes-v1');
    const outputDirectory = join(directory, 'first');
    const events: VideoBatchProgress[] = [];
    const input = await inputs();
    const invalid = {
      id: 'invalid',
      params: { ...input[0]?.params, title: 19 },
    };
    const options: VideoBatchOptions = {
      outputDirectory,
      concurrency: 2,
      maxTemporaryBytes: 64 * 1024 ** 2,
      maxNativeBytes: 512 * 1024 ** 2,
      processing: { cacheDirectory },
      onProgress: (e) => events.push(e),
    };
    const first = await batchRenderVideo(
      example,
      [input[0], invalid, ...input.slice(1)],
      options,
    );
    assert.equal(first.ok, false);
    assert.deepEqual(
      first.variants.map(({ status }) => status),
      ['completed', 'failed', 'completed', 'completed'],
    );
    const failure = first.variants[1];
    assert.equal(failure?.status, 'failed');
    assert.match(failure.error.message, /params\.title/);
    const active = new Set<string>();
    let peak = 0;
    for (const event of events) {
      if (event.status === 'compiling') active.add(event.id);
      else if (event.status === 'finished') active.delete(event.id);
      peak = Math.max(peak, active.size);
    }
    assert.equal(peak, 2);
    assert.equal(active.size, 0);
    assert.equal(finished(events, 'completed'), 3);
    assert.equal(finished(events, 'cache-hit'), 1);
    assert.equal(
      (await readdir(cacheDirectory)).filter((path) =>
        /^[a-f0-9]{64}$/.test(path),
      ).length,
      3,
    );
    assert.deepEqual((await readdir(outputDirectory)).sort(), [
      'field-square.mp4',
      'tall.mp4',
      'wide.mp4',
    ]);

    const successes = first.variants.filter(
      (variant) => variant.status === 'completed',
    );
    const dimensions = [
      [320, 180],
      [180, 320],
      [240, 240],
    ];
    const encodedAudio: string[] = [];
    const bytes = new Map<string, Buffer>();
    for (const [i, { id, output, render }] of successes.entries()) {
      const {
        streams: [stream],
        format,
      } = await probe(output);
      assert.deepEqual([stream.width, stream.height], dimensions[i]);
      assert.equal(stream.duration, '3.000000');
      assert.equal(stream.nb_read_frames, '72');
      assert.deepEqual(
        JSON.parse(format.tags.opencut_build),
        JSON.parse(JSON.stringify(render.build)),
      );
      assert.equal(render.build?.batch?.variant, id);
      assert.equal(render.build?.params?.layout, id);
      bytes.set(id, await readFile(output));
      encodedAudio.push(await audioHash(output));
    }
    assert.equal(encodedAudio[0], encodedAudio[1]);
    assert.notEqual(encodedAudio[0], encodedAudio[2]);
    assert.equal(
      successes[0]?.render.build?.processing.steps[0]?.key,
      successes[1]?.render.build?.processing.steps[0]?.key,
    );

    const retry = await batchRenderVideo(
      example,
      [
        input[0],
        {
          id: 'invalid',
          params: { ...input[0]?.params, title: 'Retried #1; A=B \\ C' },
        },
        ...input.slice(1),
      ],
      { ...options, only: ['invalid'] },
    );
    assert.deepEqual(
      retry.variants.map(({ id, status }) => [id, status]),
      [['invalid', 'completed']],
    );
    for (const { id, output } of successes)
      assert.deepEqual(await readFile(output), bytes.get(id));
    const retried = retry.variants[0];
    assert.equal(retried?.status, 'completed');
    assert.equal(
      JSON.parse((await probe(retried.output)).format.tags.opencut_build).params
        .title,
      'Retried #1; A=B \\ C',
    );

    const run = await exec(process.execPath, [
      entry,
      'batch',
      example,
      '--variants',
      variants,
      '--output-dir',
      join(directory, 'warm'),
      '--recipe-cache',
      cacheDirectory,
      '--concurrency',
      '2',
      '--temp-bytes',
      String(options.maxTemporaryBytes),
      '--memory-bytes',
      String(options.maxNativeBytes),
      '--json',
    ]);
    const warm = JSON.parse(run.stdout) as VideoBatchResult;
    assert.equal(warm.ok, true);
    assert.equal(finished(eventsOf(run.stderr), 'completed'), 0);
    assert.equal(finished(eventsOf(run.stderr), 'cache-hit'), 4);
    for (const { id, output } of warm.variants)
      assert.deepEqual(await readFile(output), bytes.get(id));

    const singleOutput = join(directory, 'single.mp4');
    const single = await exec(process.execPath, [
      entry,
      'render',
      example,
      '--params',
      videoExample('short-batch.params.json'),
      '-o',
      singleOutput,
      '--recipe-cache',
      cacheDirectory,
      '--json',
    ]);
    assert.equal(
      JSON.parse(single.stdout).build.params.title,
      'Studio dispatch',
    );
    assert.equal((await probe(singleOutput)).streams[0].nb_read_frames, '72');

    const sheet = await exec(
      process.execPath,
      [
        entry,
        'preview',
        'contact-sheet',
        example,
        '--params',
        videoExample('short-batch.params.json'),
        '--count',
        '2',
        '--columns',
        '2',
        '-o',
        join(directory, 'contact.png'),
        '--json',
      ],
      { env: { ...process.env, XDG_CACHE_HOME: directory } },
    );
    assert.equal(JSON.parse(sheet.stdout).kind, 'contact-sheet');
    assert.equal(JSON.parse(sheet.stdout).samples.length, 2);

    const rangedOutput = join(directory, 'ranged.mp4');
    const range = { startFrame: 12, endFrame: 36 };
    const maxDimension = 160;
    const forwardedControls = { range, maxDimension };
    const ranged = await renderVideo(example, rangedOutput, {
      params: input[0]?.params,
      processing: { cacheDirectory },
      ...forwardedControls,
    });
    const {
      streams: [rangedStream],
      format: { tags },
    } = await probe(rangedOutput);
    assert.deepEqual([rangedStream.width, rangedStream.height], [160, 90]);
    assert.equal(rangedStream.nb_read_frames, '24');
    assert.deepEqual(ranged.build?.render.range, range);
    assert.equal(ranged.build?.render.maxDimension, maxDimension);
    assert.deepEqual(JSON.parse(tags.opencut_build), ranged.build);

    const smallDir = join(directory, 'no-room');
    const failureResult = await batchRenderVideo(example, input, {
      ...options,
      only: ['wide'],
      outputDirectory: smallDir,
      maxTemporaryBytes: 1024,
    });
    assert.equal(failureResult.variants[0]?.status, 'failed');
    assert.deepEqual(await readdir(smallDir), []);
  },
);

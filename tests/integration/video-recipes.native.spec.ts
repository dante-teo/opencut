import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  compileVideo,
  inspectVideoRecipes,
  probeMedia,
  watchVideo,
} from '@opencut/sdk';
import type {
  VideoDefinition,
  VideoProcessingProgress,
  VideoWatchRevision,
} from '@opencut/sdk';

const generated = fileURLToPath(
  new URL('../fixtures/generated/', import.meta.url),
);
const example = (extension: string) =>
  fileURLToPath(
    new URL(`../../examples/video/recipes.video.${extension}`, import.meta.url),
  );
const entry = fileURLToPath(
  new URL('../../apps/cli/dist/index.js', import.meta.url),
);
const exec = promisify(execFile);
const cli = (...args: string[]) =>
  exec(process.execPath, [entry, ...args], { timeout: 30_000 });
const entries = async (cache: string) =>
  (await readdir(cache)).filter((name) => /^[a-f0-9]{64}$/.test(name)).sort();
const starts = (log: string) =>
  [...log.matchAll(/recipe (\S+) step (\d+): started/g)].map(
    ([, asset, step]) => `${asset}:${step}`,
  );
const hits = (log: string) =>
  [...log.matchAll(/recipe (\S+) step (\d+): cache-hit/g)].length;
const noStaging = async (cache: string) =>
  assert.deepEqual(
    (await readdir(cache)).filter((name) => name.endsWith('.stage')),
    [],
  );

async function scratch() {
  await mkdir(generated, { recursive: true });
  return mkdtemp(join(generated, 't48-'));
}

async function sample() {
  return JSON.parse(await readFile(example('json'), 'utf8')) as VideoDefinition;
}

function setPaths(
  definition: VideoDefinition,
  directory: string,
  source: string,
) {
  for (const asset of Object.values(definition.assets!))
    asset.path = relative(directory, source);
}

async function runExample(
  directory: string,
  cache: string,
  extension: string,
  output: string,
) {
  return cli(
    'render',
    example(extension),
    '--output',
    join(directory, output),
    '--recipe-cache',
    cache,
    '--recipe-workers',
    '2',
  );
}

test('T48 concurrent foreground TS and JSON renders share seven cache entries and preserve timing', async () => {
  const directory = await scratch();
  const cache = join(directory, 'cache');
  try {
    const { stdout } = await cli(
      'recipes',
      'inspect',
      example('json'),
      '--json',
    );
    assert.deepEqual(
      JSON.parse(stdout),
      await inspectVideoRecipes(example('json')),
    );
    const [ts, json] = await Promise.all([
      runExample(directory, cache, 'ts', 'ts.mp4'),
      runExample(directory, cache, 'json', 'json.mp4'),
    ]);
    assert.equal(starts(ts.stderr + '\n' + json.stderr).length, 7);
    assert.equal(hits(ts.stderr) + hits(json.stderr), 9);
    assert.equal((await entries(cache)).length, 7);
    await noStaging(cache);
    const again = await runExample(directory, cache, 'ts', 'again.mp4');
    assert.equal(hits(again.stderr), 8);
    assert.deepEqual(starts(again.stderr), []);
    const path = join(directory, 'ts.mp4');
    assert.deepEqual(
      await readFile(path),
      await readFile(join(directory, 'json.mp4')),
    );
    assert.deepEqual(
      await readFile(path),
      await readFile(join(directory, 'again.mp4')),
    );
    const { video, audio } = await probeMedia(path);
    assert.equal(video?.durationSeconds, 1);
    assert.equal(audio?.durationSeconds, 1);
    assert.equal(video?.frameRate, 24);
    assert.deepEqual([video?.width, video?.height], [160, 90]);
    assert.equal(video?.startTimeSeconds, 0);
    assert.equal(audio?.startTimeSeconds, 0);
    const { stdout: pcm } = await exec(
      'ffmpeg',
      [
        '-v',
        'error',
        '-i',
        path,
        '-map',
        '0:a:0',
        '-ac',
        '1',
        '-f',
        'f32le',
        '-',
      ],
      { encoding: 'buffer' },
    );
    const firstPulse = new Float32Array(Uint8Array.from(pcm).buffer).findIndex(
      (value) => Math.abs(value) >= 0.02,
    );
    assert.ok(
      firstPulse >= 0 && firstPulse < 2400,
      `Trimmed audio marker starts at sample ${firstPulse}`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('T48 invalidation follows dependencies, skips unused work and repairs damaged entries', async () => {
  const directory = await scratch();
  const cacheDirectory = join(directory, 'cache');
  const file = join(directory, 'edit.video.json');
  const source = join(directory, 'source.mp4');
  try {
    await copyFile(join(generated, 'video-medium.mp4'), source);
    const definition = await sample();
    setPaths(definition, directory, source);
    definition.assets!.unused = {
      kind: 'video',
      path: 'source.mp4',
      recipe: [{ type: 'resize', width: 96, height: 96 }],
    };
    const events: VideoProcessingProgress[] = [];
    async function build() {
      events.length = 0;
      await writeFile(file, JSON.stringify(definition));
      return compileVideo(file, {
        processing: {
          cacheDirectory,
          onProgress: (event) => events.push(event),
        },
      });
    }
    const materialized = () =>
      events
        .filter(({ status }) => status === 'started')
        .map(({ assetId, step }) => `${assetId}:${step}`);
    const initial = await build();
    assert.equal(initial.recipes.length, 3);
    assert.equal(materialized().length, 7);
    assert.equal((await entries(cacheDirectory)).length, 7);
    const resize = definition.assets!.picture!.recipe![2]!;
    assert.equal(resize.type, 'resize');
    resize.width = 144;
    await build();
    assert.deepEqual(materialized(), ['picture:2', 'picture:3']);
    assert.equal((await entries(cacheDirectory)).length, 9);
    definition.tracks[1]!.clips[0]!.volume = 0.5;
    await build();
    assert.deepEqual(materialized(), []);
    const corrupt = events.find(
      ({ assetId, step }) => assetId === 'soundtrack' && step === 3,
    )!;
    await writeFile(join(cacheDirectory, corrupt.key, 'media.flac'), 'damaged');
    await build();
    assert.deepEqual(materialized(), ['soundtrack:3']);
    const manifestKey = events.find(
      ({ assetId, step }) => assetId === 'soundtrack' && step === 2,
    )!.key;
    const manifest = join(cacheDirectory, manifestKey, 'result.json');
    await rm(manifest);
    await mkdir(manifest);
    await build();
    assert.deepEqual(materialized(), ['soundtrack:2']);
    assert.equal((await entries(cacheDirectory)).length, 9);
    // Preserve the path and size while changing metadata included in the key.
    const timestamp = new Date('2020-01-01');
    await utimes(source, timestamp, timestamp);
    await build();
    assert.equal(materialized().length, 7);
    assert.equal((await entries(cacheDirectory)).length, 16);
    await noStaging(cacheDirectory);
    const rotated = definition.assets!.picture!.recipe!;
    [rotated[1], rotated[2]] = [rotated[2]!, rotated[1]!];
    await writeFile(file, JSON.stringify(definition));
    await assert.rejects(
      inspectVideoRecipes(file),
      /recipe\.2: Crop rectangle/,
    );
    assert.equal((await entries(cacheDirectory)).length, 16);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('T48 CLI cancellation and worker budget failures clean staging and preserve valid cache entries', async () => {
  const directory = await scratch();
  const cacheDirectory = join(directory, 'cache');
  const file = join(directory, 'edit.video.json');
  try {
    const definition = await sample();
    setPaths(definition, directory, join(generated, 'video-medium.mp4'));
    const picture = definition.assets!.picture!;
    picture.recipe = picture.recipe!.slice(0, 1);
    definition.tracks = definition.tracks.slice(0, 1);
    delete definition.assets!.soundtrack;
    const write = () => writeFile(file, JSON.stringify(definition));
    await write();
    await compileVideo(file, { processing: { cacheDirectory } });
    const existing = await entries(cacheDirectory);
    assert.equal(existing.length, 1);
    picture.recipe.push({ type: 'resize', width: 1920, height: 1080 });
    await write();
    const output = join(directory, 'cancelled.mp4');
    const child = spawn(
      process.execPath,
      [
        entry,
        'render',
        file,
        '--output',
        output,
        '--recipe-cache',
        cacheDirectory,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let log = '';
    let interrupted = false;
    const cancel = setTimeout(() => child.kill('SIGKILL'), 10_000);
    try {
      child.stderr.on('data', (chunk: Buffer) => {
        log += chunk.toString();
        if (!interrupted && log.includes('recipe picture step 2: processing')) {
          interrupted = true;
          child.kill('SIGINT');
        }
      });
      const [code] = await once(child, 'close');
      assert.equal(code, 130, log);
      assert.match(log, /picture step 2: processing/);
      assert.match(log, /abort/i);
    } finally {
      clearTimeout(cancel);
    }
    await assert.rejects(readFile(output), { code: 'ENOENT' });
    const verifyFailure = async (
      limits: Parameters<typeof compileVideo>[1],
      pattern: RegExp,
    ) => {
      await assert.rejects(compileVideo(file, limits), pattern);
      assert.deepEqual(await entries(cacheDirectory), existing);
      await noStaging(cacheDirectory);
    };
    await verifyFailure(
      { processing: { cacheDirectory, maxTemporaryBytes: 1024 } },
      /temporary file limit/,
    );
    await verifyFailure(
      { processing: { cacheDirectory, timeoutMs: 1 } },
      /time limit/,
    );
    await verifyFailure(
      { processing: { cacheDirectory, maxPixels: 1_000_000 } },
      /pixel limit/,
    );
    await verifyFailure(
      { processing: { cacheDirectory, maxNativeBytes: 1 } },
      /(?:native memory limit|Cannot allocate memory|FFmpeg recipe step failed)/i,
    );
    const recovered = await compileVideo(file, {
      processing: { cacheDirectory },
    });
    assert.equal(recovered.project.assets[0]?.metadata?.width, 1920);
    assert.equal((await entries(cacheDirectory)).length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('T48 watched definitions use pinned processed files for playback and export', async () => {
  const directory = await scratch();
  const cacheDirectory = join(directory, 'cache');
  const signal = AbortSignal.timeout(20_000);
  const statuses: Array<
    Parameters<Parameters<typeof watchVideo>[1]['onStatus']>[0]
  > = [];
  const watcher = await watchVideo(example('json'), {
    signal,
    processing: { cacheDirectory },
    onStatus(event) {
      statuses.push(event);
    },
  });
  try {
    while (
      !statuses.some(({ status }) => status === 'error' || status === 'ready')
    )
      await delay(50, undefined, { signal });
    const event = statuses.at(-1)!;
    if (event.status === 'error') throw new Error(event.error);
    const revision: VideoWatchRevision = event.current!;
    const { sourceMetadata } = await revision.video.resolveRender();
    assert.equal(sourceMetadata.size, 2);
    assert.ok(
      [...sourceMetadata.keys()].every(
        (path) => !path.startsWith(cacheDirectory),
      ),
    );
    assert.equal(revision.playback.frameCount, 24);
    await noStaging(cacheDirectory);
  } finally {
    await watcher.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('T48 extraction preserves delayed audio relative to the trimmed picture', async () => {
  const directory = await scratch();
  const cacheDirectory = join(directory, 'cache');
  const source = join(directory, 'delay.mov');
  const definition = join(directory, 'delay.video.json');
  try {
    await exec('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=160x90:r=25:d=1',
      '-itsoffset',
      '0.2',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=1000:sample_rate=48000:duration=0.8',
      '-c:v',
      'libx264',
      '-c:a',
      'pcm_s16le',
      source,
    ]);
    assert.equal((await probeMedia(source)).audio?.startTimeSeconds, 0.2);
    const trim = { type: 'trim', start: 0.12, end: 0.92 } as const;
    const authored: VideoDefinition = {
      canvas: { width: 160, height: 90, frameRate: 25, durationFrames: 20 },
      assets: {
        picture: {
          path: 'delay.mov',
          kind: 'video',
          recipe: [trim, { type: 'convert', format: 'mp4' }],
        },
        sound: {
          path: 'delay.mov',
          kind: 'audio',
          recipe: [trim, { type: 'extractAudio' }],
        },
      },
      tracks: [
        {
          type: 'video',
          clips: [{ asset: 'picture', at: 0, sourceOut: 20, muted: true }],
        },
        { type: 'audio', clips: [{ asset: 'sound', at: 0, sourceOut: 20 }] },
      ],
    };
    await writeFile(definition, JSON.stringify(authored));
    const compiled = await compileVideo(definition, {
      processing: { cacheDirectory },
    });
    const { sourceMetadata } = await compiled.resolveRender();
    const sources = [...sourceMetadata.values()];
    const picture = sources.find(({ video }) => video)!;
    assert.equal(picture.video?.startTimeSeconds, 0);
    assert.ok(Math.abs(picture.audio!.startTimeSeconds! - 0.08) < 0.025);
    const sound = sources.find(({ video }) => !video)!;
    assert.equal(sound.durationSeconds, 0.8);
    const { stdout: pcm } = await exec(
      'ffmpeg',
      ['-v', 'error', '-i', sound.path, '-f', 'f32le', '-'],
      { encoding: 'buffer' },
    );
    const onset = new Float32Array(Uint8Array.from(pcm).buffer).findIndex(
      (value) => Math.abs(value) > 0.02,
    );
    assert.ok(
      Math.abs(onset - 3840) < 48,
      `Expected 80 ms of silence; onset was sample ${onset}`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('T48 trims delayed picture and shorter audio on the container clock', async () => {
  const directory = await scratch();
  const file = join(directory, 'edit.video.json');
  const source = join(directory, 'delayed.mov');
  try {
    await exec('ffmpeg', [
      '-v',
      'error',
      '-itsoffset',
      '0.2',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=160x90:r=25:d=0.8',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=1000:sample_rate=48000:duration=0.4',
      '-c:v',
      'libx264',
      '-c:a',
      'pcm_s16le',
      source,
    ]);
    const input = await probeMedia(source);
    assert.equal(input.startTimeSeconds, 0);
    assert.equal(input.video?.startTimeSeconds, 0.2);
    assert.equal(input.video?.durationSeconds, 0.8);
    assert.equal(input.audio?.durationSeconds, 0.4);
    const definition: VideoDefinition = {
      canvas: { width: 160, height: 90, frameRate: 25, durationFrames: 20 },
      assets: {
        early: {
          path: 'delayed.mov',
          kind: 'video',
          recipe: [{ type: 'trim', start: 0, end: 0.8 }],
        },
        late: {
          path: 'delayed.mov',
          kind: 'video',
          recipe: [
            { type: 'trim', start: 0.8, end: 1 },
            { type: 'trim', start: 0, end: 0.2 },
          ],
        },
      },
      tracks: [
        {
          type: 'video',
          clips: [
            { asset: 'early', at: 0, sourceOut: 15 },
            { asset: 'late', at: 15, sourceOut: 5 },
          ],
        },
      ],
    };
    await writeFile(file, JSON.stringify(definition));
    const { recipes } = await inspectVideoRecipes(file);
    assert.equal(recipes[0]?.steps[0]?.media.videoStartSeconds, 0.2);
    assert.equal(recipes[1]?.steps[0]?.media.hasAudio, false);
    const compiled = await compileVideo(file, {
      processing: { cacheDirectory: join(directory, 'cache') },
    });
    const { sourceMetadata, visualClips } = await compiled.resolveRender();
    const [early, late] = visualClips.map(({ path }) =>
      sourceMetadata.get(path!)!,
    );
    assert.equal(early?.video?.startTimeSeconds, 0.2);
    assert.equal(early?.video?.durationSeconds, 0.6);
    assert.equal(early?.audio?.startTimeSeconds, 0);
    assert.equal(early?.audio?.durationSeconds, 0.4);
    assert.equal(late?.video?.startTimeSeconds, 0);
    assert.equal(late?.video?.durationSeconds, 0.2);
    assert.equal(late?.audio, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function killRecipeWorker(pid: number) {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

test('T48 a retry gets a fresh staging path after a CLI is killed mid-step', async () => {
  const directory = await scratch();
  const cacheDirectory = join(directory, 'cache');
  const file = join(directory, 'edit.video.json');
  const signal = AbortSignal.timeout(15_000);
  const originalPath = process.env.PATH ?? '';
  let child: ReturnType<typeof spawn> | undefined;
  let workerPid: number | undefined;
  try {
    const definition = await sample();
    setPaths(definition, directory, join(generated, 'video-medium.mp4'));
    const picture = definition.assets!.picture!;
    picture.recipe = picture.recipe!.slice(0, 1);
    definition.assets = { picture };
    definition.tracks = definition.tracks.slice(0, 1);
    await writeFile(file, JSON.stringify(definition));
    await writeFile(
      join(directory, 'ffmpeg'),
      `#!/bin/sh
if [ "$1" = -version ]; then
  PATH="$T48_ORIGINAL_PATH" exec ffmpeg "$@"
fi
for output do :; done
printf '%s\\n%s\\n' "$$" "$output" > "$T48_MARKER"
if [ "$T48_HOLD" = 1 ]; then exec /bin/sleep 60; fi
PATH="$T48_ORIGINAL_PATH" exec ffmpeg "$@"
`,
      { mode: 0o700 },
    );
    const args = ['validate', file, '--recipe-cache', cacheDirectory];
    const env = {
      ...process.env,
      PATH: `${directory}:${originalPath}`,
      T48_ORIGINAL_PATH: originalPath,
    };
    const firstMarker = join(directory, 'first.txt');
    child = spawn(process.execPath, [entry, ...args], {
      env: { ...env, T48_MARKER: firstMarker, T48_HOLD: '1' },
      stdio: 'ignore',
    });
    const closed = once(child, 'close');
    let first = '';
    while (!first.endsWith('\n') || first.trim().split('\n').length !== 2) {
      await delay(20, undefined, { signal });
      first = await readFile(firstMarker, 'utf8').catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return '';
          throw error;
        },
      );
    }
    const [pid, firstOutput] = first.trimEnd().split('\n');
    workerPid = Number(pid);
    assert.ok(Number.isSafeInteger(workerPid) && workerPid > 1);
    assert.equal(child.kill('SIGKILL'), true);
    const [, killedBy] = await closed;
    assert.equal(killedBy, 'SIGKILL');

    const secondMarker = join(directory, 'second.txt');
    await exec(process.execPath, [entry, ...args], {
      signal,
      env: { ...env, T48_MARKER: secondMarker, T48_HOLD: '0' },
    });
    const [, secondOutput] = (await readFile(secondMarker, 'utf8'))
      .trimEnd()
      .split('\n');
    assert.notEqual(firstOutput, secondOutput);
    assert.equal(
      dirname(dirname(firstOutput!)),
      dirname(dirname(secondOutput!)),
    );
    await noStaging(cacheDirectory);
    assert.equal((await entries(cacheDirectory)).length, 1);
    for (;;) {
      const state = await exec(
        '/bin/ps',
        ['-o', 'stat=', '-p', String(workerPid)],
        { signal },
      ).then(
        ({ stdout }) => stdout.trim(),
        (error: { code: unknown }) => {
          if (error.code === 1) return '';
          throw error;
        },
      );
      if (!state || state.startsWith('Z')) break;
      await delay(20, undefined, { signal });
    }
    workerPid = undefined;
  } finally {
    try {
      child?.kill('SIGKILL');
      if (workerPid !== undefined) killRecipeWorker(workerPid);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('T48 recipe inspection and rendering accept BMP and TIFF inputs', async () => {
  const directory = await scratch();
  try {
    for (const format of ['bmp', 'tiff']) {
      const source = join(directory, `image.${format}`);
      const file = join(directory, `${format}.video.json`);
      const output = join(directory, `${format}.mp4`);
      await exec('ffmpeg', [
        '-v',
        'error',
        '-i',
        join(generated, 'still.png'),
        '-frames:v',
        '1',
        '-update',
        '1',
        source,
      ]);
      const definition: VideoDefinition = {
        canvas: { width: 160, height: 90, frameRate: 24, durationFrames: 24 },
        assets: {
          image: {
            path: `image.${format}`,
            kind: 'image',
            recipe: [{ type: 'resize', width: 160, height: 90 }],
          },
        },
        tracks: [
          { type: 'image', clips: [{ asset: 'image', at: 0, duration: 24 }] },
        ],
      };
      await writeFile(file, JSON.stringify(definition));
      const { recipes } = await inspectVideoRecipes(file);
      assert.equal(recipes[0]?.steps[0]?.format, 'png');
      await cli(
        'render',
        file,
        '--output',
        output,
        '--recipe-cache',
        join(directory, 'cache'),
      );
      const { video } = await probeMedia(output);
      assert.deepEqual(
        [video?.width, video?.height, video?.durationSeconds],
        [160, 90, 1],
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

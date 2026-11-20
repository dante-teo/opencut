import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  compileVideo,
  inspectVideoBuild,
  inspectVideoRecipes,
  previewVideo,
  probeMedia,
  renderCompiledVideo,
  watchVideo,
} from '@opencut/sdk';
import type {
  VideoDefinition,
  VideoProcessingProgress,
  VideoRecipe,
} from '@opencut/sdk';
import { fixtureDirectory } from '../fixture-paths.js';

const exec = promisify(execFile);
const cli = fileURLToPath(
  new URL('../../apps/cli/dist/index.js', import.meta.url),
);
const worker = fileURLToPath(
  new URL('../../packages/media/dist/video-interpolate', import.meta.url),
);
const apple =
  platform() === 'darwin' &&
  arch() === 'arm64' &&
  Number(release().split('.')[0]) >= 25;
const support = (async () => {
  if (!apple) return 'VideoToolbox requires Apple Silicon and macOS 26+.';
  try {
    await access(worker);
  } catch {
    return 'Build @opencut/media with a macOS 26+ SDK.';
  }
  const { stdout } = await exec(
    process.execPath,
    [cli, 'system', 'inspect', '--json'],
    { timeout: 20_000 },
  );
  const { videoToolbox } = JSON.parse(stdout);
  assert.equal(videoToolbox.status, 'probed');
  if (
    videoToolbox.frameProcessors['low-latency-interpolation'].status !==
    'reported-supported'
  )
    return 'VideoToolbox reports the interpolation model is unsupported.';
})();

async function fixture(t: TestContext) {
  const reason = await support;
  if (reason) {
    t.skip(reason);
    return;
  }
  return scratch(t);
}

async function scratch(t: TestContext) {
  await mkdir(fixtureDirectory, { recursive: true });
  const dir = await mkdtemp(join(fixtureDirectory, 't49-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function ffmpeg(...args: string[]) {
  return (
    await exec('ffmpeg', ['-hide_banner', '-v', 'error', ...args], {
      timeout: 30_000,
    })
  ).stdout;
}

const tagged =
  'setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709';
const lossless = [
  '-pix_fmt',
  'yuv420p',
  '-c:v',
  'libx264',
  '-preset',
  'ultrafast',
  '-qp',
  '0',
];
function definition(
  path: string,
  steps: VideoRecipe,
  fps = 48,
  w = 640,
  h = 360,
): VideoDefinition {
  return {
    canvas: { width: w, height: h, frameRate: fps, durationFrames: 8 },
    assets: { picture: { kind: 'video', path, recipe: steps } },
    tracks: [
      { type: 'video', clips: [{ asset: 'picture', at: 0, sourceOut: 8 }] },
    ],
  };
}

async function writeDefinition(dir: string, value: VideoDefinition) {
  const path = join(dir, 'edit.video.ts');
  await writeFile(path, `export default ${JSON.stringify(value)};\n`);
  return path;
}

async function frameHashes(path: string, stream = '0:v:0') {
  const result = await ffmpeg(
    '-i',
    path,
    '-map',
    stream,
    '-fps_mode',
    'passthrough',
    '-f',
    'framemd5',
    '-',
  );
  return result
    .split('\n')
    .filter((line) => /^0,/.test(line))
    .map((line) => line.split(',').at(-1)!.trim());
}

function audioHash(path: string) {
  return ffmpeg(
    '-i',
    path,
    '-map',
    '0:a:0',
    '-c:a',
    'pcm_f32le',
    '-f',
    'hash',
    '-',
  );
}

async function packets(path: string) {
  const { stdout } = await exec('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'packet=pts_time,duration_time',
    '-of',
    'json',
    path,
  ]);
  return (
    JSON.parse(stdout).packets as { pts_time: string; duration_time: string }[]
  ).map(
    ({ pts_time, duration_time }) =>
      [Number(pts_time), Number(duration_time)] as const,
  );
}

function near(actual: number, expected: number, tolerance = 0.000002) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} differs from ${expected}`,
  );
}

async function compiledPath(path: string, cacheDirectory: string) {
  const result = await compileVideo(path, { processing: { cacheDirectory } });
  return [...(await result.resolveRender()).sourceMetadata.keys()][0]!;
}

async function recipeBuild(file: string, cacheDirectory: string) {
  const steps: VideoProcessingProgress[] = [];
  const result = await compileVideo(file, {
    processing: {
      cacheDirectory,
      onProgress(event) {
        if (event.status === 'completed' || event.status === 'cache-hit')
          steps.push(event);
      },
    },
  });
  return {
    steps,
    path: [...(await result.resolveRender()).sourceMetadata.keys()][0]!,
  };
}

async function cacheFiles(directory: string) {
  return (await readdir(directory)).filter(
    (entry) => !entry.endsWith('.sqlite') && entry !== '.builds-v1',
  );
}

test('T49 rejects invalid effective rates and unordered scene boundaries during inspection', async (t) => {
  const dir = await scratch(t);
  await ffmpeg(
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=640x360:r=24:d=1',
    ...lossless,
    join(dir, 'src.mov'),
  );
  const file = await writeDefinition(
    dir,
    definition('src.mov', [{ type: 'interpolateFrames', numerator: 24 }]),
  );
  await assert.rejects(inspectVideoRecipes(file), /higher sampling rate/);
  await writeDefinition(
    dir,
    definition('src.mov', [
      {
        type: 'smoothSlowMotion',
        numerator: 48,
        speed: 0.5,
        sceneCuts: [0.5, 0.25],
      },
    ]),
  );
  await assert.rejects(
    inspectVideoRecipes(file),
    /Scene cuts must be strictly increasing/,
  );
});

test('T54 resolves preview and final interpolation separately and reuses equivalent offline work', async (t) => {
  const dir = await fixture(t);
  if (!dir) return;
  const { stdout } = await exec(process.execPath, [
    cli,
    'system',
    'inspect',
    '--json',
  ]);
  if (
    JSON.parse(stdout).videoToolbox.frameProcessors[
      'frame-rate-conversion-quality'
    ].status !== 'reported-supported'
  ) {
    t.skip('Offline VideoToolbox frame-rate conversion is unavailable.');
    return;
  }
  await ffmpeg(
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=640x360:r=24:d=0.5',
    '-vf',
    tagged,
    ...lossless,
    join(dir, 'motion.mov'),
  );
  const file = await writeDefinition(
    dir,
    definition('motion.mov', [{ type: 'interpolateFrames', numerator: 48 }]),
  );
  const events: VideoProcessingProgress[] = [];
  const processing = {
    cacheDirectory: join(dir, 'cache'),
    onProgress(event: VideoProcessingProgress) {
      if (event.status === 'completed' || event.status === 'cache-hit')
        events.push(event);
    },
  };
  const video = await compileVideo(file, { preview: true, processing });
  const review = await previewVideo(video).clip(
    { startFrame: 0, endFrame: 8 },
    join(dir, 'preview.mp4'),
  );
  assert.equal(review.quality, 'fast');
  assert.equal(events.length, 1);
  const final = await renderCompiledVideo(video, join(dir, 'quality.mp4'));
  assert.equal(final.quality, 'quality');
  assert.equal(events.length, 2);
  assert.notEqual(events[0]!.key, events[1]!.key);
  const maximum = await renderCompiledVideo(video, join(dir, 'maximum.mp4'), {
    quality: 'maximum',
  });
  assert.equal(maximum.quality, 'maximum');
  assert.match(maximum.warnings!.join('\n'), /same AI/);
  assert.equal(events[2]!.key, events[1]!.key);
  assert.deepEqual(
    events.map(({ status }) => status),
    ['completed', 'completed', 'cache-hit'],
  );
  const receipt = await inspectVideoBuild(file, { processing });
  assert.equal(receipt.steps[0]?.key, events[1]!.key);
  assert.deepEqual(
    receipt.renders.map(({ output, state }) => [output, state]).sort(),
    [
      [maximum.path, 'rendered'],
      [final.path, 'rendered'],
    ].sort(),
  );

  const replacement = join(dir, 'replacement.mov');
  await ffmpeg(
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=640x360:r=24:d=0.5',
    '-vf',
    `hflip,${tagged}`,
    ...lossless,
    replacement,
  );
  let status: import('@opencut/sdk').VideoWatchStatus | undefined;
  const watcher = await watchVideo(file, {
    processing,
    onStatus(event) {
      status = event;
    },
  });
  async function readyAfter(generation: number) {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (
        status?.status === 'ready' &&
        status.current &&
        status.current.generation > generation
      )
        return status.current;
      await delay(50);
    }
    assert.fail(
      `Expected a ready revision after ${generation}, got ${status?.status}`,
    );
  }
  try {
    const { generation } = await readyAfter(0);
    const exported = await watcher.withCurrent(generation, async (revision) => {
      await writeFile(join(dir, 'motion.mov'), await readFile(replacement));
      await readyAfter(generation);
      return renderCompiledVideo(revision, join(dir, 'pinned-quality.mp4'));
    });
    assert.deepEqual(
      await frameHashes(exported.path),
      await frameHashes(final.path),
    );
  } finally {
    await watcher.close();
  }

  await writeDefinition(
    dir,
    definition(
      'motion.mov',
      [{ type: 'interpolateFrames', numerator: 72 }],
      72,
    ),
  );
  const inspectArgs = [
    cli,
    'timeline',
    'inspect',
    file,
    '--frame',
    '0',
    '--json',
  ];
  const inspected = await exec(process.execPath, inspectArgs);
  assert.equal(JSON.parse(inspected.stdout).frame, 0);
  await assert.rejects(
    exec(process.execPath, [...inspectArgs, '--quality', 'fast']),
    /at most 2×/,
  );
});

test('T49 24→48 synthesizes frames, protects cuts and preserves pixels, tags and delayed PCM across repeated builds', async (t) => {
  const dir = await fixture(t);
  if (!dir) return;
  const source = join(dir, 'two-shots.mov');
  await ffmpeg(
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=640x360:r=24:d=0.5',
    '-f',
    'lavfi',
    '-i',
    'color=white:s=640x360:r=24:d=0.5',
    '-itsoffset',
    '0.125',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=0.75',
    '-filter_complex',
    `[0:v][1:v]concat=n=2:v=1:a=0,${tagged}[v]`,
    '-map',
    '[v]',
    '-map',
    '2:a',
    ...lossless,
    '-c:a',
    'pcm_s16le',
    source,
  );
  const value = definition('two-shots.mov', [
    { type: 'interpolateFrames', numerator: 48, quality: 'fast' },
  ]);
  const file = await writeDefinition(dir, value);
  const cache = join(dir, 'cache');
  for (const [output, status] of [
    ['first.mp4', /step 1: completed/],
    ['second.mp4', /step 1: cache-hit/],
  ] as const) {
    const { stderr } = await exec(
      process.execPath,
      [
        cli,
        'render',
        file,
        '--output',
        join(dir, output),
        '--recipe-cache',
        cache,
      ],
      { timeout: 30_000 },
    );
    assert.match(stderr, status);
  }
  const derived = await compiledPath(file, cache);
  assert.equal((await cacheFiles(cache)).length, 1);
  const original = await frameHashes(source);
  const result = await frameHashes(derived);
  assert.equal(result.length, 48);
  assert.deepEqual(
    result.filter((_, index) => index % 2 === 0),
    original,
  );
  assert.ok(
    original
      .slice(0, 10)
      .every(
        (hash, i) =>
          result[i * 2 + 1] !== hash && result[i * 2 + 1] !== original[i + 1],
      ),
  );
  assert.equal(result[23], original[11]);
  assert.equal(result[24], original[12]);
  assert.equal(result[47], original[23]);
  (await packets(derived)).forEach(([pts, duration], i) => {
    near(pts, i / 48);
    near(duration, 1 / 48);
  });
  const { video, audio } = await probeMedia(derived);
  assert.equal(video?.frameRate, 48);
  assert.deepEqual(
    [
      video?.durationSeconds,
      video?.colorRange,
      video?.colorSpace,
      video?.colorPrimaries,
      video?.colorTransfer,
    ],
    [1, 'tv', 'bt709', 'bt709', 'bt709'],
  );
  assert.deepEqual(
    [audio?.startTimeSeconds, audio?.durationSeconds],
    [0.125, 0.75],
  );
  assert.equal(await audioHash(derived), await audioHash(source));

  value.assets!.picture!.recipe = [
    { type: 'trim', start: 0.125, end: 0.625 },
    {
      type: 'interpolateFrames',
      numerator: 48,
      quality: 'fast',
      sceneCuts: [0.375],
    },
  ];
  await writeDefinition(dir, value);
  const trimmed = await frameHashes(await compiledPath(file, cache));
  assert.equal(trimmed.length, 24);
  assert.deepEqual(
    trimmed.filter((_, i) => i % 2 === 0),
    original.slice(3, 15),
  );
  assert.equal(trimmed[17], original[11]);
  assert.equal(trimmed[23], original[14]);
});

test('T49 30→60 works with portrait VFR timestamps and explicit cuts, and trims the final slow-motion packet', async (t) => {
  const dir = await fixture(t);
  if (!dir) return;
  const cache = join(dir, 'cache');
  const cfr = join(dir, 'portrait-cfr.mov');
  await ffmpeg(
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=360x480:r=30:d=0.4',
    ...lossless,
    cfr,
  );
  const cfrFile = await writeDefinition(
    dir,
    definition(
      'portrait-cfr.mov',
      [{ type: 'interpolateFrames', numerator: 60, quality: 'fast' }],
      60,
      360,
      480,
    ),
  );
  const doubled = await compiledPath(cfrFile, cache);
  const cfrFrames = await frameHashes(doubled);
  const cfrInput = await frameHashes(cfr);
  assert.equal(cfrFrames.length, 24);
  assert.deepEqual(
    cfrFrames.filter((_, i) => i % 2 === 0),
    cfrInput,
  );
  assert.notEqual(cfrFrames[1], cfrInput[0]);
  assert.notEqual(cfrFrames[1], cfrInput[1]);
  assert.equal((await probeMedia(doubled)).video?.frameRate, 60);
  const compiled = await compileVideo(cfrFile, {
    processing: { cacheDirectory: cache },
  });
  const delivery = await renderCompiledVideo(
    compiled,
    join(dir, 'portrait-4k60.mp4'),
    {
      quality: 'fast',
      codec: 'hevc',
      outputSize: { width: 2880, height: 3840 },
      outputFrameRate: { numerator: 60, denominator: 1 },
    },
  );
  assert.deepEqual(
    [
      delivery.width,
      delivery.height,
      delivery.metadata.video?.frameRate,
      delivery.frameCount,
    ],
    [2880, 3840, 60, 8],
  );
  assert.match(
    delivery.warnings?.join('\n') ?? '',
    /scales the 360×480 composed picture/,
  );

  const source = join(dir, 'portrait.mov');
  await ffmpeg(
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=360x640:r=30:d=0.4',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=0.4',
    '-vf',
    `setpts='if(lt(N,4),N,N+2)',${tagged}`,
    '-c:a',
    'aac',
    '-fps_mode',
    'passthrough',
    ...lossless,
    source,
  );
  const value = definition(
    'portrait.mov',
    [
      {
        type: 'interpolateFrames',
        numerator: 60,
        sceneThreshold: 100,
        sceneCuts: [0.2],
      },
    ],
    60,
    360,
    640,
  );
  const file = await writeDefinition(dir, value);
  const derived = await compiledPath(file, cache);
  const input = await probeMedia(source);
  const output = await probeMedia(derived);
  assert.ok(input.hasAudio && output.hasAudio);
  near(output.audio!.durationSeconds!, input.audio!.durationSeconds!);
  assert.deepEqual([output.video?.width, output.video?.height], [360, 640]);
  near(output.video!.durationSeconds!, input.video!.durationSeconds!);
  const frames = await frameHashes(derived);
  assert.equal(frames.length, 28);
  assert.deepEqual(frames.slice(6, 12), Array(6).fill(frames[6]));
  assert.notEqual(frames[12], frames[6]);
  assert.notEqual(frames[1], frames[0]);
  assert.notEqual(frames[1], frames[2]);

  value.assets!.picture!.recipe = [
    {
      type: 'smoothSlowMotion',
      speed: 0.47,
      numerator: 30,
      quality: 'quality',
    },
  ];
  await writeDefinition(dir, value);
  const slow = await compiledPath(file, cache);
  const slowMedia = await probeMedia(slow);
  const duration = input.video!.durationSeconds! / 0.47;
  near(slowMedia.video!.durationSeconds!, duration);
  assert.equal(slowMedia.hasAudio, false);
  const slowPackets = await packets(slow);
  assert.equal(slowPackets.length, Math.ceil(duration * 30));
  for (const [i, [pts, packetDuration]] of slowPackets.entries()) {
    near(pts, i / 30);
    near(packetDuration, Math.min(1 / 30, duration - pts));
  }
  assert.equal((await cacheFiles(cache)).length, 3);
});

test('T49 preserves a picture offset between target ticks and keeps early audio aligned', async (t) => {
  const dir = await fixture(t);
  if (!dir) return;
  const source = join(dir, 'late-picture.mov');
  await ffmpeg(
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=640x360:r=24:d=0.5',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=0.5',
    '-vf',
    'settb=1/24000,setpts=PTS+3001',
    '-enc_time_base:v',
    '1:24000',
    '-fps_mode',
    'passthrough',
    ...lossless,
    '-c:a',
    'pcm_s16le',
    '-video_track_timescale',
    '24000',
    '-movie_timescale',
    '24000',
    source,
  );
  const file = await writeDefinition(
    dir,
    definition('late-picture.mov', [
      { type: 'interpolateFrames', numerator: 48, quality: 'fast' },
    ]),
  );
  const derived = await compiledPath(file, join(dir, 'cache'));
  const input = await probeMedia(source);
  const output = await probeMedia(derived);
  near(input.video!.startTimeSeconds!, 3001 / 24000);
  near(output.video!.startTimeSeconds!, input.video!.startTimeSeconds!);
  assert.equal(output.audio?.startTimeSeconds, 0);
  assert.equal(output.audio?.durationSeconds, 0.5);
  assert.deepEqual(
    (await frameHashes(derived)).filter((_, i) => i % 2 === 0),
    await frameHashes(source),
  );
  (await packets(derived)).forEach(([pts, duration], i) => {
    near(pts, 3001 / 24000 + i / 48);
    near(duration, 1 / 48);
  });
});

test('T49 rebases retained picture and audio when an earlier track is discarded', async (t) => {
  const dir = await fixture(t);
  if (!dir) return;
  const source = join(dir, 'multitrack.mov');
  await ffmpeg(
    '-f',
    'lavfi',
    '-i',
    'color=black:s=320x180:r=24:d=1',
    '-itsoffset',
    '0.125',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=640x360:r=24:d=1',
    '-itsoffset',
    '0.25',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=0.5',
    '-map',
    '0:v',
    '-map',
    '1:v',
    '-map',
    '2:a',
    '-disposition:v:0',
    '0',
    '-disposition:v:1',
    'default',
    ...lossless,
    '-c:a',
    'pcm_s16le',
    source,
  );
  const input = await probeMedia(source);
  assert.equal(input.startTimeSeconds, 0);
  assert.equal(input.video?.startTimeSeconds, 0.125);
  assert.equal(input.audio?.startTimeSeconds, 0.25);
  const file = await writeDefinition(
    dir,
    definition('multitrack.mov', [
      { type: 'interpolateFrames', numerator: 48, quality: 'fast' },
    ]),
  );
  const cache = join(dir, 'cache');
  const fresh = await recipeBuild(file, cache);
  const cached = await recipeBuild(file, cache);
  assert.deepEqual(
    fresh.steps.map(({ status }) => status),
    ['completed'],
  );
  assert.deepEqual(
    cached.steps.map(({ status }) => status),
    ['cache-hit'],
  );
  assert.equal(cached.path, fresh.path);
  const output = await probeMedia(cached.path);
  assert.equal(output.streams.length, 2);
  assert.equal(output.startTimeSeconds, 0);
  assert.equal(output.video?.startTimeSeconds, 0);
  assert.equal(output.video?.durationSeconds, 1);
  assert.equal(output.audio?.startTimeSeconds, 0.125);
  assert.equal(output.audio?.durationSeconds, 0.5);
  assert.deepEqual(
    (await frameHashes(cached.path)).filter((_, i) => i % 2 === 0),
    await frameHashes(source, '0:v:1'),
  );
  assert.equal(await audioHash(cached.path), await audioHash(source));
  const { media } = (await inspectVideoRecipes(file)).recipes[0]!.steps[0]!;
  assert.equal(media.videoStartSeconds, 0);
  assert.equal(media.audioStartSeconds, 0.125);
});

test('T49 chains interpolation at the declared cadence after a partial final frame', async (t) => {
  const dir = await fixture(t);
  if (!dir) return;
  const source = join(dir, 'short.mov');
  await ffmpeg(
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=640x360:r=25:d=0.24',
    ...lossless,
    source,
  );
  const file = await writeDefinition(
    dir,
    definition(
      'short.mov',
      [
        { type: 'interpolateFrames', numerator: 48 },
        { type: 'interpolateFrames', numerator: 50 },
      ],
      50,
    ),
  );
  const { recipes } = await inspectVideoRecipes(file);
  assert.deepEqual(
    recipes[0]!.steps.map(({ media }) => media.frameRate),
    [48, 50],
  );

  const cache = join(dir, 'cache');
  const fresh = await recipeBuild(file, cache);
  const cached = await recipeBuild(file, cache);
  assert.deepEqual(
    fresh.steps.map(({ status }) => status),
    ['completed', 'completed'],
  );
  assert.deepEqual(
    cached.steps.map(({ status }) => status),
    ['cache-hit', 'cache-hit'],
  );
  assert.equal(cached.path, fresh.path);

  const intermediate = join(cache, fresh.steps[0]!.key, 'media.mov');
  const firstPackets = await packets(intermediate);
  assert.equal(firstPackets.length, 12);
  const [lastPts, lastDuration] = firstPackets.at(-1)!;
  near(lastPts, 11 / 48);
  near(lastDuration, 0.24 - 11 / 48);
  assert.ok((await probeMedia(intermediate)).video!.frameRate! >= 50);
  await rm(join(cache, fresh.steps[1]!.key), { recursive: true });
  const rebuilt = await recipeBuild(file, cache);
  assert.deepEqual(
    rebuilt.steps.map(({ status }) => status),
    ['cache-hit', 'completed'],
  );
  assert.equal(rebuilt.path, fresh.path);
  const finalPackets = await packets(rebuilt.path);
  assert.equal(finalPackets.length, 12);
  for (const [i, [pts, duration]] of finalPackets.entries()) {
    near(pts, i / 50);
    near(duration, 1 / 50);
  }
});

test('T49 preserves short audio when the input declares only picture duration', async (t) => {
  const dir = await fixture(t);
  if (!dir) return;
  const source = join(dir, 'short-audio.avi');
  await ffmpeg(
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=640x360:r=24:d=1',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=0.25',
    ...lossless,
    '-c:a',
    'pcm_s16le',
    source,
  );
  const input = await probeMedia(source);
  assert.equal(input.video?.durationSeconds, 1);
  assert.equal(input.audio?.durationSeconds, null);

  const file = await writeDefinition(
    dir,
    definition('short-audio.avi', [
      { type: 'interpolateFrames', numerator: 48 },
    ]),
  );
  const derived = await compiledPath(file, join(dir, 'cache'));
  const { video, audio } = await probeMedia(derived);
  assert.equal(video?.durationSeconds, 1);
  assert.deepEqual(
    [audio?.startTimeSeconds, audio?.durationSeconds],
    [0, 0.25],
  );
  assert.equal(await audioHash(derived), await audioHash(source));
});

test('T49 limits and cancellation leave no published output and allow a clean retry', async (t) => {
  const dir = await fixture(t);
  if (!dir) return;
  await ffmpeg(
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=640x360:r=24:d=1',
    ...lossless,
    join(dir, 'src.mov'),
  );
  const file = await writeDefinition(
    dir,
    definition('src.mov', [{ type: 'interpolateFrames', numerator: 48 }]),
  );
  const cacheDirectory = join(dir, 'cache');
  await assert.rejects(
    compileVideo(file, {
      processing: { cacheDirectory, maxBufferedFrames: 2 },
    }),
    /at least 3 frames/,
  );
  assert.deepEqual(await cacheFiles(cacheDirectory), []);
  await assert.rejects(
    compileVideo(file, {
      processing: { cacheDirectory, maxTemporaryBytes: 1024 },
    }),
    /temporary file limit|AI interpolation failed/,
  );
  assert.deepEqual(await cacheFiles(cacheDirectory), []);

  const abort = new AbortController();
  const reason = new Error('stop active interpolation');
  await assert.rejects(
    compileVideo(file, {
      signal: abort.signal,
      processing: {
        cacheDirectory,
        onProgress(event) {
          if (event.status === 'processing') abort.abort(reason);
        },
      },
    }),
    reason,
  );
  assert.deepEqual(await cacheFiles(cacheDirectory), []);
  const retry = await compiledPath(file, cacheDirectory);
  assert.equal((await frameHashes(retry)).length, 48);
  assert.equal((await cacheFiles(cacheDirectory)).length, 1);

  await ffmpeg(
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=640x360:r=24:d=1',
    ...lossless,
    '-vf',
    'setparams=range=pc',
    join(dir, 'full.mov'),
  );
  await writeDefinition(
    dir,
    definition('full.mov', [{ type: 'interpolateFrames', numerator: 48 }]),
  );
  await assert.rejects(
    compileVideo(file, { processing: { cacheDirectory } }),
    /8-bit, video-range SDR/,
  );
  assert.equal((await cacheFiles(cacheDirectory)).length, 1);
});

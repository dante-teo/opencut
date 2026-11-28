import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
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
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  compileVideo,
  inspectVideoRecipes,
  packageVideo,
  probeMedia,
  renderVideo,
  watchVideo,
} from '@opencut/sdk';
import type {
  VideoDefinition,
  VideoProcessingProgress,
  VideoRecipe,
  VideoWatchRevision,
  VideoWatchStatus,
} from '@opencut/sdk';
import { fixtureDirectory } from '../fixture-paths.js';

const exec = promisify(execFile);
const cli = fileURLToPath(
  new URL('../../apps/cli/dist/index.js', import.meta.url),
);
const hasWorker =
  platform() === 'darwin' &&
  arch() === 'arm64' &&
  Number(release().split('.')[0]) >= 25 &&
  existsSync(
    new URL('../../packages/media/dist/video-enhance', import.meta.url),
  );
const tagged =
  'setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709';

interface Processor {
  status: string;
  testedSizes?: {
    width: number;
    height: number;
    configurations: { scale: number; status: string; modelStatus: string }[];
  }[];
}

async function processors() {
  if (!hasWorker) return {};
  const { stdout } = await exec(
    process.execPath,
    [cli, 'system', 'inspect', '--json'],
    { timeout: 20_000 },
  );
  const result = JSON.parse(stdout);
  assert.equal(result.videoToolbox.status, 'probed');
  return result.videoToolbox.frameProcessors as Record<string, Processor>;
}

const capabilities = processors();

function configurations(
  processor: Processor | undefined,
  width: number,
  height: number,
) {
  const size = processor?.testedSizes?.find(
    (tested) => tested.width === width && tested.height === height,
  );
  return size ? size.configurations : [];
}

async function supportsFastPreset() {
  const processor = (await capabilities)['low-latency-super-resolution'];
  return configurations(processor, 640, 360).some(
    (config) =>
      config.scale === 1.5 && config.status === 'configuration-accepted',
  );
}

const preset = {
  type: 'superResolution',
  backend: 'videotoolbox',
  width: 960,
  height: 540,
} as const;

async function scratch(t: TestContext) {
  await mkdir(fixtureDirectory, { recursive: true });
  const dir = await mkdtemp(join(fixtureDirectory, 't50-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function ffmpeg(...args: string[]) {
  return exec('ffmpeg', ['-hide_banner', '-v', 'error', ...args], {
    timeout: 30_000,
  });
}

async function makeSource(
  directory: string,
  width: number,
  height: number,
  frames: number,
  filter = tagged,
) {
  const output = join(directory, 'source.mov');
  await ffmpeg(
    '-f',
    'lavfi',
    '-i',
    `testsrc2=s=${width}x${height}:r=24:d=${frames / 24}`,
    '-itsoffset',
    '0.125',
    '-f',
    'lavfi',
    '-i',
    'sine=sample_rate=48000:duration=0.125',
    '-vf',
    filter,
    '-fps_mode',
    'passthrough',
    '-c:v',
    'libx264',
    '-threads:v',
    '1',
    '-preset',
    'ultrafast',
    '-qp',
    '0',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'pcm_s16le',
    output,
  );
  return output;
}

async function writeDefinition(
  directory: string,
  width: number,
  height: number,
  recipe: VideoRecipe,
  stem = 'edit',
) {
  const definition: VideoDefinition = {
    canvas: { width, height, frameRate: 24, durationFrames: 4 },
    assets: { picture: { kind: 'video', path: 'source.mov', recipe } },
    tracks: [
      { type: 'video', clips: [{ asset: 'picture', at: 0, sourceOut: 4 }] },
    ],
  };
  const path = join(directory, stem + '.video.ts');
  await writeFile(path, `export default ${JSON.stringify(definition)};\n`);
  return path;
}

async function compiledMedia(
  file: string,
  cacheDirectory: string,
  events: VideoProcessingProgress[] = [],
) {
  const compiled = await compileVideo(file, {
    processing: { cacheDirectory, onProgress: (event) => events.push(event) },
  });
  return [...(await compiled.resolveRender()).sourceMetadata.keys()][0]!;
}

async function published(cache: string) {
  const names = await readdir(cache);
  assert.ok(names.every((name) => !name.endsWith('.stage')));
  return names.filter((name) => /^[a-f0-9]{64}$/.test(name)).sort();
}

async function videoPackets(path: string) {
  const { stdout } = await exec('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'packet=pts_time,duration_time',
    '-of',
    'compact=p=0:nk=1',
    path,
  ]);
  return stdout
    .trim()
    .split('\n')
    .map((line) => line.split('|').map(Number));
}

async function audioHash(path: string) {
  return (
    await ffmpeg(
      '-i',
      path,
      '-map',
      '0:a:0',
      '-c:a',
      'pcm_f32le',
      '-f',
      'hash',
      '-',
    )
  ).stdout;
}

async function frameHashes(path: string, filter: string) {
  const { stdout } = await ffmpeg(
    '-i',
    path,
    '-an',
    '-vf',
    filter,
    '-f',
    'framemd5',
    '-',
  );
  return stdout
    .split('\n')
    .filter((line) => /^0,/.test(line))
    .map((line) => line.split(',').at(-1)!.trim());
}

test('T50 checks recipe declarations without running an enhancement backend', async (t) => {
  const dir = await scratch(t);
  await makeSource(dir, 640, 360, 12);
  const valid = await writeDefinition(dir, 960, 540, [preset]);
  const {
    recipes: [inspection],
  } = await inspectVideoRecipes(valid);
  assert.deepEqual(inspection?.steps[0]?.parameters, {
    ...preset,
    quality: 'quality',
  });
  assert.equal(inspection?.steps[0]?.media.width, 960);
  const mismatch = await writeDefinition(dir, 960, 544, [
    { ...preset, height: 544 },
  ]);
  await assert.rejects(inspectVideoRecipes(mismatch), /original aspect ratio/);
  const overScale = await writeDefinition(dir, 1920, 1080, [
    {
      ...preset,
      width: 1920,
      height: 1080,
      quality: 'fast',
    },
  ]);
  await assert.rejects(inspectVideoRecipes(overScale), /2× at this quality/);
});

test('T50 inspection rebases retained streams before planning a trim', async (t) => {
  const dir = await scratch(t);
  const source = join(dir, 'source.mov');
  await ffmpeg(
    '-f',
    'lavfi',
    '-i',
    'color=black:s=320x180:r=24:d=1',
    '-itsoffset',
    '0.25',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=640x360:r=24:d=1',
    '-itsoffset',
    '0.375',
    '-f',
    'lavfi',
    '-i',
    'sine=sample_rate=48000:duration=0.5',
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
    '-c:v',
    'libx264',
    '-threads:v',
    '1',
    '-preset',
    'ultrafast',
    '-qp',
    '0',
    '-c:a',
    'pcm_s16le',
    source,
  );
  const input = await probeMedia(source);
  assert.equal(input.startTimeSeconds, 0);
  assert.equal(input.video?.startTimeSeconds, 0.25);
  assert.equal(input.audio?.startTimeSeconds, 0.375);
  const trim = { type: 'trim', start: 0, end: 0.25 } as const;
  const denoise = { type: 'denoise' } as const;
  const upscale = { ...preset, quality: 'fast' } as const;
  const denoiseFile = await writeDefinition(dir, 640, 360, [denoise, trim]);
  const upscaleFile = await writeDefinition(
    dir,
    960,
    540,
    [upscale, trim],
    'upscale',
  );
  for (const file of [denoiseFile, upscaleFile]) {
    const {
      recipes: [recipe],
    } = await inspectVideoRecipes(file);
    const [enhanced, trimmed] = recipe!.steps;
    assert.equal(enhanced?.media.videoStartSeconds, 0);
    assert.equal(enhanced?.media.audioStartSeconds, 0.125);
    assert.equal(enhanced?.media.audioDurationSeconds, 0.625);
    assert.equal(trimmed?.media.durationSeconds, 0.25);
    assert.equal(trimmed?.media.audioStartSeconds, 0.125);
    assert.equal(trimmed?.media.audioDurationSeconds, 0.25);
  }

  if (await supportsFastPreset()) {
    const output = await compiledMedia(upscaleFile, join(dir, 'cache'));
    const trimmed = await probeMedia(output);
    assert.equal(trimmed.video?.startTimeSeconds, 0);
    assert.equal(trimmed.video?.durationSeconds, 0.25);
    assert.equal(trimmed.audio?.startTimeSeconds, 0.125);
    assert.equal(trimmed.audio?.durationSeconds, 0.125);
  }
});

for (const {
  quality,
  processor,
  nativeScale,
  sourceSize,
  targetSize,
  matrix,
} of [
  {
    quality: 'fast',
    processor: 'low-latency-super-resolution',
    nativeScale: 2,
    sourceSize: [640, 360],
    targetSize: [1280, 720],
    matrix: 'smpte170m',
  },
  {
    quality: 'quality',
    processor: 'video-super-resolution',
    nativeScale: 4,
    sourceSize: [1280, 720],
    targetSize: [1920, 1080],
    matrix: 'bt709',
  },
] as const) {
  const [sourceWidth, sourceHeight] = sourceSize;
  test(`T50 ${quality} preserves the display matrix of untagged video`, async (t) => {
    if (
      !configurations(
        (await capabilities)[processor],
        sourceWidth,
        sourceHeight,
      ).some(
        (config) =>
          config.scale === nativeScale &&
          config.status === 'configuration-accepted' &&
          (quality === 'fast' || config.modelStatus === 'ready'),
      )
    )
      return t.skip(
        `VideoToolbox does not report the ${quality} preset at ${sourceSize.join('×')}.`,
      );
    const dir = await scratch(t);
    const source = await makeSource(dir, sourceWidth, sourceHeight, 4, 'null');
    assert.equal((await probeMedia(source)).video?.colorSpace, null);
    const [width, height] = targetSize;
    const file = await writeDefinition(dir, width, height, [
      { ...preset, width, height, quality },
    ]);
    const derived = await compiledMedia(file, join(dir, 'cache'));
    assert.equal((await probeMedia(derived)).video?.colorSpace, matrix);
  });
}

test(
  'T50 uses real fast inference, retains sync and tags, and shares the recipe cache with preview and render',
  { timeout: 30_000 },
  async (t) => {
    if (!(await supportsFastPreset()))
      return t.skip('VideoToolbox does not report 640×360 at 1.5×.');
    const dir = await scratch(t);
    const source = await makeSource(dir, 640, 360, 12);
    const bytes = await readFile(source);
    const cache = join(dir, 'cache');
    const trim = { type: 'trim', start: 0.041666, end: 0.375 } as const;
    const fastStep = { ...preset, quality: 'fast' } as const;
    const file = await writeDefinition(dir, 960, 540, [trim, fastStep]);
    const events: VideoProcessingProgress[] = [];
    const derived = await compiledMedia(file, cache, events);
    const trimEvent = events.find(
      (event) => event.step === 0 && event.status === 'completed',
    );
    assert.ok(trimEvent);
    assert.ok(
      events.some((event) => event.step === 1 && event.status === 'processing'),
    );
    const selected = join(cache, trimEvent.key, 'media.mov');
    const metadata = await probeMedia(derived);
    assert.deepEqual(
      [
        metadata.video?.width,
        metadata.video?.height,
        metadata.video?.colorSpace,
        metadata.video?.colorPrimaries,
        metadata.video?.colorTransfer,
        metadata.video?.colorRange,
      ],
      [960, 540, 'bt709', 'bt709', 'bt709', 'tv'],
    );
    assert.deepEqual(await videoPackets(derived), await videoPackets(selected));
    assert.equal(await audioHash(derived), await audioHash(selected));
    assert.equal(
      metadata.audio?.startTimeSeconds,
      (await probeMedia(selected)).audio?.startTimeSeconds,
    );
    const actual = await frameHashes(derived, 'null');
    const lanczos = await frameHashes(selected, 'scale=960:540:flags=lanczos');
    assert.ok(actual.length >= 6 && actual.length === lanczos.length);
    assert.ok(actual.every((hash, index) => hash !== lanczos[index]));
    assert.ok(new Set(actual).size > 1);
    const reused: VideoProcessingProgress[] = [];
    assert.equal(await compiledMedia(file, cache, reused), derived);
    assert.deepEqual(
      reused.map((event) => event.status),
      ['cache-hit', 'cache-hit'],
    );
    const rendered = join(dir, 'rendered.mp4');
    await renderVideo(file, rendered, {
      processing: { cacheDirectory: cache },
    });
    assert.equal((await videoPackets(rendered)).length, 4);
    const { video: finalVideo } = await probeMedia(rendered);
    assert.deepEqual(
      [
        finalVideo?.colorRange,
        finalVideo?.colorSpace,
        finalVideo?.colorPrimaries,
        finalVideo?.colorTransfer,
      ],
      ['tv', 'bt709', 'bt709', 'bt709'],
    );

    let onStatus!: (event: VideoWatchStatus) => void;
    const ready = new Promise<VideoWatchRevision>((resolve, reject) => {
      onStatus = (event) => {
        if (event.status === 'error') reject(new Error(event.error));
        if (event.status === 'ready' && event.current) resolve(event.current);
      };
    });
    const watch = await watchVideo(file, {
      processing: { cacheDirectory: cache },
      maxDimension: 960,
      signal: t.signal,
      onStatus,
    });
    try {
      const revision = await ready;
      const [snapshot] = (
        await revision.video.resolveRender()
      ).sourceMetadata.keys();
      assert.deepEqual(await readFile(snapshot!), await readFile(derived));
    } finally {
      await watch.close();
    }

    const qualityChange: VideoProcessingProgress[] = [];
    const high = (await capabilities)['video-super-resolution'];
    const highReady = configurations(high, 640, 360).some(
      (config) => config.scale === 4 && config.modelStatus === 'ready',
    );
    if (highReady) {
      await writeDefinition(dir, 960, 540, [trim, preset]);
      assert.notEqual(await compiledMedia(file, cache, qualityChange), derived);
      assert.deepEqual(
        qualityChange
          .filter(
            ({ status }) => status === 'completed' || status === 'cache-hit',
          )
          .map(({ status }) => status),
        ['cache-hit', 'completed'],
      );
    }

    const change: VideoProcessingProgress[] = [];
    await writeDefinition(dir, 960, 540, [{ ...trim, start: 0 }, fastStep]);
    assert.notEqual(await compiledMedia(file, cache, change), derived);
    assert.equal(
      change.filter(({ status }) => status === 'completed').length,
      2,
    );
    assert.equal((await published(cache)).length, highReady ? 5 : 4);
    assert.deepEqual(await readFile(source), bytes);
  },
);

test('T50 high quality produces portrait UHD and composes with T49', async (t) => {
  const support = await capabilities;
  if (
    !configurations(support['video-super-resolution'], 1280, 720).some(
      (config) => config.scale === 4 && config.modelStatus === 'ready',
    )
  )
    return t.skip(
      'Apple 4× video model is unavailable or not ready at 1280×720.',
    );
  const dir = await scratch(t);
  const source = await makeSource(dir, 720, 1280, 6);
  const cache = join(dir, 'cache');
  const file = await writeDefinition(dir, 2160, 3840, [
    { ...preset, width: 2160, height: 3840 },
  ]);
  const output = await compiledMedia(file, cache);
  const { video } = await probeMedia(output);
  assert.deepEqual(
    [video?.width, video?.height, video?.rotation, video?.sampleAspectRatio],
    [2160, 3840, 0, 1],
  );
  assert.deepEqual(await videoPackets(output), await videoPackets(source));
  assert.equal(await audioHash(output), await audioHash(source));

  if (support['low-latency-interpolation']?.status !== 'reported-supported')
    return;
  const chain = await writeDefinition(dir, 1080, 1920, [
    { type: 'interpolateFrames', numerator: 30 },
    { ...preset, width: 1080, height: 1920 },
  ]);
  const resolved = await compiledMedia(chain, cache);
  const packets = await videoPackets(resolved);
  assert.equal(packets.length, 8);
  assert.deepEqual(packets.at(-1), [0.233333, 0.016667]);
});

test('T50 cancellation and bounded failures publish no media and allow retry', async (t) => {
  if (!hasWorker)
    return t.skip(
      'Build the enhancement worker on Apple Silicon with macOS 26+.',
    );
  const dir = await scratch(t);
  await makeSource(dir, 640, 360, 8, 'null');
  const cache = join(dir, 'cache');
  const file = await writeDefinition(dir, 960, 540, [
    { ...preset, quality: 'fast' },
  ]);
  if (!(await supportsFastPreset())) return;
  const controller = new AbortController();
  const cancelled = new Error('Stopped T50 processing');
  await assert.rejects(
    compileVideo(file, {
      signal: controller.signal,
      processing: {
        cacheDirectory: cache,
        onProgress({ status }) {
          if (status === 'processing') controller.abort(cancelled);
        },
      },
    }),
    cancelled,
  );
  assert.deepEqual(await published(cache), []);
  await assert.rejects(
    compileVideo(file, {
      processing: { cacheDirectory: cache, maxTemporaryBytes: 1024 },
    }),
    /temporary file limit/,
  );
  assert.deepEqual(await published(cache), []);
  const retried = await compiledMedia(file, cache);
  assert.equal((await probeMedia(retried)).video?.colorRange, 'tv');
  assert.equal((await published(cache)).length, 1);

  const bad = join(dir, 'bad');
  await mkdir(bad);
  await makeSource(bad, 640, 360, 8, `${tagged},setparams=color_trc=smpte2084`);
  const hdr = await writeDefinition(bad, 960, 540, [
    { ...preset, quality: 'fast' },
  ]);
  await assert.rejects(
    compiledMedia(hdr, cache),
    /HDR and alpha are unsupported/,
  );
  assert.equal((await published(cache)).length, 1);

  const variable = join(dir, 'variable');
  await mkdir(variable);
  await makeSource(variable, 640, 360, 8, `${tagged},setpts=PTS+gte(N\\,4)`);
  const vfr = await writeDefinition(variable, 960, 540, [
    { ...preset, quality: 'fast' },
  ]);
  await assert.rejects(
    compiledMedia(vfr, cache),
    /constant frame cadence|video packet timing/,
  );
  assert.equal((await published(cache)).length, 1);
});

test('T50 denoise uses a temporal model where supported and fails explicitly otherwise', async (t) => {
  if (!hasWorker)
    return t.skip(
      'Build the enhancement worker on Apple Silicon with macOS 26+.',
    );
  const dir = await scratch(t);
  const source = await makeSource(
    dir,
    640,
    360,
    8,
    `${tagged},noise=alls=15:allf=t+u`,
  );
  const cache = join(dir, 'cache');
  const file = await writeDefinition(dir, 640, 360, [
    { type: 'denoise', strength: 'strong' },
  ]);
  const processor = (await capabilities)['temporal-noise-filter'];
  if (processor?.status === 'hardware-unsupported') {
    await assert.rejects(
      compiledMedia(file, cache),
      /temporal denoising is unsupported/,
    );
    assert.deepEqual(await published(cache), []);
    return;
  }
  if (
    !configurations(processor, 640, 360).some(
      (config) => config.status === 'configuration-accepted',
    )
  )
    return t.skip(
      'VideoToolbox does not report temporal denoising at 640×360.',
    );
  const result = await compiledMedia(file, cache);
  assert.deepEqual(await videoPackets(result), await videoPackets(source));
  assert.equal(await audioHash(result), await audioHash(source));
  assert.notDeepEqual(
    await frameHashes(result, 'null'),
    await frameHashes(source, 'null'),
  );
});

test('enhancement packages keep the existing v4 backend contract', async (t) => {
  const directory = await scratch(t);
  await makeSource(directory, 640, 360, 6);
  const definition = await writeDefinition(directory, 640, 360, [
    { type: 'denoise', strength: 'medium' },
  ]);
  const { entry, manifest } = await packageVideo(
    definition,
    join(directory, 'bundle'),
  );

  assert.equal(
    manifest.requirements.native.find(({ kind }) => kind === 'enhancement')
      ?.version,
    'videotoolbox-enhancement-v4',
  );
  await inspectVideoRecipes(entry);
});

test('shared pixel transfer preserves conversion across padded rows and strips', async (t) => {
  if (!hasWorker)
    return t.skip('Requires the Apple Silicon enhancement worker.');
  const directory = await scratch(t);
  const binary = join(directory, 'transfer');
  await exec(
    '/usr/bin/clang',
    [
      '-O2',
      '-fobjc-arc',
      '-Wall',
      '-Wextra',
      '-Werror',
      'tests/integration/pixel-transfer.m',
      'packages/media/native/pixel-transfer.m',
      '-o',
      binary,
      ...['Foundation', 'CoreVideo', 'Accelerate'].flatMap((framework) => [
        '-framework',
        framework,
      ]),
    ],
    { timeout: 30_000 },
  );
  await exec(binary, [], { timeout: 15_000 });
});

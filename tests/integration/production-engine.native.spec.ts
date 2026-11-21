import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { compileVideo, previewVideo, watchVideo } from '@opencut/sdk';
import type { VideoDefinition, VideoWatchStatus } from '@opencut/sdk';
import { fixtureDirectory } from '../fixture-paths.js';
import { requireTool, runTool } from '../../scripts/fixture-lib.js';

const adapterFixtures = join(fixtureDirectory, 'reference-motion', 'assets');
const cli = fileURLToPath(
  new URL('../../apps/cli/dist/index.js', import.meta.url),
);

before(() => {
  runTool('python3', [
    fileURLToPath(new URL('../reference-motion/fixtures.py', import.meta.url)),
    '--adapters-only',
  ]);
});

function run(...args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args, '--json'], {
    encoding: 'utf8',
    timeout: 120000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const frameRgb = (file: string) => {
  const result = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      file,
      '-frames:v',
      '1',
      '-threads',
      '1',
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      'pipe:1',
    ],
    { maxBuffer: 8 * 1024 * 1024 },
  );
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
};
const stable = (
  source: string,
  x: number,
  y: number,
  expected: number[],
  tolerance = 6,
) => {
  const data = frameRgb(source);
  for (const [i, channel] of expected.entries()) {
    const actual = data[(y * 64 + x) * 3 + i]!;
    assert.ok(
      Math.abs(actual - channel) <= tolerance,
      `Pixel ${x},${y} channel ${i}: ${actual}; expected ${channel}`,
    );
  }
};

test('an isolated track group applies opacity once and applies a matte and blend to lower-track footage', async () => {
  requireTool('ffmpeg');
  requireTool('ffprobe');
  await mkdir(fixtureDirectory, { recursive: true });
  const directory = await mkdtemp(join(fixtureDirectory, 'isolated-group-'));
  try {
    const video = join(directory, 'source.mp4');
    const backdrop = (color: string, path: string) =>
      runTool('ffmpeg', [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        `color=c=${color}:s=64x64:r=24:d=1`,
        '-c:v',
        'libx264',
        '-threads',
        '1',
        '-pix_fmt',
        'yuv420p',
        path,
      ]);
    backdrop('0xff8040', video);
    const svg = (x: number, width: number, alpha: number) =>
      `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect x="${x}" y="0" width="${width}" height="64" fill="#00ff00" fill-opacity="${alpha}"/></svg>`;
    for (const [id, src] of Object.entries({
      a: svg(0, 48, 0.5),
      b: svg(16, 48, 0.5),
      mask: svg(0, 32, 1),
    }))
      await writeFile(join(directory, id + '.svg'), src);
    const asset = (id: string) => ({
      kind: 'graphic' as const,
      renderer: 'svg' as const,
      path: id + '.svg',
    });
    const definition: VideoDefinition = {
      version: 3,
      canvas: {
        width: 64,
        height: 64,
        frameRate: 24,
        durationFrames: 12,
        backgroundColor: '#000000',
      },
      assets: {
        one: asset('a'),
        two: asset('b'),
        window: asset('mask'),
        footage: { kind: 'video', path: 'source.mp4' },
      },
      tracks: [
        {
          type: 'video',
          id: 'first',
          clips: [{ asset: 'one', at: 0, duration: 12 }],
        },
        {
          type: 'video',
          id: 'second',
          clips: [{ asset: 'two', at: 0, duration: 12 }],
        },
      ],
      visualGroups: [
        { id: 'isolated', tracks: ['first', 'second'], opacity: 0.5 },
      ],
    };
    const path = join(directory, 'groups.video.json');
    await writeFile(path, JSON.stringify(definition));
    const opacity = join(directory, 'opacity.png');
    await previewVideo(await compileVideo(path)).frame(0, opacity);
    stable(opacity, 6, 28, [0, 64, 0]);
    stable(opacity, 30, 28, [0, 96, 0]);
    definition.canvas.backgroundColor = '#80ffff';
    definition.tracks = [
      {
        type: 'video',
        id: 'real-source',
        clips: [{ asset: 'footage', at: 0, sourceOut: 12 }],
      },
      {
        type: 'video',
        id: 'second',
        clips: [{ asset: 'two', at: 0, duration: 12 }],
      },
      {
        type: 'video',
        id: 'matte-track',
        clips: [{ asset: 'window', at: 0, duration: 12 }],
      },
    ];
    definition.visualGroups = [
      {
        id: 'composite',
        tracks: ['second', 'matte-track'],
        matte: 'matte-track',
        blend: 'multiply',
      },
    ];
    await writeFile(path, JSON.stringify(definition));
    const matte = join(directory, 'multiply.png');
    await previewVideo(await compileVideo(path)).frame(0, matte);
    stable(matte, 25, 28, [128, 128, 32]);
    stable(matte, 51, 28, [255, 128, 64]);

    const cached = (name: string) =>
      run(
        'render',
        path,
        '-o',
        join(directory, name + '.mp4'),
        '--picture-cache',
        join(directory, 'picture-cache'),
      ) as { path: string; pictureRanges: { status: string }[] };
    const statuses = (result: ReturnType<typeof cached>) =>
      result.pictureRanges.map(({ status }) => status);
    assert.deepEqual(statuses(cached('cold')), ['rendered']);
    assert.deepEqual(statuses(cached('warm')), ['reused']);
    await writeFile(join(directory, 'mask.svg'), svg(32, 32, 1));
    const newMask = cached('new-mask');
    assert.deepEqual(statuses(newMask), ['rendered']);
    stable(newMask.path, 25, 28, [255, 128, 64]);
    stable(newMask.path, 51, 28, [128, 128, 32]);

    const replacement = join(directory, 'replacement.mp4');
    backdrop('0x40a0c0', replacement);
    await rename(replacement, video);
    const newBackdrop = cached('new-backdrop');
    assert.deepEqual(statuses(newBackdrop), ['rendered']);
    stable(newBackdrop.path, 25, 28, [64, 160, 192]);
    stable(newBackdrop.path, 51, 28, [32, 160, 96]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Lottie and GLB round-trip through the public CLI with shuffled and repeated samples', async () => {
  requireTool('ffmpeg');
  requireTool('ffprobe');
  const directory = await mkdtemp(join(fixtureDirectory, 'adapter-seek-'));
  try {
    await writeFile(
      join(directory, 'relay.json'),
      await readFile(join(adapterFixtures, 'relay.json')),
    );
    await writeFile(
      join(directory, 'parallax.glb'),
      await readFile(join(adapterFixtures, 'parallax.glb')),
    );
    const files = [
      ['lottie', 'relay.json'],
      ['three', 'parallax.glb'],
    ] as const;
    for (const [renderer, source] of files) {
      const definition = {
        version: 3,
        canvas: {
          width: 384,
          height: 216,
          frameRate: { numerator: 30000, denominator: 1001 },
          backgroundColor: '#1a2330',
        },
        assets: {
          overlay: {
            kind: 'graphic',
            renderer,
            path: source,
            durationFrames: 300,
            ...(renderer === 'three' && {
              scene: {
                version: 1,
                camera: {
                  position: [
                    {
                      keys: [
                        { at: 0, value: -2 },
                        { at: 150, value: 2 },
                      ],
                    },
                    1.7,
                    5,
                  ],
                  target: [0, 0, 0],
                },
                lights: [{ type: 'ambient', color: '#ffffff', intensity: 2 }],
              },
            }),
          },
        },
        tracks: [
          {
            type: 'video',
            clips: [
              {
                asset: 'overlay',
                at: 0,
                sourceIn: 15,
                sourceOut: 135,
                speed: { numerator: 3, denominator: 2 },
              },
            ],
          },
        ],
      };
      const file = join(directory, `${renderer}.video.json`);
      await writeFile(file, JSON.stringify(definition));
      const packagePath = join(directory, `relocatable-${renderer}`);
      const { entry } = run('package', file, '--output', packagePath);
      run('package', 'verify', packagePath);
      const captures = [];
      for (const [i, frame] of [42, 3, 75, 42].entries()) {
        const output = join(directory, `${renderer}-${i}.png`);
        run(
          'preview',
          'frame',
          entry,
          '--frame',
          String(frame),
          '--quality',
          'quality',
          '--output',
          output,
        );
        captures.push(await readFile(output));
      }
      assert.deepEqual(captures[0], captures[3]);
      assert.notDeepEqual(captures[0], captures[1]);
      assert.notDeepEqual(captures[0], captures[2]);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('adapter validation rejects Lottie expressions and unsupported GLB extensions before opening Chromium', async () => {
  const directory = await mkdtemp(
    join(fixtureDirectory, 'adapter-unsupported-'),
  );
  const source = await readFile(join(adapterFixtures, 'parallax.glb'));
  const end = 20 + source.readUInt32LE(12);
  const model = JSON.parse(source.toString('utf8', 20, end));
  model.extensionsUsed = ['KHR_draco_mesh_compression'];
  const json = JSON.stringify(model);
  const payload = Buffer.from(
    json.padEnd(Math.ceil(Buffer.byteLength(json) / 4) * 4, ' '),
  );
  const glb = Buffer.concat([
    source.subarray(0, 20),
    payload,
    source.subarray(end),
  ]);
  glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(payload.length, 12);
  try {
    const file = join(directory, 'negative.video.json');
    const lottie = JSON.parse(
      await readFile(join(adapterFixtures, 'relay.json'), 'utf8'),
    );
    lottie.layers[0].ks.p.x = 'time * 10';
    await writeFile(join(directory, 'negative.json'), JSON.stringify(lottie));
    await writeFile(join(directory, 'negative.glb'), glb);
    const base = {
      version: 3,
      canvas: { width: 384, height: 216, frameRate: 30 },
      tracks: [
        { type: 'video', clips: [{ asset: 'bad', at: 0, sourceOut: 120 }] },
      ],
    };
    await writeFile(
      file,
      JSON.stringify({
        ...base,
        assets: {
          bad: {
            kind: 'graphic',
            renderer: 'lottie',
            path: 'negative.json',
            durationFrames: 120,
          },
        },
      }),
    );
    await assert.rejects(
      compileVideo(file),
      /assets\.bad\.lottie.*Lottie expressions/,
    );
    await writeFile(
      file,
      JSON.stringify({
        ...base,
        assets: {
          bad: {
            kind: 'graphic',
            renderer: 'three',
            path: 'negative.glb',
            durationFrames: 120,
            scene: {
              version: 1,
              camera: { position: [0, 2, 5], target: [0, 0, 0] },
              lights: [{ type: 'ambient', color: '#ffffff', intensity: 1 }],
            },
          },
        },
      }),
    );
    await assert.rejects(
      compileVideo(file),
      /assets\.bad\.three.*KHR_draco_mesh_compression/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('audio-dependent pixels follow the resolved mix and reject stale encoded-picture reuse', async () => {
  requireTool('ffmpeg');
  const directory = await mkdtemp(join(fixtureDirectory, 'audio-picture-'));
  const rate = 48000;
  function tone(hz: number) {
    const frames = 3 * rate;
    const wav = Buffer.alloc(44 + 2 * frames);
    wav.write('RIFF', 0);
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(rate, 24);
    wav.writeUInt32LE(rate * 2, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36);
    wav.writeUInt32LE(frames * 2, 40);
    for (let i = 0; i < frames; i++) {
      const peak = Math.max(0, 1 - Math.abs(i - 2 * rate) / 32);
      const value = Math.min(
        1,
        0.2 * Math.sin((i * hz * 2 * Math.PI) / rate) + 0.8 * peak,
      );
      wav.writeInt16LE(Math.round(value * 32767), 44 + 2 * i);
    }
    return wav;
  }
  try {
    await writeFile(join(directory, 'low.wav'), tone(220));
    await writeFile(join(directory, 'high.wav'), tone(880));
    const file = join(directory, 'signal.video.json');
    const make = (path: string) => ({
      version: 3,
      canvas: {
        width: 192,
        height: 108,
        frameRate: 30,
        durationFrames: 60,
        backgroundColor: '#101818',
      },
      assets: {
        input: { kind: 'audio', path },
        view: {
          kind: 'graphic',
          renderer: 'scene',
          durationFrames: 60,
          audioAnalysis: {
            version: 1,
            source: 'mix',
            window: 2048,
            hop: 256,
            waveform: 32,
            bins: 48,
          },
          scene: {
            version: 1,
            units: 'px',
            children: [
              {
                id: 'fft',
                type: 'audio',
                mode: 'spectrum',
                x: 0,
                y: 10,
                width: 192,
                height: 90,
                gain: 10,
                color: '#55ffee',
              },
            ],
          },
        },
      },
      tracks: [
        {
          id: 'picture',
          type: 'video',
          clips: [{ asset: 'view', at: 0, sourceOut: 60 }],
        },
        {
          id: 'sound',
          type: 'audio',
          clips: [{ asset: 'input', at: 15, sourceIn: 30, sourceOut: 75 }],
        },
      ],
    });
    await writeFile(file, JSON.stringify(make('low.wav')));
    const low = join(directory, 'low.png');
    const high = join(directory, 'high.png');
    const cache = join(directory, 'picture-cache');
    const recipeCache = join(directory, 'recipe-cache');
    run(
      'preview',
      'frame',
      file,
      '--frame',
      '30',
      '--recipe-cache',
      recipeCache,
      '-o',
      low,
    );
    const analysisDirectory = join(recipeCache, 'graphic-analysis-v1-LE');
    const [analysis] = await readdir(analysisDirectory);
    assert.ok(typeof analysis === 'string' && analysis.endsWith('.fft'));
    const record = join(analysisDirectory, analysis);
    const beforeTitleEdit = await stat(record);
    const withTitle = make('low.wav');
    await writeFile(
      file,
      JSON.stringify({ ...withTitle, name: 'Changed title' }),
    );
    run(
      'preview',
      'frame',
      file,
      '--frame',
      '31',
      '--recipe-cache',
      recipeCache,
      '-o',
      join(directory, 'changed-title.png'),
    );
    assert.equal((await stat(record)).mtimeMs, beforeTitleEdit.mtimeMs);
    assert.deepEqual(await readdir(analysisDirectory), [analysis]);
    await writeFile(file, JSON.stringify(make('low.wav')));
    const first = run(
      'render',
      file,
      '--picture-cache',
      cache,
      '--picture-version',
      'save',
      '-o',
      join(directory, 'original.mp4'),
    );
    const decoded = spawnSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-i',
        first.path,
        '-map',
        '0:a:0',
        '-ar',
        '48000',
        '-ac',
        '1',
        '-f',
        'f32le',
        'pipe:1',
      ],
      { maxBuffer: 2 * 1024 * 1024 },
    );
    assert.equal(decoded.status, 0, decoded.stderr.toString());
    let peak = 0;
    let at = 0;
    for (let i = rate; i < Math.min(rate * 2, decoded.stdout.length / 4); i++) {
      const value = Math.abs(decoded.stdout.readFloatLE(i * 4));
      if (value > peak) {
        peak = value;
        at = i / rate;
      }
    }
    assert.ok(peak > 0.4);
    assert.ok(Math.abs(at - 1.5) < 0.01, `Peak occurred at ${at}`);
    await writeFile(file, JSON.stringify(make('high.wav')));
    run('preview', 'frame', file, '--frame', '30', '-o', high);
    function center(path: string) {
      const rgb = frameRgb(path);
      const xs = Array.from({ length: 192 }, (_, x) => x).filter(
        (x) => rgb[(40 * 192 + x) * 3 + 1]! > 190,
      );
      assert.ok(xs.length > 0);
      return xs.reduce((a, b) => a + b, 0) / xs.length;
    }
    assert.ok(Math.abs(center(low) - 38) < 9);
    assert.ok(Math.abs(center(high) - 150) < 9);
    const reuse = spawnSync(
      process.execPath,
      [
        cli,
        'render',
        file,
        '--picture-cache',
        cache,
        '--picture-version',
        first.pictureVersion.id,
        '-o',
        join(directory, 'wrong.mp4'),
        '--json',
      ],
      { encoding: 'utf8' },
    );
    assert.notEqual(reuse.status, 0);
    assert.match(reuse.stderr, /Picture or video export settings changed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('parameterized JSON watch preserves a kinetic preset through an invalid edit', async () => {
  requireTool('ffmpeg');
  const directory = await mkdtemp(join(fixtureDirectory, 'json-preset-watch-'));
  const file = join(directory, 'preset.video.json');
  const events: VideoWatchStatus[] = [];
  const signal = AbortSignal.timeout(45_000);
  const make = (backgroundColor: string) => ({
    format: 'opencut-video-json',
    version: 1,
    parameters: { title: { type: 'string', default: 'Local title' } },
    bindings: [
      {
        parameter: 'title',
        path: ['assets', 'title', 'scene', 'preset', 'title'],
      },
    ],
    composition: {
      version: 3,
      canvas: { width: 192, height: 108, frameRate: 24, backgroundColor },
      assets: {
        title: {
          kind: 'graphic',
          renderer: 'scene',
          durationFrames: 24,
          scene: {
            version: 1,
            units: 'px',
            preset: {
              name: 'title-sequence',
              title: 'Bound text',
              revealFrames: 12,
            },
          },
        },
      },
      tracks: [
        { type: 'video', clips: [{ asset: 'title', at: 0, sourceOut: 24 }] },
      ],
    },
  });
  async function until(status: VideoWatchStatus['status'], generation: number) {
    for (;;) {
      const event = events.find(
        (item) => item.status === status && item.generation >= generation,
      );
      if (event) return event;
      await delay(40, undefined, { signal });
    }
  }
  await writeFile(file, JSON.stringify(make('#102435')));
  const watch = await watchVideo(file, {
    onStatus: (event) => events.push(event),
    signal,
    params: { title: 'Watch and recover' },
  });
  try {
    const first = await until('ready', 1);
    assert.ok(first.current);
    await writeFile(file, '{');
    const failed = await until('error', first.generation + 1);
    assert.equal(failed.current?.playback.path, first.current.playback.path);
    await stat(first.current.playback.path);
    await writeFile(file, JSON.stringify(make('#103447')));
    const next = await until('ready', failed.generation + 1);
    assert.notEqual(next.current?.sourceRevision, first.current.sourceRevision);
  } finally {
    await watch.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('media-frame offsets select the frame at an exact rational boundary', async (t) => {
  const directory = await mkdtemp(
    join(fixtureDirectory, 'media-frame-offset-'),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  runTool('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=blue:s=64x64:r=30:d=1.5',
    '-vf',
    "drawbox=color=red:t=fill:enable='gte(n,24)'",
    '-c:v',
    'libx264',
    '-threads',
    '1',
    join(directory, 'input.mp4'),
  ]);
  const make = (offset: {
    numerator: number;
    denominator: number;
  }): VideoDefinition => ({
    version: 3,
    canvas: { width: 64, height: 64, frameRate: 10 },
    assets: {
      input: { kind: 'video', path: 'input.mp4' },
      sampled: {
        kind: 'graphic',
        renderer: 'scene',
        durationFrames: 3,
        mediaFrames: {
          source: { asset: 'input', offset },
        },
        scene: {
          version: 1,
          units: 'px',
          children: [
            {
              type: 'media-frame',
              id: 'sample',
              resource: 'source',
              width: 64,
              height: 64,
            },
          ],
        },
      },
    },
    tracks: [
      { type: 'video', clips: [{ asset: 'sampled', at: 0, sourceOut: 3 }] },
    ],
  });
  const red = [255, 0, 0];
  const blue = [0, 0, 255];
  for (const [id, offset, expected] of [
    ['boundary', { numerator: 7, denominator: 10 }, red],
    [
      'just-after',
      { numerator: 6_300_000_000_000_001, denominator: 9_000_000_000_000_001 },
      red,
    ],
    [
      'just-before',
      { numerator: 6_300_000_000_000_002, denominator: 9_000_000_000_000_003 },
      blue,
    ],
  ] as const) {
    const path = join(directory, id + '.video.json');
    await writeFile(path, JSON.stringify(make(offset)));
    const preview = previewVideo(await compileVideo(path));
    const before = join(directory, id + '-before.png');
    const boundary = join(directory, id + '-boundary.png');
    await preview.frame(0, before);
    await preview.frame(1, boundary);
    stable(before, 32, 32, blue);
    stable(boundary, 32, 32, expected);
  }
});

test('dense overlapping stacks preserve ordering and the group backdrop in preview and export', async (t) => {
  const directory = await mkdtemp(join(fixtureDirectory, 'dense-stack-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const colors = { backdrop: '#be8046', overlay: '#3988f0', tint: '#80ff80' };
  await Promise.all(
    Object.entries(colors).map(([id, color]) =>
      writeFile(
        join(directory, id + '.svg'),
        `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="${id === 'overlay' ? 32 : 64}" height="64" fill="${color}"/></svg>`,
      ),
    ),
  );
  const tracks: VideoDefinition['tracks'] = Array.from(
    { length: 66 },
    (_, i) => ({
      type: 'video',
      id: 'track-' + i,
      clips: [
        {
          asset:
            i === 0 ? 'backdrop' : i === 31 || i === 64 ? 'overlay' : 'tint',
          at: i === 31 ? 1 : 0,
          duration: i === 31 ? 3 : 4,
          visual: {
            opacity: i === 0 || i === 65 ? 1 : i === 31 || i === 64 ? 0.5 : 0,
          },
        },
      ],
    }),
  );
  const definition: VideoDefinition = {
    version: 3,
    canvas: { width: 64, height: 64, frameRate: 24, durationFrames: 4 },
    assets: Object.fromEntries(
      Object.keys(colors).map((id) => [
        id,
        { kind: 'graphic', renderer: 'svg', path: id + '.svg' },
      ]),
    ),
    tracks,
    visualGroups: [
      {
        id: 'finish',
        tracks: ['track-64', 'track-65'],
        opacity: 0.6,
        blend: 'multiply',
      },
    ],
  };
  const dense = join(directory, 'dense.video.json');
  const sparse = join(directory, 'sparse.video.json');
  await writeFile(dense, JSON.stringify(definition));
  await writeFile(
    sparse,
    JSON.stringify({
      ...definition,
      tracks: tracks.filter((_, i) => [0, 31, 64, 65].includes(i)),
    }),
  );
  for (const frame of [0, 2]) {
    const actual = join(directory, `dense-${frame}.png`);
    const expected = join(directory, `sparse-${frame}.png`);
    await previewVideo(await compileVideo(dense)).frame(frame, actual);
    await previewVideo(await compileVideo(sparse)).frame(frame, expected);
    assert.deepEqual(frameRgb(actual), frameRgb(expected));
  }
  const actual = run('render', dense, '-o', join(directory, 'dense.mp4'));
  const expected = run('render', sparse, '-o', join(directory, 'sparse.mp4'));
  const cached = run(
    'render',
    dense,
    '--picture-cache',
    join(directory, 'cache'),
    '-o',
    join(directory, 'cached.mp4'),
  );
  assert.equal(actual.frameCount, 4);
  function picture(file: string) {
    const decoded = spawnSync('ffmpeg', [
      '-v',
      'error',
      '-i',
      file,
      '-map',
      '0:v:0',
      '-pix_fmt',
      'rgb24',
      '-threads',
      '1',
      '-f',
      'rawvideo',
      'pipe:1',
    ]);
    assert.equal(decoded.status, 0, decoded.stderr.toString());
    return decoded.stdout;
  }
  assert.deepEqual(picture(actual.path), picture(expected.path));
  assert.deepEqual(picture(cached.path), picture(expected.path));
});

test('professional mix delivery controls invalidate audio-reactive picture and reuse identical settings', async (t) => {
  const directory = await mkdtemp(join(fixtureDirectory, 'reactive-delivery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  runTool('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'aevalsrc=0.24*sin(2*PI*317*t)|0.07*sin(2*PI*811*t):s=48000:d=1',
    '-c:a',
    'pcm_s16le',
    join(directory, 'dialogue.wav'),
  ]);
  const definition: VideoDefinition = {
    version: 3,
    canvas: { width: 64, height: 64, frameRate: 12 },
    professionalMix: { preset: 'natural-cinematic' },
    assets: {
      dialogue: { kind: 'audio', path: 'dialogue.wav' },
      meter: {
        kind: 'graphic',
        renderer: 'scene',
        durationFrames: 12,
        audioAnalysis: {
          version: 1,
          source: 'mix',
          window: 1024,
          hop: 256,
          waveform: 16,
          bins: 16,
        },
        scene: {
          version: 1,
          units: 'px',
          children: [
            {
              type: 'audio',
              id: 'level',
              mode: 'rms',
              width: 64,
              height: 64,
              color: '#00ff80',
            },
          ],
        },
      },
    },
    tracks: [
      { type: 'video', clips: [{ asset: 'meter', at: 0, sourceOut: 12 }] },
      {
        type: 'audio',
        audioRole: 'dialogue',
        clips: [{ asset: 'dialogue', at: 0, sourceOut: 12 }],
      },
    ],
  };
  const path = join(directory, 'master.video.json');
  await writeFile(path, JSON.stringify(definition));
  const cache = join(directory, 'picture');
  const render = (name: string, ...settings: string[]) =>
    run(
      'render',
      path,
      '--picture-cache',
      cache,
      '--recipe-cache',
      join(directory, 'recipes'),
      '-o',
      join(directory, name + '.mp4'),
      ...settings,
    );
  const statuses = (result: { pictureRanges: { status: string }[] }) =>
    result.pictureRanges.map(({ status }) => status);
  const initial = render('initial', '--picture-version', 'save');
  assert.deepEqual(statuses(initial), ['rendered']);
  assert.deepEqual(
    statuses(
      render(
        'explicit-defaults',
        '--audio-channels',
        '2',
        '--audio-rate',
        '48000',
        '--audio-bitrate',
        '192',
      ),
    ),
    ['reused'],
  );
  assert.deepEqual(statuses(render('mono', '--audio-channels', '1')), [
    'rendered',
  ]);
  assert.deepEqual(statuses(render('other-rate', '--audio-rate', '44100')), [
    'rendered',
  ]);
  assert.deepEqual(statuses(render('other-bitrate', '--audio-bitrate', '64')), [
    'rendered',
  ]);
  const revisedSettings = [
    '--audio-channels',
    '1',
    '--audio-rate',
    '44100',
    '--audio-bitrate',
    '64',
  ];
  const revised = render('revised', ...revisedSettings);
  assert.equal(revised.metadata.audio.channels, 1);
  assert.equal(revised.metadata.audio.sampleRate, 44100);
  assert.deepEqual(statuses(revised), ['rendered']);
  assert.deepEqual(statuses(render('repeat', ...revisedSettings)), ['reused']);

  const stale = spawnSync(
    process.execPath,
    [
      cli,
      'render',
      path,
      '--picture-cache',
      cache,
      '--picture-version',
      initial.pictureVersion.id,
      '-o',
      join(directory, 'stale.mp4'),
      ...revisedSettings,
      '--json',
    ],
    { encoding: 'utf8' },
  );
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /Picture or video export settings changed/);
});

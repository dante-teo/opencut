import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileVideo, defineVideo, previewVideo } from '@opencut/sdk';
import type { VideoDefinition } from '@opencut/sdk';
import {
  decodeStillFrame,
  probeMedia,
  renderTimelineFrame,
  renderVideoTimeline,
} from '../../packages/media/src/index.js';
import { decodeFrames } from './media-comparison.js';
import { requireTool, runTool } from '../../scripts/fixture-lib.js';
import type { Probe } from '../../scripts/fixture-lib.js';
import { fixtureDirectory, videoExample } from '../fixture-paths.js';

const entry = fileURLToPath(
  new URL('../../apps/cli/dist/index.js', import.meta.url),
);
const example = videoExample('showcase.video.ts');
const hash = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');

test('T44 public CLI renders and previews a 20-second TypeScript definition', async () => {
  requireTool('ffmpeg');
  requireTool('ffprobe');
  const directory = await mkdtemp(join(fixtureDirectory, 't44-'));
  const sources = [
    example,
    join(fixtureDirectory, 'video-long.mp4'),
    join(fixtureDirectory, 'audio-tone.wav'),
    join(fixtureDirectory, 'still.png'),
  ];
  const before = await Promise.all(sources.map(hash));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [entry, ...args, '--json'], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 30_000,
    });
  const cli = (...args: string[]) => {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  try {
    const inspected = cli('inspect', example);
    const alias = join(directory, 'alias.video.ts');
    await symlink(example, alias, 'file');
    assert.deepEqual(cli('inspect', alias), inspected);
    await rm(alias);
    cli('validate', example);
    cli('render', example, '--output', 'ts.mp4');
    for (const frame of [30, 96, 414, 479])
      cli(
        'preview',
        'frame',
        example,
        '--frame',
        String(frame),
        '--output',
        `ts-${frame}.png`,
      );
    const outputBeforeOverwrite = await hash(join(directory, 'ts.mp4'));
    assert.notEqual(
      await hash(join(directory, 'ts-96.png')),
      await hash(join(directory, 'ts-479.png')),
    );
    const probe: Probe = JSON.parse(
      runTool('ffprobe', [
        '-v',
        'error',
        '-count_frames',
        '-show_streams',
        '-show_format',
        '-of',
        'json',
        join(directory, 'ts.mp4'),
      ]),
    );
    const video = probe.streams?.find(
      ({ codec_type }) => codec_type === 'video',
    );
    const audio = probe.streams?.find(
      ({ codec_type }) => codec_type === 'audio',
    );
    assert.equal(video?.codec_name, 'h264');
    assert.equal(video.width, 320);
    assert.equal(video.height, 180);
    assert.equal(video.avg_frame_rate, '24/1');
    assert.equal(video.nb_read_frames, '480');
    assert.equal(Number(probe.format?.duration), 20);
    assert.equal(audio?.codec_name, 'aac');
    assert.equal(Number(audio.duration), 20);

    for (const frame of [30, 96, 414, 479]) {
      const preview = decodeRgb(join(directory, `ts-${frame}.png`));
      const rendered = decodeRgb(join(directory, 'ts.mp4'), frame);
      assert.equal(preview.length, 320 * 180 * 3);
      assert.equal(rendered.length, preview.length);
      const error =
        preview.reduce(
          (sum, value, index) => sum + Math.abs(value - rendered[index]!),
          0,
        ) / preview.length;
      assert.ok(error < 10, `Frame ${frame} mean RGB error: ${error}`);
    }

    const { default: showcase } = await import(pathToFileURL(example).href);
    const tooLong = structuredClone(showcase) as VideoDefinition;
    for (const asset of Object.values(tooLong.assets!))
      if (asset.path) asset.path = join('..', asset.path.split('/').at(-1)!);
    const footage = tooLong.tracks[0];
    assert.equal(footage?.type, 'video');
    const clip = footage.clips[1];
    assert.ok(clip && 'sourceOut' in clip);
    clip.sourceOut = 132;
    await writeFile(
      join(directory, 'invalid.video.ts'),
      `export default ${JSON.stringify(tooLong)};\n`,
    );
    const invalid = run(
      'render',
      'invalid.video.ts',
      '--output',
      'invalid.mp4',
    );
    assert.equal(invalid.status, 1, invalid.stderr);
    assert.match(invalid.stderr, /Out point exceeds the duration/);
    assert.ok(!(await readdir(directory)).includes('invalid.mp4'));

    const replaced = run('render', example, '--output', 'ts.mp4');
    assert.equal(replaced.status, 1, replaced.stderr);
    assert.match(replaced.stderr, /Refusing to overwrite/);
    assert.equal(await hash(join(directory, 'ts.mp4')), outputBeforeOverwrite);
    assert.equal((await readdir(directory)).length, 6);

    assert.deepEqual(await Promise.all(sources.map(hash)), before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function decodeRgb(path: string, frame?: number) {
  const result = spawnSync('ffmpeg', [
    '-v',
    'error',
    '-i',
    path,
    ...(frame === undefined ? [] : ['-vf', `select=eq(n\\,${frame})`]),
    '-frames:v',
    '1',
    '-pix_fmt',
    'rgb24',
    '-f',
    'rawvideo',
    '-',
  ]);
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
}

test('TypeScript definitions render mixed tracks, subtitles, grading, effects and exact timing', async () => {
  requireTool('ffmpeg');
  requireTool('ffprobe');
  const directory = await mkdtemp(join(fixtureDirectory, 't45-'));
  const definitions = join(directory, 'definitions');
  const ts = join(definitions, 'mixed.video.ts');
  const titleFont = fileURLToPath(
    new URL('../../packages/media/fonts/NotoEmoji.ttf', import.meta.url),
  );
  const rate = { numerator: 24, denominator: 1 };
  const frame = (numerator: number) => ({ numerator, denominator: 24 });
  const exact = (numerator: number, denominator = 1) => ({
    numerator,
    denominator,
  });
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [entry, ...args, '--json'], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  try {
    await mkdir(definitions);
    const embeddedFont = (await readFile(titleFont)).toString('base64');
    const grade = {
      exposure: 0.3,
      contrast: 1.1,
      saturation: 0.8,
      temperature: 0.1,
      tint: 0.05,
      curve: [
        { input: 0.25, output: 0.35 },
        { input: 0.8, output: 0.72 },
      ],
    };
    const definition = defineVideo({
      name: 'Mixed definition',
      canvas: {
        frameRate: rate,
        width: 320,
        height: 180,
        backgroundColor: '#193149A0',
      },
      assets: {
        camera: { path: '../../video-long.mp4', kind: 'video' },
        voice: { path: '../../audio-tone.wav', kind: 'audio' },
        held: { path: '../../still.png', kind: 'image' },
      },
      fonts: { emoji: { data: embeddedFont } },
      tracks: [
        {
          id: 'picture',
          type: 'video',
          volume: 0.7,
          clips: [
            {
              id: 'opening',
              asset: 'camera',
              at: frame(0),
              sourceIn: frame(12),
              sourceOut: frame(36),
              grade,
              speed: exact(3, 2),
              muted: true,
              visual: {
                fit: 'cover',
                crop: { left: 0.05, right: 0.02, top: 0.1, bottom: 0.08 },
              },
              keyframes: {
                scale: [
                  {
                    time: exact(0),
                    value: 0.8,
                    easing: 'ease-in-out',
                    curve: [0.1, 0.9],
                  },
                  { time: frame(16), value: 1.05, easing: 'linear' },
                ],
              },
            },
            {
              id: 'incoming',
              asset: 'camera',
              at: frame(16),
              sourceIn: frame(48),
              sourceOut: frame(64),
              volume: 0.35,
            },
            {
              id: 'freeze',
              asset: 'held',
              at: frame(32),
              sourceIn: frame(1),
              sourceOut: frame(9),
              visual: { scale: 0.8, rotation: 5 },
              grade,
            },
          ],
        },
        {
          id: 'titles',
          type: 'text',
          clips: [
            {
              id: 'heading',
              at: frame(2),
              sourceIn: frame(2),
              sourceOut: frame(15),
              text: {
                content: '☺',
                font: 'emoji',
                canvasFill: '#00000020',
                fontSize: 24,
                rotation: 8,
                fontWeight: 700,
                emphasis: ['☺'],
              },
              visual: { y: -40, opacity: 0.8 },
            },
          ],
        },
        {
          id: 'audio',
          type: 'audio',
          volume: 0.6,
          clips: [
            {
              id: 'dialogue',
              asset: 'camera',
              at: frame(0),
              sourceIn: frame(12),
              sourceOut: frame(36),
              speed: exact(3, 2),
              detachedAudio: true,
              effects: [
                { type: 'eq', frequency: 300, db: -3 },
                { type: 'compressor', threshold: -18, ratio: 3 },
                { type: 'limiter', ceiling: -2 },
              ],
              gainKeys: [
                { time: exact(1, 1000), value: 0.2 },
                { time: frame(15), value: 0.75 },
              ],
              fadeIn: { duration: exact(1, 100), from: 0.25 },
              fadeOut: { duration: exact(1, 10), to: 0.3 },
            },
            {
              id: 'music',
              asset: 'voice',
              at: exact(25, 36),
              sourceIn: exact(1, 111),
              sourceOut: exact(2, 3),
              volume: 0.4,
            },
          ],
        },
      ],
      transitions: [
        { id: 'up', kind: 'fade-in', clipId: 'opening', frames: 3 },
        {
          id: 'dissolve',
          kind: 'cross-dissolve',
          from: 'opening',
          to: 'incoming',
          frames: 6,
        },
        { id: 'down', kind: 'fade-out', clipId: 'incoming', frames: 4 },
      ],
      markers: [{ id: 'cut', frame: 16, name: 'Cut' }],
      subtitles: {
        style: { color: '#FFFFFF', fontSize: 22, font: 'emoji' },
        cues: [
          {
            id: 'cue',
            text: '☺ ☻',
            start: exact(113, 1000),
            end: exact(32, 25),
            pop: true,
            emphasis: ['☺'],
            style: {
              x: 10,
              stroke: { width: 1, color: '#000000' },
              embeddedFont: null,
            },
            words: [
              { from: 0, to: 1, start: exact(0), end: exact(25, 73) },
              { from: 2, to: 3, start: exact(25, 73), end: exact(109, 100) },
            ],
          },
        ],
      },
    });
    const authored = JSON.stringify(definition);
    await writeFile(ts, `export default ${authored};\n`);

    const compiled = await compileVideo(ts);
    const { visualTransitions, audioClips } = await compiled.resolveRender();
    assert.ok(visualTransitions?.some(({ layers }) => layers.length === 2));
    assert.deepEqual(
      audioClips
        .find(({ clipId }) => clipId === 'dialogue')
        ?.effects?.map(({ type }) => type),
      ['eq', 'compressor', 'limiter'],
    );
    assert.equal(
      compiled.project.clips.find(({ id }) => id === 'heading')?.text
        ?.embeddedFont,
      embeddedFont,
    );
    assert.equal(compiled.project.subtitles?.style.embeddedFont, embeddedFont);

    run('render', ts, '--output', 'typescript.mp4');

    const frames = [2, 5, 14, 17, 29, 35, 39];
    for (const index of frames) {
      const sdkFrame = join(directory, `sdk-${index}.png`);
      const cliFrame = join(directory, `cli-${index}.png`);
      await previewVideo(compiled).frame(index, sdkFrame);
      run(
        'preview',
        'frame',
        ts,
        '--frame',
        String(index),
        '--output',
        cliFrame,
      );
      assert.equal(await hash(cliFrame), await hash(sdkFrame));
    }
    assert.equal(await readFile(ts, 'utf8'), `export default ${authored};\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('T54 indexed seeks and sequential decoding agree on fractional project ticks', async () => {
  requireTool('ffmpeg');
  requireTool('ffprobe');
  const directory = await mkdtemp(join(fixtureDirectory, 't54-seek-'));
  try {
    const indexed = join(directory, 'indexed.mp4');
    runTool('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=160x90:r=24:d=8',
      '-vf',
      "select='not(between(n,149,152))'",
      '-fps_mode',
      'vfr',
      '-c:v',
      'libx264',
      '-threads',
      '1',
      '-g',
      '24',
      indexed,
    ]);
    await copyFile(indexed, join(directory, 'sequential.mkv'));
    const preview = async (name: string, graded = false) => {
      const file = join(directory, name + '.video.ts');
      const body: VideoDefinition = {
        canvas: {
          width: 160,
          height: 90,
          frameRate: { numerator: 24000, denominator: 1001 },
          durationFrames: 72,
        },
        assets: { video: { kind: 'video', path: name } },
        tracks: [
          {
            type: 'video',
            clips: [
              {
                asset: 'video',
                at: 0,
                sourceIn: 96,
                sourceOut: 168,
                ...(graded && {
                  grade: {
                    exposure: 0,
                    contrast: 1,
                    saturation: 0.6,
                    temperature: 0,
                    tint: 0,
                    curve: [],
                  },
                }),
              },
            ],
          },
        ],
      };
      await writeFile(file, `export default ${JSON.stringify(body)};\n`);
      return previewVideo(await compileVideo(file, { preview: true }));
    };
    const seek = await preview('indexed.mp4');
    const sequential = await preview('sequential.mkv');
    const { path: indexed49 } = await seek.frame(
      49,
      join(directory, 'indexed49.png'),
    );
    const { path: sequential49 } = await sequential.frame(
      49,
      join(directory, 'sequential49.png'),
    );
    const { path: sequential50 } = await sequential.frame(
      50,
      join(directory, 'sequential50.png'),
    );
    assert.equal(await hash(indexed49), await hash(sequential49));
    assert.notEqual(await hash(indexed49), await hash(sequential50));
    const range = { startFrame: 49, endFrame: 60 };
    const graded = await preview('indexed.mp4', true);
    const reference = await preview('sequential.mkv', true);
    const actual = await graded.clip(range, join(directory, 'graded.mp4'));
    const expected = await reference.clip(
      range,
      join(directory, 'reference.mp4'),
    );
    assert.equal(await hash(actual.path), await hash(expected.path));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('transformed layers decode sequentially when an indexed seek skips over a VFR gap', async () => {
  requireTool('ffmpeg');
  requireTool('ffprobe');
  const directory = await mkdtemp(join(fixtureDirectory, 't54-seek-gap-'));
  try {
    const indexed = join(directory, 'gap.mp4');
    const sequential = join(directory, 'gap.mkv');
    runTool('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=160x90:r=24:d=9',
      '-vf',
      "select='not(between(n,72,191))'",
      '-fps_mode',
      'vfr',
      '-c:v',
      'libx264',
      '-threads',
      '1',
      '-g',
      '240',
      '-sc_threshold',
      '0',
      '-bf',
      '3',
      '-force_key_frames',
      '8',
      indexed,
    ]);
    // Use the same input bytes under a name that selects sequential decoding.
    await copyFile(indexed, sequential);
    const timeline = (path: string, output: string) => ({
      width: 160,
      height: 90,
      frameRate: { numerator: 24, denominator: 1 },
      frameCount: 84,
      visualClips: [
        {
          clipId: 'gap',
          path,
          timelineStartFrame: 0,
          sourceStartFrame: 120,
          frameCount: 84,
          grade: {
            exposure: 0,
            contrast: 1,
            saturation: 0.6,
            temperature: 0,
            tint: 0,
            curve: [],
          },
        },
      ],
      output: join(directory, output),
    });
    const reference = await renderVideoTimeline(
      timeline(sequential, 'reference.mp4'),
    );
    const actual = await renderVideoTimeline(timeline(indexed, 'render.mp4'));
    assert.equal(await hash(actual.path), await hash(reference.path));

    // The single-frame attempt inside the gap produces no indexed frames.
    const range = { startFrame: 15, endFrame: 16 };
    const expectedFrame = await renderTimelineFrame({
      ...timeline(sequential, 'reference.png'),
      range,
    });
    const actualFrame = await renderTimelineFrame({
      ...timeline(indexed, 'frame.png'),
      range,
    });
    assert.equal(await hash(actualFrame.path), await hash(expectedFrame.path));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('T45 source-backed freezes match the corresponding extracted image and support relative fonts', async () => {
  requireTool('ffmpeg');
  requireTool('ffprobe');
  const directory = await mkdtemp(join(fixtureDirectory, 't45-held-'));
  try {
    const video = await probeMedia(join(fixtureDirectory, 'video-long.mp4'));
    const frameTime = { numerator: 1, denominator: 2 };
    runTool('ffmpeg', [
      '-v',
      'error',
      '-nostdin',
      '-n',
      '-i',
      join(fixtureDirectory, 'audio-tone.wav'),
      '-itsoffset',
      '1',
      '-i',
      video.path,
      '-map',
      '1:v:0',
      '-map',
      '0:a:0',
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      join(directory, 'delayed.mp4'),
    ]);
    const delayed = await probeMedia(join(directory, 'delayed.mp4'));
    assert.equal(delayed.startTimeSeconds, 0);
    assert.equal(delayed.video?.startTimeSeconds, 1);
    const still = await decodeStillFrame(video, 0.5, true);
    await writeFile(join(directory, 'held.png'), still);
    const fontPath = fileURLToPath(
      new URL('../../packages/media/fonts/NotoEmoji.ttf', import.meta.url),
    );
    await copyFile(fontPath, join(directory, 'font.ttf'));
    const path = join(directory, 'held.video.ts');
    const definition = defineVideo({
      canvas: { width: 320, height: 180, frameRate: 24, durationFrames: 12 },
      assets: {
        frame: {
          path: 'delayed.mp4',
          kind: 'image',
          freezeFrame: frameTime,
        },
      },
      fonts: { emoji: { path: 'font.ttf' } },
      tracks: [
        {
          type: 'image',
          id: 'freeze',
          clips: [{ at: 2, duration: 8, asset: 'frame' }],
        },
        {
          type: 'image',
          id: 'graded',
          clips: [
            {
              at: 3,
              duration: 6,
              asset: 'frame',
              grade: {
                exposure: 0.5,
                contrast: 1.5,
                saturation: 0.8,
                temperature: 0.04,
                tint: -0.1,
                curve: [],
              },
              visual: {
                scale: 0.5,
                x: 25,
                opacity: 0.7,
                crop: { left: 0.1, top: 0.15, right: 0, bottom: 0 },
              },
              keyframes: {
                rotation: [
                  {
                    time: { numerator: 0, denominator: 1 },
                    value: -10,
                    easing: 'linear',
                  },
                  {
                    time: { numerator: 1, denominator: 4 },
                    value: 10,
                    easing: 'linear',
                  },
                ],
              },
            },
          ],
        },
        {
          type: 'text',
          clips: [
            { at: 3, duration: 6, text: { content: '☺', font: 'emoji' } },
          ],
        },
      ],
    });
    await writeFile(path, `export default ${JSON.stringify(definition)};\n`);
    const compiled = await compileVideo(path);
    assert.equal(
      compiled.project.clips.at(-1)?.text?.embeddedFont,
      (await readFile(fontPath)).toString('base64'),
    );
    assert.deepEqual((await compiled.resolveRender()).audioClips, []);
    const attached = await compiled.resolveRender();
    const extracted = await (
      await compileVideo(await writeStillDefinition())
    ).resolveRender();
    const a = join(directory, 'video.mp4');
    const b = join(directory, 'still.mp4');
    await renderVideoTimeline({ ...attached, output: a });
    await renderVideoTimeline({ ...extracted, output: b });
    const selections = [1, 2, 5, 8, 9, 10];
    const other = decodeFrames(b, selections, 320, 180);
    for (const [index, rgb] of decodeFrames(a, selections, 320, 180))
      assert.deepEqual(rgb, other.get(index), `Freeze frame ${index}`);
    for (const startFrame of [1, 5, 10]) {
      const output = join(directory, `held-${startFrame}.png`);
      const reference = join(directory, `still-${startFrame}.png`);
      const range = { startFrame, endFrame: startFrame + 1 };
      await renderTimelineFrame({ ...attached, output, range });
      await renderTimelineFrame({ ...extracted, output: reference, range });
      assert.equal(await hash(output), await hash(reference));
    }
    async function writeStillDefinition() {
      const path = join(directory, 'still.video.ts');
      await writeFile(
        path,
        `export default ${JSON.stringify({
          ...definition,
          assets: { frame: { kind: 'image', path: 'held.png' } },
        })};\n`,
      );
      return path;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('T45 single-frame previews support definitions above the full-render subtitle cap', async () => {
  requireTool('ffmpeg');
  requireTool('ffprobe');
  const directory = await mkdtemp(join(fixtureDirectory, 't45-cues-'));
  try {
    const definition = defineVideo({
      canvas: { width: 320, height: 180, frameRate: 24 },
      tracks: [],
      subtitles: {
        style: {},
        cues: Array.from({ length: 257 }, (_, index) => ({
          id: `cue-${index}`,
          text: `Caption ${index}`,
          start: { numerator: index, denominator: 24 },
          end: { numerator: index + 1, denominator: 24 },
        })),
      },
    });
    const input = 'captions.video.ts';
    await writeFile(
      join(directory, input),
      `export default ${JSON.stringify(definition)};\n`,
    );
    const result = spawnSync(
      process.execPath,
      [
        entry,
        'preview',
        'frame',
        input,
        '--frame',
        '256',
        '--output',
        'captions.png',
        '--json',
      ],
      { cwd: directory, encoding: 'utf8', timeout: 30_000 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).frame, 256);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFile,
  link,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { frameTime } from '@opencut/core';
import { defineVideo, renderVideo } from '@opencut/sdk';
import { renderVideoTimeline } from '../../packages/media/src/index.js';
import type {
  PictureCache,
  PictureRange,
  VideoTimelineOptions,
} from '../../packages/media/src/index.js';
import { fixtureDirectory } from '../fixture-paths.js';
import { decodeAudio, sampleOnsets } from './audio-comparison.js';
import { ffmpeg, verifyVideoTimestamps } from './media-comparison.js';

const entry = fileURLToPath(
  new URL('../../apps/cli/dist/index.js', import.meta.url),
);
const rate = { numerator: 60, denominator: 1 };
const picture = (path: string) =>
  ffmpeg([
    '-i',
    path,
    '-map',
    '0:v:0',
    '-c:v',
    'rawvideo',
    '-threads',
    '1',
    '-pix_fmt',
    'yuv420p',
    '-f',
    'rawvideo',
    'pipe:1',
  ]);

test('CLI picture cache reuses shifted 60 fps picture and preserves caption and narration timing', async () => {
  const directory = await mkdtemp(join(fixtureDirectory, 'picture-cache-'));
  const file = join(directory, 'edit.video.ts');
  const cache = join(directory, "picture's cache");
  const recipeCache = join(directory, 'recipes');
  const render = (name: string, options: string[]) => {
    const output = join(directory, name + '.mp4');
    const result = spawnSync(
      process.execPath,
      [
        entry,
        'render',
        file,
        '--output',
        output,
        '--recipe-cache',
        recipeCache,
        ...options,
      ],
      { cwd: directory, encoding: 'utf8', timeout: 60_000 },
    );
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    return { output, stdout: result.stdout };
  };
  const cached = (name: string, options: string[] = []) => {
    const { output, stdout } = render(name, [
      '--picture-cache',
      cache,
      '--json',
      ...options,
    ]);
    const result = JSON.parse(stdout) as {
      pictureRanges: PictureRange[];
      recipeProcessing: { status: string }[];
    };
    return { output, ...result };
  };
  const frame = (n: number) => frameTime(n, rate);
  const writeEdit = (
    shift: number,
    {
      volume = 1,
      caption = 'Narration',
      scale = 1,
      fade = 4,
      exposure = 0,
      sourceIn = 12,
    } = {},
  ) =>
    writeFile(
      file,
      'export default ' +
        JSON.stringify(
          defineVideo({
            canvas: { width: 160, height: 90, frameRate: rate },
            assets: {
              processed: {
                path: '../video-medium.mp4',
                kind: 'video',
                recipe: [{ type: 'frameRate', numerator: 60 }],
              },
              next: { path: 'next.mp4', kind: 'video' },
              voice: { path: '../audio-tone.wav', kind: 'audio' },
            },
            tracks: [
              {
                type: 'video',
                clips: [
                  {
                    at: 0,
                    duration: 12 + shift,
                    text: { content: 'Analysis', fontSize: 16 },
                  },
                  {
                    id: 'shot',
                    at: 12 + shift,
                    asset: 'processed',
                    sourceIn,
                    sourceOut: sourceIn + 54,
                    speed: { numerator: 3, denominator: 2 },
                    muted: true,
                    visual: { scale },
                    grade: {
                      exposure,
                      saturation: 1,
                      contrast: 1,
                      temperature: 0,
                      tint: 0,
                      curve: [],
                    },
                    keyframes: {
                      x: [
                        { time: frame(0), value: 0, easing: 'linear' },
                        { time: frame(36), value: 10, easing: 'linear' },
                      ],
                    },
                  },
                  {
                    id: 'next-shot',
                    at: 48 + shift,
                    asset: 'next',
                    sourceIn: 4,
                    sourceOut: 36,
                    muted: true,
                  },
                ],
              },
              {
                type: 'audio',
                clips: [
                  { at: 18 + shift, asset: 'voice', sourceOut: 60, volume },
                ],
              },
            ],
            transitions: [
              { id: 'fade', kind: 'fade-in', clipId: 'shot', frames: fade },
            ],
            subtitles: {
              style: { fontSize: 18, y: 25 },
              cues: [
                {
                  id: 'voice-cue',
                  text: caption,
                  start: frame(18 + shift),
                  end: frame(28 + shift),
                },
              ],
            },
          }),
        ),
    );
  const spans = (ranges: PictureRange[]) =>
    ranges.map(({ startFrame, endFrame, status }) => [
      startFrame,
      endFrame,
      status,
    ]);
  const misses = (ranges: PictureRange[]) =>
    ranges
      .filter(({ status }) => status === 'rendered')
      .map(({ startFrame, endFrame }) => [startFrame, endFrame]);
  const entries = async () =>
    (await readdir(join(cache, 'picture-v1'), { withFileTypes: true }))
      .filter((item) => item.isDirectory() && /^[a-f0-9]{64}$/.test(item.name))
      .map(({ name }) => name);
  try {
    const secondSource = join(directory, 'next.mp4');
    await copyFile(join(fixtureDirectory, 'video-long.mp4'), secondSource);
    await writeEdit(0);
    const first = cached('first');
    assert.deepEqual(spans(first.pictureRanges), [
      [0, 12, 'rendered'],
      [12, 16, 'rendered'],
      [16, 18, 'rendered'],
      [18, 28, 'rendered'],
      [28, 48, 'rendered'],
      [48, 80, 'rendered'],
    ]);

    const firstEntries = await entries();
    await writeEdit(70);
    const shifted = cached('shifted');
    assert.deepEqual(spans(shifted.pictureRanges), [
      [0, 82, 'rendered'],
      [82, 86, 'reused'],
      [86, 88, 'reused'],
      [88, 98, 'reused'],
      [98, 118, 'reused'],
      [118, 150, 'reused'],
    ]);
    const newEntries = (await entries()).filter(
      (name) => !firstEntries.includes(name),
    );
    assert.equal(newEntries.length, 1);
    assert.ok(
      shifted.recipeProcessing.some(({ status }) => status === 'cache-hit'),
    );
    const reference = render('reference', []);
    verifyVideoTimestamps(shifted.output, rate, 150);
    assert.ok(
      picture(shifted.output).equals(picture(reference.output)),
      'cached picture differs from clean render',
    );
    const audio = decodeAudio(shifted.output).samples;
    assert.deepEqual(audio, decodeAudio(reference.output).samples);
    assert.ok(Math.abs(sampleOnsets(audio)[0]! - 88 / 60) < 0.01);

    await writeEdit(70, { volume: 0.5 });
    const audioEdit = cached('audio-only');
    assert.deepEqual(misses(audioEdit.pictureRanges), []);
    assert.ok(picture(audioEdit.output).equals(picture(shifted.output)));
    assert.notDeepEqual(decodeAudio(audioEdit.output).samples, audio);

    await writeEdit(70, { caption: 'Revised caption' });
    const captionEdit = cached('caption');
    assert.deepEqual(misses(captionEdit.pictureRanges), [[88, 98]]);
    assert.ok(!picture(captionEdit.output).equals(picture(shifted.output)));

    for (const [name, edit] of [
      ['framing', { scale: 0.85 }],
      ['grade', { exposure: 0.2 }],
      ['source-frames', { sourceIn: 16 }],
    ] as const) {
      await writeEdit(70, edit);
      assert.deepEqual(misses(cached(name).pictureRanges), [
        [82, 86],
        [86, 88],
        [88, 98],
        [98, 118],
      ]);
    }
    await writeEdit(70, { fade: 6 });
    assert.deepEqual(misses(cached('transition').pictureRanges), [[82, 88]]);

    await writeEdit(70);
    await copyFile(join(fixtureDirectory, 'video-medium.mp4'), secondSource);
    assert.deepEqual(misses(cached('changed-file').pictureRanges), [
      [118, 150],
    ]);
    await writeFile(
      join(cache, 'picture-v1', newEntries[0]!, 'media.nut'),
      'truncated',
    );
    const textOutput = render('text-output', ['--picture-cache', cache]);
    assert.match(textOutput.stdout, /Picture \[0, 82\): rendered/);
    assert.match(textOutput.stdout, /Picture \[118, 150\): reused/);

    const fps = ['--fps', '30000/1001', '--width', '128', '--height', '72'];
    const resampled = cached('resampled', fps);
    const resampledReference = render('resampled-reference', fps);
    verifyVideoTimestamps(
      resampled.output,
      { numerator: 30000, denominator: 1001 },
      75,
    );
    assert.ok(
      picture(resampled.output).equals(picture(resampledReference.output)),
    );
    assert.deepEqual(
      decodeAudio(resampled.output).samples,
      decodeAudio(resampledReference.output).samples,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('picture cache preserves cross-dissolves when shifted on a fractional project clock', async () => {
  const directory = await mkdtemp(join(fixtureDirectory, 'picture-dissolve-'));
  const file = join(directory, 'edit.video.ts');
  const pictureCacheDirectory = join(directory, 'cache');
  const frameRate = { numerator: 30000, denominator: 1001 };
  const writeEdit = (shift: number) =>
    writeFile(
      file,
      'export default ' +
        JSON.stringify(
          defineVideo({
            canvas: { width: 160, height: 90, frameRate },
            assets: { camera: { path: '../video-medium.mp4', kind: 'video' } },
            tracks: [
              {
                type: 'video',
                clips: [
                  {
                    at: 0,
                    duration: 8 + shift,
                    text: { content: 'Intro', fontSize: 14 },
                  },
                  {
                    id: 'outgoing',
                    asset: 'camera',
                    at: 8 + shift,
                    sourceIn: 10,
                    sourceOut: 34,
                    muted: true,
                    speed: { numerator: 3, denominator: 2 },
                  },
                  {
                    id: 'incoming',
                    asset: 'camera',
                    at: 24 + shift,
                    sourceIn: 50,
                    sourceOut: 66,
                    muted: true,
                  },
                ],
              },
            ],
            transitions: [
              {
                id: 'dissolve',
                kind: 'cross-dissolve',
                from: 'outgoing',
                to: 'incoming',
                frames: 6,
              },
            ],
          }),
        ),
    );
  try {
    await writeEdit(0);
    const first = await renderVideo(file, join(directory, 'first.mp4'), {
      pictureCacheDirectory,
    });
    const shift = 35;
    await writeEdit(shift);
    const revised = await renderVideo(file, join(directory, 'revised.mp4'), {
      pictureCacheDirectory,
    });
    const reference = await renderVideo(file, join(directory, 'reference.mp4'));
    assert.deepEqual(
      revised.pictureRanges,
      first.pictureRanges?.map(({ startFrame, endFrame }) => ({
        startFrame: startFrame === 0 ? 0 : startFrame + shift,
        endFrame: endFrame + shift,
        status: startFrame === 0 ? 'rendered' : 'reused',
      })),
    );
    verifyVideoTimestamps(revised.path, frameRate, 40 + shift);
    assert.ok(
      picture(revised.path).equals(picture(reference.path)),
      'cached dissolve differs from clean render',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('ordinary footage uses the same frames in cached and sequential renders across a VFR gap', async () => {
  const directory = await mkdtemp(join(fixtureDirectory, 'picture-seek-'));
  const path = join(directory, 'gap.mp4');
  const frameRate = { numerator: 24000, denominator: 1001 };
  try {
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=160x90:r=24:d=12',
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
      '8,10',
      path,
    ]);
    const options: VideoTimelineOptions = {
      width: 160,
      height: 90,
      frameRate,
      frameCount: 156,
      visualClips: [
        {
          clipId: 'footage',
          path,
          timelineStartFrame: 0,
          sourceStartFrame: 120,
          frameCount: 156,
        },
        {
          clipId: 'in-gap',
          text: { content: 'Gap' },
          timelineStartFrame: 15,
          sourceStartFrame: 0,
          frameCount: 1,
        },
        {
          clipId: 'after-gap',
          text: { content: 'After' },
          timelineStartFrame: 145,
          sourceStartFrame: 0,
          frameCount: 5,
        },
      ],
      output: join(directory, 'reference.mp4'),
    };
    const entries = new Map<string, string>();
    const pictureCache: PictureCache = {
      backend: 'test',
      sourceIdentity: (path) => path,
      async materialize(key, encode) {
        const cached = entries.get(key);
        if (cached) return { path: cached, reused: true };
        const path = join(directory, key + '.nut');
        await encode(path);
        entries.set(key, path);
        return { path, reused: false };
      },
    };
    const reference = await renderVideoTimeline(options);
    const cached = await renderVideoTimeline({
      ...options,
      pictureCache,
      output: join(directory, 'cached.mp4'),
    });
    assert.ok(picture(cached.path).equals(picture(reference.path)));
    verifyVideoTimestamps(cached.path, frameRate, 156);
    const warm = await renderVideoTimeline({
      ...options,
      pictureCache,
      output: join(directory, 'warm.mp4'),
    });
    assert.equal(warm.pictureRanges?.length, 5);
    assert.ok(warm.pictureRanges.every(({ status }) => status === 'reused'));
    assert.ok(picture(warm.path).equals(picture(reference.path)));

    const inputBytes = await readFile(path);
    const alias = join(directory, 'alias.mp4');
    await link(path, alias);
    for (const output of [path, alias]) {
      await assert.rejects(
        renderVideoTimeline({
          ...options,
          pictureCache,
          output,
          overwrite: true,
        }),
        /must not replace source media/,
      );
      assert.deepEqual(await readFile(output), inputBytes);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

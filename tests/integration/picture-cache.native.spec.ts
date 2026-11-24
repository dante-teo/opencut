import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { unlinkSync, utimesSync, writeFileSync } from 'node:fs';
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
import {
  compileVideo,
  defineVideo,
  findSourceChange,
  planVideoRender,
  renderCompiledVideo,
  renderVideo,
} from '@opencut/sdk';
import {
  findSourceChange as findMp4SourceChange,
  readMp4FrameIndex,
  renderVideoTimeline,
} from '../../packages/media/src/index.js';
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

test('CLI saves verified picture packets and stream copies them into an audio-only revision', async (t) => {
  const directory = await mkdtemp(join(fixtureDirectory, 'audio-revision-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'edit.video.ts');
  const cache = join(directory, 'cache');
  const writeEdit = (volume: number, scale: number) =>
    writeFile(
      file,
      'export default ' +
        JSON.stringify(
          defineVideo({
            canvas: {
              width: 160,
              height: 90,
              frameRate: rate,
              durationFrames: 24,
            },
            assets: {
              shot: { path: '../video-medium.mp4', kind: 'video' },
              song: { path: '../audio-tone.wav', kind: 'audio' },
            },
            tracks: [
              {
                type: 'video',
                muted: true,
                clips: [
                  { asset: 'shot', at: 0, sourceOut: 24, visual: { scale } },
                ],
              },
              {
                type: 'audio',
                volume,
                clips: [{ asset: 'song', at: 0, sourceOut: 24 }],
              },
            ],
          }),
        ),
    );
  const run = (version: string, name: string) => {
    const path = join(directory, `${name}.mp4`);
    const result = spawnSync(
      process.execPath,
      [
        entry,
        'render',
        file,
        '--output',
        path,
        '--picture-cache',
        cache,
        '--picture-version',
        version,
        '--json',
      ],
      { encoding: 'utf8', timeout: 60_000 },
    );
    return { path, result };
  };
  await writeEdit(1, 1);
  const saved = run('save', 'saved');
  assert.equal(saved.result.status, 0, saved.result.stderr);
  const id = JSON.parse(saved.result.stdout).pictureVersion.id as string;
  assert.match(id, /^[a-f0-9]{64}\.[a-f0-9]{64}$/);
  await writeEdit(0.35, 1);
  const revised = run(id, 'revised');
  assert.equal(revised.result.status, 0, revised.result.stderr);
  assert.deepEqual(JSON.parse(revised.result.stdout).pictureVersion, {
    id,
    status: 'reused',
  });
  const packetHash = (path: string) =>
    ffmpeg([
      '-i',
      path,
      '-map',
      '0:v:0',
      '-c:v',
      'copy',
      '-f',
      'hash',
      'pipe:1',
    ]).toString();
  assert.equal(packetHash(saved.path), packetHash(revised.path));
  assert.ok(
    revised.result.stderr
      .split('\n')
      .some(
        (line) => line.startsWith('{') && JSON.parse(line).stage === 'muxing',
      ),
  );
  for (const [expected, status] of [
    ['120/2', 0],
    ['30', 1],
  ] as const) {
    const probe = spawnSync(
      process.execPath,
      [entry, 'probe', revised.path, '--expect-fps', expected, '--json'],
      { encoding: 'utf8' },
    );
    assert.equal(probe.status, status, probe.stderr);
    assert.deepEqual(
      JSON.parse(probe.stdout).frameRateCheck.passed,
      status === 0,
    );
  }
  verifyVideoTimestamps(revised.path, rate, 24);
  assert.notDeepEqual(
    decodeAudio(saved.path).samples,
    decodeAudio(revised.path).samples,
  );
  await writeEdit(0.35, 0.9);
  const changed = run(id, 'changed-picture');
  assert.equal(changed.result.status, 1);
  assert.match(
    changed.result.stderr,
    /Picture or video export settings changed.*Rebuild the picture/,
  );
  await writeEdit(0.35, 1);
  await writeFile(join(cache, 'picture-v1', id, 'media.mp4'), 'invalid cache');
  const corrupt = run(id, 'corrupt-picture');
  assert.equal(corrupt.result.status, 1);
  assert.match(corrupt.result.stderr, /Saved picture is missing or corrupt/);
});

test('an audio source change after composition preserves verified cached picture ranges', async (t) => {
  const directory = await mkdtemp(
    join(fixtureDirectory, 'changed-render-source-'),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'edit.video.ts');
  const wav = join(directory, 'music.wav');
  const output = join(directory, 'render.mp4');
  const cache = join(directory, 'cache');
  const audio = await readFile(join(fixtureDirectory, 'audio-tone.wav'));
  await writeFile(wav, audio);
  const writeEdit = (audioRole: 'music' | 'dialogue') =>
    writeFile(
      file,
      'export default ' +
        JSON.stringify(
          defineVideo({
            canvas: {
              width: 160,
              height: 90,
              frameRate: 60,
              durationFrames: 24,
            },
            assets: { music: { path: 'music.wav', kind: 'audio' } },
            tracks: [
              {
                type: 'text',
                clips: [{ at: 0, duration: 24, text: { content: 'Picture' } }],
              },
              {
                type: 'audio',
                audioRole,
                clips: [{ asset: 'music', at: 0, sourceOut: 24 }],
              },
            ],
            professionalMix: { preset: 'natural-cinematic' },
          }),
        ),
    );
  await writeEdit('music');
  const options = {
    pictureCacheDirectory: cache,
    pictureVersion: 'save',
    processing: { cacheDirectory: join(directory, 'recipes') },
  };
  for (const scenario of ['unchanged', 'changed', 'removed'] as const) {
    if (scenario === 'removed') await writeEdit('dialogue');
    const video = await compileVideo(file, options);
    await assert.rejects(
      renderCompiledVideo(video, output, {
        ...options,
        onProgress(event) {
          if (event.stage !== 'composition' || event.percent !== 100) return;
          if (scenario === 'unchanged') utimesSync(wav, 1, 1);
          else if (scenario === 'removed') unlinkSync(wav);
          else {
            audio[audio.length - 1] = audio[audio.length - 1]! ^ 1;
            writeFileSync(wav, audio);
          }
        },
      }),
      (error: unknown) => {
        const change = findSourceChange(error)?.change;
        assert.equal(change?.path, wav);
        assert.equal(
          change?.stage,
          scenario === 'removed' ? 'audio analysis' : 'audio mastering',
        );
        assert.equal(
          change?.content,
          scenario === 'removed' ? 'unknown' : scenario,
        );
        if (scenario === 'removed') {
          assert.equal(change.after, null);
          assert.ok(change.before);
          assert.ok(change.beforeSha256);
        }
        assert.equal(change?.completedPictureRanges?.length, 1);
        assert.deepEqual(change.completedPictureRanges[0], {
          startFrame: 0,
          endFrame: 24,
          status: scenario === 'unchanged' ? 'rendered' : 'reused',
        });
        return true;
      },
    );
    await assert.rejects(readFile(output), { code: 'ENOENT' });
    if (scenario === 'removed') await writeFile(wav, audio);
    const plan = await planVideoRender(file, output, options);
    assert.equal(plan.pictureRanges[0]?.status, 'reuse');
  }
  const audioStages: string[] = [];
  await renderVideo(file, output, {
    ...options,
    onProgress(event) {
      if (event.stage?.startsWith('audio-'))
        audioStages.push(`${event.stage}:${event.percent}`);
    },
  });
  assert.deepEqual(audioStages, [
    'audio-analysis:0',
    'audio-analysis:100',
    'audio-mastering:0',
    'audio-mastering:100',
  ]);
});

test('MP4 frame inspection identifies metadata-only and content changes', async (t) => {
  const directory = await mkdtemp(
    join(fixtureDirectory, 'changed-mp4-source-'),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'input.mp4');
  const source = join(fixtureDirectory, 'video-medium.mp4');
  await copyFile(source, path);
  const checkChange = (content: string) => (error: unknown) => {
    const change = findMp4SourceChange(error)?.change;
    assert.equal(change?.path, path);
    assert.equal(change?.content, content);
    assert.notEqual(change?.before, change?.after);
    return true;
  };
  const first = await readMp4FrameIndex(path);
  utimesSync(path, 1, 1);
  await assert.rejects(first.checkSource(), checkChange('unchanged'));
  const next = await readMp4FrameIndex(path);
  await copyFile(join(fixtureDirectory, 'video-short.mp4'), path);
  await assert.rejects(next.checkSource(), checkChange('changed'));
});

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
      join(cache, 'picture-v1', newEntries[0]!, 'media.mkv'),
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

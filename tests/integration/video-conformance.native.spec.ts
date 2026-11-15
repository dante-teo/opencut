import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { symlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { test } from 'node:test';
import {
  compileVideo,
  previewVideo,
  probeMedia,
  renderCompiledVideo,
  renderVideo,
} from '@opencut/sdk';
import type { VideoDefinition } from '@opencut/sdk';
import {
  generatedFixtures,
  resolveFixtureDirectory,
} from '../fixture-paths.js';
import { decodeAudio, sampleOnsets } from './audio-comparison.js';
import {
  compareRgb,
  decodeFrames,
  ffmpeg,
  probeFrameTimestamps,
  verifyVideoTimestamps,
} from './media-comparison.js';
import {
  assertFramesMatch,
  assertNear,
  assertSimilarExports,
  conformanceWorkspace,
  losslessH264,
  previewTolerance,
  repeatTolerance,
  saveRgb,
  toneAmplitude,
} from './conformance-support.js';

const rate = { numerator: 24, denominator: 1 };

function pixel(rgb: Buffer, width: number, x: number, y: number) {
  const offset = (y * width + x) * 3;
  return [...rgb.subarray(offset, offset + 3)];
}

function brightPixels(
  rgb: Buffer,
  width: number,
  startY: number,
  endY: number,
) {
  let count = 0;
  for (let i = startY * width * 3; i < endY * width * 3; i += 3)
    if (rgb[i]! > 210 && rgb[i + 1]! > 210 && rgb[i + 2]! > 210) count++;
  return count;
}

test(
  'mixed-rate composition matches authored boundaries, transforms and decoded preview',
  { timeout: 120_000 },
  async (t) => {
    const run = await conformanceWorkspace(t, 'mixed-composition');
    const width = 160,
      height = 96;
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'color=red:s=160x96:r=24:d=2',
      '-f',
      'lavfi',
      '-i',
      'color=lime:s=8x8:r=24:d=2',
      '-filter_complex',
      "[0:v][1:v]overlay=x='8+4*n':y=76",
      ...losslessH264,
      run.path('red.mov'),
    ]);
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'color=blue:s=64x96:r=30:d=2',
      '-vf',
      "geq=lum='if(between(X,8,19)*between(Y,34,45),32+8*mod(N,25),lum(X,Y))':cb='if(between(X,4,9)*between(Y,17,22),128,cb(X,Y))':cr='if(between(X,4,9)*between(Y,17,22),128,cr(X,Y))',setpts='N+3*gte(N,12)'",
      '-fps_mode',
      'passthrough',
      ...losslessH264,
      run.path('portrait.mov'),
    ]);
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'color=yellow:s=40x32',
      '-frames:v',
      '1',
      '-threads',
      '1',
      '-update',
      '1',
      run.path('layer.png'),
    ]);
    const source = probeFrameTimestamps(run.path('portrait.mov'), 'v:0');
    const intervals = new Set(
      source.frames.slice(1).map(({ pts }, i) => pts! - source.frames[i]!.pts!),
    );
    assert.equal(intervals.size, 2, 'fixture has two distinct frame intervals');

    const value: VideoDefinition = {
      canvas: { width, height, frameRate: 24, durationFrames: 48 },
      assets: {
        red: { kind: 'video', path: 'red.mov' },
        portrait: { kind: 'video', path: 'portrait.mov' },
        layer: { kind: 'image', path: 'layer.png' },
      },
      tracks: [
        {
          type: 'video',
          clips: [
            {
              id: 'red-clip',
              asset: 'red',
              at: 0,
              sourceOut: 12,
              speed: { numerator: 1, denominator: 2 },
            },
            {
              id: 'portrait-clip',
              asset: 'portrait',
              at: 24,
              sourceIn: 6,
              sourceOut: 24,
              visual: { fit: 'cover' },
            },
            {
              id: 'graded-clip',
              asset: 'red',
              at: 44,
              sourceOut: 3,
              grade: {
                exposure: 0,
                contrast: 1,
                saturation: 0,
                temperature: 0,
                tint: 0,
                curve: [],
              },
            },
          ],
        },
        {
          type: 'image',
          clips: [
            {
              id: 'yellow',
              asset: 'layer',
              at: 8,
              duration: 12,
              visual: { scale: 0.25, rotation: 8 },
              keyframes: {
                x: [
                  {
                    time: { numerator: 0, denominator: 1 },
                    value: -40,
                    easing: 'linear',
                  },
                  {
                    time: { numerator: 1, denominator: 3 },
                    value: 40,
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
            {
              at: 3,
              duration: 3,
              text: { content: 'TITLE', fontSize: 18, color: '#FFFFFF' },
              visual: { y: -28 },
            },
          ],
        },
      ],
      transitions: [
        {
          id: 'dissolve',
          kind: 'cross-dissolve',
          from: 'red-clip',
          to: 'portrait-clip',
          frames: 6,
        },
      ],
      subtitles: {
        style: { fontSize: 18, color: '#FFFFFF' },
        cues: [
          {
            id: 'caption',
            text: 'SUBTITLE',
            start: { numerator: 30, denominator: 24 },
            end: { numerator: 35, denominator: 24 },
          },
        ],
      },
    };
    const definition = await run.definition(value);
    const compiled = await compileVideo(definition);
    const preview = previewVideo(compiled);
    const inspect = preview.inspectFrame(12);
    assert.deepEqual(
      inspect.visualClips.find(({ id }) => id === 'red-clip')?.sourceTime,
      { numerator: 1, denominator: 4 },
    );
    assert.equal(
      inspect.visualClips.find(({ id }) => id === 'yellow')?.visual.x,
      0,
    );
    assert.equal(preview.inspectFrame(48).boundary, 'end');

    const final = (await renderCompiledVideo(compiled, run.path('final.mp4')))
      .path;
    const repeated = (await renderVideo(definition, run.path('repeated.mp4')))
      .path;
    const clip = (
      await preview.clip(
        { startFrame: 2, endFrame: 46 },
        run.path('preview.mp4'),
        { quality: 'high' },
      )
    ).path;
    const positions = [
      2, 3, 5, 6, 7, 8, 12, 16, 19, 20, 21, 24, 26, 27, 28, 29, 30, 31, 34, 35,
      41, 42, 43, 44, 45,
    ];
    for (const path of [final, repeated]) verifyVideoTimestamps(path, rate, 48);
    verifyVideoTimestamps(clip, rate, 44);
    const missing = run.path('dropped-frame.mp4');
    ffmpeg([
      '-i',
      final,
      '-vf',
      "select='not(eq(n,12))'",
      '-fps_mode',
      'passthrough',
      '-an',
      ...losslessH264,
      missing,
    ]);
    assert.throws(() => verifyVideoTimestamps(missing, rate, 48), /found 47/);
    assert.throws(
      () => verifyVideoTimestamps(missing, rate, 47),
      /frame 12.*off the project grid/i,
    );
    const wrongFrame = run.path('wrong-frame.mp4');
    ffmpeg([
      '-i',
      final,
      '-vf',
      "drawbox=color=black:t=fill:enable='eq(n,23)'",
      ...losslessH264,
      '-c:a',
      'copy',
      wrongFrame,
    ]);
    await assert.rejects(
      assertSimilarExports(final, wrongFrame, {
        width,
        height,
        frameCount: 48,
        fps: 24,
      }),
      /frame 23:/,
    );
    const frames = decodeFrames(final, positions, width, height);
    const rgb = (frame: number) => frames.get(frame)!;
    const repeatedFrames = decodeFrames(repeated, positions, width, height);
    const repeatMetrics = assertFramesMatch(
      repeatedFrames,
      frames,
      repeatTolerance,
    );
    const clipFrames = decodeFrames(
      clip,
      positions.map((frame) => frame - 2),
      width,
      height,
    );
    const clipMetrics = assertFramesMatch(
      new Map(positions.map((frame) => [frame, clipFrames.get(frame - 2)!])),
      frames,
    );
    const center = (frame: number) => pixel(rgb(frame), width, 80, 48);
    const [red, green, blue] = center(24);
    assert.ok(
      red! > 60 && blue! > 60 && green! < 30,
      'cross-dissolve contains both pictures',
    );
    assert.ok(center(21)[0]! > 230 && center(27)[2]! > 230);
    assert.ok(
      center(41)[2]! > 230 && center(42).every((channel) => channel < 10),
      'picture out is exclusive',
    );
    for (const [frame, x, expected] of [
      [7, 40, false],
      [8, 40, true],
      [12, 80, true],
      [16, 120, true],
      [19, 120, true],
      [20, 120, false],
    ] as const) {
      assert.equal(
        pixel(rgb(frame), width, x, 48)[1]! > 180,
        expected,
        `overlay at ${frame}, x=${x}`,
      );
    }
    const gradedColor = center(45);
    assert.ok(gradedColor.every((channel) => channel > 35 && channel < 95));
    assertNear(
      Math.max(...gradedColor),
      Math.min(...gradedColor),
      3,
      'desaturated red is neutral',
    );
    const retimedPixels = [12, 20].map((frame) => {
      // At half speed these project frames sample source frames 6 and 10.
      const x = 16 + 4 * (frame / 2);
      const atExpectedTime = pixel(rgb(frame), width, x, 80)[1]!;
      const atNormalSpeed = pixel(rgb(frame), width, 16 + 4 * frame, 80)[1]!;
      assert.ok(
        atExpectedTime > 200 && atNormalSpeed < 25,
        `source motion at frame ${frame}`,
      );
      return { frame, x, atExpectedTime, atNormalSpeed };
    });
    // With sourceIn at project frame 6, the three missing source ticks hold
    // frame 11 at timeline frames 27–29. Frame 12 first appears at frame 30.
    const vfrFrames = [
      [27, 11],
      [28, 11],
      [29, 11],
      [30, 12],
      [31, 13],
      [35, 18],
    ] as const;
    const portrait = decodeFrames(
      run.path('portrait.mov'),
      vfrFrames.map(([, sourceFrame]) => sourceFrame),
      64,
      96,
    );
    const vfrSampling = vfrFrames.map(([frame, sourceFrame]) => {
      const expected = pixel(portrait.get(sourceFrame)!, 64, 14, 40)[1]!;
      const actual = pixel(rgb(frame), width, 35, 28)[1]!;
      assertNear(
        actual,
        expected,
        3,
        `portrait source frame ${sourceFrame} at timeline frame ${frame}`,
      );
      return { frame, sourceFrame, expected, actual };
    });
    const title = [2, 3, 5, 6].map((frame) =>
      brightPixels(rgb(frame), width, 0, 40),
    );
    const subtitles = [29, 30, 34, 35].map((frame) =>
      brightPixels(rgb(frame), width, 48, height),
    );
    for (const [off, start, end, after] of [title, subtitles]) {
      assert.equal(off, 0);
      assert.ok(start! > 10 && end! > 10);
      assert.equal(after, 0);
    }

    const png = (await preview.frame(24, run.path('preview-24.png'))).path;
    const frameMetrics = compareRgb(
      decodeFrames(png, [0], width, height).get(0)!,
      rgb(24),
      previewTolerance,
    );
    assert.ok(frameMetrics.passed, JSON.stringify(frameMetrics));
    // The same oracle must reject a missing overlay and a frame sampled outside the dissolve.
    for (const [bad, expected] of [
      [7, 8],
      [27, 24],
    ] as const)
      assert.equal(
        compareRgb(rgb(bad), rgb(expected), previewTolerance).passed,
        false,
        `compositing negative control ${bad}→${expected}`,
      );

    saveRgb(rgb(24), width, height, run.path('export-24.png'));
    run.measure('decoded composition', {
      sourcePtsDeltas: [...intervals],
      width,
      height,
      frameCount: 48,
      transitionCenter: { red, green, blue },
      titleBrightPixels: title,
      subtitleBrightPixels: subtitles,
      retimedPixels,
      vfrSampling,
      gradedColor,
      repeatBuild: repeatMetrics,
      clipPreview: clipMetrics,
      pngPreview: frameMetrics.metrics,
      artifacts: await run.artifacts(
        png,
        run.path('export-24.png'),
        final,
        clip,
      ),
    });
  },
);

test(
  'two-minute portrait render stays in sync and preserves independently measurable mix and fades',
  { timeout: 120_000 },
  async (t) => {
    const run = await conformanceWorkspace(t, 'long-sync');
    const width = 96,
      height = 160,
      seconds = 120;
    const clock = 'lt(mod(t+14,15),0.125)';
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      `color=black:s=${width}x${height}:r=24:d=${seconds},drawbox=x=0:y=0:w=24:h=24:color=white:t=fill:enable='${clock}'`,
      '-f',
      'lavfi',
      '-i',
      `aevalsrc='0.2*sin(2*PI*440*t)*${clock}':s=48000:d=${seconds}`,
      ...losslessH264,
      '-c:a',
      'pcm_s16le',
      run.path('clock.mov'),
    ]);
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'aevalsrc=0.1*sin(2*PI*880*t):s=48000:d=4',
      '-c:a',
      'pcm_s16le',
      run.path('bed.wav'),
    ]);
    const value: VideoDefinition = {
      canvas: { width, height, frameRate: 24, durationFrames: seconds * 24 },
      assets: {
        clock: { kind: 'video', path: 'clock.mov' },
        bed: { kind: 'audio', path: 'bed.wav' },
      },
      tracks: [
        {
          type: 'video',
          clips: [{ asset: 'clock', at: 0, sourceOut: seconds * 24 }],
        },
        {
          type: 'audio',
          clips: [
            {
              asset: 'bed',
              at: 14 * 24,
              sourceOut: 4 * 24,
              fadeIn: 24,
              fadeOut: 24,
              volume: 0.2,
              effects: [{ type: 'eq', frequency: 880, db: 6 }],
            },
          ],
        },
      ],
    };
    const compiled = await compileVideo(await run.definition(value));
    const path = (await renderCompiledVideo(compiled, run.path('long.mp4')))
      .path;
    const metadata = await probeMedia(path);
    assert.deepEqual(
      [
        metadata.video?.width,
        metadata.video?.height,
        metadata.video?.durationSeconds,
        metadata.audio?.durationSeconds,
        metadata.audio?.sampleRate,
      ],
      [width, height, seconds, seconds, 48000],
    );
    const pts = verifyVideoTimestamps(path, rate, seconds * 24);
    const expected = Array.from({ length: 8 }, (_, i) => 1 + 15 * i);
    const markers = expected.flatMap((time) => [
      time * 24 - 1,
      time * 24,
      time * 24 + 2,
      time * 24 + 3,
    ]);
    const frames = decodeFrames(path, markers, width, height);
    const audio = decodeAudio(path);
    const onsets = sampleOnsets(audio.samples);
    assert.equal(onsets.length, expected.length);
    const sync = expected.map((time, i) => {
      const frame = time * 24;
      assert.deepEqual(
        markers
          .slice(i * 4, i * 4 + 4)
          .map((index) => pixel(frames.get(index)!, width, 12, 12)[0]! > 230),
        [false, true, true, false],
      );
      assertNear(onsets[i]!, pts[frame]!, 0.01, `marker at ${time}s`);
      return {
        frame,
        videoSeconds: pts[frame],
        audioSeconds: onsets[i],
        skewMs: (onsets[i]! - pts[frame]!) * 1000,
      };
    });
    assert.throws(
      () =>
        assertNear(
          onsets[4]! + 1 / 24,
          pts[expected[4]! * 24]!,
          0.01,
          'shifted pulse',
        ),
      /shifted pulse/,
    );
    const bed = [14.1, 16.025, 16.2, 17.8, 18.1].map((time) =>
      toneAmplitude(audio.samples, 880, time, 0.05),
    );
    const mixed = toneAmplitude(audio.samples, 440, 16.025, 0.05);
    assertNear(mixed, 0.2 / Math.sqrt(2), 0.012, 'sync tone under the music');
    assert.ok(
      bed[0]! > 0.001 &&
        bed[0]! < bed[2]! / 3 &&
        bed[3]! > 0.003 &&
        bed[3]! < bed[2]! / 3,
    );
    assertNear(bed[1]!, bed[2]!, 0.004, 'music amplitude during mix');
    assertNear(
      bed[2]!,
      (0.1 * 0.2 * 10 ** (6 / 20)) / Math.sqrt(2),
      0.004,
      'EQ boost and clip volume',
    );
    assert.ok(bed[4]! < 0.001, 'music out is exclusive');

    const clip = (
      await previewVideo(compiled).clip(
        { startFrame: 14 * 24, endFrame: 18 * 24 },
        run.path('sync-preview.mp4'),
        { quality: 'high' },
      )
    ).path;
    verifyVideoTimestamps(clip, rate, 96);
    const clipAudio = decodeAudio(clip).samples;
    const clipOnsets = sampleOnsets(clipAudio);
    assert.equal(clipOnsets.length, 1);
    assertNear(clipOnsets[0]!, onsets[1]! - 14, 0.01, 'trimmed preview onset');
    const toneComparison = [0.1, 2.025, 2.2, 3.8].map((time) => {
      const preview = toneAmplitude(clipAudio, 880, time, 0.05);
      const exported = toneAmplitude(audio.samples, 880, time + 14, 0.05);
      assertNear(preview, exported, 0.004, 'preview music amplitude');
      return { time, preview, exported };
    });
    const wav = run.path('sync-preview.wav');
    ffmpeg(['-i', clip, '-map', '0:a:0', '-c:a', 'pcm_s16le', wav]);
    run.measure('timestamp grid, A/V markers and spectral mix', {
      metadata,
      frameCount: pts.length,
      decodedAudioSamples: audio.samples.length,
      sync,
      musicAmplitudes: bed,
      overlapping440Hz: mixed,
      previewOnsets: clipOnsets,
      toneComparison,
      artifacts: await run.artifacts(path, clip, wav),
    });
  },
);

test('audio effect ordering has the expected noncommutative gain', async (t) => {
  const run = await conformanceWorkspace(t, 'effect-order');
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'aevalsrc=0.09*sin(2*PI*440*t):s=48000:d=1',
    '-c:a',
    'pcm_s16le',
    run.path('tone.wav'),
  ]);
  const eq = { type: 'eq', frequency: 440, db: 12 } as const;
  const limiter = { type: 'limiter', ceiling: -18 } as const;
  const amplitudes = [];
  const artifactPaths = [];
  for (const [name, effects] of [
    ['eq-first', [eq, limiter]],
    ['limiter-first', [limiter, eq]],
  ] as const) {
    const file = await run.definition(
      {
        canvas: { width: 64, height: 64, frameRate: 24, durationFrames: 24 },
        assets: { tone: { kind: 'audio', path: 'tone.wav' } },
        tracks: [
          {
            type: 'audio',
            clips: [
              { asset: 'tone', at: 0, sourceOut: 24, effects: [...effects] },
            ],
          },
        ],
      },
      name,
    );
    const path = (await renderVideo(file, run.path(name + '.mp4'))).path;
    amplitudes.push(toneAmplitude(decodeAudio(path).samples, 440, 0.25, 0.5));
    const wav = run.path(name + '.wav');
    ffmpeg(['-i', path, '-map', '0:a:0', '-c:a', 'pcm_s16le', wav]);
    artifactPaths.push(wav);
  }
  // The mono source is downmixed into stereo, but only EQ-first drives the limiter.
  assert.ok(amplitudes[0]! < 0.15 && amplitudes[0]! > 0.07);
  assert.ok(amplitudes[1]! > amplitudes[0]! * 1.7 && amplitudes[1]! < 0.39);
  run.measure('ordered effects', {
    eqFirst: amplitudes[0],
    limiterFirst: amplitudes[1],
    artifacts: await run.artifacts(...artifactPaths),
  });
});

test('a definition edited during recipe processing publishes a single revision', async (t) => {
  const run = await conformanceWorkspace(t, 'compile-revision');
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'color=red:s=64x64:r=24:d=1',
    ...losslessH264,
    run.path('source.mov'),
  ]);
  const value: VideoDefinition = {
    canvas: {
      width: 64,
      height: 64,
      frameRate: 24,
      durationFrames: 12,
      backgroundColor: '#0000FF',
    },
    assets: {
      picture: {
        kind: 'video',
        path: 'source.mov',
        recipe: [{ type: 'resize', width: 64, height: 64 }],
      },
    },
    tracks: [
      { type: 'video', clips: [{ asset: 'picture', at: 0, sourceOut: 6 }] },
    ],
  };
  const file = await run.definition(value);
  const cacheDirectory = run.path('cache');
  let edited = false;
  const first = await compileVideo(file, {
    processing: {
      cacheDirectory,
      onProgress({ status }) {
        if (status !== 'started') return;
        value.canvas.backgroundColor = '#00FF00';
        value.tracks[0]!.clips[0]!.at = 6;
        writeFileSync(file, `export default ${JSON.stringify(value)};\n`);
        edited = true;
      },
    },
  });
  assert.ok(edited);
  const progress: string[] = [];
  const second = await compileVideo(file, {
    processing: {
      cacheDirectory,
      onProgress: ({ status }) => progress.push(status),
    },
  });
  assert.deepEqual(progress, ['cache-hit']);
  const before = (await renderCompiledVideo(first, run.path('before-edit.mp4')))
    .path;
  const after = (await renderCompiledVideo(second, run.path('after-edit.mp4')))
    .path;
  const centers = [before, after].map((path) => {
    verifyVideoTimestamps(path, rate, 12);
    return [...decodeFrames(path, [5, 6], 64, 64).values()].map((frame) =>
      pixel(frame, 64, 32, 32),
    );
  });
  const dominant = centers.map((revision) =>
    revision.map((rgb) => rgb.indexOf(Math.max(...rgb))),
  );
  assert.deepEqual(dominant, [
    [0, 2],
    [1, 0],
  ]);
  assert.ok(
    centers
      .flat()
      .every(
        (rgb) =>
          Math.max(...rgb) > 230 &&
          rgb.filter((value) => value < 20).length === 2,
      ),
  );
  run.measure('edit during recipe processing', {
    boundaryFrames: [5, 6],
    centers,
    progress,
    artifacts: await run.artifacts(before, after),
  });
});

test('fixture workspaces reject outside paths and symlinks before writing', async (t) => {
  const run = await conformanceWorkspace(t, 'fixture-paths');
  const outside = dirname(generatedFixtures);
  assert.throws(
    () => resolveFixtureDirectory(outside),
    /Fixture directory must be inside/,
  );
  const alias = run.path('alias');
  await symlink(outside, alias, 'dir');
  assert.throws(
    () => resolveFixtureDirectory(alias),
    /Fixture directory must be inside/,
  );
  assert.throws(
    () => resolveFixtureDirectory(run.path('alias/new-media')),
    /Fixture directory must be inside/,
  );
  assert.equal(
    resolveFixtureDirectory(run.path('new-media')),
    run.path('new-media'),
  );
});

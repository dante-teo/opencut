import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  compileVideo,
  previewVideo,
  probeMedia,
  renderCompiledVideo,
  renderVideo,
} from '@opencut/sdk';
import type { VideoDefinition, VideoProcessingProgress } from '@opencut/sdk';
import { decodeAudio } from './audio-comparison.js';
import {
  assertFramesMatch,
  conformanceWorkspace,
  losslessH264,
  repeatTolerance,
  saveRgb,
  toneAmplitude,
} from './conformance-support.js';
import {
  command,
  compareRgb,
  decodeFrames,
  ffmpeg,
  verifyVideoTimestamps,
} from './media-comparison.js';

const tagged =
  'setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709';
const cli = resolve('apps/cli/dist/index.js');
const nativeWorkers = {
  interpolation: existsSync(resolve('packages/media/dist/video-interpolate')),
  enhancement: existsSync(resolve('packages/media/dist/video-enhance')),
};

interface Processor {
  status: string;
  testedSizes?: {
    width: number;
    height: number;
    configurations: { scale: number; status: string }[];
  }[];
}

const capabilities = () =>
  JSON.parse(
    command(process.execPath, [cli, 'system', 'inspect', '--json']).toString(),
  ).videoToolbox.frameProcessors as Record<string, Processor> | undefined;
const supports = (processor: Processor | undefined, scale: number) =>
  processor?.testedSizes?.some(
    (size) =>
      size.width === 640 &&
      size.height === 360 &&
      size.configurations.some(
        (item) =>
          item.scale === scale && item.status === 'configuration-accepted',
      ),
  );

const noLimit = { mean: 255, p95: 255, largePixelFraction: 1 };
const difference = (a: Buffer, b: Buffer) =>
  compareRgb(a, b, noLimit).metrics.mean;
const parseBuild = (output: string) =>
  [...output.matchAll(/recipe picture step (\d+): (completed|cache-hit)/g)].map(
    ([, step, status]) => `${step}:${status}`,
  );

function markerCenter(rgb: Buffer) {
  let count = 0;
  let sum = 0;
  for (let y = 8; y < 40; y++) {
    for (let x = 0; x < 144; x++) {
      const offset = (y * 640 + x) * 3;
      if (rgb[offset]! < 180) continue;
      count++;
      sum += x;
    }
  }
  assert.ok(count > 150, 'the tracked moving marker must remain visible');
  return sum / count;
}

test(
  'AI interpolation and super-resolution chain follows the reference motion and preserves final composition',
  { timeout: 120_000 },
  async (t) => {
    const processors = capabilities();
    if (
      !supports(processors?.['low-latency-interpolation'], 1) ||
      !supports(processors?.['low-latency-super-resolution'], 1.5)
    ) {
      return t.skip(
        'VideoToolbox 640×360 low-latency interpolation and 1.5× super-resolution are required for this chain.',
      );
    }
    if (!nativeWorkers.interpolation || !nativeWorkers.enhancement)
      return t.skip('Build the VideoToolbox workers with a macOS 26+ SDK.');
    const run = await conformanceWorkspace(t, 'ai-chain');
    const reference = run.path('reference.mov');
    const referenceLow = run.path('reference-low.mov');
    const source = run.path('source.mov');
    const cacheDirectory = run.path('cache');
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=960x540:r=48:d=0.75',
      '-f',
      'lavfi',
      '-i',
      'color=white:s=36x36:r=48:d=0.75',
      '-filter_complex',
      `[0:v]drawbox=x=0:y=0:w=960:h=72:color=black:t=fill[base];[base][1:v]overlay=x='30+6*n':y=18,${tagged}`,
      ...losslessH264,
      reference,
    ]);
    ffmpeg([
      '-i',
      reference,
      '-vf',
      'scale=640:360:flags=area',
      ...losslessH264,
      referenceLow,
    ]);
    ffmpeg([
      '-i',
      referenceLow,
      '-f',
      'lavfi',
      '-i',
      'aevalsrc=0.18*sin(2*PI*440*t):s=48000:d=0.75',
      '-vf',
      "select='not(mod(n,2))'",
      '-r',
      '24',
      ...losslessH264,
      '-c:a',
      'pcm_s16le',
      source,
    ]);
    const value: VideoDefinition = {
      canvas: { width: 960, height: 540, frameRate: 48, durationFrames: 40 },
      assets: {
        picture: {
          kind: 'video',
          path: 'source.mov',
          recipe: [
            { type: 'trim', start: 0, end: 0.5 },
            { type: 'interpolateFrames', numerator: 48, quality: 'fast' },
            {
              type: 'superResolution',
              width: 960,
              height: 540,
              quality: 'fast',
            },
          ],
        },
      },
      tracks: [
        { type: 'video', clips: [{ asset: 'picture', at: 4, sourceOut: 24 }] },
        {
          type: 'text',
          clips: [
            {
              at: 16,
              duration: 6,
              text: { content: 'AI chain', fontSize: 38 },
            },
          ],
        },
      ],
    };
    const definition = await run.definition(value);
    async function build(file: string) {
      const events: VideoProcessingProgress[] = [];
      const compiled = await compileVideo(file, {
        processing: {
          cacheDirectory,
          onProgress: (event) => events.push(event),
        },
      });
      const completed = events.filter(
        ({ status }) => status === 'completed' || status === 'cache-hit',
      );
      return { compiled, completed, events };
    }
    const { compiled, completed, events } = await build(definition);
    assert.deepEqual(
      completed.map(({ status }) => status),
      ['completed', 'completed', 'completed'],
    );
    for (const step of [1, 2])
      assert.ok(
        events.some(
          (event) => event.step === step && event.status === 'processing',
        ),
      );
    const intermediate = run.path(`cache/${completed[1]!.key}/media.mov`);
    const derived = run.path(`cache/${completed[2]!.key}/media.mov`);
    verifyVideoTimestamps(intermediate, { numerator: 48, denominator: 1 }, 24);
    verifyVideoTimestamps(derived, { numerator: 48, denominator: 1 }, 24);
    const sourceMetadata = await probeMedia(derived);
    assert.deepEqual(
      [
        sourceMetadata.video?.width,
        sourceMetadata.video?.height,
        sourceMetadata.video?.colorSpace,
        sourceMetadata.video?.durationSeconds,
        sourceMetadata.audio?.durationSeconds,
      ],
      [960, 540, 'bt709', 0.5, 0.5],
    );
    const indices = Array.from({ length: 12 }, (_, i) => i);
    const expectedLow = decodeFrames(referenceLow, indices, 640, 360);
    const generatedLow = decodeFrames(intermediate, indices, 640, 360);
    const interpolation = [1, 3, 5, 7, 9].map((frame) => {
      const actual = generatedLow.get(frame)!;
      const reference = expectedLow.get(frame)!;
      const before = expectedLow.get(frame - 1)!;
      const after = expectedLow.get(frame + 1)!;
      const fromBefore = difference(actual, before);
      const fromAfter = difference(actual, after);
      const referenceError = difference(actual, reference);
      const holdError = Math.min(
        difference(before, reference),
        difference(after, reference),
      );
      const markerError = Math.abs(
        markerCenter(actual) - markerCenter(reference),
      );
      return {
        frame,
        fromBefore,
        fromAfter,
        referenceError,
        holdError,
        markerError,
      };
    });
    run.measure('interpolated motion against withheld native frames', {
      interpolation,
      metadata: sourceMetadata,
      artifacts: await run.artifacts(referenceLow, intermediate),
    });
    for (const {
      frame,
      fromBefore,
      fromAfter,
      referenceError,
      holdError,
      markerError,
    } of interpolation) {
      assert.ok(
        fromBefore > 0.05 && fromAfter > 0.05,
        `frame ${frame} duplicates an endpoint`,
      );
      assert.ok(
        markerError <= 2.5,
        `interpolated frame ${frame} shifts the motion marker by ${markerError}px`,
      );
      assert.ok(
        referenceError <= 1.65 * holdError + 0.75,
        `interpolated frame ${frame} strays from the reference motion`,
      );
    }
    assertFramesMatch(
      new Map([0, 2, 4, 6, 8, 10].map((i) => [i, generatedLow.get(i)!])),
      new Map([0, 2, 4, 6, 8, 10].map((i) => [i, expectedLow.get(i)!])),
      repeatTolerance,
    );
    const baseline = run.path('lanczos.mov');
    ffmpeg([
      '-i',
      intermediate,
      '-vf',
      'scale=960:540:flags=lanczos',
      '-an',
      ...losslessH264,
      baseline,
    ]);
    const upscaled = decodeFrames(derived, indices, 960, 540);
    const lanczos = decodeFrames(baseline, indices, 960, 540);
    const truth = decodeFrames(reference, indices, 960, 540);
    const quality = indices.map((frame) => {
      const actual = upscaled.get(frame)!;
      const control = lanczos.get(frame)!;
      const previous = upscaled.get(frame - 1);
      const delta = previous ? difference(actual, previous) : 0;
      const baselineDelta = frame
        ? difference(control, lanczos.get(frame - 1)!)
        : 0;
      return {
        frame,
        fromLanczos: difference(actual, control),
        referenceError: difference(actual, truth.get(frame)!),
        lanczosError: difference(control, truth.get(frame)!),
        temporalDelta: delta,
        lanczosTemporalDelta: baselineDelta,
      };
    });
    const artifactPaths = [];
    for (const [name, image] of [
      ['ground-truth', truth],
      ['lanczos', lanczos],
      ['enhanced', upscaled],
    ] as const) {
      const png = run.path(name + '.png');
      saveRgb(image.get(6)!, 960, 540, png);
      artifactPaths.push(png);
    }
    run.measure('enhancement reference and temporal deltas', {
      quality,
      artifacts: await run.artifacts(...artifactPaths),
    });
    for (const row of quality) {
      assert.ok(
        row.fromLanczos > 0.05,
        `frame ${row.frame} matches the conventional scaler`,
      );
      assert.ok(
        row.referenceError <= row.lanczosError * 1.35 + 1,
        `frame ${row.frame} loses too much reference detail`,
      );
      assert.ok(
        row.temporalDelta <= row.lanczosTemporalDelta * 1.6 + 0.8,
        `frame ${row.frame} has a temporal discontinuity`,
      );
    }

    const second = await build(definition);
    assert.deepEqual(
      second.completed.map(({ status }) => status),
      ['cache-hit', 'cache-hit', 'cache-hit'],
    );
    assert.deepEqual(
      second.completed.map(({ key }) => key),
      completed.map(({ key }) => key),
    );
    const final = (
      await renderCompiledVideo(compiled, run.path('ai-final.mp4'))
    ).path;
    const alternate = (
      await renderCompiledVideo(second.compiled, run.path('ai-ts.mp4'))
    ).path;
    const preview = (
      await previewVideo(compiled).clip(
        { startFrame: 3, endFrame: 29 },
        run.path('ai-preview.mp4'),
        { maxDimension: 960, quality: 'high' },
      )
    ).path;
    for (const path of [final, alternate])
      verifyVideoTimestamps(path, { numerator: 48, denominator: 1 }, 40);
    verifyVideoTimestamps(preview, { numerator: 48, denominator: 1 }, 26);
    const probes = [3, 4, 5, 10, 15, 16, 21, 22, 27, 28];
    const exportedRgb = decodeFrames(final, probes, 960, 540);
    const previewRgb = decodeFrames(
      preview,
      probes.map((frame) => frame - 3),
      960,
      540,
    );
    const parity = assertFramesMatch(
      decodeFrames(alternate, probes, 960, 540),
      exportedRgb,
      repeatTolerance,
    );
    const comparison = assertFramesMatch(
      new Map(probes.map((frame) => [frame, previewRgb.get(frame - 3)!])),
      exportedRgb,
    );
    const outputAudio = decodeAudio(final).samples;
    const alternateAudio = decodeAudio(alternate).samples;
    const previewAudio = decodeAudio(preview).samples;
    const levels = [
      toneAmplitude(outputAudio, 440, 0.2, 0.1),
      toneAmplitude(alternateAudio, 440, 0.2, 0.1),
      toneAmplitude(previewAudio, 440, 0.2 - 3 / 48, 0.1),
    ];
    assert.ok(levels.every((value) => value > 0.11 && value < 0.14));
    assert.ok(toneAmplitude(outputAudio, 440, 0, 0.04) < 0.001);
    assert.ok(toneAmplitude(outputAudio, 440, 0.65, 0.08) < 0.001);
    run.measure('combined composition', {
      comparison,
      parity,
      audio440Hz: levels,
      artifacts: await run.artifacts(final, preview),
    });

    await writeFile(derived, 'interrupted AI output');
    const repaired = await build(definition);
    assert.deepEqual(
      repaired.completed.map(({ status }) => status),
      ['cache-hit', 'cache-hit', 'completed'],
    );
    assert.deepEqual(
      repaired.completed.map(({ key }) => key),
      completed.map(({ key }) => key),
    );
    verifyVideoTimestamps(derived, { numerator: 48, denominator: 1 }, 24);
    assertFramesMatch(decodeFrames(derived, indices, 960, 540), upscaled);
    await assert.rejects(
      access(run.path(`cache/.${completed[2]!.key}.stage`)),
      { code: 'ENOENT' },
    );

    // Simulate a worker/model version update within the CLI process. The real backend
    // still runs inference. This avoids replacing the shared native executable.
    const media = pathToFileURL(resolve('packages/media/dist/index.js')).href;
    const module = `export * from ${JSON.stringify(media)};
    import { enhancementBackendVersion as original } from ${JSON.stringify(media)};
    export async function enhancementBackendVersion(signal) {
      return [...await original(signal), 'conformance-model-revision'];
    }`;
    const hook = `import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === '@opencut/media' && context.parentURL?.endsWith('/video-processing.js'))
        return { url: ${JSON.stringify('data:text/javascript,' + encodeURIComponent(module))}, shortCircuit: true };
      return next(specifier, context);
    } });`;
    const versioned = run.path('model-revision.mp4');
    const outcome = spawnSync(
      process.execPath,
      [
        '--import',
        'data:text/javascript,' + encodeURIComponent(hook),
        cli,
        'render',
        definition,
        '--recipe-cache',
        cacheDirectory,
        '--output',
        versioned,
      ],
      { encoding: 'utf8', timeout: 30_000 },
    );
    assert.equal(outcome.status, 0, outcome.stderr);
    const changed = parseBuild(outcome.stderr);
    assert.deepEqual(changed, ['1:cache-hit', '2:cache-hit', '3:completed']);
    const entries = (await readdir(cacheDirectory)).filter((name) =>
      /^[a-f0-9]{64}$/.test(name),
    );
    assert.equal(entries.length, 4);
    assert.deepEqual(
      (await readdir(cacheDirectory)).filter((name) => name.endsWith('.stage')),
      [],
    );
    run.measure('selective cache repair and model signature invalidation', {
      original: completed,
      reused: second.completed,
      corruptOutput: repaired.completed,
      modelRevision: changed,
      cacheEntries: entries.length,
    });
  },
);

test(
  'temporal denoising restores a known clean source without frame loss',
  { timeout: 60_000 },
  async (t) => {
    const processor = capabilities()?.['temporal-noise-filter'];
    if (!supports(processor, 1))
      return t.skip(
        `VideoToolbox temporal noise filtering at 640×360: ${processor?.status ?? 'unavailable'}.`,
      );
    if (!nativeWorkers.enhancement)
      return t.skip(
        'Build the VideoToolbox enhancement worker with a macOS 26+ SDK.',
      );
    const run = await conformanceWorkspace(t, 'ai-restoration');
    const clean = run.path('clean.mov');
    const noisy = run.path('noisy.mov');
    const cacheDirectory = run.path('cache');
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=640x360:r=24:d=0.5',
      '-vf',
      tagged,
      ...losslessH264,
      clean,
    ]);
    ffmpeg([
      '-i',
      clean,
      '-vf',
      'noise=all_seed=4242:alls=22:allf=t+u',
      ...losslessH264,
      noisy,
    ]);
    const path = await run.definition({
      canvas: { width: 640, height: 360, frameRate: 24, durationFrames: 12 },
      assets: {
        picture: {
          kind: 'video',
          path: 'noisy.mov',
          recipe: [{ type: 'denoise', quality: 'strong' }],
        },
      },
      tracks: [
        { type: 'video', clips: [{ asset: 'picture', at: 0, sourceOut: 12 }] },
      ],
    });
    const compiled = await compileVideo(path, {
      processing: { cacheDirectory },
    });
    const [restored] = (await compiled.resolveRender()).sourceMetadata.keys();
    verifyVideoTimestamps(restored!, { numerator: 24, denominator: 1 }, 12);
    const indices = Array.from({ length: 12 }, (_, i) => i);
    const reference = decodeFrames(clean, indices, 640, 360);
    const input = decodeFrames(noisy, indices, 640, 360);
    const output = decodeFrames(restored!, indices, 640, 360);
    const measurements = indices.map((frame) => ({
      frame,
      noisyError: difference(input.get(frame)!, reference.get(frame)!),
      restoredError: difference(output.get(frame)!, reference.get(frame)!),
      restoredDelta: frame
        ? difference(output.get(frame)!, output.get(frame - 1)!)
        : 0,
      referenceDelta: frame
        ? difference(reference.get(frame)!, reference.get(frame - 1)!)
        : 0,
    }));
    const rendered = (
      await renderVideo(path, run.path('restored.mp4'), {
        processing: { cacheDirectory },
      })
    ).path;
    verifyVideoTimestamps(rendered, { numerator: 24, denominator: 1 }, 12);
    const artifactPaths = [];
    for (const [name, frames] of [
      ['clean', reference],
      ['noisy', input],
      ['restored', output],
    ] as const) {
      const png = run.path(name + '.png');
      saveRgb(frames.get(6)!, 640, 360, png);
      artifactPaths.push(png);
    }
    run.measure('restoration against clean reference', {
      measurements,
      artifacts: await run.artifacts(...artifactPaths, rendered),
    });
    const total = (key: 'noisyError' | 'restoredError') =>
      measurements.reduce((sum, row) => sum + row[key], 0);
    assert.ok(
      total('restoredError') < total('noisyError') * 0.98,
      'denoising should move the clip toward the clean reference',
    );
    assert.ok(
      measurements.every(
        ({ restoredError, noisyError, restoredDelta, referenceDelta }) =>
          restoredError <= noisyError * 1.15 + 1 &&
          restoredDelta <= referenceDelta + 12,
      ),
      'restoration must avoid frame-local regressions and flicker',
    );
  },
);

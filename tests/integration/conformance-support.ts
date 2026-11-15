import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { TestContext } from 'node:test';
import { probeMedia } from '@opencut/sdk';
import type { VideoDefinition } from '@opencut/sdk';
import { fixtureDirectory } from '../fixture-paths.js';
import { decodeAudio } from './audio-comparison.js';
import {
  compareRgb,
  decodeFrames,
  ffmpeg,
  verifyVideoTimestamps,
} from './media-comparison.js';

export const losslessH264 = [
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
];

export const previewTolerance = { mean: 5, p95: 25, largePixelFraction: 0.025 };
export const repeatTolerance = { mean: 0.5, p95: 2, largePixelFraction: 0.001 };

export async function conformanceWorkspace(t: TestContext, name: string) {
  await mkdir(fixtureDirectory, { recursive: true });
  const directory = await mkdtemp(join(fixtureDirectory, name + '-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = process.env.OPENCUT_CONFORMANCE_ARTIFACTS;
  const artifactDirectory = output && join(output, name);
  if (artifactDirectory) await mkdir(artifactDirectory);

  return {
    path: (filename: string) => join(directory, filename),
    async definition(
      value: VideoDefinition,
      format: 'ts' | 'json' = 'json',
      stem = 'edit',
    ) {
      const path = join(directory, stem + '.video.' + format);
      const body = JSON.stringify(value, null, 2);
      await writeFile(
        path,
        format === 'ts' ? `export default ${body};\n` : body,
      );
      return path;
    },
    artifacts(...paths: string[]) {
      return Promise.all(
        paths.map(async (path) => {
          if (!artifactDirectory) return null;
          const filename = basename(path);
          await copyFile(path, join(artifactDirectory, filename));
          return join(name, filename);
        }),
      );
    },
    measure(check: string, values: Record<string, unknown>) {
      t.diagnostic(
        'measurement ' + JSON.stringify({ case: name, check, ...values }),
      );
    },
  };
}

export function assertFramesMatch(
  actual: ReadonlyMap<number, Buffer>,
  expected: ReadonlyMap<number, Buffer>,
  tolerance = previewTolerance,
) {
  assert.deepEqual([...actual.keys()], [...expected.keys()]);
  return [...actual].map(([frame, rgb]) => {
    const { metrics, passed } = compareRgb(
      rgb,
      expected.get(frame)!,
      tolerance,
    );
    assert.ok(passed, `frame ${frame}: ${JSON.stringify(metrics)}`);
    return { frame, ...metrics };
  });
}

export function saveRgb(
  rgb: Buffer,
  width: number,
  height: number,
  path: string,
) {
  ffmpeg(
    [
      '-f',
      'rawvideo',
      '-pixel_format',
      'rgb24',
      '-video_size',
      `${width}x${height}`,
      '-i',
      'pipe:0',
      '-frames:v',
      '1',
      '-threads',
      '1',
      '-update',
      '1',
      path,
    ],
    rgb,
  );
}

export function toneAmplitude(
  samples: Float32Array,
  hz: number,
  start: number,
  length: number,
) {
  const first = Math.round(start * 48000);
  const count = Math.round(length * 48000);
  assert.ok(first >= 0 && first + count <= samples.length);
  let real = 0;
  let imaginary = 0;
  for (let i = 0; i < count; i++) {
    const phase = (2 * Math.PI * hz * i) / 48000;
    real += samples[first + i]! * Math.cos(phase);
    imaginary += samples[first + i]! * Math.sin(phase);
  }
  return (2 * Math.hypot(real, imaginary)) / count;
}

export function assertNear(
  actual: number,
  expected: number,
  tolerance: number,
  label: string,
) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual} vs ${expected} ± ${tolerance}`,
  );
}

export async function assertSimilarExports(
  left: string,
  right: string,
  {
    width,
    height,
    frameCount,
    fps,
  }: { width: number; height: number; frameCount: number; fps: number },
) {
  for (const path of [left, right]) {
    const { video } = await probeMedia(path);
    assert.deepEqual([video?.width, video?.height], [width, height]);
    verifyVideoTimestamps(path, { numerator: fps, denominator: 1 }, frameCount);
  }
  // Retain coverage of short-lived visual errors while bounding decoder output.
  const batchSize = Math.max(
    1,
    Math.floor((32 * 1024 ** 2) / (width * height * 3)),
  );
  for (let start = 0; start < frameCount; start += batchSize) {
    const frames = Array.from(
      { length: Math.min(batchSize, frameCount - start) },
      (_, index) => start + index,
    );
    assertFramesMatch(
      decodeFrames(left, frames, width, height),
      decodeFrames(right, frames, width, height),
      repeatTolerance,
    );
  }
  for (const channel of [0, 1] as const) {
    const { samples: a } = decodeAudio(left, channel);
    const { samples: b } = decodeAudio(right, channel);
    assert.equal(a.length, b.length);
    const rms = Math.sqrt(
      a.reduce((total, sample, i) => total + (sample - b[i]!) ** 2, 0) /
        a.length,
    );
    assert.ok(
      rms <= 0.003,
      `decoded PCM difference, channel ${channel}: ${rms}`,
    );
  }
}

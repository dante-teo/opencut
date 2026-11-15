import { ffmpeg, probeFrameTimestamps } from './media-comparison.js';

const sampleRate = 48000;

export function decodeAudio(path: string, channel: 0 | 1 = 0) {
  const timestamps = probeFrameTimestamps(path, 'a:0');
  if (timestamps.sampleRate !== sampleRate)
    throw new Error(
      `Expected ${sampleRate} Hz export audio, found ${timestamps.sampleRate}`,
    );
  const { frames, numerator, denominator } = timestamps;
  // Raw PCM has no PTS. Its indices represent the project clock only after
  // verifying that the decoded audio starts at zero and has no gaps or overlaps.
  let sampleCount = 0;
  for (const [i, { pts, nb_samples }] of frames.entries()) {
    if (
      pts === undefined ||
      !Number.isSafeInteger(pts) ||
      BigInt(pts) * BigInt(numerator) * BigInt(sampleRate) !==
        BigInt(sampleCount) * BigInt(denominator)
    )
      throw new Error(
        `Audio frame ${i} PTS ${pts} at ${numerator}/${denominator} does not match sample ${sampleCount}`,
      );
    if (
      nb_samples === undefined ||
      !Number.isSafeInteger(nb_samples) ||
      nb_samples <= 0
    )
      throw new Error(`Missing sample count for decoded audio frame ${i}`);
    sampleCount += nb_samples;
  }
  const pcm = ffmpeg([
    '-i',
    path,
    '-map',
    '0:a:0',
    '-c:a',
    'pcm_f32le',
    '-ar',
    String(sampleRate),
    '-ac',
    '2',
    '-f',
    'f32le',
    'pipe:1',
  ]);
  if (pcm.length !== sampleCount * 8)
    throw new Error(
      `Expected ${sampleCount} stereo PCM samples, decoded ${pcm.length} bytes`,
    );
  return {
    samples: Float32Array.from({ length: sampleCount }, (_, i) =>
      pcm.readFloatLE(i * 8 + channel * 4),
    ),
    startSeconds: (frames[0]!.pts! * numerator) / denominator,
    decodedFrames: frames.length,
  };
}

export function sampleOnsets(samples: Float32Array) {
  const result: number[] = [];
  let audible = false;
  for (let i = 0; i + 240 <= samples.length; i += 240) {
    const rms = Math.sqrt(
      samples.subarray(i, i + 240).reduce((sum, x) => sum + x * x, 0) / 240,
    );
    const active = rms > 0.04;
    if (active && !audible) result.push(i / sampleRate);
    audible = active;
  }
  return result;
}

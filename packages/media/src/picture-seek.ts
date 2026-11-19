import { checkRenderSignal, runMediaTool } from './process.js';
import { indexedSeekArgs } from './video-filter.js';

async function firstPictureTimestamp(
  path: string,
  stream: number,
  seekSeconds: number,
  signal?: AbortSignal,
) {
  try {
    // Use the same decoder and input seek as the compositor. A packet's DTS
    // can precede the target even when the first decoded picture's PTS does not.
    const result = await runMediaTool(
      'ffmpeg',
      [
        '-v',
        'error',
        '-nostdin',
        '-xerror',
        '-copyts',
        '-threads',
        '1',
        ...indexedSeekArgs(seekSeconds),
        '-i',
        path,
        '-map',
        `0:${stream}`,
        '-filter_threads',
        '1',
        '-vf',
        'scale=2:2,format=yuv420p',
        '-frames:v',
        '1',
        '-c:v',
        'rawvideo',
        '-threads',
        '1',
        '-fps_mode',
        'passthrough',
        '-enc_time_base:v',
        'demux',
        '-avoid_negative_ts',
        'disabled',
        '-f',
        'framecrc',
        'pipe:1',
      ],
      undefined,
      undefined,
      { signal },
    );
    const output = result.toString();
    const timeBase = /^#tb 0: ([1-9]\d*)\/([1-9]\d*)$/m.exec(output);
    const frame = /^0,\s*-?\d+,\s*(-?\d+),/m.exec(output);
    if (timeBase && frame)
      return {
        pts: BigInt(frame[1]!),
        numerator: BigInt(timeBase[1]!),
        denominator: BigInt(timeBase[2]!),
      };
  } catch {
    // If the probe is inconclusive, the normal sequential path owns decoding errors.
    checkRenderSignal(signal);
  }
}

export function pictureSeekCheck(signal?: AbortSignal) {
  const origins = new Map<string, Promise<boolean>>();
  return async (
    path: string,
    stream: number,
    seekSeconds: number,
    firstFrame: number,
    rate: { numerator: number; denominator: number },
  ) => {
    const key = JSON.stringify([path, stream]);
    let hasZeroOrigin = origins.get(key);
    if (!hasZeroOrigin) {
      // Sequential sampling rebases the first decoded frame. An indexed decode
      // uses the original PTS, so both clocks must share an actual zero origin.
      hasZeroOrigin = firstPictureTimestamp(path, stream, 0, signal).then(
        (timestamp) => timestamp?.pts === 0n,
      );
      origins.set(key, hasZeroOrigin);
    }
    if (!(await hasZeroOrigin)) return false;
    const first = await firstPictureTimestamp(
      path,
      stream,
      seekSeconds,
      signal,
    );
    // round=up must place the first decoded picture strictly before the first
    // requested project tick. This retains its predecessor across VFR gaps.
    return (
      !!first &&
      first.pts > 0n &&
      first.pts * first.numerator * BigInt(rate.numerator) <=
        BigInt(firstFrame - 1) * BigInt(rate.denominator) * first.denominator
    );
  };
}

import { open } from 'node:fs/promises';
import {
  isStillImage,
  validateEmbeddedFont,
  videoSourceDuration,
} from '@opencut/media';
import type { MediaMetadata } from '@opencut/media';
import type { MediaAsset } from './project.js';

/** Translate probe metadata into the compiled asset fields. */
export function describeMediaAsset(probed: MediaMetadata) {
  const image = isStillImage(probed);
  const durationSeconds = image ? null : probed.durationSeconds;
  const videoMicroseconds = Math.round(
    (videoSourceDuration(probed) ?? 0) * 1_000_000,
  );
  const mediaTypes: MediaAsset['mediaTypes'] = [];
  if (probed.video) mediaTypes.push('video');
  if (probed.audio) mediaTypes.push('audio');
  const asset: Pick<MediaAsset, 'mediaTypes' | 'duration'> & {
    metadata: NonNullable<MediaAsset['metadata']>;
  } = {
    mediaTypes,
    metadata: {
      kind: image ? 'image' : probed.video ? 'video' : 'audio',
      formatName: probed.formatName,
      durationSeconds,
      ...(!image &&
        Number.isSafeInteger(videoMicroseconds) &&
        videoMicroseconds > 0 && {
          videoDuration: {
            numerator: videoMicroseconds,
            denominator: 1_000_000,
          },
        }),
      width: probed.video?.width ?? null,
      height: probed.video?.height ?? null,
      videoCodec: probed.video?.codec ?? null,
      audioCodec: probed.audio?.codec ?? null,
      frameRate: image ? null : (probed.video?.frameRate ?? null),
      frameRateRatio: image ? null : (probed.video?.frameRateRatio ?? null),
      hasAudio: probed.hasAudio,
    },
  };
  // ffprobe exposes decimal seconds. Record the source bound to microsecond precision.
  if (durationSeconds !== null && durationSeconds > 0) {
    const numerator = Math.round(durationSeconds * 1_000_000);
    if (Number.isSafeInteger(numerator) && numerator > 0)
      asset.duration = { numerator, denominator: 1_000_000 };
  }
  return asset;
}

export async function readEmbeddedFont(path: string) {
  const file = await open(path, 'r');
  let bytes: Buffer;
  try {
    const { size } = await file.stat();
    if (!size || size > 2_097_152)
      throw new Error('Choose a TTF or OTF font up to 2 MiB.');
    bytes = Buffer.alloc(size);
    const { bytesRead } = await file.read(bytes, 0, size, 0);
    if (bytesRead !== size)
      throw new Error('The font file changed while reading.');
  } finally {
    await file.close();
  }
  await validateEmbeddedFont(bytes);
  return bytes.toString('base64');
}

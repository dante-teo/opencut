import { executeTransaction, projectRevision } from './editing.js';
import type { EditOperation } from './editing.js';
import type { Project } from './project.js';

/** Add an entire source at project-frame precision; untimed stills default to five seconds. */
export function addAssetClip(
  project: Project,
  input: {
    assetId: string;
    trackId?: string;
    mediaType: 'video' | 'audio';
    at: number;
  },
) {
  const asset = project.assets.find((asset) => asset.id === input.assetId);
  if (!asset) throw new Error('Asset is not in the current project.');
  if (!asset.mediaTypes.includes(input.mediaType))
    throw new Error(
      `This asset cannot be placed on a ${input.mediaType} track.`,
    );
  const rate = project.settings.frameRate;
  let out: number;
  if (asset.metadata?.kind === 'image') {
    out = Math.max(1, Math.round((5 * rate.numerator) / rate.denominator));
  } else {
    if (!asset.duration)
      throw new Error(
        'Source duration is unavailable. Reimport a timed media file.',
      );
    out = Number(
      (BigInt(asset.duration.numerator) * BigInt(rate.numerator)) /
        (BigInt(asset.duration.denominator) * BigInt(rate.denominator)),
    );
    if (out < 1) throw new Error('Source is shorter than one project frame.');
  }
  const operations: EditOperation[] = [];
  const trackId = input.trackId ?? globalThis.crypto.randomUUID();
  if (input.trackId === undefined)
    operations.push({
      type: 'track.add',
      id: trackId,
      name: input.mediaType === 'video' ? 'Video' : 'Audio',
      mediaType: input.mediaType,
    });
  const track = project.tracks.find((track) => track.id === trackId);
  if (input.trackId !== undefined && track?.type !== input.mediaType)
    throw new Error('Choose a compatible timeline track.');
  operations.push({
    type: 'clip.add',
    assetId: asset.id,
    trackId,
    at: input.at,
    in: 0,
    out,
  });
  return executeTransaction(project, {
    expectedRevision: projectRevision(project),
    label: 'Add media clip',
    operations,
  }).project;
}

import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { probeMedia } from '@opencut/media';
import type { MediaAsset, Project } from './project.js';
import {
  canonicalProjectFilePath,
  createMediaReference,
  inspectMediaFile,
  readProjectFile,
  resolveMediaReference,
  updateProjectFile,
} from './project-files.js';
import type { MediaAvailability } from './project-files.js';

export class AssetError extends Error {
  override name = 'AssetError';
  constructor(
    public readonly code:
      | 'ASSET_NOT_FOUND'
      | 'ASSET_REFERENCED'
      | 'SOURCE_UNAVAILABLE'
      | 'INVALID_MEDIA',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface AssetInfo {
  asset: MediaAsset;
  source: MediaAvailability;
  referencedBy: string[];
}

export interface AssetImportResult extends AssetInfo {
  path: string;
  imported: boolean;
}

function requireAsset(project: Project, id: string): MediaAsset {
  const asset = project.assets.find((candidate) => candidate.id === id);
  if (!asset)
    throw new AssetError(
      'ASSET_NOT_FOUND',
      `Asset '${id}' does not exist. Use media list to find its stable ID.`,
    );
  return asset;
}

async function assetInfo(
  project: Project,
  path: string,
  asset: MediaAsset,
): Promise<AssetInfo> {
  const sourcePath = resolveMediaReference(asset.file, path);
  return {
    asset,
    source: {
      assetId: asset.id,
      path: sourcePath,
      ...(await inspectMediaFile(sourcePath)),
    },
    referencedBy: project.clips
      .filter((clip) => clip.assetId === asset.id)
      .map((clip) => clip.id),
  };
}

export async function listMediaAssets(
  projectFilePath: string,
): Promise<{ path: string; assets: AssetInfo[] }> {
  const project = await readProjectFile(projectFilePath);
  const path = await canonicalProjectFilePath(projectFilePath);
  const assets: AssetInfo[] = [];
  for (const asset of project.assets)
    assets.push(await assetInfo(project, path, asset));
  return { path: projectFilePath, assets };
}

export async function getMediaAsset(
  projectFilePath: string,
  id: string,
): Promise<AssetInfo & { path: string }> {
  const project = await readProjectFile(projectFilePath);
  const path = await canonicalProjectFilePath(projectFilePath);
  return {
    path: projectFilePath,
    ...(await assetInfo(project, path, requireAsset(project, id))),
  };
}

/** Read original media in place. Source arguments are cwd-relative; persisted paths are project-relative. */
export async function importMediaAsset(
  projectFilePath: string,
  mediaFilePath: string,
): Promise<AssetImportResult> {
  const requested = resolve(mediaFilePath);
  return updateProjectFile<AssetImportResult>(
    projectFilePath,
    async (project, path) => {
      const availability = await inspectMediaFile(requested);
      if (availability.status !== 'available')
        throw new AssetError(
          'SOURCE_UNAVAILABLE',
          `Cannot import '${requested}': ${availability.message} Restore the source path or grant read permission, then retry.`,
        );
      const source = await realpath(requested);
      const before = await stat(source);
      for (const asset of project.assets) {
        const existing = resolveMediaReference(asset.file, path);
        // Foreign-platform absolute references are data, never cwd-relative host paths.
        if ((await inspectMediaFile(existing)).status === 'unsupported_path')
          continue;
        let same = existing === source;
        if (!same) {
          try {
            const candidate = await stat(existing);
            same =
              candidate.isFile() &&
              candidate.ino !== 0 &&
              candidate.dev === before.dev &&
              candidate.ino === before.ino;
          } catch {
            // Offline assets remain in the project and do not block other imports.
          }
        }
        if (same)
          return {
            project,
            result: {
              path,
              imported: false,
              ...(await assetInfo(project, path, asset)),
            },
          };
      }
      const probed = await probeMedia(source);
      if (!probed.video && !probed.audio)
        throw new AssetError(
          'INVALID_MEDIA',
          `No supported video, audio or image stream in '${source}'. Choose a media file supported by ffprobe.`,
        );
      const after = await stat(source);
      if (
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs
      )
        throw new AssetError(
          'SOURCE_UNAVAILABLE',
          `Source '${source}' changed while probing. Wait for it to finish writing and retry.`,
        );
      const format = probed.formatName ?? '';
      const image = Boolean(
        probed.video &&
        !probed.audio &&
        (format.endsWith('_pipe') ||
          ['image2', 'image2pipe'].includes(format) ||
          (['gif', 'apng'].includes(format) && !probed.durationSeconds)),
      );
      const durationSeconds = image ? null : probed.durationSeconds;
      const mediaTypes: MediaAsset['mediaTypes'] = [];
      if (probed.video) mediaTypes.push('video');
      if (probed.audio) mediaTypes.push('audio');
      const ids = new Set([
        project.metadata.id,
        ...project.assets.map((asset) => asset.id),
        ...project.tracks.map((track) => track.id),
        ...project.clips.map((clip) => clip.id),
      ]);
      let id = randomUUID();
      while (ids.has(id)) id = randomUUID();
      const asset: MediaAsset = {
        id,
        name: basename(source),
        file: createMediaReference(source, path),
        mediaTypes,
        metadata: {
          kind: image ? 'image' : probed.video ? 'video' : 'audio',
          formatName: probed.formatName,
          durationSeconds,
          width: probed.video?.width ?? null,
          height: probed.video?.height ?? null,
          videoCodec: probed.video?.codec ?? null,
          audioCodec: probed.audio?.codec ?? null,
          frameRate: image ? null : (probed.video?.frameRate ?? null),
          frameRateRatio: image ? null : (probed.video?.frameRateRatio ?? null),
          hasAudio: probed.hasAudio,
        },
      };
      // ffprobe exposes decimal seconds; persist the model's source bound to microsecond precision.
      if (durationSeconds !== null && durationSeconds > 0) {
        const numerator = Math.round(durationSeconds * 1_000_000);
        if (Number.isSafeInteger(numerator) && numerator > 0)
          asset.duration = { numerator, denominator: 1_000_000 };
      }
      project.assets.push(asset);
      project.metadata.updatedAt = new Date(
        Math.max(Date.now(), Date.parse(project.metadata.updatedAt)),
      ).toISOString();
      const info = await assetInfo(project, path, asset);
      if (info.source.status !== 'available')
        throw new AssetError(
          'SOURCE_UNAVAILABLE',
          `Source '${source}' became unavailable during import. Restore it or grant read permission, then retry.`,
        );
      return {
        project,
        result: {
          path,
          imported: true,
          ...info,
        },
      };
    },
  );
}

/** Remove only the project entry, including when its source is offline. Never unlink media. */
export async function removeMediaAsset(
  projectFilePath: string,
  id: string,
): Promise<{ path: string; removedAssetId: string }> {
  return updateProjectFile(projectFilePath, async (project, path) => {
    requireAsset(project, id);
    const clips = project.clips.filter((clip) => clip.assetId === id);
    if (clips.length)
      throw new AssetError(
        'ASSET_REFERENCED',
        `Cannot remove asset '${id}'; referenced by timeline clips: ${clips.map((clip) => clip.id).join(', ')}. Remove those references before removing the asset.`,
      );
    project.assets = project.assets.filter((asset) => asset.id !== id);
    project.metadata.updatedAt = new Date(
      Math.max(Date.now(), Date.parse(project.metadata.updatedAt)),
    ).toISOString();
    return {
      project,
      result: { path, removedAssetId: id },
    };
  });
}

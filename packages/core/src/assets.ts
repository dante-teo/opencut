import { randomUUID } from 'node:crypto';
import { lstat, open, realpath, rm, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { MediaCache, probeMedia, validateEmbeddedFont } from '@opencut/media';
import type { MediaAsset, Project } from './project.js';
import type { OnlineMediaLibrary } from './online-media.js';
import { serializeProject, validateProject } from './project.js';
import { clipSourceTime, clipTimelineEnd } from './clip-timing.js';
import { compareTimes, frameTime } from './time.js';
import { insertFreeze } from './timeline.js';
import { editableTracks } from './timeline-layout.js';
import {
  checkProjectRevision,
  EditError,
  previewTransaction,
  projectRevision,
} from './editing.js';
import {
  canonicalProjectFilePath,
  createMediaReference,
  inspectMediaFile,
  readProjectFile,
  resolveMediaReference,
  SessionError,
  updateProjectFile,
} from './project-files.js';
import type {
  MediaAvailability,
  ProjectUpdateOptions,
} from './project-files.js';

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
  options: Pick<ProjectUpdateOptions, 'dryRun' | 'expectedRevision'> = {},
): Promise<AssetImportResult> {
  return updateProjectFile(
    projectFilePath,
    (project, path) => prepareMediaAsset(project, path, mediaFilePath),
    { ...options, label: 'media import' },
  );
}

/** Shared import preparation for disk transactions and unsaved desktop sessions. */
export async function prepareMediaAsset(
  original: Project,
  path: string,
  mediaFilePath: string,
  options?: { localMediaOnly: boolean },
): Promise<{ project: Project; result: AssetImportResult }> {
  const project = structuredClone(original);
  const requested = resolve(mediaFilePath);
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
  const probed = await probeMedia(source, undefined, options);
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
  const videoMicroseconds = Math.round(
    (probed.video?.durationSeconds ?? 0) * 1_000_000,
  );
  const mediaTypes: MediaAsset['mediaTypes'] = [];
  if (probed.video) mediaTypes.push('video');
  if (probed.audio) mediaTypes.push('audio');
  const ids = new Set([
    project.metadata.id,
    ...project.assets.map((asset) => asset.id),
    ...project.tracks.map((track) => track.id),
    ...project.clips.map((clip) => clip.id),
    ...(project.transitions?.map((transition) => transition.id) ?? []),
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
}

/** Refresh the source and metadata while retaining all references to the asset ID. */
export async function prepareMediaRelink(
  original: Project,
  path: string,
  id: string,
  file: string,
  absolute = false,
): Promise<{ project: Project; result: AssetInfo }> {
  const old = requireAsset(original, id);
  const prepared = await prepareMediaAsset(
    { ...original, assets: [] },
    path,
    file,
  );
  const asset = { ...prepared.result.asset, id: old.id, name: old.name };
  if (absolute)
    asset.file = { type: 'absolute', path: prepared.result.source.path };
  if (
    old.provenance &&
    resolveMediaReference(old.file, path) === prepared.result.source.path
  )
    asset.provenance = old.provenance;
  const candidate = {
    ...original,
    assets: original.assets.map((entry) => (entry.id === id ? asset : entry)),
  };
  const validation = validateProject(candidate);
  if (!validation.success) throw validation.error;
  return {
    project: validation.project,
    result: await assetInfo(validation.project, path, asset),
  };
}

export function relinkMediaAsset(
  path: string,
  id: string,
  file: string,
  options: Pick<ProjectUpdateOptions, 'dryRun' | 'expectedRevision'> = {},
) {
  return updateProjectFile(
    path,
    (project, canonical) => prepareMediaRelink(project, canonical, id, file),
    {
      ...options,
      label: 'Relink media',
    },
  );
}

/** Probe a downloaded result and attach its checked attribution before publication. */
export async function prepareOnlineMediaAsset(
  project: Project,
  path: string,
  download: Awaited<ReturnType<OnlineMediaLibrary['download']>>,
) {
  const prepared = await prepareMediaAsset(project, path, download.path, {
    localMediaOnly: true,
  });
  const { asset } = prepared.result;
  const metadata = asset.metadata;
  const timedImage =
    download.kind === 'image' &&
    metadata?.kind === 'video' &&
    (metadata.formatName === 'gif' || metadata.formatName === 'apng');
  if (metadata?.kind !== download.kind && !timedImage)
    throw new AssetError(
      'INVALID_MEDIA',
      'The downloaded file does not match the selected media type.',
    );
  if (prepared.result.imported) {
    asset.name = download.title;
    asset.provenance = download.provenance;
  }
  return prepared;
}

export async function prepareFreezeFrame(
  project: Project,
  path: string,
  id: string,
  at: number,
  frames: number,
  output: string,
  absolute = false,
) {
  const clip = project.clips.find((entry) => entry.id === id);
  const asset = project.assets.find((entry) => entry.id === clip?.assetId);
  const position = frameTime(at, project.settings.frameRate);
  const duration = frameTime(frames, project.settings.frameRate);
  if (
    !clip ||
    !asset?.mediaTypes.includes('video') ||
    asset.metadata?.kind === 'image' ||
    project.tracks.find((entry) => entry.id === clip.trackId)?.type !==
      'video' ||
    compareTimes(position, clip.timelineStart) < 0 ||
    compareTimes(position, clipTimelineEnd(clip)) >= 0 ||
    !frames
  )
    throw new AssetError(
      'INVALID_MEDIA',
      'Choose a playhead frame inside a video clip and a positive duration.',
    );
  editableTracks(project, [clip.trackId]);
  const source = await assetInfo(project, path, asset);
  if (source.source.status !== 'available')
    throw new AssetError('SOURCE_UNAVAILABLE', source.source.message);
  const target = resolve(output);
  if (!target.toLowerCase().endsWith('.png'))
    throw new AssetError(
      'INVALID_MEDIA',
      'Choose a new PNG file for the freeze frame.',
    );
  const time = clipSourceTime(clip, position);
  const bytes = await new MediaCache().frame(
    source.source.path,
    time.numerator / time.denominator,
    undefined,
    true,
  );
  const file = await open(target, 'wx');
  const created = await file.stat({ bigint: true });
  const discard = async () => {
    const current = await lstat(target, { bigint: true }).catch(() => null);
    if (
      current?.dev === created.dev &&
      current.ino === created.ino &&
      current.birthtimeNs === created.birthtimeNs
    )
      await rm(target);
  };
  try {
    try {
      await file.writeFile(bytes);
    } finally {
      await file.close();
    }
    const prepared = await prepareMediaAsset(project, path, target, {
      localMediaOnly: true,
    });
    if (absolute)
      prepared.result.asset.file = { type: 'absolute', path: target };
    const updated = insertFreeze(
      prepared.project,
      id,
      prepared.result.asset.id,
      position,
      duration,
    );
    return {
      project: updated.project,
      result: { clip: updated.clip, path: target },
      discard,
    };
  } catch (error) {
    await discard().catch(() => {});
    throw error;
  }
}

/** Publish a freeze in one file-backed edit, discarding its PNG after a known rejection. */
export async function freezeProjectFrame(
  path: string,
  id: string,
  at: number,
  frames: number,
  output: string,
  options: Pick<ProjectUpdateOptions, 'expectedRevision'> = {},
) {
  const canonical = await canonicalProjectFilePath(path);
  const snapshot = await readProjectFile(canonical);
  checkProjectRevision(snapshot, options.expectedRevision);
  const baseline = serializeProject(snapshot);
  const prepared = await prepareFreezeFrame(
    snapshot,
    canonical,
    id,
    at,
    frames,
    output,
  );
  const discard = prepared.discard;
  try {
    return await updateProjectFile(
      canonical,
      async (current) => {
        if (serializeProject(current) !== baseline)
          throw new EditError(
            'REVISION_CONFLICT',
            'Project changed while preparing the freeze frame. Inspect it and retry.',
          );
        return prepared;
      },
      {
        ...options,
        expectedRevision: projectRevision(snapshot),
        label: 'Freeze frame',
      },
    );
  } catch (error) {
    if (
      !(error instanceof SessionError) ||
      [
        'REVISION_CONFLICT',
        'SESSION_CHANGED',
        'SESSION_BUSY',
        'SESSION_CLOSED',
        'UPDATE_FAILED',
        'INVALID_TRANSACTION',
        'SESSION_TOO_LARGE',
      ].includes(error.code)
    )
      await discard?.().catch(() => {});
    throw error;
  }
}

export async function prepareEmbeddedFont(
  project: Project,
  id: string,
  path: string,
) {
  const clip = project.clips.find((clip) => clip.id === id && clip.text);
  const subtitle = project.subtitles?.cues.some((cue) => cue.id === id);
  if (!clip && !subtitle)
    throw new AssetError(
      'INVALID_MEDIA',
      'Select a title or subtitle to import its font.',
    );
  const file = await open(path, 'r');
  let bytes: Buffer;
  try {
    const { size } = await file.stat();
    if (!size || size > 2_097_152)
      throw new AssetError(
        'INVALID_MEDIA',
        'Choose a TTF or OTF font up to 2 MiB.',
      );
    bytes = Buffer.alloc(size);
    const { bytesRead } = await file.read(bytes, 0, size, 0);
    if (bytesRead !== size)
      throw new AssetError(
        'INVALID_MEDIA',
        'The font file changed while reading.',
      );
  } finally {
    await file.close();
  }
  await validateEmbeddedFont(bytes);
  const embeddedFont = bytes.toString('base64');
  const next = previewTransaction(project, {
    expectedRevision: projectRevision(project),
    operations: [
      clip
        ? { type: 'text.set', id, text: { embeddedFont } }
        : { type: 'subtitle.style', ids: [id], style: { embeddedFont } },
    ],
  }).project;
  return { project: next, result: { id, file: basename(path) } };
}

/** Remove only the project entry, including when its source is offline. Never unlink media. */
export async function removeMediaAsset(
  projectFilePath: string,
  id: string,
  options: Pick<ProjectUpdateOptions, 'dryRun' | 'expectedRevision'> = {},
): Promise<{ path: string; removedAssetId: string }> {
  return updateProjectFile(
    projectFilePath,
    async (project, path) => {
      project = removeAssetFromProject(project, id);
      return {
        project,
        result: { path, removedAssetId: id },
      };
    },
    { ...options, label: 'media remove' },
  );
}

/** Remove an unused entry without touching its original file. */
export function removeAssetFromProject(original: Project, id: string): Project {
  const project = structuredClone(original);
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
  return project;
}

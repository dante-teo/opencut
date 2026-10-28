import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaError, probeMedia } from '@opencut/media';
import type { MediaMetadata } from '@opencut/media';
import { createProject, serializeProject, validateProject } from './project.js';
import {
  getEditHistory,
  projectSnapshot,
  redoEdit,
  undoEdit,
} from './editing.js';
import {
  getMediaAsset,
  importMediaAsset,
  listMediaAssets,
  checkProjectMedia,
  readProjectFile,
  removeMediaAsset,
  updateProjectFile,
  validateProjectFile,
  writeProjectFile,
} from './project-files.js';

vi.mock('@opencut/media', async (original) => ({
  ...(await original<typeof import('@opencut/media')>()),
  probeMedia: vi.fn(),
}));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    access: vi.fn(actual.access),
    rename: vi.fn(actual.rename),
  };
});

let directory: string;
let path: string;
let source: string;
function metadata(kind: 'video' | 'audio' | 'image'): MediaMetadata {
  const stream = {
    index: 0,
    type: kind === 'audio' ? 'audio' : 'video',
    codec: kind === 'image' ? 'png' : kind === 'video' ? 'h264' : 'pcm_s16le',
    durationSeconds: kind === 'image' ? null : 2.5,
    startTimeSeconds: 0,
    timeBase: null,
    bitRate: null,
    language: null,
    isDefault: true,
    isAttachedPicture: false,
    width: kind === 'audio' ? null : 640,
    height: kind === 'audio' ? null : 360,
    frameRate: kind === 'video' ? 30000 / 1001 : null,
    frameRateRatio: kind === 'video' ? '30000/1001' : null,
    pixelFormat: null,
    sampleRate: kind === 'audio' ? 48000 : null,
    channels: kind === 'audio' ? 2 : null,
    channelLayout: null,
  };
  return {
    path: source,
    formatName:
      kind === 'image' ? 'png_pipe' : kind === 'audio' ? 'wav' : 'mov,mp4',
    startTimeSeconds: 0,
    durationSeconds: stream.durationSeconds,
    hasAudio: kind === 'audio',
    video: kind === 'audio' ? null : stream,
    audio: kind === 'audio' ? stream : null,
    streams: [stream],
  };
}

beforeEach(async () => {
  directory = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), 'opencut-assets-')),
  );
  path = join(directory, 'project.json');
  source = join(directory, '日本語 #1%.txt');
  await fs.writeFile(source, 'source sentinel; probe is mocked');
  await writeProjectFile(
    createProject({ name: 'Assets', createdAt: '2020-01-01T00:00:00.000Z' }),
    path,
  );
  vi.mocked(probeMedia).mockResolvedValue(metadata('video'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(probeMedia).mockReset();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('headless asset management', () => {
  it('shares import/remove history, previews without saving, and restores metadata without probing', async () => {
    const original = await readProjectFile(path);
    const bytes = await fs.readFile(path, 'utf8');
    const modified = (await fs.stat(path)).mtimeMs;
    await importMediaAsset(path, source, { dryRun: true, expectedRevision: 0 });
    expect(await fs.readFile(path, 'utf8')).toBe(bytes);
    expect((await fs.stat(path)).mtimeMs).toBe(modified);
    const imported = await importMediaAsset(path, source, {
      expectedRevision: 0,
    });
    const first = await readProjectFile(path);
    expect(getEditHistory(first)).toMatchObject({
      revision: 1,
      undo: [{ label: 'media import' }],
      redo: [],
    });
    const saved = await fs.readFile(path, 'utf8');
    await importMediaAsset(path, source, { expectedRevision: 1 });
    expect(await fs.readFile(path, 'utf8')).toBe(saved);
    const calls = vi.mocked(probeMedia).mock.calls.length;
    await updateProjectFile(
      path,
      async (project) => ({ project: undoEdit(project), result: undefined }),
      { history: 'restore' },
    );
    expect(projectSnapshot(await readProjectFile(path))).toEqual(original);
    await updateProjectFile(
      path,
      async (project) => ({ project: redoEdit(project), result: undefined }),
      { history: 'restore' },
    );
    expect(projectSnapshot(await readProjectFile(path))).toEqual(
      projectSnapshot(first),
    );
    await removeMediaAsset(path, imported.asset.id, { expectedRevision: 3 });
    expect(getEditHistory(await readProjectFile(path))).toMatchObject({
      revision: 4,
      undo: [{ label: 'media import' }, { label: 'media remove' }],
    });
    await updateProjectFile(
      path,
      async (project) => ({ project: undoEdit(project), result: undefined }),
      { history: 'restore' },
    );
    expect((await readProjectFile(path)).assets).toEqual([imported.asset]);
    expect(vi.mocked(probeMedia)).toHaveBeenCalledTimes(calls);
    expect(await fs.readFile(source, 'utf8')).toBe(
      'source sentinel; probe is mocked',
    );
  });

  it.each([false, true])(
    'resolves symlinked project directories consistently (shadow source: %s)',
    async (shadowSource) => {
      const projectDirectory = join(directory, 'work', 'project');
      const mediaDirectory = join(directory, 'work', 'media');
      const links = join(directory, 'links');
      await fs.mkdir(projectDirectory, { recursive: true });
      await fs.mkdir(mediaDirectory);
      await fs.mkdir(links);
      await fs.symlink(projectDirectory, join(links, 'project'), 'dir');
      const physicalPath = join(projectDirectory, 'project.json');
      const aliasPath = join(links, 'project', 'project.json');
      const sourcePath = join(mediaDirectory, 'source.txt');
      await fs.writeFile(sourcePath, 'original source sentinel');
      if (shadowSource) {
        await fs.mkdir(join(links, 'media'));
        await fs.writeFile(
          join(links, 'media', 'source.txt'),
          'different source sentinel',
        );
      }
      await writeProjectFile(
        createProject({ name: 'Directory alias' }),
        physicalPath,
      );
      const imported = await importMediaAsset(aliasPath, sourcePath);
      expect(imported.asset.file).toEqual({
        type: 'relative',
        path: '../media/source.txt',
      });
      const before = await fs.readFile(physicalPath, 'utf8');
      for (const location of [aliasPath, physicalPath]) {
        const listed = await listMediaAssets(location);
        expect(listed.assets).toEqual([
          { asset: imported.asset, source: imported.source, referencedBy: [] },
        ]);
        const info = await getMediaAsset(location, imported.asset.id);
        expect(info.source).toMatchObject({
          path: sourcePath,
          status: 'available',
        });
        const report = await validateProjectFile(location);
        expect(report.valid).toBe(true);
        expect(report.media).toEqual([imported.source]);
        expect(
          await checkProjectMedia(await readProjectFile(location), location),
        ).toEqual([imported.source]);
        const duplicate = await importMediaAsset(location, sourcePath);
        expect(duplicate.imported).toBe(false);
        expect(duplicate.asset.id).toBe(imported.asset.id);
      }
      expect(await fs.readFile(physicalPath, 'utf8')).toBe(before);
      expect(await fs.readFile(sourcePath, 'utf8')).toBe(
        'original source sentinel',
      );
    },
  );

  it.each(['video', 'audio', 'image'] as const)(
    'persists %s metadata, stable IDs and relative paths across reloads',
    async (kind) => {
      vi.mocked(probeMedia).mockResolvedValue(metadata(kind));
      const imported = await importMediaAsset(path, source);
      expect(imported.imported).toBe(true);
      expect(imported.asset.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(imported.asset.file).toEqual({
        type: 'relative',
        path: '日本語 #1%.txt',
      });
      expect(imported.asset.metadata).toEqual({
        kind,
        formatName:
          kind === 'image' ? 'png_pipe' : kind === 'audio' ? 'wav' : 'mov,mp4',
        durationSeconds: kind === 'image' ? null : 2.5,
        width: kind === 'audio' ? null : 640,
        height: kind === 'audio' ? null : 360,
        videoCodec: kind === 'audio' ? null : kind === 'image' ? 'png' : 'h264',
        audioCodec: kind === 'audio' ? 'pcm_s16le' : null,
        frameRate: kind === 'video' ? 30000 / 1001 : null,
        frameRateRatio: kind === 'video' ? '30000/1001' : null,
        hasAudio: kind === 'audio',
      });
      expect(imported.asset.duration).toEqual(
        kind === 'image'
          ? undefined
          : { numerator: 2_500_000, denominator: 1_000_000 },
      );
      const reopened = await readProjectFile(path);
      expect(reopened.assets).toEqual([imported.asset]);
      expect(reopened.metadata.updatedAt).not.toBe(reopened.metadata.createdAt);
      expect(await getMediaAsset(path, imported.asset.id)).toEqual({
        path,
        asset: imported.asset,
        source: imported.source,
        referencedBy: [],
      });
      expect(await fs.readFile(source, 'utf8')).toBe(
        'source sentinel; probe is mocked',
      );
      expect((await fs.readdir(directory)).sort()).toEqual([
        'project.json',
        'project.json.opencut-lock',
        '日本語 #1%.txt',
      ]);
    },
  );

  it('persists both video and audio codecs for audiovisual files', async () => {
    const probe = metadata('video');
    probe.audio = metadata('audio').audio;
    probe.audio!.codec = 'aac';
    probe.hasAudio = true;
    vi.mocked(probeMedia).mockResolvedValue(probe);
    const { asset } = await importMediaAsset(path, source);
    expect(asset.mediaTypes).toEqual(['video', 'audio']);
    expect(asset.metadata).toMatchObject({
      videoCodec: 'h264',
      audioCodec: 'aac',
      hasAudio: true,
    });
  });

  it('deduplicates normalized paths, symlinks and hard links without probing or rewriting', async () => {
    const first = await importMediaAsset(path, source);
    const before = await fs.readFile(path, 'utf8');
    const stamp = (await fs.stat(path)).mtimeMs;
    const alias = join(directory, 'alias.txt');
    const hard = join(directory, 'hard.txt');
    await fs.symlink(source, alias);
    await fs.link(source, hard);
    for (const input of [
      source,
      join(directory, 'sub', '..', '日本語 #1%.txt'),
      alias,
      hard,
    ]) {
      const duplicate = await importMediaAsset(path, input);
      expect(duplicate.imported).toBe(false);
      expect(duplicate.asset.id).toBe(first.asset.id);
    }
    expect(probeMedia).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(path, 'utf8')).toBe(before);
    expect((await fs.stat(path)).mtimeMs).toBe(stamp);
  });

  it('assigns unique IDs to distinct files even when their contents match', async () => {
    const first = await importMediaAsset(path, source);
    const secondPath = join(directory, 'second.txt');
    await fs.copyFile(source, secondPath);
    const second = await importMediaAsset(path, secondPath);
    expect(second.imported).toBe(true);
    expect(second.asset.id).not.toBe(first.asset.id);
    expect((await readProjectFile(path)).assets).toHaveLength(2);
  });

  it('preserves unknown metadata instead of inventing duration or frame rate', async () => {
    const probe = metadata('video');
    probe.durationSeconds = null;
    probe.video!.frameRate = null;
    probe.video!.frameRateRatio = null;
    vi.mocked(probeMedia).mockResolvedValue(probe);
    const imported = await importMediaAsset(path, source);
    expect(imported.asset.duration).toBeUndefined();
    expect(imported.asset.metadata).toMatchObject({
      durationSeconds: null,
      frameRate: null,
      frameRateRatio: null,
    });
  });

  it('rejects missing files and directories without changing the project', async () => {
    const before = await fs.readFile(path, 'utf8');
    for (const input of [join(directory, 'missing.mp4'), directory])
      await expect(importMediaAsset(path, input)).rejects.toMatchObject({
        code: 'SOURCE_UNAVAILABLE',
      });
    expect(await fs.readFile(path, 'utf8')).toBe(before);
    expect(probeMedia).not.toHaveBeenCalled();
    expect(await fs.readdir(directory)).not.toContain('project.json.lock');
  });

  it('rejects unreadable source files before probing', async () => {
    vi.mocked(fs.access).mockRejectedValueOnce(
      Object.assign(new Error('Permission denied'), { code: 'EACCES' }),
    );
    const before = await fs.readFile(path, 'utf8');
    await expect(importMediaAsset(path, source)).rejects.toThrow(
      'grant read permission',
    );
    expect(await fs.readFile(path, 'utf8')).toBe(before);
    expect(probeMedia).not.toHaveBeenCalled();
  });

  it('rejects invalid formats and unsupported streams without saving', async () => {
    const before = await fs.readFile(path, 'utf8');
    vi.mocked(probeMedia).mockRejectedValueOnce(
      new MediaError(
        'ffprobe failed: Invalid data found when processing input',
      ),
    );
    await expect(importMediaAsset(path, source)).rejects.toThrow(
      'Invalid data',
    );
    vi.mocked(probeMedia).mockResolvedValueOnce({
      ...metadata('video'),
      video: null,
      audio: null,
    });
    await expect(importMediaAsset(path, source)).rejects.toMatchObject({
      code: 'INVALID_MEDIA',
    });
    expect(await fs.readFile(path, 'utf8')).toBe(before);
  });

  it('reports offline assets on list/info and can remove them without deleting files', async () => {
    const imported = await importMediaAsset(path, source);
    await fs.rename(source, join(directory, 'moved.txt'));
    const before = await fs.readFile(path, 'utf8');
    const listed = await listMediaAssets(path);
    expect(listed.assets[0]?.source.status).toBe('missing');
    expect((await getMediaAsset(path, imported.asset.id)).asset).toEqual(
      imported.asset,
    );
    expect(await fs.readFile(path, 'utf8')).toBe(before);
    expect(await removeMediaAsset(path, imported.asset.id)).toEqual({
      path,
      removedAssetId: imported.asset.id,
    });
    expect((await readProjectFile(path)).assets).toEqual([]);
    expect(await fs.readFile(join(directory, 'moved.txt'), 'utf8')).toBe(
      'source sentinel; probe is mocked',
    );
    await expect(getMediaAsset(path, imported.asset.id)).rejects.toMatchObject({
      code: 'ASSET_NOT_FOUND',
    });
    await expect(
      removeMediaAsset(path, imported.asset.id),
    ).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' });
  });

  it('blocks removal of referenced assets and preserves project bytes', async () => {
    const { asset } = await importMediaAsset(path, source);
    const project = await readProjectFile(path);
    project.tracks = [{ id: 'track', name: 'Video', type: 'video' }];
    project.clips = [
      {
        id: 'clip',
        assetId: asset.id,
        trackId: 'track',
        timelineStart: { numerator: 0, denominator: 1 },
        sourceIn: { numerator: 0, denominator: 1 },
        sourceOut: { numerator: 1, denominator: 1 },
      },
    ];
    await fs.writeFile(path, serializeProject(project));
    const before = await fs.readFile(path, 'utf8');
    expect((await getMediaAsset(path, asset.id)).referencedBy).toEqual([
      'clip',
    ]);
    await expect(removeMediaAsset(path, asset.id)).rejects.toMatchObject({
      code: 'ASSET_REFERENCED',
      message: expect.stringContaining('clip'),
    });
    expect(await fs.readFile(path, 'utf8')).toBe(before);
  });

  it('keeps old assets without probe metadata valid and rejects malformed new metadata', async () => {
    const project = await readProjectFile(path);
    project.assets = [
      {
        id: 'legacy',
        name: 'Legacy',
        file: { type: 'relative', path: 'old.mp4' },
        mediaTypes: ['video'],
      },
    ];
    await fs.writeFile(path, serializeProject(project));
    expect(
      (await listMediaAssets(path)).assets[0]?.asset.metadata,
    ).toBeUndefined();
    const imported = await importMediaAsset(path, source);
    imported.asset.metadata!.width = -1;
    expect(
      validateProject({ ...project, assets: [imported.asset] }).success,
    ).toBe(false);
  });
});

describe('atomic project updates', () => {
  it('rejects a source that changes during probing without publishing an asset', async () => {
    const before = await fs.readFile(path, 'utf8');
    vi.mocked(probeMedia).mockImplementationOnce(async () => {
      await fs.writeFile(
        source,
        'a changed source sentinel with a different size',
      );
      return metadata('video');
    });
    await expect(importMediaAsset(path, source)).rejects.toMatchObject({
      code: 'SOURCE_UNAVAILABLE',
    });
    expect(await fs.readFile(path, 'utf8')).toBe(before);
  });

  it('keeps invalid project data intact and does not probe sources', async () => {
    await fs.writeFile(path, '{malformed');
    await expect(importMediaAsset(path, source)).rejects.toMatchObject({
      code: 'INVALID_JSON',
    });
    expect(await fs.readFile(path, 'utf8')).toBe('{malformed');
    expect(probeMedia).not.toHaveBeenCalled();
    expect((await fs.readdir(directory)).sort()).toEqual([
      'project.json',
      'project.json.opencut-lock',
      '日本語 #1%.txt',
    ]);
  });

  it('preserves bytes and cleans temporary files when publication fails', async () => {
    const before = await fs.readFile(path, 'utf8');
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error('disk failure'));
    await expect(importMediaAsset(path, source)).rejects.toMatchObject({
      code: 'UPDATE_FAILED',
    });
    expect(await fs.readFile(path, 'utf8')).toBe(before);
    expect((await fs.readdir(directory)).sort()).toEqual([
      'project.json',
      'project.json.opencut-lock',
      '日本語 #1%.txt',
    ]);
  });

  it('refuses project symlinks, hard links and stale locks', async () => {
    const before = await fs.readFile(path, 'utf8');
    const linked = join(directory, 'linked.json');
    await fs.symlink(path, linked);
    await expect(importMediaAsset(linked, source)).rejects.toThrow(
      'symlinks and hard links',
    );
    await fs.link(path, join(directory, 'hard.json'));
    await expect(importMediaAsset(path, source)).rejects.toThrow(
      'symlinks and hard links',
    );
    await fs.rm(join(directory, 'hard.json'));
    await fs.writeFile(`${path}.lock`, 'owned by another writer');
    await expect(importMediaAsset(path, source)).rejects.toThrow('locked');
    expect(await fs.readFile(`${path}.lock`, 'utf8')).toBe(
      'owned by another writer',
    );
    expect(await fs.readFile(path, 'utf8')).toBe(before);
  });

  it('fails competing updates safely while a probe is pending', async () => {
    let release!: (value: MediaMetadata) => void;
    let started!: () => void;
    const probing = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.mocked(probeMedia).mockImplementationOnce(() => {
      started();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const first = importMediaAsset(path, source);
    await probing;
    await expect(importMediaAsset(path, source)).rejects.toThrow('locked');
    expect((await readProjectFile(path)).assets).toEqual([]);
    release(metadata('video'));
    await first;
    expect((await readProjectFile(path)).assets).toHaveLength(1);
  });

  it('detects outside changes instead of overwriting them', async () => {
    await expect(
      updateProjectFile(path, async (project) => {
        const external = {
          ...project,
          metadata: { ...project.metadata, name: 'External' },
        };
        await fs.writeFile(path, serializeProject(external));
        return {
          project: {
            ...project,
            assets: [
              {
                id: 'other',
                name: 'Other',
                file: { type: 'relative', path: 'other.mp4' },
                mediaTypes: ['video'],
              },
            ],
          },
          result: null,
        };
      }),
    ).rejects.toThrow('changed during');
    expect((await readProjectFile(path)).metadata.name).toBe('External');
    expect((await readProjectFile(path)).assets).toEqual([]);
  });
});

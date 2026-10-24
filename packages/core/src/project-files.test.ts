import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createProject,
  ProjectFormatError,
  serializeProject,
  validateProject,
} from './index.js';
import {
  checkProjectMedia,
  createMediaReference,
  ProjectFileError,
  readProjectFile,
  resolveMediaReference,
  writeProjectFile,
  validateProjectFile,
} from './project-files.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, access: vi.fn(actual.access) };
});

const directories: string[] = [];
async function temporary(): Promise<string> {
  const directory = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), 'opencut-project-')),
  );
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe('media reference paths', () => {
  it('uses the project directory, including spaces and literal URL punctuation', () => {
    const reference = createMediaReference(
      '/work/media/日本語 #1%.txt',
      '/work/demo/project.opencut.json',
    );
    expect(reference).toEqual({
      type: 'relative',
      path: '../media/日本語 #1%.txt',
    });
    expect(
      resolveMediaReference(reference, '/moved/demo/project.opencut.json'),
    ).toBe('/moved/media/日本語 #1%.txt');
  });

  it('normalizes Windows separators and resolves same-drive relative paths lexically', () => {
    const reference = createMediaReference(
      'C:\\work\\media\\camera.txt',
      'C:\\work\\project.opencut.json',
    );
    expect(reference).toEqual({ type: 'relative', path: 'media/camera.txt' });
    expect(
      resolveMediaReference(reference, 'D:/moved/project.opencut.json'),
    ).toBe('D:/moved/media/camera.txt');
  });

  it('retains absolute references for different drives and platforms', () => {
    expect(
      createMediaReference('D:/media/camera.txt', 'C:/work/project.json'),
    ).toEqual({ type: 'absolute', path: 'D:/media/camera.txt' });
    expect(
      createMediaReference('C:/media/camera.txt', '/work/project.json'),
    ).toEqual({ type: 'absolute', path: 'C:/media/camera.txt' });
    expect(
      resolveMediaReference(
        { type: 'absolute', path: '/media/camera.txt' },
        '/moved/project.json',
      ),
    ).toBe('/media/camera.txt');
  });

  it('falls back to an absolute reference for POSIX filenames containing colons', () => {
    const path = '/bundle/media/scene:take.mp4';
    const reference = createMediaReference(path, '/bundle/project.json');

    expect(reference).toEqual({ type: 'absolute', path });
    expect(resolveMediaReference(reference, '/moved/project.json')).toBe(path);
  });

  it('supports UNC shares and preserves different-share absolute paths', () => {
    const reference = createMediaReference(
      '\\\\server\\share\\media\\camera.txt',
      '\\\\server\\share\\project.json',
    );
    expect(reference).toEqual({ type: 'relative', path: 'media/camera.txt' });
    expect(
      resolveMediaReference(reference, '//new-server/share/project.json'),
    ).toBe('//new-server/share/media/camera.txt');
    expect(
      createMediaReference(
        '//server/other/camera.txt',
        '//server/share/project.json',
      ),
    ).toEqual({ type: 'absolute', path: '//server/other/camera.txt' });
  });

  it('requires absolute project locations so resolution cannot depend on cwd', () => {
    expect(() =>
      resolveMediaReference(
        { type: 'relative', path: 'media/file.txt' },
        'project.json',
      ),
    ).toThrow('absolute file path');
    expect(() =>
      createMediaReference('media/file.txt', '/work/project.json'),
    ).toThrow('absolute file path');
  });

  it('rejects foreign project file I/O before accessing the host filesystem', async () => {
    const path =
      process.platform === 'win32'
        ? '/foreign/project.json'
        : 'Z:/foreign/project.json';
    await expect(readProjectFile(path)).rejects.toThrow(
      'different operating system',
    );
    await expect(
      writeProjectFile(createProject({ name: 'Foreign' }), path),
    ).rejects.toThrow('different operating system');
  });
});

describe('project file and media checks', () => {
  it('retains availability checks for project locations with an absent parent', async () => {
    const directory = await temporary();
    const source = join(directory, 'source.txt');
    await fs.writeFile(source, 'source sentinel');
    const project = createProject({ name: 'Absent project directory' });
    project.assets = [
      {
        id: 'available',
        name: 'Available',
        file: { type: 'absolute', path: source },
        mediaTypes: ['audio'],
      },
      {
        id: 'missing',
        name: 'Missing',
        file: { type: 'relative', path: 'missing.txt' },
        mediaTypes: ['audio'],
      },
    ];
    expect(
      (
        await checkProjectMedia(
          project,
          join(directory, 'absent', 'project.json'),
        )
      ).map((media) => media.status),
    ).toEqual(['available', 'missing']);
  });

  it('returns format issues as a validation report while retaining I/O errors', async () => {
    const directory = await temporary();
    const path = join(directory, 'invalid.json');
    await expect(validateProjectFile(path)).rejects.toMatchObject({
      code: 'READ_FAILED',
    });
    await fs.writeFile(path, '{broken');
    expect(await validateProjectFile(path)).toEqual({
      path,
      valid: false,
      structureValid: false,
      issues: [expect.objectContaining({ code: 'invalid_json' })],
      media: [],
    });
  });

  it('reports valid structure and unavailable media separately', async () => {
    const directory = await temporary();
    const path = join(directory, 'project.json');
    const project = createProject({ name: 'Availability' });
    await writeProjectFile(project, path);
    expect(await validateProjectFile(path)).toEqual({
      path,
      valid: true,
      structureValid: true,
      issues: [],
      media: [],
    });
    project.assets.push({
      id: 'missing',
      name: 'Missing',
      mediaTypes: ['audio'],
      file: { type: 'relative', path: 'missing.txt' },
    });
    await fs.writeFile(path, serializeProject(project));
    expect(await validateProjectFile(path)).toMatchObject({
      valid: false,
      structureValid: true,
      issues: [],
      media: [{ status: 'missing' }],
    });
  });
  it('saves/loads a populated project and survives moving its whole folder', async () => {
    const directory = await temporary();
    const original = join(directory, 'original');
    const moved = join(directory, 'moved');
    await fs.mkdir(join(original, 'media'), { recursive: true });
    // Text sentinels exercise file availability, not decoding or generated media fixtures.
    const source = join(original, 'media', 'camera #1.txt');
    await fs.writeFile(source, 'read-only source sentinel');
    const path = join(original, 'project.opencut.json');
    const project = createProject({ name: 'Movable project' });
    project.assets = [
      {
        id: 'camera',
        name: 'Camera',
        file: createMediaReference(source, path),
        mediaTypes: ['video', 'audio'],
      },
    ];
    project.tracks = [
      { id: 'video', name: 'Video', type: 'video' },
      { id: 'audio', name: 'Audio', type: 'audio' },
    ];
    project.clips = project.tracks.map((track) => ({
      id: `clip-${track.id}`,
      assetId: 'camera',
      trackId: track.id,
      timelineStart: { numerator: 0, denominator: 1 },
      sourceIn: { numerator: 0, denominator: 1 },
      sourceOut: { numerator: 1001, denominator: 30000 },
    }));
    await writeProjectFile(project, path);
    const json = await fs.readFile(path, 'utf8');
    expect(json).toBe(serializeProject(project));
    await fs.rename(original, moved);
    const movedPath = join(moved, 'project.opencut.json');
    const loaded = await readProjectFile(movedPath);
    expect(loaded).toEqual(project);
    expect(await checkProjectMedia(loaded, movedPath)).toEqual([
      {
        assetId: 'camera',
        path: join(moved, 'media', 'camera #1.txt'),
        status: 'available',
        message: expect.any(String),
      },
    ]);
    expect(
      await fs.readFile(join(moved, 'media', 'camera #1.txt'), 'utf8'),
    ).toBe('read-only source sentinel');
    expect(await fs.readFile(movedPath, 'utf8')).toBe(json);
  });

  it('reports missing files, directories and foreign paths without altering project data', async () => {
    const directory = await temporary();
    const path = join(directory, 'project.json');
    await fs.writeFile(join(directory, 'sentinel.txt'), 'text');
    const project = createProject({ name: 'Offline' });
    project.assets = [
      {
        id: 'missing',
        name: 'Missing',
        file: { type: 'relative', path: 'missing.txt' },
        mediaTypes: ['video'],
      },
      {
        id: 'directory',
        name: 'Directory',
        file: { type: 'relative', path: '.' },
        mediaTypes: ['audio'],
      },
      {
        id: 'invalid-parent',
        name: 'Parent is a file',
        file: { type: 'relative', path: 'sentinel.txt/child.txt' },
        mediaTypes: ['audio'],
      },
      {
        id: 'foreign',
        name: 'Foreign',
        file: {
          type: 'absolute',
          path:
            process.platform === 'win32'
              ? '/foreign/media.txt'
              : 'Z:/foreign/media.txt',
        },
        mediaTypes: ['video'],
      },
    ];
    const before = structuredClone(project);
    expect(validateProject(project).success).toBe(true);
    await writeProjectFile(project, path);
    expect(await readProjectFile(path)).toEqual(before);
    expect(
      (await checkProjectMedia(project, path)).map((result) => result.status),
    ).toEqual(['missing', 'not_file', 'missing', 'unsupported_path']);
    expect(project).toEqual(before);
  });

  it('follows media symlinks and reports dangling targets as missing', async () => {
    const directory = await temporary();
    const source = join(directory, 'source.txt');
    await fs.writeFile(source, 'preserve this');
    await fs.symlink('source.txt', join(directory, 'linked.txt'));
    await fs.symlink('absent.txt', join(directory, 'dangling.txt'));
    const project = createProject({ name: 'Linked media' });
    project.assets = ['linked', 'dangling'].map((id) => ({
      id,
      name: id,
      file: { type: 'relative', path: `${id}.txt` },
      mediaTypes: ['audio'],
    }));

    expect(
      (await checkProjectMedia(project, join(directory, 'project.json'))).map(
        (result) => ({ assetId: result.assetId, status: result.status }),
      ),
    ).toEqual([
      { assetId: 'linked', status: 'available' },
      { assetId: 'dangling', status: 'missing' },
    ]);
    expect(await fs.readFile(source, 'utf8')).toBe('preserve this');
  });

  it('reports unreadable media separately from missing media', async () => {
    const directory = await temporary();
    const source = join(directory, 'sentinel.txt');
    await fs.writeFile(source, 'text');
    const project = createProject({ name: 'Unreadable' });
    project.assets = [
      {
        id: 'asset',
        name: 'Asset',
        file: { type: 'relative', path: 'sentinel.txt' },
        mediaTypes: ['audio'],
      },
    ];
    vi.mocked(fs.access).mockRejectedValueOnce(
      Object.assign(new Error('Permission denied'), { code: 'EACCES' }),
    );
    expect(
      await checkProjectMedia(project, join(directory, 'project.json')),
    ).toEqual([
      {
        assetId: 'asset',
        path: source,
        status: 'unreadable',
        message: expect.stringContaining('Permission denied'),
      },
    ]);
  });

  it('returns an empty availability list for an empty project', async () => {
    const directory = await temporary();
    expect(
      await checkProjectMedia(
        createProject({ name: 'Empty' }),
        join(directory, 'project.json'),
      ),
    ).toEqual([]);
  });

  it('never overwrites an existing file or a symlink, including user media', async () => {
    const directory = await temporary();
    const source = join(directory, 'sentinel.txt');
    const symlink = join(directory, 'link.json');
    await fs.writeFile(source, 'preserve this');
    await fs.symlink(source, symlink);
    const project = createProject({ name: 'New' });
    await expect(writeProjectFile(project, source)).rejects.toMatchObject({
      code: 'WRITE_FAILED',
    });
    await expect(writeProjectFile(project, symlink)).rejects.toThrow(
      'existing files and symlinks are refused',
    );
    expect(await fs.readFile(source, 'utf8')).toBe('preserve this');
    expect((await fs.lstat(symlink)).isSymbolicLink()).toBe(true);
    const dangling = join(directory, 'dangling.json');
    await fs.symlink(join(directory, 'absent.txt'), dangling);
    await expect(writeProjectFile(project, dangling)).rejects.toBeInstanceOf(
      ProjectFileError,
    );
  });

  it('retains actionable read, parse, version and write failures', async () => {
    const directory = await temporary();
    const path = join(directory, 'project.json');
    await expect(readProjectFile(path)).rejects.toMatchObject({
      code: 'READ_FAILED',
      path,
      cause: { code: 'ENOENT' },
    });
    await fs.writeFile(path, '{broken');
    await expect(readProjectFile(path)).rejects.toBeInstanceOf(
      ProjectFormatError,
    );
    await fs.writeFile(path, '{"schemaVersion": 2}');
    await expect(readProjectFile(path)).rejects.toMatchObject({
      code: 'UNSUPPORTED_VERSION',
    });
    await expect(
      writeProjectFile(
        createProject({ name: 'New' }),
        join(directory, 'absent', 'project.json'),
      ),
    ).rejects.toMatchObject({
      code: 'WRITE_FAILED',
      cause: { code: 'ENOENT' },
    });
  });

  it('rejects invalid data before creating a file or checking media', async () => {
    const directory = await temporary();
    const path = join(directory, 'project.json');
    const project = createProject({ name: 'Invalid' });
    project.settings.width = 0;
    await expect(writeProjectFile(project, path)).rejects.toMatchObject({
      code: 'INVALID_PROJECT',
    });
    await expect(fs.stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(checkProjectMedia(project, path)).rejects.toMatchObject({
      code: 'INVALID_PROJECT',
    });
  });
});

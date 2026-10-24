import { describe, expect, it } from 'vitest';
import {
  PROJECT_SCHEMA_VERSION,
  ProjectFormatError,
  compareTimes,
  createProject,
  deserializeProject,
  frameTime,
  serializeProject,
  validateProject,
} from './index.js';
import type { Project } from './index.js';

const rate = { numerator: 30000, denominator: 1001 };
const at = (frame: number) => frameTime(frame, rate);

function example(): Project {
  const project = createProject({
    id: 'project-demo',
    name: 'Demo 🎬',
    createdAt: '2026-10-24T08:00:00.000Z',
    settings: { width: 1920, height: 1080, frameRate: rate },
  });
  project.assets = [
    {
      id: 'asset-camera',
      name: 'Camera',
      file: { type: 'relative', path: 'media/camera one.mp4' },
      mediaTypes: ['video', 'audio'],
      duration: at(300),
    },
    {
      id: 'asset-music',
      name: 'Music',
      file: { type: 'relative', path: '../audio/music.wav' },
      mediaTypes: ['audio'],
    },
  ];
  project.tracks = [
    { id: 'track-video', name: 'Video 1', type: 'video' },
    { id: 'track-dialogue', name: 'Dialogue', type: 'audio' },
    { id: 'track-music', name: 'Music', type: 'audio' },
  ];
  project.clips = [
    {
      id: 'clip-camera',
      assetId: 'asset-camera',
      trackId: 'track-video',
      timelineStart: at(0),
      sourceIn: at(15),
      sourceOut: at(150),
    },
    {
      id: 'clip-dialogue',
      assetId: 'asset-camera',
      trackId: 'track-dialogue',
      timelineStart: at(0),
      sourceIn: at(15),
      sourceOut: at(150),
    },
    {
      id: 'clip-camera-2',
      assetId: 'asset-camera',
      trackId: 'track-video',
      timelineStart: at(135),
      sourceIn: at(150),
      sourceOut: at(300),
    },
    {
      id: 'clip-music',
      assetId: 'asset-music',
      trackId: 'track-music',
      timelineStart: at(30),
      sourceIn: { numerator: 1, denominator: 48000 },
      sourceOut: { numerator: 480001, denominator: 48000 },
    },
  ];
  return project;
}

function issues(project: unknown) {
  const result = validateProject(project);
  expect(result.success).toBe(false);
  if (result.success) throw new Error('Expected invalid project');
  expect(result.error).toBeInstanceOf(ProjectFormatError);
  return result.error.issues;
}

describe('project creation and persistence', () => {
  it('creates independent valid empty projects with stable unique IDs and defaults', () => {
    const first = createProject({ name: 'First' });
    const second = createProject({ name: 'Second' });
    expect(first.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(first.metadata.id).not.toBe(second.metadata.id);
    expect(first.metadata.createdAt).toBe(first.metadata.updatedAt);
    expect(first.settings).toEqual({
      width: 1920,
      height: 1080,
      frameRate: { numerator: 30, denominator: 1 },
    });
    expect(first.assets).toEqual([]);
    expect(first.tracks).toEqual([]);
    expect(first.clips).toEqual([]);
    expect(deserializeProject(serializeProject(first))).toEqual(first);
    first.settings.width = 100;
    expect(second.settings.width).toBe(1920);
  });

  it('round trips multiple assets, video/audio tracks and clips without data loss', () => {
    const project = example();
    const json = serializeProject(project);
    const loaded = deserializeProject(json);
    expect(loaded).toEqual(project);
    expect(loaded.metadata.id).toBe('project-demo');
    expect(json).toContain('\n  "schemaVersion": 1,\n');
    expect(json.endsWith('\n')).toBe(true);
    expect(serializeProject(loaded)).toBe(json);
    loaded.assets[0]!.name = 'Renamed';
    expect(project.assets[0]!.name).toBe('Camera');
  });

  it('has deterministic object order regardless of input key insertion order', () => {
    const project = example();
    const shuffled = JSON.parse(
      JSON.stringify(project),
      (_key, value: unknown) => {
        if (value && typeof value === 'object' && !Array.isArray(value))
          return Object.fromEntries(Object.entries(value).reverse());
        return value;
      },
    ) as Project;
    expect(serializeProject(shuffled)).toBe(serializeProject(project));
    expect(shuffled.metadata.updatedAt).toBe(project.metadata.updatedAt);
  });

  it('preserves array order, unreduced times and input data', () => {
    const project = example();
    project.clips.reverse();
    project.clips[0]!.sourceIn = { numerator: 2, denominator: 4 };
    const before = structuredClone(project);
    expect(deserializeProject(serializeProject(project))).toEqual(before);
    expect(project).toEqual(before);
  });

  it('returns validated data without sharing mutable state with the input', () => {
    const project = example();
    const before = structuredClone(project);
    const result = validateProject(project);
    if (!result.success) throw result.error;

    result.project.metadata.name = 'Renamed';
    result.project.settings.frameRate.numerator = 24;
    result.project.assets[0]!.file.path = 'media/relinked.mp4';
    result.project.assets[0]!.mediaTypes.pop();
    result.project.tracks[0]!.name = 'Renamed track';
    result.project.clips[0]!.sourceIn.numerator = 0;
    result.project.clips.pop();

    expect(project).toEqual(before);
  });

  it('does not rely on array indices for asset or track references', () => {
    const project = example();
    project.assets.reverse();
    project.tracks.reverse();
    expect(validateProject(project).success).toBe(true);
    expect(
      deserializeProject(serializeProject(project)).clips[0]!.assetId,
    ).toBe('asset-camera');
  });

  it('preserves offline assets without attempting filesystem or probe access', () => {
    const project = example();
    project.assets[0]!.file = {
      type: 'absolute',
      path: '/does/not/exist/camera.mp4',
    };
    expect(deserializeProject(serializeProject(project))).toEqual(project);
  });

  it.each(['', '{', '{"schemaVersion":1,}', '/* comment */ {}', '{} {}'])(
    'reports malformed JSON: %j',
    (json) => {
      try {
        deserializeProject(json);
        throw new Error('Expected failure');
      } catch (error) {
        expect(error).toBeInstanceOf(ProjectFormatError);
        expect(error).toMatchObject({
          code: 'INVALID_JSON',
          issues: [{ path: '', code: 'invalid_json' }],
        });
        expect((error as Error).cause).toBeInstanceOf(SyntaxError);
      }
    },
  );

  it.each([0, 2, 999, -1])(
    'clearly rejects unsupported schema %s before parsing its payload',
    (schemaVersion) => {
      const result = validateProject({ schemaVersion });
      expect(result).toMatchObject({
        success: false,
        error: {
          code: 'UNSUPPORTED_VERSION',
          issues: [
            {
              path: '/schemaVersion',
              message: expect.stringContaining(`version ${schemaVersion}`),
            },
          ],
        },
      });
      expect(() =>
        deserializeProject(JSON.stringify({ schemaVersion })),
      ).toThrow('supported version is 1');
    },
  );

  it.each([undefined, '1', 1.5, null, Number.MAX_SAFE_INTEGER + 1])(
    'rejects malformed schema versions %s',
    (schemaVersion) => {
      expect(issues({ ...example(), schemaVersion })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: '/schemaVersion' }),
        ]),
      );
    },
  );

  it.each([null, [], true, 1, 'project', {}])(
    'rejects an invalid root %j',
    (value) => {
      expect(issues(value).length).toBeGreaterThan(0);
    },
  );

  it('revalidates on serialization and creation', () => {
    const project = example();
    project.clips[0]!.assetId = 'unknown';
    expect(() => serializeProject(project)).toThrow(
      "/clips/0/assetId: Asset 'unknown' does not exist",
    );
    expect(() => createProject({ name: ' ' })).toThrow('/metadata/name');
  });
});

describe('project structure and reference validation', () => {
  it.each([
    ['width', 0],
    ['width', 1.5],
    ['height', -1],
    ['height', Infinity],
    ['width', Number.MAX_SAFE_INTEGER + 1],
  ] as const)('rejects invalid %s=%s', (key, value) => {
    const project = example();
    project.settings[key] = value;
    expect(issues(project)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: `/settings/${key}` }),
      ]),
    );
  });

  it('rejects invalid frame rates and time components with precise locations', () => {
    const project = example();
    project.settings.frameRate.denominator = 0;
    project.clips[0]!.timelineStart.numerator = -1;
    project.clips[1]!.sourceIn.numerator = 0.1;
    project.clips[2]!.sourceOut.denominator = 0;
    expect(issues(project).map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        '/settings/frameRate/denominator',
        '/clips/0/timelineStart/numerator',
        '/clips/1/sourceIn/numerator',
        '/clips/2/sourceOut/denominator',
      ]),
    );
  });

  it('rejects unsafe times, nonfinite values and numeric strings without coercion', () => {
    const project = example();
    project.clips[0]!.sourceIn.numerator = Number.MAX_SAFE_INTEGER + 1;
    project.clips[1]!.sourceOut.numerator = NaN;
    project.clips[2]!.timelineStart.denominator = Infinity;
    const value: unknown = {
      ...project,
      settings: { ...project.settings, width: '1920' },
    };
    expect(issues(value)).toHaveLength(4);
  });

  it('rejects duplicates across assets, tracks, clips and metadata', () => {
    const project = example();
    project.assets[1]!.id = project.assets[0]!.id;
    project.tracks[0]!.id = project.metadata.id;
    project.clips[1]!.id = project.clips[0]!.id;
    const duplicates = issues(project).filter(
      (issue) => issue.code === 'duplicate_id',
    );
    expect(duplicates.map((issue) => issue.path)).toEqual([
      '/assets/1/id',
      '/tracks/0/id',
      '/clips/1/id',
    ]);
  });

  it('collects missing references and incompatible media errors', () => {
    const project = example();
    project.clips[0]!.assetId = 'unknown-asset';
    project.clips[1]!.trackId = 'unknown-track';
    project.clips[2]!.assetId = 'asset-music';
    expect(issues(project)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/clips/0/assetId',
          code: 'invalid_reference',
        }),
        expect.objectContaining({
          path: '/clips/1/trackId',
          code: 'invalid_reference',
        }),
        expect.objectContaining({
          path: '/clips/2/assetId',
          code: 'incompatible_media',
        }),
      ]),
    );
  });

  it('rejects reversed and empty source ranges and known duration overruns', () => {
    const project = example();
    project.clips[0]!.sourceOut = project.clips[0]!.sourceIn;
    project.clips[1]!.sourceOut = at(0);
    project.clips[2]!.sourceOut = at(301);
    expect(issues(project).map((issue) => issue.code)).toEqual([
      'invalid_range',
      'invalid_range',
      'source_bounds',
    ]);
  });

  it('compares source bounds exactly at safe integer limits', () => {
    const project = example();
    const max = Number.MAX_SAFE_INTEGER;
    project.assets[0]!.duration = { numerator: max, denominator: max - 1 };
    project.clips = [
      {
        ...project.clips[0]!,
        sourceIn: at(0),
        sourceOut: { numerator: max - 1, denominator: max - 2 },
      },
    ];
    expect(issues(project)).toEqual([
      expect.objectContaining({ code: 'source_bounds' }),
    ]);
  });

  it('permits exact exclusive end bounds and unknown durations', () => {
    const project = example();
    expect(
      compareTimes(project.clips[2]!.sourceOut, project.assets[0]!.duration!),
    ).toBe(0);
    delete project.assets[0]!.duration;
    expect(validateProject(project).success).toBe(true);
  });

  it('rejects zero known durations and missing required entity fields', () => {
    const project = example();
    project.assets[0]!.duration = { numerator: 0, denominator: 1 };
    expect(issues(project)[0]!.path).toBe('/assets/0/duration');
    const incomplete = { ...example(), clips: [{ id: 'clip' }] };
    expect(issues(incomplete).map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        '/clips/0/assetId',
        '/clips/0/trackId',
        '/clips/0/timelineStart',
        '/clips/0/sourceIn',
        '/clips/0/sourceOut',
      ]),
    );
  });

  it('rejects invalid names, IDs, track types and empty/repeated media types', () => {
    const project = example();
    project.assets[0]!.name = ' ';
    project.assets[1]!.mediaTypes = [];
    project.clips[0]!.id = 'bad id';
    const value = {
      ...project,
      tracks: [{ id: 'track', name: 'Track', type: 'subtitle' }],
    };
    expect(issues(value)).toHaveLength(4);
    const repeated = example();
    repeated.assets[0]!.mediaTypes = ['video', 'video'];
    expect(issues(repeated)[0]!.path).toBe('/assets/0/mediaTypes');
  });

  it('rejects invalid timestamps and updates preceding creation', () => {
    const project = example();
    project.metadata.createdAt = '2026-02-30T00:00:00.000Z';
    expect(issues(project)[0]!.path).toBe('/metadata/createdAt');
    project.metadata.createdAt = '2026-10-24T08:00:00.000Z';
    project.metadata.updatedAt = '2026-10-23T08:00:00.000Z';
    expect(issues(project)[0]!.code).toBe('invalid_timestamp');
  });

  it('rejects unknown fields instead of silently losing data', () => {
    const project = example();
    const value = {
      ...project,
      future: true,
      settings: { ...project.settings, typo: 1 },
    };
    const errors = issues(value);
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '', code: 'unrecognized_keys' }),
        expect.objectContaining({
          path: '/settings',
          code: 'unrecognized_keys',
        }),
      ]),
    );
  });

  it.each([
    { type: 'relative', path: '' },
    { type: 'relative', path: '/root/file.mp4' },
    { type: 'relative', path: 'C:/media/file.mp4' },
    { type: 'relative', path: 'media\\file.mp4' },
    { type: 'relative', path: 'https://example.com/file.mp4' },
    { type: 'absolute', path: 'media/file.mp4' },
    { type: 'absolute', path: 'file:///media/file.mp4' },
    { type: 'absolute', path: '/file\0.mp4' },
    { type: 'absolute', path: '//server' },
  ])('rejects ambiguous/invalid media reference %j', (file) => {
    const project = example();
    const value = { ...project, assets: [{ ...project.assets[0], file }] };
    expect(
      issues(value).some((issue) => issue.path.startsWith('/assets/0/file')),
    ).toBe(true);
  });

  it.each([
    { type: 'relative', path: 'media/日本語 #1%.mp4' },
    { type: 'relative', path: '../shared/music.wav' },
    { type: 'absolute', path: '/Volumes/Media/file.mp4' },
    { type: 'absolute', path: 'C:/Media/file.mp4' },
    { type: 'absolute', path: '//server/share/file.mp4' },
  ] as const)('preserves portable or explicitly absolute paths %j', (file) => {
    const project = example();
    project.assets[0]!.file = file;
    expect(
      deserializeProject(serializeProject(project)).assets[0]!.file,
    ).toEqual(file);
  });
});

import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addClip,
  createProject,
  frameTime,
  projectInspectionSchema,
  serializeProject,
  timelineInspectionSchema,
} from '@opencut/core';

const entry = fileURLToPath(
  new URL('../../apps/cli/dist/index.js', import.meta.url),
);
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'opencut-inspect-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const run = (...args: string[]) =>
  spawnSync(process.execPath, [entry, ...args], {
    encoding: 'utf8',
    cwd: directory,
    env: { ...process.env, PATH: '' },
  });

async function example() {
  let project = createProject({
    name: 'Offline',
    settings: {
      width: 160,
      height: 90,
      frameRate: { numerator: 30000, denominator: 1001 },
    },
  });
  project.assets = [
    {
      id: 'asset',
      name: 'Unavailable',
      mediaTypes: ['video', 'audio'],
      file: { type: 'relative', path: 'missing.mp4' },
    },
  ];
  project.tracks = [
    { id: 'v', name: 'Video', type: 'video' },
    { id: 'a', name: 'Audio', type: 'audio' },
  ];
  const time = (frame: number) => frameTime(frame, project.settings.frameRate);
  project = addClip(project, {
    id: 'visual',
    assetId: 'asset',
    trackId: 'v',
    timelineStart: time(10),
    sourceIn: time(5),
    sourceOut: time(25),
    visual: { opacity: 0.5, x: -10 },
    volume: 0.25,
  }).project;
  project = addClip(project, {
    id: 'muted',
    assetId: 'asset',
    trackId: 'a',
    timelineStart: time(0),
    sourceIn: time(0),
    sourceOut: time(30),
    muted: true,
  }).project;
  const path = join(directory, 'project.json');
  const original = serializeProject(project);
  await writeFile(path, original);
  return { project, path, original };
}

describe('agent CLI discovery and offline inspection', () => {
  it('discovers every command with arguments, typed options, limits and JSON schemas without tools', () => {
    const result = run('help', '--json');
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const catalog = JSON.parse(result.stdout);
    expect(catalog.discoveryVersion).toBe(1);
    expect(catalog.commands).toHaveLength(42);
    expect(
      new Set(catalog.commands.map((command: { name: string }) => command.name))
        .size,
    ).toBe(catalog.commands.length);
    for (const command of catalog.commands) {
      expect(command.status).toBe('supported');
      expect(command.arguments).toBeInstanceOf(Array);
      expect(
        command.options.map((option: { name: string }) => option.name),
      ).toContain('--json');
      const help = run(...command.name.split(' '), '--help');
      expect(help.status, help.stderr).toBe(0);
      expect(help.stdout).toContain('Usage:');
    }
    const frame = catalog.commands.find(
      (command: { name: string }) => command.name === 'preview frame',
    );
    expect(frame.arguments).toEqual([
      { name: 'project-file', required: true, variadic: false, type: 'string' },
    ]);
    expect(
      frame.options.find(
        (option: { name: string }) => option.name === '--frame',
      ),
    ).toMatchObject({ required: true, unit: 'project-frame', minimum: 0 });
    expect(catalog.schemas[frame.resultSchema].required).toContain('revision');
    expect(
      catalog.schemas['timeline inspect'].properties.visualClips.items
        .properties.sourceTime,
    ).toBeDefined();
    expect(
      JSON.parse(run('cache', '--help', '--json').stdout).commands.map(
        (command: { name: string }) => command.name,
      ),
    ).toEqual(
      catalog.commands
        .filter((command: { name: string }) =>
          command.name.startsWith('cache '),
        )
        .map((command: { name: string }) => command.name),
    );
    expect(catalog.capabilities.mcp.status).toBe('unavailable');
    expect(catalog.capabilities.sdk.package).toBe('@opencut/sdk');
    expect(catalog.capabilities.textLayers).toMatchObject({
      defaultFont: 'Noto Sans SC',
      transactionSchema: 'edit apply input',
    });
    expect(
      catalog.schemas['edit apply input'].properties.operations.items.oneOf,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            type: { type: 'string', const: 'text.add' },
          }),
        }),
      ]),
    );
    expect(catalog.capabilities.subtitles).toMatchObject({
      formats: ['srt', 'vtt'],
      transactionSchema: 'edit apply input',
      burnIn: true,
    });
    expect(catalog.capabilities.scriptingRuntime.status).toBe('supported');
    expect(catalog.schemas.run.required).toContain('result');
    expect(catalog.capabilities.visualInspection.headless).toBe(true);
    expect(catalog.exitCodes['2']).toBe('invalid arguments');
    expect(JSON.parse(run('--help', '--json').stdout).commands).toEqual(
      catalog.commands,
    );
    expect(
      JSON.parse(run('help', 'preview', '--json').stdout).commands,
    ).toHaveLength(3);
  });

  it('returns complete revision-tagged project content without history or probing', async () => {
    const { path, project, original } = await example();
    const result = run('project', 'inspect', path, '--json');
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const report = projectInspectionSchema.parse(JSON.parse(result.stdout));
    expect(report.settings).toEqual(project.settings);
    expect(report.assets).toEqual(project.assets);
    expect(report.tracks).toEqual(project.tracks);
    expect(report.clips).toEqual(project.clips);
    expect(report.revision).toBe(0);
    expect(report.duration).toEqual(frameTime(30, project.settings.frameRate));
    expect(report).not.toHaveProperty('editing');
    expect(await readFile(path, 'utf8')).toBe(original);
  });

  it.each(['project', 'timeline'])(
    'accepts global options between %s and inspect',
    async (group) => {
      const { path, original } = await example();
      const options = group === 'timeline' ? ['--frame', '10'] : [];
      const canonical = run(group, 'inspect', path, ...options, '--json');
      const interleaved = run(group, '--json', 'inspect', path, ...options);
      expect(canonical.status, canonical.stderr).toBe(0);
      expect(interleaved.status, interleaved.stderr).toBe(0);
      expect(interleaved.stderr).toBe('');
      expect(JSON.parse(interleaved.stdout)).toEqual(
        JSON.parse(canonical.stdout),
      );
      expect(await readFile(path, 'utf8')).toBe(original);
    },
  );

  it.each([
    ['project', 'inspect'],
    ['timeline', 'inspect'],
    ['preview', 'frame'],
    ['preview', 'contact-sheet'],
    ['preview', 'clip'],
  ])('scopes help with global options between %s and %s', (group, action) => {
    const canonical = run(group, action, '--help', '--json');
    expect(canonical.status, canonical.stderr).toBe(0);
    for (const help of ['--help', '-h']) {
      const interleaved = run(group, '--json', help, action);
      expect(interleaved.status, interleaved.stderr).toBe(0);
      expect(interleaved.stderr).toBe('');
      expect(JSON.parse(interleaved.stdout)).toEqual(
        JSON.parse(canonical.stdout),
      );
    }
  });

  it.each(['frame', 'from', 'to', 'size', 'count', 'columns'])(
    'rejects inspection-only --%s on other commands',
    (option) => {
      const result = run('--version', `--${option}`, '0', '--json');
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toMatchObject({ ok: false });
    },
  );

  it('uses exact source mapping, ordering, gain/mute and half-open boundaries at fractional rates', async () => {
    const { path, project, original } = await example();
    const inspect = (frame: number) => {
      const result = run(
        'timeline',
        'inspect',
        path,
        '--frame',
        String(frame),
        '--json',
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe('');
      return timelineInspectionSchema.parse(JSON.parse(result.stdout));
    };
    const at = inspect(10);
    expect(at.visualClips.map((clip) => clip.id)).toEqual(['visual']);
    expect(at.visualClips[0]!.sourceTime).toEqual(
      frameTime(5, project.settings.frameRate),
    );
    expect(at.visualClips[0]!.visual).toEqual({
      x: -10,
      y: 0,
      scale: 1,
      opacity: 0.5,
      fit: 'contain',
    });
    expect(at.audioClips.map((clip) => clip.id)).toEqual(['visual', 'muted']);
    expect(at.mixingSources.map((clip) => clip.id)).toEqual(['visual']);
    expect(at.mixingSources[0]!.effectiveVolume).toBe(0.25);
    expect(inspect(9).visualGap).toBe(true);
    expect(inspect(29).boundary).toBe('inside');
    expect(inspect(30)).toMatchObject({
      boundary: 'end',
      activeClips: [],
      gap: true,
    });
    expect(inspect(31).boundary).toBe('after');
    expect(await readFile(path, 'utf8')).toBe(original);
  });

  it.each([
    ['help', 'nonexistent'],
    ['project', 'inspect'],
    ['project', 'inspect', 'missing.json', '--frame', '0'],
    ['timeline', 'inspect', 'missing.json'],
    ['timeline', 'inspect', 'missing.json', '--frame', '0.5'],
    ['timeline', 'inspect', 'missing.json', '--frame=-1'],
    ['timeline', 'inspect', 'missing.json', '--frame', '9007199254740992'],
    ['preview', 'frame', 'missing.json', '--frame', '0', '--output', 'bad.mp4'],
    [
      'preview',
      'frame',
      'missing.json',
      '--frame',
      '0',
      '--output',
      'new.png',
      '--size',
      '63',
    ],
    ['preview', 'clip', 'missing.json', '--output', 'new.mp4'],
    [
      'preview',
      'clip',
      'missing.json',
      '--from',
      '0',
      '--to',
      '1',
      '--output',
      'new.mp4',
      '--quality',
      'unknown',
    ],
    [
      'preview',
      'frame',
      'missing.json',
      '--frame',
      '0',
      '--output',
      'new.png',
      '--overwrite',
    ],
    [
      'preview',
      'frame',
      'missing.json',
      '--frame',
      '0',
      '--output',
      'new.png',
      '--timestamp',
      '1',
    ],
  ])(
    'rejects invalid arguments with structured stderr and no stdout: %j',
    (...args) => {
      const result = run(...args, '--json');
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toMatchObject({
        ok: false,
        error: { message: expect.any(String) },
      });
    },
  );

  it('reports structured file errors and refuses out-of-range previews', async () => {
    expect(run('project', 'inspect', 'missing.json', '--json').status).toBe(1);
    const { path } = await example();
    for (const args of [
      ['frame', '--frame', '30'],
      ['clip', '--from', '10', '--to', '10'],
      ['contact-sheet', '--from', '0', '--to', '2', '--count', '3'],
      ['contact-sheet', '--count', '17'],
      ['contact-sheet', '--columns', '0'],
    ]) {
      const result = run(
        'preview',
        args[0]!,
        path,
        ...args.slice(1),
        '--output',
        args[0] === 'clip' ? 'preview.mp4' : 'preview.png',
        '--json',
      );
      expect(result.status, result.stderr).toBe(2);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr).error.message).toBeTruthy();
    }
  });
});

it('bounds preview duration before decoding or creating temporary output', async () => {
  const { path, project } = await example();
  project.clips = [project.clips[0]!];
  project.clips[0]!.timelineStart = frameTime(0, project.settings.frameRate);
  project.clips[0]!.sourceOut = frameTime(1005, project.settings.frameRate);
  await writeFile(path, serializeProject(project));
  const result = run(
    'preview',
    'clip',
    path,
    '--from',
    '0',
    '--to',
    '1000',
    '--output',
    'long.mp4',
    '--json',
  );
  expect(result.status).toBe(2);
  expect(result.stdout).toBe('');
  expect(JSON.parse(result.stderr).error.message).toContain('30 seconds');
});

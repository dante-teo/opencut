import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  createProject,
  openProject,
  parseSubtitleTime,
  parseSubtitles,
} from '@opencut/sdk';

const cli = resolve('apps/cli/dist/index.js');
const fixture = (extension: string) =>
  resolve('tests/fixtures/subtitles/multilingual.' + extension);
const run = (...args: string[]) =>
  JSON.parse(
    execFileSync(process.execPath, [cli, ...args, '--json'], {
      encoding: 'utf8',
    }),
  );
let directory: string;
let path: string;

beforeEach(async () => {
  const root = resolve('tests/fixtures/generated');
  await mkdir(root, { recursive: true });
  directory = await mkdtemp(join(root, 't34-subtitles-'));
  path = join(directory, 'project.json');
  await (await createProject(path, { name: 'Subtitle workflow' })).save();
});
afterEach(async () => rm(directory, { recursive: true, force: true }));

it('shares CLI and SDK cue edits, exact inspection, sidecars and persistent history', async () => {
  expect(
    run('help', 'subtitle').commands.map(
      (command: { name: string }) => command.name,
    ),
  ).toEqual(['subtitle import', 'subtitle list', 'subtitle export']);
  expect(
    run('subtitle', 'import', path, fixture('srt'), '--dry-run'),
  ).toMatchObject({ revision: 1, dryRun: true, cueCount: 2 });
  expect(run('subtitle', 'list', path).cues).toEqual([]);
  expect(
    run('subtitle', 'import', path, fixture('srt'), '--expected-revision', '0'),
  ).toMatchObject({ revision: 1, cueCount: 2 });
  const editor = await openProject(path);
  const imported = editor.project.inspect().subtitles!.cues;
  const initialVtt = join(directory, 'initial.vtt');
  await editor.project.exportSubtitles(initialVtt);
  expect(parseSubtitles(await readFile(initialVtt, 'utf8'), 'vtt')).toEqual(
    parseSubtitles(await readFile(fixture('vtt'), 'utf8'), 'vtt'),
  );
  expect(await editor.project.importSubtitles(initialVtt)).toEqual({
    format: 'vtt',
    cueCount: 2,
  });
  const cues = editor.project.inspect().subtitles!.cues;
  editor.project.apply(
    { type: 'subtitle.remove', id: cues[2]!.id },
    { type: 'subtitle.remove', id: cues[3]!.id },
    {
      type: 'subtitle.set',
      id: imported[0]!.id,
      start: parseSubtitleTime('0.115'),
      duration: parseSubtitleTime('0.490'),
      text: 'Edited\n中文字幕 😀',
    },
    {
      type: 'subtitle.style',
      style: { fontSize: 31, background: { color: '#344455aa', padding: 4 } },
    },
  );
  expect(await editor.save()).toMatchObject({ revision: 2 });
  expect(
    run('timeline', 'inspect', path, '--frame', '13').visualClips,
  ).toMatchObject([
    { id: imported[0]!.id, subtitle: true, text: { fontSize: 31 } },
    { id: imported[1]!.id, subtitle: true, text: { fontSize: 31 } },
  ]);
  const batch = join(directory, 'batch.json');
  await writeFile(
    batch,
    JSON.stringify({
      expectedRevision: 2,
      operations: [
        {
          type: 'subtitle.split',
          id: imported[0]!.id,
          at: parseSubtitleTime('0.205'),
          rightId: 'right',
        },
        { type: 'subtitle.set', id: 'right', text: '右' },
        { type: 'subtitle.merge', ids: [imported[0]!.id, 'right'] },
        {
          type: 'subtitle.move',
          id: imported[1]!.id,
          start: parseSubtitleTime('0.415'),
        },
      ],
    }),
  );
  expect(run('edit', 'apply', path, batch)).toMatchObject({ revision: 3 });
  const expected = run('subtitle', 'list', path).cues;
  expect(expected[0].text).toBe('Edited\n中文字幕 😀\n右');
  for (const format of ['srt', 'vtt'] as const) {
    const file = join(directory, 'output.' + format);
    expect(run('subtitle', 'export', path, '--output', file)).toMatchObject({
      path: file,
      cueCount: 2,
      format,
    });
    const contents = await readFile(file, 'utf8');
    expect(parseSubtitles(contents, format)).toMatchObject(
      expected.map(({ start, end, text }: (typeof imported)[number]) => ({
        start: parseSubtitleTime(`${start.numerator}/${start.denominator}`),
        end: parseSubtitleTime(`${end.numerator}/${end.denominator}`),
        text,
      })),
    );
    expect(
      spawnSync(process.execPath, [
        cli,
        'subtitle',
        'export',
        path,
        '--output',
        file,
      ]).status,
    ).toBe(1);
    expect(await readFile(file, 'utf8')).toBe(contents);
  }
  expect(run('edit', 'undo', path)).toMatchObject({ revision: 4 });
  expect(run('subtitle', 'list', path).cues[0].text).toBe(
    'Edited\n中文字幕 😀',
  );
  expect(run('edit', 'redo', path)).toMatchObject({ revision: 5 });
  expect((await openProject(path)).project.inspect().subtitles?.cues).toEqual(
    expected,
  );
});

it('rejects malformed imports atomically and accepts BOM-marked UTF-16', async () => {
  const file = join(directory, 'input.srt');
  const original = await readFile(path, 'utf8');
  await writeFile(
    file,
    (await readFile(fixture('srt'), 'utf8')) +
      '\n3\n00:00:00,555 --> invalid\nbad\n',
  );
  const failure = spawnSync(
    process.execPath,
    [cli, 'subtitle', 'import', path, file, '--json'],
    { encoding: 'utf8' },
  );
  expect(failure.status).toBe(1);
  expect(JSON.parse(failure.stderr).error.message).toContain(
    'Subtitle block 3',
  );
  expect(await readFile(path, 'utf8')).toBe(original);
  await writeFile(
    file,
    Buffer.from('\uFEFF' + (await readFile(fixture('srt'), 'utf8')), 'utf16le'),
  );
  expect(run('subtitle', 'import', path, file)).toMatchObject({
    cueCount: 2,
    revision: 1,
  });
});

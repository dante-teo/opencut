import assert from 'node:assert/strict';
import {
  access,
  copyFile,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  cli,
  prepareWorkspace,
  runDeployedNode,
  sourceHashes,
  succeed,
  succeedDeployedNode,
  verifyDelivery,
} from './agent-workspace.js';

const project = 'cut.opencut.json';

test(
  'CLI-only agent workflow in a deployed runtime',
  { timeout: 120_000 },
  async (t) => {
    const cwd = await prepareWorkspace();
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const originalMedia = await sourceHashes(cwd);
    const command = (...args: string[]) => JSON.parse(cli(cwd, ...args));
    const failure = (...args: string[]) => {
      const result = runDeployedNode(cwd, 'dist/index.js', '--json', ...args);
      assert.equal(result.status, 1, result.stderr.toString());
      assert.equal(result.stdout.length, 0);
      return JSON.parse(result.stderr.toString()).error;
    };
    const catalog = command('help');
    assert.equal(catalog.discoveryVersion, 1);
    assert.equal(catalog.capabilities.visualInspection.status, 'supported');
    const scoped = command('help', 'edit', 'apply');
    assert.equal(scoped.commands.length, 1);
    assert.equal(scoped.commands[0].arguments[1].name, 'batch.json');
    assert.match(scoped.help, /Batch JSON/);
    assert.equal(scoped.help, command('edit', 'apply', '--help').help);
    assert.equal(
      command('help', 'preview', 'frame').help,
      command('preview', 'frame', '--help').help,
    );
    assert.equal(
      command('help', 'project', 'render').commands[0].jsonOutput,
      'jsonl',
    );

    command(
      'project',
      'create',
      project,
      '--name',
      'CLI rough cut',
      '--width',
      '160',
      '--height',
      '90',
      '--fps',
      '30',
    );
    assert.equal(command('project', 'inspect', project).revision, 0);
    assert.equal(
      failure('media', 'import', project, 'media/missing.mp4').code,
      'SOURCE_UNAVAILABLE',
    );
    const importMedia = (file: string) =>
      command('media', 'import', project, `media/${file}`).asset.id;
    const camera = importMedia('camera.mp4');
    const music = importMedia('music.wav');
    const logo = importMedia('logo.png');
    const inspected = command('project', 'inspect', project);
    const original = await readFile(join(cwd, project));

    // Execute the portable Skill's actual batch example with the discovered IDs.
    const guide = await readFile(
      join(cwd, 'video-editor/references/workflow.md'),
      'utf8',
    );
    const example = guide.match(/```json\n([\s\S]+?)\n```/)?.[1];
    assert.ok(example);
    const batch = JSON.parse(
      example
        .replace('CAMERA_ID', camera)
        .replace('MUSIC_ID', music)
        .replace('LOGO_ID', logo),
    );
    batch.expectedRevision = inspected.revision;
    const writeBatch = (file: string, value: unknown) =>
      writeFile(join(cwd, file), JSON.stringify(value), { flag: 'wx' });
    await writeBatch('batch.json', batch);
    await writeBatch('invalid.json', {
      ...batch,
      operations: [
        ...batch.operations,
        { type: 'clip.move', id: 'take-right', at: 29 },
      ],
    });
    assert.match(
      failure('edit', 'apply', project, 'invalid.json').message,
      /overlap/i,
    );
    assert.deepEqual(await readFile(join(cwd, project)), original);
    const dryRun = command('edit', 'apply', project, 'batch.json', '--dry-run');
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.revision, inspected.revision + 1);
    assert.deepEqual(await readFile(join(cwd, project)), original);
    const commit = command('edit', 'apply', project, 'batch.json');
    assert.equal(commit.revision, dryRun.revision);
    assert.equal(
      failure('edit', 'apply', project, 'batch.json').code,
      'REVISION_CONFLICT',
    );
    const saved = await readFile(join(cwd, project));
    const frame = command(
      'preview',
      'frame',
      project,
      '--frame',
      '30',
      '--output',
      'review.png',
    );
    assert.equal(frame.revision, commit.revision);
    const sheet = command(
      'preview',
      'contact-sheet',
      project,
      '--from',
      '0',
      '--to',
      '60',
      '--count',
      '5',
      '--output',
      'sheet.png',
    );
    assert.equal(sheet.samples.length, 5);
    const clip = command(
      'preview',
      'clip',
      project,
      '--from',
      '14',
      '--to',
      '46',
      '--size',
      '160',
      '--output',
      'sample.mp4',
    );
    assert.equal(clip.frameCount, 32);
    succeed(cwd, 'ffmpeg', [
      '-v',
      'error',
      '-xerror',
      '-i',
      'sample.mp4',
      '-f',
      'null',
      '-',
    ]);
    const events = cli(
      cwd,
      'project',
      'render',
      project,
      '--output',
      'final.mp4',
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(events.at(-1).event, 'completed');

    await copyFile(join(cwd, project), join(cwd, 'shifted.opencut.json'));
    command('clip', 'visual', 'shifted.opencut.json', 'logo', '--x', '10');
    command(
      'preview',
      'frame',
      'shifted.opencut.json',
      '--frame',
      '30',
      '--output',
      'shifted.png',
    );

    // Render editable text from the deployed CLI. This exercises its packaged
    // native rasterizer and fonts inside the same module boundary as agents.
    const textProject = 'text.opencut.json';
    command(
      'project',
      'create',
      textProject,
      '--name',
      'Bilingual title',
      '--width',
      '240',
      '--height',
      '160',
    );
    await writeBatch('text-batch.json', {
      expectedRevision: 0,
      operations: [
        {
          type: 'text.add',
          id: 'title',
          at: 0,
          duration: 30,
          text: { content: 'OpenCut\n中文字幕 😀', fontSize: 30 },
        },
      ],
    });
    command('edit', 'apply', textProject, 'text-batch.json');
    assert.equal(
      command('timeline', 'inspect', textProject, '--frame', '0').visualClips[0]
        .kind,
      'text',
    );
    command(
      'preview',
      'frame',
      textProject,
      '--frame',
      '0',
      '--output',
      'bilingual.png',
    );
    assert.equal(command('probe', 'bilingual.png').video.codec, 'png');

    const deployedCli = join(cwd, 'dist/index.js');
    await rm(deployedCli);
    await writeFile(
      deployedCli,
      "import { writeFileSync } from 'node:fs'; writeFileSync(new URL('../executed', import.meta.url), 'unexpected execution');",
      { flag: 'wx' },
    );
    verifyDelivery(cwd);
    await assert.rejects(access(join(cwd, 'executed')), { code: 'ENOENT' });

    // The project and export still describe the centered logo, but the review PNG does not.
    await rename(join(cwd, 'shifted.png'), join(cwd, 'review.png'));
    assert.throws(() => verifyDelivery(cwd), /Expected centered logo/);
    assert.deepEqual(await readFile(join(cwd, project)), saved);
    assert.deepEqual(await sourceHashes(cwd), originalMedia);
  },
);

test(
  'standalone TypeScript SDK and documented runner examples in a deployed runtime',
  { timeout: 120_000 },
  async (t) => {
    const cwd = await prepareWorkspace();
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const originalMedia = await sourceHashes(cwd);
    const fallback = runDeployedNode(
      cwd,
      '--input-type=module',
      '--eval',
      "import 'tsx'",
    );
    assert.notEqual(fallback.status, 0);
    assert.match(
      fallback.stderr.toString(),
      /Module resolves outside the deployed workspace: tsx/,
    );
    const sdkPath = await realpath(join(cwd, 'node_modules/@opencut/sdk'));
    assert.ok(sdkPath.startsWith((await realpath(cwd)) + sep), sdkPath);
    await assert.rejects(access(join(sdkPath, 'src')), { code: 'ENOENT' });
    const copy = (source: string, name: string) =>
      copyFile(
        fileURLToPath(new URL(source, import.meta.url)),
        join(cwd, name),
      );
    await copy('./agent-sdk-workflow.ts', 'edit.ts');
    succeedDeployedNode(cwd, 'edit.ts');
    verifyDelivery(cwd);

    for (const name of [
      'title-card.ts',
      'rough-cut.ts',
      'review-and-export.ts',
    ])
      await copy(`../../examples/scripts/${name}`, name);
    succeedDeployedNode(cwd, 'title-card.ts', 'title.json', 'media/logo.png');
    const rough = JSON.parse(
      cli(
        cwd,
        'run',
        'rough-cut.ts',
        '--project',
        'project.opencut.json',
        '--create',
        'Rough cut',
        '--',
        'media/camera.mp4',
        'media/camera.mp4',
      ),
    );
    assert.equal(rough.result.shots, 2);
    const review = JSON.parse(
      cli(
        cwd,
        'run',
        'review-and-export.ts',
        '--project',
        'project.opencut.json',
        '--expected-revision',
        '1',
        '--',
        '30',
        'example-review.png',
        'example.mp4',
      ),
    );
    assert.equal(review.result.video.frameCount, 60);
    assert.equal(review.changed, false);
    succeed(cwd, 'ffmpeg', [
      '-v',
      'error',
      '-xerror',
      '-i',
      'example.mp4',
      '-f',
      'null',
      '-',
    ]);
    const guide = await readFile(
      join(cwd, 'video-editor/references/sdk.md'),
      'utf8',
    );
    const example = guide.match(/```ts\n([\s\S]+?)\n```/)?.[1];
    assert.ok(example);
    const saved = await readFile(join(cwd, 'project.opencut.json'));
    await copyFile(join(cwd, 'media/camera.mp4'), join(cwd, 'b-roll.mp4'));
    await writeFile(join(cwd, 'cutaway.ts'), example, { flag: 'wx' });
    succeedDeployedNode(cwd, 'cutaway.ts');
    await access(join(cwd, 'cutaway-review.png'));
    assert.deepEqual(await readFile(join(cwd, 'project.opencut.json')), saved);
    assert.deepEqual(await sourceHashes(cwd), originalMedia);
  },
);

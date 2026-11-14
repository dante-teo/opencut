import assert from 'node:assert/strict';
import { execFileSync, fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createProject, openProject } from '@opencut/sdk';

const generated = resolve('tests/fixtures/generated');
const cli = resolve('apps/cli/dist/index.js');
const query = {
  provider: 'openverse',
  kind: 'image',
  query: 'fixture',
} as const;

test('public SDK and CLI import licensed online media without Electron', async (t) => {
  await mkdir(generated, { recursive: true });
  const root = await mkdtemp(join(generated, 'online-headless-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const png = join(root, 'source.png');
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=s=16x16:c=red',
    '-frames:v',
    '1',
    png,
  ]);
  const bytes = await readFile(png);
  const providerResponse = {
    page_count: 1,
    results: [
      {
        title: 'Red fixture',
        creator: 'Test creator',
        license: 'by',
        license_version: '4.0',
        foreign_landing_url: 'https://openverse.org/image/fixture',
        url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/fixture.png',
      },
    ],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith('https://api.openverse.org/'))
      return new Response(JSON.stringify(providerResponse), {
        headers: { 'content-type': 'application/json' },
      });
    if (url.startsWith('https://upload.wikimedia.org/'))
      return new Response(bytes, { headers: { 'content-type': 'image/png' } });
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const sdkPath = join(root, 'sdk.json');
    const editor = await createProject(sdkPath, { name: 'Online SDK' });
    await editor.save();
    const opened = await openProject(sdkPath);
    const page = await opened.project.searchOnlineMedia(query);
    assert.equal(page.results.length, 1);
    assert.equal(page.results[0]!.previewUrl, null);
    const imported = await opened.project.importOnlineMedia(
      page.results[0]!.id,
      join(root, 'sdk-media'),
    );
    assert.equal(imported.asset.provenance?.license, 'CC BY 4.0');
    await opened.save();
    assert.equal(
      (await openProject(sdkPath)).project.inspect().assets.length,
      1,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  const preload = join(root, 'mock-fetch.mjs');
  await writeFile(
    preload,
    `import { readFileSync } from 'node:fs';\nconst body = ${JSON.stringify(providerResponse)};\nglobalThis.fetch = async (input) => String(input).startsWith('https://api.openverse.org/') ? new Response(JSON.stringify(body), {headers: {'content-type':'application/json'}}) : new Response(readFileSync(${JSON.stringify(png)}), {headers: {'content-type':'image/png'}});\n`,
  );
  const request = join(root, 'request.json');
  await writeFile(request, JSON.stringify(query));
  const cliPath = join(root, 'cli.json');
  await (await createProject(cliPath, { name: 'Online CLI' })).save();
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args, '--json'], {
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: `--import=${preload}` },
    });
  const unsupportedRequest = join(root, 'unsupported.json');
  await writeFile(
    unsupportedRequest,
    JSON.stringify({ provider: 'openverse', kind: 'video', query: 'fixture' }),
  );
  const unsupported = run('online', 'search', unsupportedRequest);
  assert.equal(unsupported.status, 1);
  assert.equal(
    JSON.parse(unsupported.stderr).error.code,
    'UNSUPPORTED_CAPABILITY',
  );
  const search = run('online', 'search', request);
  assert.equal(search.status, 0, search.stderr);
  const selectedId = JSON.parse(search.stdout).results[0].id as string;
  assert.match(selectedId, /^[0-9a-f-]{36}$/);
  const importResult = run(
    'online',
    'import',
    cliPath,
    request,
    '--result',
    selectedId,
    '--directory',
    join(root, 'cli-media'),
    '--expected-revision',
    '0',
  );
  assert.equal(importResult.status, 0, importResult.stderr);
  assert.equal(
    JSON.parse(importResult.stdout).asset.provenance.license,
    'CC BY 4.0',
  );
  const retry = run(
    'online',
    'import',
    cliPath,
    request,
    '--result',
    selectedId,
    '--directory',
    join(root, 'cli-media'),
    '--expected-revision',
    '0',
  );
  assert.equal(retry.status, 1);
  assert.equal(JSON.parse(retry.stderr).error.code, 'REVISION_CONFLICT');
  const sdkAsset = (await openProject(join(root, 'sdk.json'))).project.inspect()
    .assets[0]!;
  const cliAsset = (await openProject(cliPath)).project.inspect().assets[0]!;
  assert.deepEqual(cliAsset.provenance, sdkAsset.provenance);
  assert.equal(cliAsset.name, sdkAsset.name);

  await rm(JSON.parse(importResult.stdout).artifact);
  const restored = run(
    'online',
    'import',
    cliPath,
    request,
    '--result',
    selectedId,
    '--directory',
    join(root, 'cli-media'),
    '--expected-revision',
    '1',
  );
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(JSON.parse(restored.stdout).imported, true);
  const reopened = await openProject(cliPath);
  assert.equal(reopened.project.inspect().assets.length, 2);
  assert.equal(
    (await reopened.project.checkMedia()).find(
      (asset) => asset.assetId === JSON.parse(restored.stdout).asset.id,
    )?.status,
    'available',
  );

  const lostPath = join(root, 'lost-reply.json');
  await (await createProject(lostPath, { name: 'Lost reply' })).save();
  const worker = fork(
    resolve('tests/integration/session-worker.ts'),
    [lostPath, 'crash-after-commit'],
    {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    },
  );
  try {
    const exited = once(worker, 'exit');
    const [ready] = await once(worker, 'message');
    assert.equal((ready as { ok: boolean }).ok, true);
    const uncertain = run(
      'online',
      'import',
      lostPath,
      request,
      '--result',
      selectedId,
      '--directory',
      join(root, 'lost-media'),
      '--expected-revision',
      '0',
    );
    assert.equal(uncertain.status, 1);
    assert.equal(
      JSON.parse(uncertain.stderr).error.code,
      'SESSION_DISCONNECTED',
    );
    await exited;
    const committed = await openProject(lostPath);
    assert.equal(committed.project.inspect().assets.length, 1);
    assert.equal(
      (await committed.project.checkMedia())[0]?.status,
      'available',
    );
  } finally {
    if (worker.exitCode === null && worker.signalCode === null)
      worker.kill('SIGKILL');
  }
});

import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { OnlineMediaLibrary } from '@opencut/sdk';

const generated = resolve('tests/fixtures/generated');
const cli = resolve('apps/cli/dist/index.js');
const query = {
  provider: 'openverse',
  kind: 'image',
  query: 'fixture',
} as const;

test('public SDK and CLI download licensed online media without Electron', async (t) => {
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
    const library = new OnlineMediaLibrary();
    const page = await library.search(query);
    assert.equal(page.results.length, 1);
    assert.equal(page.results[0]!.previewUrl, null);
    const downloaded = await library.download(
      page.results[0]!.id,
      join(root, 'sdk-media'),
    );
    assert.equal(downloaded.provenance.license, 'CC BY 4.0');
    assert.deepEqual(await readFile(downloaded.path), bytes);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const preload = join(root, 'mock-fetch.mjs');
  await writeFile(
    preload,
    `
      import { readFileSync } from 'node:fs';
      const body = ${JSON.stringify(providerResponse)};
      globalThis.fetch = async (input, { signal } = {}) => {
        if (String(input).startsWith('https://api.openverse.org/'))
          return Response.json(body);
        const bytes = readFileSync(${JSON.stringify(png)});
        const headers = { 'content-type': 'image/png' };
        if (!process.env.OPENCUT_TEST_SLOW_DOWNLOAD)
          return new Response(bytes, { headers });
        let timer;
        let abort;
        return new Response(new ReadableStream({
          start(controller) {
            abort = () => {
              clearTimeout(timer);
              controller.error(signal.reason);
            };
            signal.addEventListener('abort', abort, { once: true });
            controller.enqueue(bytes.subarray(0, 8));
            process.stderr.write('download started\\n');
            timer = setTimeout(() => {
              signal.removeEventListener('abort', abort);
              process.stderr.write('download finished\\n');
              controller.enqueue(bytes.subarray(8));
              controller.close();
            }, 1500);
          },
          cancel() {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
          },
        }), { headers });
      };
    `,
  );
  const request = join(root, 'request.json');
  await writeFile(request, JSON.stringify(query));
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
  const download = run(
    'online',
    'download',
    request,
    '--result',
    selectedId,
    '--directory',
    join(root, 'cli-media'),
  );
  assert.equal(download.status, 0, download.stderr);
  const artifact = JSON.parse(download.stdout);
  assert.equal(artifact.provenance.license, 'CC BY 4.0');
  assert.deepEqual(await readFile(artifact.path), bytes);

  const definition = join(root, 'online.video.ts');
  await writeFile(
    definition,
    `export default ${JSON.stringify({
      canvas: { width: 64, height: 64, frameRate: 24 },
      assets: {
        licensed: {
          kind: 'image',
          path: artifact.path.slice(root.length + 1),
          provenance: artifact.provenance,
        },
      },
      tracks: [
        { type: 'image', clips: [{ asset: 'licensed', at: 0, duration: 1 }] },
      ],
    })};\n`,
  );
  const inspected = run('inspect', definition);
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.deepEqual(
    JSON.parse(inspected.stdout).assets[0].provenance,
    artifact.provenance,
  );

  await t.test(
    'SIGINT discards an in-flight download',
    { skip: process.platform === 'win32' },
    async () => {
      const directory = join(root, 'cancelled-media');
      const child = spawn(
        process.execPath,
        [
          '--import',
          preload,
          cli,
          'online',
          'download',
          request,
          '--result',
          selectedId,
          '--directory',
          directory,
          '--json',
        ],
        {
          env: { ...process.env, OPENCUT_TEST_SLOW_DOWNLOAD: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      let diagnostics = '';
      let cancelled = false;
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        output += chunk;
      });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        diagnostics += chunk;
        if (!cancelled && diagnostics.includes('download started')) {
          cancelled = true;
          child.kill('SIGINT');
        }
      });
      try {
        const [code] = await once(child, 'close', {
          signal: AbortSignal.timeout(10_000),
        });
        assert.ok(cancelled, diagnostics);
        assert.equal(code, 130, diagnostics);
        assert.doesNotMatch(diagnostics, /download finished/);
        assert.equal(output, '');
        assert.deepEqual(await readdir(directory), []);
      } finally {
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
      }
    },
  );
});

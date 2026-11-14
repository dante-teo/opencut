import { execFileSync } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchDesktop } from './helpers.js';
import { controlDesktopProject } from '@opencut/core/node';
import type { DesktopControlRequest } from '@opencut/core/node';

const root = resolve('tests/fixtures/generated');
const names = ['still.png', 'audio-tone.wav', 'video-medium.mp4'];
const fixturesAvailable = await Promise.all(
  names.map((name) =>
    access(join(root, name)).then(
      () => true,
      () => false,
    ),
  ),
);

// Historical coverage for the removed online browser. Headless provider operations are covered by Core and SDK tests.
test.skip('searches both public providers, previews media and reopens offline imports with credits', async () => {
  test.skip(
    fixturesAvailable.includes(false),
    'Generate synthetic fixtures first.',
  );
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'online-media-'));
  const jpegPath = join(directory, 'fixture.jpg');
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-i',
    join(root, names[0]!),
    '-frames:v',
    '1',
    jpegPath,
  ]);
  for (const [format, filename] of [
    ['gif', 'animated.gif'],
    ['apng', 'animated.png'],
  ]) {
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=32x32:rate=4:duration=1',
      '-f',
      format!,
      join(directory, filename!),
    ]);
  }
  const { application, page } = await launchDesktop();
  const projectPath = join(directory, 'project.json');
  try {
    await application.evaluate(
      async (
        { app, dialog, shell },
        { directory, projectPath, root, jpegPath },
      ) => {
        const { readFile } = process.getBuiltinModule('node:fs/promises')!;
        const { join } = process.getBuiltinModule('node:path')!;
        const data = 'https://upload.wikimedia.org/wikipedia/commons';
        const source = 'https://commons.wikimedia.org/wiki/File:';
        const license = 'https://creativecommons.org/licenses/by/4.0/';
        app.setPath('userData', directory);
        dialog.showSaveDialog = async () => ({
          canceled: false,
          filePath: projectPath,
        });
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [projectPath],
        });
        shell.openExternal = async (url) => {
          if (url !== 'https://freesound.org/people/fixture/sounds/12/')
            throw new Error('Unexpected source URL');
        };
        globalThis.fetch = async (input, options) => {
          const url = new URL(String(input));
          const requestHeaders = new Headers(options?.headers);
          if (
            requestHeaders.has('authorization') ||
            url.searchParams.has('key')
          )
            throw new Error('Unexpected provider credential');
          if (url.hostname === 'commons.wikimedia.org') {
            const video = url.searchParams
              .get('gsrsearch')
              ?.endsWith('filetype:video');
            const title = video ? 'Fixture clip.mp4' : 'Fixture still.jpg';
            const file = {
              url: data + (video ? '/clip.mp4' : '/still.jpg'),
              descriptionurl: source + title.replaceAll(' ', '_'),
              derivatives: [{ src: data + '/transcoded/clip.mp4' }],
              extmetadata: {
                Artist: { value: '<b>Fixture author</b>' },
                LicenseUrl: { value: license },
              },
            };
            return Response.json({
              query: {
                pages: [
                  {
                    title: 'File:' + title,
                    [video ? 'videoinfo' : 'imageinfo']: [file],
                  },
                  ...(!video
                    ? [
                        ...['animated.gif', 'animated.png'].map((name) => ({
                          title: 'File:' + name,
                          imageinfo: [
                            {
                              ...file,
                              url: data + '/' + name,
                              descriptionurl: source + name,
                            },
                          ],
                        })),
                        {
                          title: 'File:Invalid.png',
                          imageinfo: [
                            {
                              ...file,
                              url: data + '/bad.png',
                              descriptionurl: source + 'Invalid.png',
                            },
                          ],
                        },
                      ]
                    : []),
                ],
              },
            });
          }
          if (url.hostname === 'api.openverse.org') {
            if (!url.pathname.endsWith('/audio/'))
              throw new Error('Unexpected Openverse endpoint');
            return Response.json({
              page_count: 1,
              results: [
                {
                  title: 'Fixture tone',
                  creator: 'Fixture author',
                  license: 'by',
                  license_version: '4.0',
                  foreign_landing_url: source + 'Tone.wav',
                  url: data + '/tone.wav',
                },
                {
                  title: 'Source-only audio',
                  creator: 'Fixture author',
                  license: 'cc0',
                  foreign_landing_url:
                    'https://freesound.org/people/fixture/sounds/12/',
                  url: 'https://freesound.org/people/fixture/sounds/12/download.wav',
                },
                {
                  title: 'Restricted audio',
                  creator: 'Fixture author',
                  license: 'by-nc',
                  license_version: '4.0',
                  foreign_landing_url: source + 'Restricted.wav',
                  url: data + '/tone.wav',
                },
              ],
            });
          }
          if (url.href === data + '/bad.png')
            return new Response('<html>Not media</html>', {
              headers: { 'Content-Type': 'text/html' },
            });
          const files: Record<string, [string, string]> = {
            [data + '/still.jpg']: [jpegPath, 'image/jpeg'],
            [data + '/animated.gif']: [
              join(directory, 'animated.gif'),
              'image/gif',
            ],
            [data + '/animated.png']: [
              join(directory, 'animated.png'),
              'image/apng',
            ],
            [data + '/tone.wav']: [join(root, 'audio-tone.wav'), 'audio/wav'],
            [data + '/clip.mp4']: [join(root, 'video-medium.mp4'), 'video/mp4'],
          };
          const file = files[url.href];
          if (!file) throw new Error('Unexpected fetch: ' + url.href);
          const bytes = new Uint8Array(await readFile(file[0]));
          const partial = requestHeaders.has('range');
          return new Response(bytes, {
            status: partial ? 206 : 200,
            headers: {
              'Content-Type': file[1],
              'Content-Length': String(bytes.length),
              ...(partial
                ? {
                    'Content-Range':
                      'bytes 0-' + (bytes.length - 1) + '/' + bytes.length,
                  }
                : {}),
            },
          });
        };
      },
      { directory, projectPath, root, jpegPath },
    );
    await page
      .getByRole('button', { name: 'New project', exact: true })
      .click();
    await page.getByLabel('Project name', { exact: true }).fill('Online media');
    await page
      .getByRole('button', { name: 'Create project', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Browse online', exact: true })
      .click();
    const search = page.getByRole('searchbox', { name: 'Search online media' });
    const submit = page.getByRole('button', { name: 'Search', exact: true });
    const result = (name: string) =>
      page.locator('.online-results li').filter({ hasText: name });
    const count = (assets: number) =>
      page.getByRole('heading', { name: `Media assets (${assets})` });
    await search.fill('fixture');
    await submit.click();
    const still = result('Fixture still.jpg');
    await still.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect
      .poll(() =>
        still
          .locator('img')
          .evaluate((image) => (image as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0);
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(640, 480),
    );
    await page.waitForFunction(() => innerWidth === 640);
    await expect
      .poll(() =>
        page
          .locator('.library-panel')
          .evaluate((panel) => panel.scrollWidth - panel.clientWidth),
      )
      .toBe(0);
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(1080, 720),
    );
    await result('Invalid.png')
      .getByRole('button', { name: 'Add to project' })
      .click();
    await expect(page.getByRole('alert')).toContainText('supported media file');
    expect(await readdir(join(directory, 'online-media'))).toEqual([]);
    await expect(count(0)).toBeVisible();
    await still.getByRole('button', { name: 'Add to project' }).click();
    await expect(count(1)).toBeVisible();
    await still.getByRole('button', { name: 'Add to project' }).click();
    await expect(
      page.getByText('Media is already in the project.'),
    ).toBeVisible();
    await page.getByLabel('Online media type').selectOption('video');
    await submit.click();
    await result('Fixture clip.mp4')
      .getByRole('button', { name: 'Preview', exact: true })
      .click();
    await expect
      .poll(() =>
        result('Fixture clip.mp4')
          .locator('video')
          .evaluate((video) => (video as HTMLVideoElement).videoWidth),
      )
      .toBeGreaterThan(0);
    await result('Fixture clip.mp4')
      .getByRole('button', { name: 'Add to project' })
      .click();
    await expect(count(2)).toBeVisible();
    await page.getByLabel('Online media provider').selectOption('openverse');
    await page.getByLabel('Online media type').selectOption('audio');
    await submit.click();
    const tone = result('Fixture tone');
    await tone.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect
      .poll(() =>
        tone
          .locator('audio')
          .evaluate((audio) => (audio as HTMLAudioElement).readyState),
      )
      .toBeGreaterThan(0);
    await expect(result('Restricted audio')).toHaveCount(0);
    await expect(
      result('Source-only audio').getByRole('button', {
        name: 'Add to project',
      }),
    ).toHaveCount(0);
    await result('Source-only audio')
      .getByRole('button', { name: 'Open source' })
      .click();
    await tone.getByRole('button', { name: 'Add to project' }).click();
    await expect(count(3)).toBeVisible();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(count(2)).toBeVisible();
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect(count(3)).toBeVisible();
    await page
      .getByRole('button', { name: 'Save project', exact: true })
      .click();
    await expect(
      page.getByText('Project saved.', { exact: true }),
    ).toBeVisible();
    const saved = JSON.parse(await readFile(projectPath, 'utf8'));
    const found = (await controlDesktopProject(projectPath, {
      action: 'online-search',
      provider: 'commons',
      query: 'fixture',
      kind: 'image',
    } as unknown as DesktopControlRequest)) as {
      results: { id: string; title: string }[];
    };
    expect(found.results.length).toBeGreaterThan(0);
    const importResult = await controlDesktopProject(projectPath, {
      action: 'online-import',
      id: found.results[0]!.id,
      expectedRevision: saved.editing.revision,
    } as unknown as DesktopControlRequest);
    expect(importResult).toMatchObject({
      revision: saved.editing.revision,
      notice: 'Media is already in the project.',
    });
    expect(
      saved.assets.map((asset: { provenance: unknown }) => asset.provenance),
    ).toEqual([
      {
        provider: 'commons',
        creator: 'Fixture author',
        sourceUrl: 'https://commons.wikimedia.org/wiki/File:Fixture_still.jpg',
        license: 'CC BY 4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
      },
      {
        provider: 'commons',
        creator: 'Fixture author',
        sourceUrl: 'https://commons.wikimedia.org/wiki/File:Fixture_clip.mp4',
        license: 'CC BY 4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
      },
      {
        provider: 'openverse',
        creator: 'Fixture author',
        sourceUrl: 'https://commons.wikimedia.org/wiki/File:Tone.wav',
        license: 'CC BY 4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
      },
    ]);
    expect(await readFile(saved.assets[0].file.path)).toEqual(
      await readFile(jpegPath),
    );
    expect(await readFile(saved.assets[2].file.path)).toEqual(
      await readFile(join(root, names[1]!)),
    );
    await page.getByLabel('Online media provider').selectOption('commons');
    await page.getByLabel('Online media type').selectOption('image');
    await submit.click();
    for (const [index, name] of ['animated.gif', 'animated.png'].entries()) {
      const item = result(name);
      await item.getByRole('button', { name: 'Preview', exact: true }).click();
      await expect
        .poll(() =>
          item
            .locator('img')
            .evaluate((image) => (image as HTMLImageElement).naturalWidth),
        )
        .toBe(32);
      await item.getByRole('button', { name: 'Add to project' }).click();
      await expect(count(4 + index)).toBeVisible();
    }
    const animations = JSON.parse(
      await readFile(projectPath, 'utf8'),
    ).assets.slice(3);
    expect(animations).toMatchObject([
      { name: 'animated.gif', metadata: { kind: 'video', formatName: 'gif' } },
      { name: 'animated.png', metadata: { formatName: 'apng' } },
    ]);
    expect(animations[0].duration.numerator).toBeGreaterThan(0);
    await application.evaluate(() => {
      globalThis.fetch = async () => {
        throw new Error('Offline');
      };
    });
    await page
      .getByRole('button', { name: 'Close project', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Open project', exact: true })
      .click();
    await expect(count(5)).toBeVisible();
    const imported = page
      .locator('.asset-list')
      .getByRole('button', { name: /Fixture tone/ });
    await expect(imported).toHaveAttribute('draggable', 'true');
    await imported.click();
    await expect(page.locator('.asset-credit')).toContainText('CC BY 4.0');
    await expect(page.locator('audio')).toHaveAttribute(
      'src',
      /^opencut:\/\/media\//,
    );
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

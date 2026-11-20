import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { renderVideo } from '@opencut/sdk';
import { launchDesktop } from './helpers.js';
import { assertSimilarExports } from '../integration/conformance-support.js';
import { fixtureDirectory, videoExample } from '../fixture-paths.js';

test('switches music at the same frame, preserves the dialogue draft, and exports the selected mix', async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(fixtureDirectory, 'music-review-'));
  const path = join(directory, 'music.video.ts');
  const output = join(directory, 'selected.mp4');
  const source = `export default {
    canvas: { width: 160, height: 90, frameRate: 30, durationFrames: 30 },
    assets: { tone: { path: '../audio-tone.wav', kind: 'audio' } },
    tracks: [
      { id: 'music-one', name: 'Music One', type: 'audio', audioRole: 'music', clips: [{ asset: 'tone', at: 0, sourceOut: 30, volume: 0.6 }] },
      { id: 'music-two', name: 'Music Two', type: 'audio', audioRole: 'music', clips: [{ asset: 'tone', at: 8, sourceOut: 22, volume: 0.25 }] },
    ],
    musicComparison: { selected: 'music-one', candidates: [{ trackId: 'music-one' }, { trackId: 'music-two', previouslyUsedIn: ['April delivery'] }] },
  };`;
  await writeFile(path, source);
  const { application, page } = await launchDesktop();
  try {
    await application.evaluate(
      ({ dialog }, { path, output }) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [path],
        });
        dialog.showSaveDialog = async () => ({
          canceled: false,
          filePath: output,
        });
      },
      { path, output },
    );
    await page.getByRole('button', { name: 'Open definition' }).click();
    const workspace = page.getByLabel('Definition review');
    const status = workspace.getByRole('status', {
      name: 'Compilation status',
    });
    const movie = workspace.getByLabel('Compiled timeline preview');
    await expect(status).toContainText('Preview ready', { timeout: 25_000 });
    await expect
      .poll(() => movie.evaluate((video: HTMLVideoElement) => video.readyState))
      .toBeGreaterThan(1);
    await movie.evaluate((video: HTMLVideoElement) => {
      video.currentTime = 0.52;
    });
    await expect(workspace.getByLabel('Current frame')).toHaveText(
      'Frame 15 / 29',
    );
    await workspace
      .getByText('Professional Dialogue Mix', { exact: true })
      .click();
    const clarity = workspace.getByRole('slider', { name: 'Voice Clarity' });
    await clarity.press('End');
    await expect(clarity).toHaveValue('1');
    await workspace
      .getByText('Advanced settings and automation', { exact: true })
      .click();
    const advanced = workspace.getByLabel('Advanced mix settings');
    const draft =
      '{"preset":"natural-cinematic","enabled":false,"clarity":0.81}';
    await advanced.fill(draft);
    const previous = await movie.getAttribute('src');
    const candidate = workspace.getByLabel('Music candidate');
    await candidate.selectOption('music-two');
    await expect(candidate).toHaveValue('music-two', { timeout: 25_000 });
    await expect(clarity).toHaveValue('1');
    await expect(advanced).toHaveValue(draft);
    await expect(
      workspace.getByText('Previously delivered in April delivery'),
    ).toBeVisible();
    await expect(movie).not.toHaveAttribute('src', previous!);
    await expect
      .poll(() =>
        movie.evaluate((video: HTMLVideoElement) => video.currentTime),
      )
      .toBeCloseTo(0.52, 4);
    await workspace.getByLabel('Match loudness').click();
    await expect(workspace.getByLabel('Match loudness')).toBeChecked({
      timeout: 25_000,
    });
    await expect(status).toContainText('Preview ready');
    await expect(clarity).toHaveValue('1');
    await expect(advanced).toHaveValue(draft);
    await workspace.getByRole('button', { name: 'Export MP4' }).click();
    await expect(workspace.getByLabel('Export result')).toContainText(
      'selected.mp4',
      { timeout: 25_000 },
    );
    const direct = join(directory, 'expected.mp4');
    await renderVideo(path, direct, {
      musicSelection: { candidate: 'music-two', matchLoudness: true },
    });
    await assertSimilarExports(output, direct, {
      width: 160,
      height: 90,
      frameCount: 30,
      fps: 30,
    });
    await writeFile(
      path,
      source.replace(
        'export default {',
        'export default { professionalMix: { preset: "natural-cinematic", enabled: false, clarity: 0.33 },',
      ),
    );
    await expect(clarity).toHaveValue('0.33', { timeout: 25_000 });
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('reviews consecutive definition builds and keeps the last playable revision on error', async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(fixtureDirectory, 't46-desktop-'));
  const path = join(directory, 'review.video.ts');
  const helper = join(directory, 'review-title.ts');
  const source = (await readFile('examples/video/review.video.ts', 'utf8'))
    .replace('../../tests/fixtures/generated', '..')
    .replace(
      'start: { numerator: 3, denominator: 4 }',
      'start: { numerator: 19, denominator: 25 }',
    );
  await copyFile('examples/video/review-title.ts', helper);
  await writeFile(path, source);
  const { application, page } = await launchDesktop();
  try {
    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      });
    }, path);
    await expect(
      page.getByRole('button', { name: 'Open a project' }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: 'Open definition' }).click();
    const workspace = page.getByLabel('Definition review');
    const status = workspace.getByRole('status', {
      name: 'Compilation status',
    });
    await expect(status).toContainText('Preview ready', { timeout: 25_000 });
    const movie = workspace.getByLabel('Compiled timeline preview');
    async function expectPlaybackAt(frame: number, totalFrames = 48, fps = 24) {
      await expect(workspace.getByLabel('Current frame')).toHaveText(
        `Frame ${frame} / ${totalFrames - 1}`,
        { timeout: 25_000 },
      );
      await expect
        .poll(() =>
          movie.evaluate(
            (video: HTMLVideoElement, fps) =>
              Math.floor(video.currentTime * fps),
            fps,
          ),
        )
        .toBe(frame);
    }
    const initialURL = await movie.getAttribute('src');
    await expect
      .poll(() => movie.evaluate((video: HTMLVideoElement) => video.readyState))
      .toBeGreaterThan(1);
    await movie.evaluate(async (video: HTMLVideoElement) => video.play());
    await expect
      .poll(() =>
        movie.evaluate((video: HTMLVideoElement) => video.currentTime),
      )
      .toBeGreaterThan(0.1);
    await movie.evaluate((video: HTMLVideoElement) => {
      video.pause();
      video.currentTime = 0;
    });
    await expectPlaybackAt(0);
    await workspace.getByRole('button', { name: 'Next frame' }).click();
    await expectPlaybackAt(1);
    await expect(
      workspace.getByRole('button', { name: 'Inspect clip first' }),
    ).toBeVisible();

    await workspace
      .getByRole('button', { name: 'Inspect clip second' })
      .click();
    await expectPlaybackAt(24);
    await workspace
      .getByRole('button', { name: 'Cross-dissolve, 8 frames' })
      .click();
    await expectPlaybackAt(20);
    await workspace.getByLabel('Scrollable timeline').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const subtitle = workspace.getByRole('button', {
      name: 'Inspect subtitle caption',
    });
    await subtitle.press('Enter');
    await expectPlaybackAt(19);

    await writeFile(path, 'export default {');
    await expect(workspace.getByRole('alert')).toContainText('Cannot load');
    await expect(status).toContainText('Showing last valid revision');
    await expect(movie).toHaveAttribute('src', initialURL!);
    await expect(
      workspace.getByRole('heading', { name: 'OpenCut review' }),
    ).toBeVisible();

    await writeFile(
      path,
      source.replace('name: title', "name: 'Obsolete'") +
        '\nawait new Promise((done) => setTimeout(done, 1500));\n',
    );
    await expect(status).toContainText('Compiling');
    await writeFile(
      path,
      source.replace('name: title', "name: title + ' edited'"),
    );
    await expect(
      workspace.getByRole('heading', { name: 'OpenCut review edited' }),
    ).toBeVisible({ timeout: 25_000 });
    await expect(movie).toHaveAttribute('src', initialURL!);
    const secondURL = await movie.getAttribute('src');
    await writeFile(helper, "export const title = 'Helper changed';\n");
    await expect(
      workspace.getByRole('heading', { name: 'Helper changed edited' }),
    ).toBeVisible({ timeout: 25_000 });
    await expect(movie).not.toHaveAttribute('src', secondURL!);
    await expectPlaybackAt(19);
    const output = join(directory, 'review.mp4');
    await application.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    }, output);
    await workspace.getByRole('button', { name: 'Export MP4' }).click();
    await expect(workspace.getByLabel('Export result')).toContainText(
      'review.mp4',
    );
    const direct = join(directory, 'foreground.mp4');
    await renderVideo(path, direct);
    await assertSimilarExports(output, direct, {
      width: 320,
      height: 180,
      frameCount: 48,
      fps: 24,
    });
    await workspace.getByRole('button', { name: 'Export MP4' }).click();
    await expect(workspace.getByRole('alert')).toContainText(
      'Refusing to overwrite',
    );
    await movie.evaluate((video: HTMLVideoElement) => {
      video.currentTime = 1.75;
    });
    await expectPlaybackAt(42);
    function revisionAtRate(frameRate: number, durationFrames: number) {
      return `export default {
        name: 'Revision at ${frameRate} fps',
        canvas: { width: 320, height: 180, frameRate: ${frameRate}, durationFrames: ${durationFrames} },
        tracks: [{ type: 'text', clips: [{ at: 0, duration: ${durationFrames}, text: { content: 'End' } }] }]
      };`;
    }
    await writeFile(path, revisionAtRate(30, 60));
    await expectPlaybackAt(52, 60, 30);
    await expect
      .poll(() =>
        movie.evaluate((video: HTMLVideoElement) => video.currentTime),
      )
      .toBeCloseTo(1.75, 5);

    await writeFile(path, revisionAtRate(24, 48));
    await expectPlaybackAt(42);

    await writeFile(path, revisionAtRate(30, 6));
    await expectPlaybackAt(5, 6, 30);
    await workspace.getByRole('button', { name: 'Close definition' }).click();
    await expect(page.getByLabel('Review workspace')).toBeVisible();
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('seeks to a timeline selection made while preview metadata loads', async () => {
  const { application, page } = await launchDesktop();
  try {
    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      });
    }, videoExample('review.video.ts'));
    await page.evaluate(() => {
      // Defer metadata fetching until the timeline selection has happened.
      const original = HTMLVideoElement.prototype.setAttribute;
      HTMLVideoElement.prototype.setAttribute = function (name, value) {
        original.call(this, name, name === 'preload' ? 'none' : value);
      };
    });
    await page.getByRole('button', { name: 'Open definition' }).click();
    const workspace = page.getByLabel('Definition review');
    const movie = workspace.getByLabel('Compiled timeline preview');
    await expect(movie).toHaveAttribute('preload', 'none');
    await expect(workspace.getByLabel('Current frame')).toHaveText(
      'Frame 0 / 47',
    );
    await workspace
      .getByRole('button', { name: 'Inspect clip second' })
      .click();
    await movie.evaluate((video: HTMLVideoElement) => {
      if (video.readyState !== HTMLMediaElement.HAVE_NOTHING) {
        throw new Error(
          'Expected metadata to remain deferred during the selection',
        );
      }
      video.preload = 'auto';
      video.load();
    });
    await expect
      .poll(() =>
        movie.evaluate((video: HTMLVideoElement) =>
          Math.floor(video.currentTime * 24),
        ),
      )
      .toBe(24);
    await expect(workspace.getByLabel('Current frame')).toHaveText(
      'Frame 24 / 47',
    );
  } finally {
    await application.close();
  }
});

test('previews and exports a recipe-backed definition', async () => {
  const directory = await mkdtemp(join(fixtureDirectory, 't48-desktop-'));
  const path = videoExample('recipes.video.ts');
  const output = join(directory, 'desktop.mp4');
  const { application, page } = await launchDesktop({
    XDG_CACHE_HOME: directory,
  });
  try {
    await application.evaluate(
      ({ dialog }, { path, output }) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [path],
        });
        dialog.showSaveDialog = async () => ({
          canceled: false,
          filePath: output,
        });
      },
      { path, output },
    );
    await page.getByRole('button', { name: 'Open definition' }).click();
    const workspace = page.getByLabel('Definition review');
    await expect(
      workspace.getByRole('status', { name: 'Compilation status' }),
    ).toContainText('Preview ready', { timeout: 20_000 });
    await expect(workspace.getByLabel('Current frame')).toHaveText(
      'Frame 0 / 23',
    );
    await workspace.getByRole('button', { name: 'Export MP4' }).click();
    await expect(workspace.getByLabel('Export result')).toContainText(
      'desktop.mp4',
    );
    const direct = join(directory, 'foreground.mp4');
    await renderVideo(path, direct, {
      processing: { cacheDirectory: join(directory, 'opencut', 'recipes-v1') },
    });
    await assertSimilarExports(output, direct, {
      width: 160,
      height: 90,
      frameCount: 24,
      fps: 24,
    });
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('imports dialogue and music, compares the processed mix and exports through desktop', async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(fixtureDirectory, 'desktop-mix-'));
  const definition = join(directory, 'Desk mix.video.ts');
  const output = join(directory, 'desktop.mp4');
  const settings = join(directory, 'mix.json');
  const source = join(fixtureDirectory, 'audio-tone.wav');
  const { application, page } = await launchDesktop();
  try {
    await application.evaluate(
      ({ dialog }, args) => {
        dialog.showOpenDialog = async (...call: unknown[]) => {
          const title =
            (call.at(-1) as { title?: string } | undefined)?.title ?? '';
          return title.startsWith('Choose dialogue') ||
            title.startsWith('Choose background')
            ? { canceled: false, filePaths: [args.source] }
            : { canceled: true, filePaths: [] };
        };
        dialog.showSaveDialog = async (...call: unknown[]) => {
          const title = (call.at(-1) as { title?: string } | undefined)?.title;
          return {
            canceled: false,
            filePath:
              title === 'Save dialogue mix definition'
                ? args.definition
                : title === 'Save mix settings'
                  ? args.settings
                  : args.output,
          };
        };
      },
      { source, definition, output, settings },
    );
    await page.getByRole('button', { name: 'Create dialogue mix' }).click();
    const workspace = page.getByLabel('Definition review');
    const status = workspace.getByRole('status', {
      name: 'Compilation status',
    });
    await expect(status).toContainText('Preview ready', { timeout: 30_000 });
    await workspace
      .getByText('Professional Dialogue Mix', { exact: true })
      .click();
    const panel = workspace.getByLabel('Dialogue mix settings');
    await expect(panel.getByLabel('Dialogue audio role')).toHaveValue(
      'dialogue',
    );
    await expect(panel.getByLabel('Music audio role')).toHaveValue('music');
    await panel.getByLabel('Preset').selectOption('clear-voiceover');
    await panel.getByRole('button', { name: 'Apply to preview' }).click();
    await expect(status).toContainText('Revision 2', { timeout: 30_000 });
    await expect(panel.getByLabel('Preset')).toHaveValue('clear-voiceover');
    await expect(panel.getByLabel('Mix loudness')).toContainText('After');
    await panel.getByLabel('Preset').selectOption('natural-cinematic');
    await panel.getByLabel('Enable mix').uncheck();
    await panel.getByRole('button', { name: 'Compare before' }).click();
    await expect(panel.getByLabel('Mix loudness')).toContainText(
      'Before (level matched)',
      { timeout: 30_000 },
    );
    await expect(panel.getByLabel('Preset')).toHaveValue('natural-cinematic');
    await expect(panel.getByLabel('Enable mix')).not.toBeChecked();
    await panel.getByRole('button', { name: 'Save mix settings' }).click();
    await expect(panel.getByText(/^Saved /)).toContainText('mix.json');
    const { mix, roles } = JSON.parse(await readFile(settings, 'utf8')) as {
      mix: { preset: string; enabled: boolean };
      roles: Record<string, string>;
    };
    expect(mix).toMatchObject({ preset: 'natural-cinematic', enabled: false });
    expect(roles).toEqual({ dialogue: 'dialogue', music: 'music' });
    await workspace.getByRole('button', { name: 'Export MP4' }).click();
    await expect(workspace.getByLabel('Export result')).toContainText(
      'desktop.mp4',
      { timeout: 30_000 },
    );
    const direct = await renderVideo(definition, join(directory, 'sdk.mp4'), {
      audioMixEdit: {
        mix: { preset: 'clear-voiceover' },
        roles: { dialogue: 'dialogue', music: 'music' },
      },
    });
    await assertSimilarExports(output, direct.path, {
      width: direct.width,
      height: direct.height,
      frameCount: direct.frameCount,
      fps: 30,
    });
  } finally {
    await application.close();
    await rm(directory, { force: true, recursive: true });
  }
});

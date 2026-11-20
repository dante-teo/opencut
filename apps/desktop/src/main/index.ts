import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  nativeTheme,
  nativeImage,
  net,
  protocol,
  session,
} from 'electron';
import iconPath from '../../resources/opencut-icon.png?asset';
import { randomUUID } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getApplicationInfo } from '@opencut/core';
import {
  isVideoDefinitionPath,
  musicSelectionSchema,
  renderCompiledVideo,
  videoMixEditSchema,
} from '@opencut/core/video';
import { probeMedia } from '@opencut/media';
import type { IpcMainInvokeEvent } from 'electron';
import { DefinitionReviewSession } from './definition-review.js';
import {
  APP_INFO_CHANNEL,
  DEFINITION_CHANNELS,
  OPEN_PREVIEW_CHANNEL,
  PREVIEW_METRICS_CHANNEL,
  RELEASE_PREVIEW_CHANNEL,
  type DefinitionExportResult,
  type PreviewSource,
} from '../bridge.js';
import { createDialogueMixDefinition } from './create-dialogue-mix.js';
import { servePreviewFile } from './preview-file.js';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'opencut',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

const directory = fileURLToPath(new URL('.', import.meta.url));
const rendererRoot = resolve(directory, '../renderer');
const devURL = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;
if (app.isPackaged && process.platform === 'darwin') {
  // Finder launches with a system PATH that omits Homebrew's ARM prefix.
  process.env.PATH = [process.env.PATH, '/opt/homebrew/bin']
    .filter(Boolean)
    .join(':');
}
const backgroundTest =
  !app.isPackaged && process.env.OPENCUT_DESKTOP_TEST_BACKGROUND === '1';
if (backgroundTest && process.platform === 'darwin') {
  app.setActivationPolicy('accessory');
}
if (devURL && new URL(devURL).origin !== 'http://127.0.0.1:5173') {
  throw new Error('Refusing unexpected renderer development origin.');
}
const rendererURL = new URL(devURL ?? 'opencut://app/index.html').href;
let mainWindow: BrowserWindow | null = null;
const definitionReview = new DefinitionReviewSession((state) => {
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send(DEFINITION_CHANNELS.changed, state);
});
let selectingDefinition = false;
let definitionExport: AbortController | undefined;
let previewFile: { url: string; path: string } | null = null;
let openingPreview = false;

function assertSender(event: IpcMainInvokeEvent): void {
  if (
    event.sender !== mainWindow?.webContents ||
    event.senderFrame !== event.sender.mainFrame ||
    event.senderFrame.url !== rendererURL
  ) {
    throw new Error('Untrusted IPC sender.');
  }
}

async function openPreview(
  event: IpcMainInvokeEvent,
): Promise<PreviewSource | null> {
  assertSender(event);
  const window = mainWindow;
  if (!window || openingPreview || selectingDefinition || definitionExport)
    return null;
  openingPreview = true;
  try {
    const selection = await dialog.showOpenDialog(window, {
      title: 'Open video preview',
      properties: ['openFile'],
      filters: [
        { name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv'] },
      ],
    });
    const path = selection.filePaths[0];
    if (selection.canceled || !path) return null;
    if (!(await stat(path)).isFile())
      throw new Error('Select a local video file.');
    let frameRate: number | null = null;
    let videoEndSeconds: number | null = null;
    let width: number | null = null;
    let height: number | null = null;
    let warning: string | null = null;
    try {
      const metadata = await probeMedia(path);
      if (
        !metadata.video ||
        metadata.durationSeconds === null ||
        metadata.durationSeconds <= 0
      ) {
        warning = 'No timed video detected. Browser decoding may fail.';
      } else {
        frameRate = metadata.video.frameRate;
        const video = metadata.video;
        if (
          video.durationSeconds !== null &&
          video.startTimeSeconds !== null &&
          metadata.startTimeSeconds !== null
        ) {
          videoEndSeconds =
            video.startTimeSeconds -
            metadata.startTimeSeconds +
            video.durationSeconds;
        }
        width = metadata.video.width;
        height = metadata.video.height;
      }
    } catch {
      warning =
        'Metadata unavailable (ffprobe is optional). Playback can still work; no source frame rate is available.';
    }
    // Revalidate after the native dialog/probe, including a window closing/reopening.
    assertSender(event);
    const url = `opencut://media/${randomUUID()}`;
    previewFile = { url, path };
    return {
      url,
      name: basename(path),
      frameRate,
      videoEndSeconds,
      width,
      height,
      warning,
    };
  } finally {
    openingPreview = false;
  }
}

function getWindowBackgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? '#111015' : '#f3f2f7';
}

function handleStartupError(error: unknown): void {
  console.error('Unable to start OpenCut:', error);
  app.exit(1);
}

async function createWindow(): Promise<void> {
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) throw new Error('Unable to load the OpenCut app icon.');
  app.dock?.setIcon(icon);
  const window = new BrowserWindow({
    title: 'OpenCut',
    icon,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    width: 1080,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    show: !backgroundTest,
    focusable: !backgroundTest,
    backgroundColor: getWindowBackgroundColor(),
    webPreferences: {
      preload: join(directory, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      // Keep animation and playback clocks running in hidden test windows.
      backgroundThrottling: !backgroundTest,
    },
  });
  if (backgroundTest) window.webContents.setAudioMuted(true);
  mainWindow = window;
  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null;
      definitionExport?.abort();
      void definitionReview.close().catch(console.error);
      previewFile = null;
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) =>
    event.preventDefault(),
  );
  await window.loadURL(rendererURL);
}

// Do not top-level await app.whenReady(): Electron waits for ESM entry evaluation.
app
  .whenReady()
  .then(async () => {
    nativeTheme.themeSource = 'system';
    nativeTheme.on('updated', () => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.setBackgroundColor(getWindowBackgroundColor());
      }
    });
    session.defaultSession.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    session.defaultSession.setPermissionCheckHandler(() => false);
    protocol.handle('opencut', async (request) => {
      try {
        const url = new URL(request.url);
        if (url.host === 'media') {
          const path =
            request.url === previewFile?.url
              ? previewFile.path
              : definitionReview.resolveMedia(request.url);
          if (request.method !== 'GET' || !path)
            return new Response(null, { status: 403 });
          return await servePreviewFile(path, request);
        }
        if (url.host !== 'app' || request.method !== 'GET')
          return new Response(null, { status: 403 });
        const file = resolve(
          rendererRoot,
          decodeURIComponent(url.pathname).slice(1) || 'index.html',
        );
        const local = relative(rendererRoot, file);
        if (local.startsWith('..') || isAbsolute(local))
          return new Response(null, { status: 403 });
        return await net.fetch(pathToFileURL(file).href);
      } catch {
        return new Response(null, { status: 404 });
      }
    });
    ipcMain.handle(APP_INFO_CHANNEL, (event) => {
      assertSender(event);
      return getApplicationInfo();
    });
    ipcMain.handle(
      DEFINITION_CHANNELS.open,
      async (event, ...args: unknown[]) => {
        assertSender(event);
        if (args.length) throw new Error('Unexpected definition arguments.');
        if (
          selectingDefinition ||
          openingPreview ||
          definitionExport ||
          !mainWindow
        )
          return;
        selectingDefinition = true;
        try {
          const { canceled, filePaths } = await dialog.showOpenDialog(
            mainWindow,
            {
              title: 'Review a video definition',
              message:
                'Only open trusted local TypeScript. OpenCut executes the selected script and its imports on every rebuild.',
              properties: ['openFile'],
              filters: [{ name: 'Video definitions', extensions: ['ts'] }],
            },
          );
          assertSender(event);
          if (canceled) return;
          const [path] = filePaths;
          if (!path || !isVideoDefinitionPath(path))
            throw new Error('Choose a .video.ts file.');
          previewFile = null;
          definitionReview.open(path);
        } finally {
          selectingDefinition = false;
        }
      },
    );
    ipcMain.handle(
      DEFINITION_CHANNELS.createMix,
      async (event, ...args: unknown[]) => {
        assertSender(event);
        if (args.length) throw new Error('Unexpected mix arguments.');
        if (
          !mainWindow ||
          selectingDefinition ||
          openingPreview ||
          definitionExport
        )
          return;
        const window = mainWindow;
        selectingDefinition = true;
        const pickAudio = (title: string) =>
          dialog.showOpenDialog(window, {
            title,
            properties: ['openFile', 'multiSelections'],
            filters: [
              {
                name: 'Audio',
                extensions: [
                  'wav',
                  'flac',
                  'm4a',
                  'mp3',
                  'aac',
                  'aiff',
                  'ogg',
                  'opus',
                  'mp4',
                  'mov',
                ],
              },
            ],
          });
        try {
          const { filePaths: voice, canceled } = await pickAudio(
            'Choose dialogue recordings',
          );
          assertSender(event);
          if (canceled || !voice.length) return;
          const { filePaths: music } = await pickAudio(
            'Choose background music (Cancel to skip)',
          );
          assertSender(event);
          const { filePaths: picture } = await dialog.showOpenDialog(window, {
            title: 'Choose video picture (Cancel to skip)',
            properties: ['openFile'],
            filters: [
              { name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'webm'] },
            ],
          });
          assertSender(event);
          const destination = await dialog.showSaveDialog(window, {
            title: 'Save dialogue mix definition',
            defaultPath: 'Dialogue Mix.video.ts',
            filters: [{ name: 'Video definitions', extensions: ['ts'] }],
          });
          assertSender(event);
          if (destination.canceled || !destination.filePath) return;
          if (!isVideoDefinitionPath(destination.filePath))
            throw new Error('Choose a new .video.ts filename.');
          await createDialogueMixDefinition(
            destination.filePath,
            voice,
            music,
            picture[0],
          );
          assertSender(event);
          previewFile = null;
          definitionReview.open(destination.filePath);
        } finally {
          selectingDefinition = false;
        }
      },
    );
    ipcMain.handle(
      DEFINITION_CHANNELS.applyMix,
      async (event, ...args: unknown[]) => {
        assertSender(event);
        const [generation, edit] = args;
        if (
          args.length !== 2 ||
          typeof generation !== 'number' ||
          !Number.isSafeInteger(generation) ||
          generation < 1
        )
          throw new Error('Expected a preview generation and mix settings.');
        if (selectingDefinition || definitionExport)
          throw new Error('Another review action is in progress.');
        await definitionReview.applyMix(
          generation,
          edit === null ? null : videoMixEditSchema.parse(edit),
        );
      },
    );
    ipcMain.handle(
      DEFINITION_CHANNELS.compareMix,
      async (event, ...args: unknown[]) => {
        assertSender(event);
        const [generation, comparison] = args;
        if (
          args.length !== 2 ||
          typeof generation !== 'number' ||
          !Number.isSafeInteger(generation) ||
          generation < 1 ||
          (comparison !== 'after' && comparison !== 'before')
        )
          throw new Error('Expected a preview generation and comparison mode.');
        if (selectingDefinition || definitionExport)
          throw new Error('Another review action is in progress.');
        await definitionReview.compareMix(generation, comparison);
      },
    );
    ipcMain.handle(
      DEFINITION_CHANNELS.selectMusic,
      async (event, ...args: unknown[]) => {
        assertSender(event);
        const [generation, selection] = args;
        if (
          args.length !== 2 ||
          typeof generation !== 'number' ||
          !Number.isSafeInteger(generation) ||
          generation < 1
        )
          throw new Error('Expected a preview generation and music selection.');
        if (selectingDefinition || definitionExport)
          throw new Error('Another review action is in progress.');
        await definitionReview.selectMusic(
          generation,
          musicSelectionSchema.parse(selection),
        );
      },
    );
    ipcMain.handle(
      DEFINITION_CHANNELS.saveMix,
      async (event, ...args: unknown[]) => {
        assertSender(event);
        if (args.length !== 1)
          throw new Error('Expected one set of mix settings.');
        const edit = videoMixEditSchema.parse(args[0]);
        if (!mainWindow || selectingDefinition || definitionExport) return null;
        selectingDefinition = true;
        try {
          const destination = await dialog.showSaveDialog(mainWindow, {
            title: 'Save mix settings',
            defaultPath: 'mix.json',
            filters: [{ name: 'Mix settings', extensions: ['json'] }],
          });
          assertSender(event);
          if (destination.canceled || !destination.filePath) return null;
          if (!destination.filePath.toLowerCase().endsWith('.json'))
            throw new Error('Choose a new .json filename.');
          await writeFile(
            destination.filePath,
            JSON.stringify(edit, null, 2) + '\n',
            { flag: 'wx' },
          );
          return destination.filePath;
        } finally {
          selectingDefinition = false;
        }
      },
    );
    ipcMain.handle(
      DEFINITION_CHANNELS.loadMix,
      async (event, ...args: unknown[]) => {
        assertSender(event);
        if (args.length) throw new Error('Unexpected mix arguments.');
        if (!mainWindow || selectingDefinition || definitionExport) return null;
        selectingDefinition = true;
        try {
          const result = await dialog.showOpenDialog(mainWindow, {
            title: 'Open mix settings',
            properties: ['openFile'],
            filters: [{ name: 'Mix settings', extensions: ['json'] }],
          });
          assertSender(event);
          const [path] = result.filePaths;
          if (result.canceled || !path) return null;
          const file = await stat(path);
          if (!file.isFile() || file.size > 16 * 1024 * 1024)
            throw new Error('Choose a mix JSON file smaller than 16 MiB.');
          return videoMixEditSchema.parse(
            JSON.parse(await readFile(path, 'utf8')),
          );
        } finally {
          selectingDefinition = false;
        }
      },
    );
    ipcMain.handle(DEFINITION_CHANNELS.close, (event, ...args: unknown[]) => {
      assertSender(event);
      if (args.length) throw new Error('Unexpected definition arguments.');
      if (definitionExport)
        throw new Error('Cancel the export before closing the definition.');
      return definitionReview.close();
    });
    ipcMain.handle(
      DEFINITION_CHANNELS.export,
      async (event, ...args: unknown[]) => {
        assertSender(event);
        const [generation] = args;
        if (
          args.length !== 1 ||
          typeof generation !== 'number' ||
          !Number.isSafeInteger(generation) ||
          generation < 1
        )
          throw new Error('Expected one preview generation.');
        if (!mainWindow || selectingDefinition || definitionExport)
          throw new Error('Another review action is in progress.');
        const window = mainWindow;
        const controller = new AbortController();
        definitionExport = controller;
        try {
          const { canceled, filePath } = await dialog.showSaveDialog(window, {
            title: 'Export video',
            defaultPath: 'Export.mp4',
            filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
          });
          if (canceled || !filePath || controller.signal.aborted)
            return { status: 'cancelled' };
          assertSender(event);
          if (!filePath.toLowerCase().endsWith('.mp4'))
            throw new Error('Choose an MP4 output path.');
          // Only pin snapshots for actual renders. A pending native dialog
          // must not keep watcher shutdown waiting.
          return await definitionReview.exportRevision(
            generation,
            async (video): Promise<DefinitionExportResult> => {
              try {
                const result = await renderCompiledVideo(video, filePath, {
                  signal: controller.signal,
                  onProgress: ({ percent }) => {
                    if (!window.isDestroyed())
                      window.webContents.send(
                        DEFINITION_CHANNELS.progress,
                        percent,
                      );
                  },
                });
                return { status: 'saved', path: result.path };
              } catch (error) {
                if (controller.signal.aborted) return { status: 'cancelled' };
                throw error;
              }
            },
          );
        } finally {
          definitionExport = undefined;
        }
      },
    );
    ipcMain.handle(
      DEFINITION_CHANNELS.cancelExport,
      (event, ...args: unknown[]) => {
        assertSender(event);
        if (args.length) throw new Error('Unexpected definition arguments.');
        definitionExport?.abort();
      },
    );
    ipcMain.handle(OPEN_PREVIEW_CHANNEL, openPreview);
    ipcMain.handle(RELEASE_PREVIEW_CHANNEL, (event, ...args: unknown[]) => {
      assertSender(event);
      if (args.length !== 1 || typeof args[0] !== 'string')
        throw new Error('Expected one preview URL.');
      if (previewFile?.url === args[0]) previewFile = null;
    });
    ipcMain.handle(PREVIEW_METRICS_CHANNEL, (event) => {
      assertSender(event);
      const metrics = app.getAppMetrics();
      return {
        cpuPercent: metrics.reduce(
          (sum, metric) => sum + metric.cpu.percentCPUUsage,
          0,
        ),
        workingSetMiB:
          metrics.reduce(
            (sum, metric) => sum + metric.memory.workingSetSize,
            0,
          ) / 1024,
        processCount: metrics.length,
      };
    });
    await createWindow();
  })
  .catch(handleStartupError);
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow().catch(handleStartupError);
  }
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let quitting = false;
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  definitionExport?.abort();
  void definitionReview
    .close()
    .catch(console.error)
    .finally(() => {
      quitting = true;
      app.quit();
    });
});

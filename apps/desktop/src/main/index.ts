import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  nativeTheme,
  net,
  protocol,
  session,
} from 'electron';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getApplicationInfo } from '@opencut/core';
import { probeMedia } from '@opencut/media';
import {
  APP_INFO_CHANNEL,
  PROJECT_CHANNELS,
  OPEN_PREVIEW_CHANNEL,
  PREVIEW_METRICS_CHANNEL,
  ASSET_PREVIEW_CHANNEL,
  RELEASE_PREVIEW_CHANNEL,
  type PreviewSource,
} from '../bridge.js';
import type { IpcMainInvokeEvent } from 'electron';
import { servePreviewFile } from './preview-file.js';
import { ProjectSession, type ProjectAction } from './project-session.js';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'opencut',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

const directory = fileURLToPath(new URL('.', import.meta.url));
const rendererRoot = resolve(directory, '../renderer');
const devURL = process.env.ELECTRON_RENDERER_URL;
if (devURL && new URL(devURL).origin !== 'http://127.0.0.1:5173') {
  throw new Error('Refusing unexpected renderer development origin.');
}
const rendererURL = new URL(devURL ?? 'opencut://app/index.html').href;
let mainWindow: BrowserWindow | null = null;
let previewFile: { url: string; path: string } | null = null;
let openingPreview = false;
let closingProject = false;
let previewGeneration = 0;
const projectSession = new ProjectSession({
  async open() {
    const window = mainWindow;
    if (!window) throw new Error('No project window is available.');
    const selection = await dialog.showOpenDialog(window, {
      title: 'Open project',
      properties: ['openFile'],
      filters: [{ name: 'OpenCut project', extensions: ['json'] }],
    });
    return selection.canceled ? null : (selection.filePaths[0] ?? null);
  },
  async save() {
    const window = mainWindow;
    if (!window) throw new Error('No project window is available.');
    const selection = await dialog.showSaveDialog(window, {
      title: 'Save new project',
      defaultPath: 'Untitled.opencut.json',
      filters: [{ name: 'OpenCut project', extensions: ['json'] }],
      buttonLabel: 'Save new file',
    });
    return selection.canceled ? null : (selection.filePath ?? null);
  },
  async unsaved() {
    const window = mainWindow;
    if (!window) return 'cancel';
    const { response } = await dialog.showMessageBox(window, {
      type: 'warning',
      message: 'Save your unsaved project?',
      detail: 'Save before continuing, or discard the unsaved project.',
      buttons: ['Save', 'Discard', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    return response === 0 ? 'save' : response === 1 ? 'discard' : 'cancel';
  },
});

async function closeProjectWindow(
  window: BrowserWindow,
  quit: boolean,
): Promise<void> {
  if (closingProject) return;
  closingProject = true;
  try {
    const reply = await projectSession.run('close');
    if (!reply.ok) {
      await dialog.showMessageBox(window, {
        type: 'error',
        message: 'Unable to close project',
        detail: reply.error,
      });
      return;
    }
    if (reply.canceled) return;
    if (quit) app.quit();
    else window.close();
  } finally {
    closingProject = false;
  }
}

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
  if (!window || openingPreview) return null;
  openingPreview = true;
  const generation = ++previewGeneration;
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
    if (generation !== previewGeneration)
      throw new Error(
        'Project changed while opening the preview. Open the video again.',
      );
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
  return nativeTheme.shouldUseDarkColors ? '#101416' : '#f6f8f7';
}

function handleStartupError(error: unknown): void {
  console.error('Unable to start OpenCut:', error);
  app.exit(1);
}

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    title: 'OpenCut',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    width: 1080,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: getWindowBackgroundColor(),
    webPreferences: {
      preload: join(directory, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  });
  mainWindow = window;
  window.on('close', (event) => {
    if (projectSession.needsCloseGuard) {
      event.preventDefault();
      void closeProjectWindow(window, false);
    } else {
      // Closing a clean window clears the session before macOS activation reopens it.
      void projectSession.run('close');
    }
  });
  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null;
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
          if (request.method !== 'GET' || request.url !== previewFile?.url)
            return new Response(null, { status: 403 });
          return await servePreviewFile(previewFile.path, request);
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
    for (const [action, channel] of Object.entries(PROJECT_CHANNELS)) {
      ipcMain.handle(channel, async (event, ...args: unknown[]) => {
        assertSender(event);
        if (
          args.length !==
          (['create', 'edit', 'undo', 'redo'].includes(action) ? 1 : 0)
        )
          return { ok: false, error: 'Invalid project request arguments.' };
        const reply = await projectSession.run(
          action as ProjectAction,
          args[0],
        );
        assertSender(event);
        if (
          reply.ok &&
          !reply.canceled &&
          ['create', 'open', 'close'].includes(action)
        ) {
          previewGeneration++;
          previewFile = null;
        }
        return reply;
      });
    }
    ipcMain.handle(OPEN_PREVIEW_CHANNEL, openPreview);
    ipcMain.handle(ASSET_PREVIEW_CHANNEL, async (event, ...args: unknown[]) => {
      assertSender(event);
      if (args.length !== 1) throw new Error('Expected one video asset ID.');
      const generation = ++previewGeneration;
      const { asset, path } = await projectSession.previewAsset(args[0]);
      assertSender(event);
      if (generation !== previewGeneration)
        throw new Error('Preview selection changed.');
      const url = `opencut://media/${randomUUID()}`;
      previewFile = { url, path };
      return {
        url,
        name: asset.name,
        frameRate: asset.metadata?.frameRate ?? null,
        videoEndSeconds: null,
        width: asset.metadata?.width ?? null,
        height: asset.metadata?.height ?? null,
        warning: null,
      } satisfies PreviewSource;
    });
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

app.on('before-quit', (event) => {
  if (mainWindow && projectSession.needsCloseGuard) {
    event.preventDefault();
    void closeProjectWindow(mainWindow, true);
  }
});

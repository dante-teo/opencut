import {
  app,
  BrowserWindow,
  ipcMain,
  nativeTheme,
  net,
  protocol,
  session,
} from 'electron';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getApplicationInfo } from '@opencut/core';
import { APP_INFO_CHANNEL } from '../bridge.js';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'opencut',
    privileges: { standard: true, secure: true, supportFetchAPI: true },
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
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
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
      if (
        event.sender !== mainWindow?.webContents ||
        event.senderFrame !== event.sender.mainFrame ||
        event.senderFrame.url !== rendererURL
      ) {
        throw new Error('Untrusted IPC sender.');
      }
      return getApplicationInfo();
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

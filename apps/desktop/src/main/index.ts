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
import { stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getApplicationInfo, projectRevision } from '@opencut/core';
import { isVideoDefinitionPath, renderPreviewCache } from '@opencut/core/node';
import { WAVEFORM_CHUNK_SECONDS } from '@opencut/shared';
import {
  probeMedia,
  demandingMedia,
  validateCacheLimits,
  type ProxyResult,
} from '@opencut/media';
import { ExportSession } from './export-session.js';
import { MediaClient } from './media-client.js';
import { DefinitionReviewSession } from './definition-review.js';
import {
  APP_INFO_CHANNEL,
  DEFINITION_CHANNELS,
  EXPORT_CHANNELS,
  EXPORT_CHANGED_CHANNEL,
  PROJECT_CHANGED_CHANNEL,
  THUMBNAIL_CHANNEL,
  PROJECT_CHANNELS,
  OPEN_PREVIEW_CHANNEL,
  PREVIEW_METRICS_CHANNEL,
  ASSET_PREVIEW_CHANNEL,
  RELEASE_PREVIEW_CHANNEL,
  TIMELINE_PREVIEW_CHANNEL,
  MEDIA_CACHE_CHANNEL,
  TIMELINE_FRAME_CHANNEL,
  TIMELINE_RENDER_CHANNEL,
  DESKTOP_CONTROL_CHANNEL,
  DESKTOP_CONTROL_REPLY,
  TIMELINE_TEXT_CHANNEL,
  TIMELINE_ARTWORK_CHANNEL,
  CANCEL_TIMELINE_ARTWORK_CHANNEL,
  type TimelineArtworkResult,
  type TimelineTextImage,
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
      corsEnabled: true,
      stream: true,
    },
  },
]);

const directory = fileURLToPath(new URL('.', import.meta.url));
const rendererRoot = resolve(directory, '../renderer');
const devURL = process.env.ELECTRON_RENDERER_URL;
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
let mediaClient: MediaClient | null = null;
let previewFile: { url: string; path: string } | null = null;
const timelineFiles = new Map<string, string>();
let timelineRender: AbortController | undefined;
const desktopReplies = new Map<
  string,
  (reply: { value?: unknown; error?: string }) => void
>();
const artworkRequests = new Map<number, AbortController>();
let timelineGeneration = 0;
let frameRequests = { pending: 0 };
function revokeTimeline() {
  timelineRender?.abort();
  timelineGeneration++;
  frameRequests = { pending: 0 };
  for (const request of artworkRequests.values()) request.abort();
  void mediaClient?.request('invalidate').catch(() => {});
  timelineFiles.clear();
}
let openingPreview = false;
let closingProject = false;
let previewGeneration = 0;
const projectSession: ProjectSession = new ProjectSession(
  {
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
    async saveProjectCopy(bundle) {
      const window = mainWindow;
      if (!window) throw new Error('No project window is available.');
      const selection = await dialog.showSaveDialog(window, {
        title: bundle
          ? 'Package project in a new folder'
          : 'Save project snapshot',
        defaultPath: bundle
          ? 'OpenCut project package'
          : 'Snapshot.opencut.json',
      });
      return selection.canceled ? null : (selection.filePath ?? null);
    },
    async savePreviewFrame() {
      if (!mainWindow) throw new Error('No project window is available.');
      const selection = await dialog.showSaveDialog(mainWindow, {
        title: 'Export frame',
        defaultPath: 'Frame.png',
        filters: [{ name: 'PNG image', extensions: ['png'] }],
      });
      return selection.canceled ? null : (selection.filePath ?? null);
    },
    async exportSubtitles(format) {
      const window = mainWindow;
      if (!window) throw new Error('No project window is available.');
      const selection = await dialog.showSaveDialog(window, {
        title: 'Export subtitle sidecar',
        defaultPath: `Subtitles.${format}`,
        filters: [
          {
            name: format === 'srt' ? 'SubRip' : 'WebVTT',
            extensions: [format],
          },
        ],
        buttonLabel: 'Save new file',
      });
      return selection.canceled ? null : (selection.filePath ?? null);
    },
  },
  (state, sequence) => {
    previewGeneration++;
    previewFile = null;
    revokeTimeline();
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send(PROJECT_CHANGED_CHANNEL, state, sequence);
  },
  async (control, state) => {
    if (!mainWindow || mainWindow.isDestroyed())
      throw new Error('Open a review window first.');
    if (
      control.action === 'select' &&
      control.id &&
      !(control.kind === 'asset'
        ? state.project.assets.some(({ id }) => id === control.id)
        : state.project.clips.some(({ id }) => id === control.id) ||
          state.project.subtitles?.cues.some(({ id }) => id === control.id))
    )
      throw new Error('Selection ID is not in the current project.');
    const id = randomUUID();
    const contents = mainWindow.webContents;
    if (desktopReplies.size >= 16)
      throw new Error('Too many pending desktop requests.');
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        desktopReplies.delete(id);
        reject(new Error('The editor did not acknowledge the request.'));
      }, 5000);
      desktopReplies.set(id, (reply) => {
        clearTimeout(timeout);
        desktopReplies.delete(id);
        if (reply.error) reject(new Error(reply.error));
        else
          resolve({
            accepted: true,
            revision: projectRevision(state.project),
            state: reply.value,
          });
      });
      contents.send(
        DESKTOP_CONTROL_CHANNEL,
        id,
        control,
        state.view,
        projectRevision(state.project),
      );
    });
  },
);

const exportSession = new ExportSession(
  (input) => projectSession.captureExport(input),
  async () => {
    if (!mainWindow) throw new Error('No export window is available.');
    const selection = await dialog.showSaveDialog(mainWindow, {
      title: 'Export video',
      defaultPath: 'Export.mp4',
      buttonLabel: 'Choose output',
      filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
    });
    return selection.canceled ? null : (selection.filePath ?? null);
  },
  (state) => {
    if (!mainWindow?.isDestroyed())
      mainWindow?.webContents.send(EXPORT_CHANGED_CHANNEL, state);
  },
  async (width, height, text, visual, signal, neutral) => {
    const { png, ...raster } = await mediaClient!.request<
      Omit<import('@opencut/media').TextRaster, 'png'> & {
        png: Uint8Array | null;
      }
    >('export-text', { width, height, text, visual, neutral }, signal);
    return { ...raster, png: png ? Buffer.from(png) : null };
  },
);

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
    await exportSession.cancelAndWait();
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
  window.on('close', (event) => {
    if (exportSession.active) {
      event.preventDefault();
      void closeProjectWindow(window, false);
    } else {
      // Closing a clean window clears the session before macOS activation reopens it.
      void projectSession.dispose();
    }
  });
  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null;
      void definitionReview.close();
      previewFile = null;
      revokeTimeline();
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
    mediaClient = new MediaClient();
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
              : (timelineFiles.get(request.url) ??
                definitionReview.resolveMedia(request.url));
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
    for (const [action, channel] of Object.entries(EXPORT_CHANNELS)) {
      ipcMain.handle(channel, async (event, ...args: unknown[]) => {
        assertSender(event);
        if (args.length !== (action === 'start' || action === 'cancel' ? 1 : 0))
          throw new Error('Invalid export request arguments.');
        if (action === 'current') return exportSession.current();
        if (action === 'start') return exportSession.start(args[0]);
        if (action === 'cancel') return exportSession.cancel(args[0]);
        const output = await exportSession.chooseOutput();
        assertSender(event);
        return output;
      });
    }
    ipcMain.handle(APP_INFO_CHANNEL, (event) => {
      assertSender(event);
      return getApplicationInfo();
    });
    ipcMain.handle(
      DEFINITION_CHANNELS.open,
      async (event, ...args: unknown[]) => {
        assertSender(event);
        if (args.length) throw new Error('Unexpected definition arguments.');
        if (selectingDefinition || !mainWindow) return;
        selectingDefinition = true;
        try {
          const { canceled, filePaths } = await dialog.showOpenDialog(
            mainWindow,
            {
              title: 'Review a video definition',
              message:
                'Only open trusted local TypeScript. OpenCut executes the selected script and its imports on every rebuild.',
              properties: ['openFile'],
              filters: [
                { name: 'Video definitions', extensions: ['ts', 'json'] },
              ],
            },
          );
          assertSender(event);
          if (canceled) return;
          const [path] = filePaths;
          if (!path || !isVideoDefinitionPath(path))
            throw new Error('Choose a .video.ts or .video.json file.');
          definitionReview.open(path);
        } finally {
          selectingDefinition = false;
        }
      },
    );
    ipcMain.handle(DEFINITION_CHANNELS.close, (event, ...args: unknown[]) => {
      assertSender(event);
      if (args.length) throw new Error('Unexpected definition arguments.');
      return definitionReview.close();
    });
    for (const [key, channel] of Object.entries(PROJECT_CHANNELS)) {
      const action = key as ProjectAction;
      ipcMain.handle(channel, async (event, ...args: unknown[]) => {
        assertSender(event);
        const scoped =
          action === 'exportFrame' ||
          action === 'exportSubtitles' ||
          action === 'copyProject';
        if (args.length !== Number(scoped))
          return { ok: false, error: 'Invalid project request arguments.' };
        const reply = await projectSession.run(action, args[0]);
        assertSender(event);
        return reply;
      });
    }
    // Bound concurrent native thumbnail work; unsupported platforms/formats use icons.
    let thumbnailQueue = Promise.resolve<string | null>(null);
    ipcMain.handle(THUMBNAIL_CHANNEL, (event, ...args: unknown[]) => {
      assertSender(event);
      if (args.length !== 1 || typeof args[0] !== 'string')
        throw new Error('Expected one asset ID.');
      const generation = timelineGeneration;
      const work = thumbnailQueue.then(async () => {
        if (generation !== timelineGeneration) return null;
        assertSender(event);
        const { asset, path } = await projectSession.previewAsset(args[0]);
        if (!asset.mediaTypes.includes('video')) return null;
        if (asset.metadata?.kind === 'video') {
          try {
            const result = await mediaClient!.request<string>('thumbnail', {
              path,
              timestamp: 0,
              hardware: false,
            });
            if (generation !== timelineGeneration) return null;
            assertSender(event);
            return result;
          } catch {
            return null;
          }
        }
        if (process.platform === 'linux') return null;
        try {
          const image = await nativeImage.createThumbnailFromPath(path, {
            width: 96,
            height: 64,
          });
          if (generation !== timelineGeneration) return null;
          assertSender(event);
          return image.isEmpty() ? null : image.toDataURL();
        } catch {
          return null;
        }
      });
      thumbnailQueue = work.catch(() => null);
      return work;
    });
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
        kind:
          asset.metadata?.kind ??
          (asset.mediaTypes.includes('video') ? 'video' : 'audio'),
        frameRate: asset.metadata?.frameRate ?? null,
        videoEndSeconds: null,
        width: asset.metadata?.width ?? null,
        height: asset.metadata?.height ?? null,
        warning: null,
      } satisfies PreviewSource;
    });
    ipcMain.handle(
      TIMELINE_PREVIEW_CHANNEL,
      async (event, ...args: unknown[]) => {
        assertSender(event);
        if (args.length !== 1 || !args[0] || typeof args[0] !== 'object')
          throw new Error('Expected a timeline media request.');
        const input = args[0] as Record<string, unknown>;
        if (
          Object.keys(input)
            .filter((key) => key !== 'originalOnly')
            .sort()
            .join(',') !== 'assetId,expectedRevision,projectId' ||
          (input.originalOnly !== undefined &&
            typeof input.originalOnly !== 'boolean')
        )
          throw new Error('Invalid timeline media request.');
        const generation = timelineGeneration;
        const { asset, path } = await projectSession.previewAsset(
          input.assetId,
          {
            projectId: input.projectId,
            expectedRevision: input.expectedRevision,
          },
        );
        const selected = input.originalOnly
          ? { path, proxy: false }
          : await mediaClient!
              .request<ProxyResult>('select', {
                path,
                auto:
                  !!asset.metadata &&
                  asset.metadata.kind === 'video' &&
                  demandingMedia(asset.metadata),
              })
              .catch(() => ({ path, proxy: false }));
        assertSender(event);
        if (generation !== timelineGeneration)
          throw new Error('Timeline project changed.');
        if (timelineFiles.size >= 128)
          throw new Error('Too many timeline media grants.');
        const url = `opencut://media/${randomUUID()}`;
        timelineFiles.set(url, selected.path);
        return {
          url,
          proxy: selected.proxy,
          ...('displayAspectRatio' in selected && selected.displayAspectRatio
            ? { displayAspectRatio: selected.displayAspectRatio }
            : {}),
          name: asset.name,
          kind:
            asset.metadata?.kind ??
            (asset.mediaTypes.includes('video') ? 'video' : 'audio'),
          frameRate: asset.metadata?.frameRate ?? null,
          videoEndSeconds: null,
          width: asset.metadata?.width ?? null,
          height: asset.metadata?.height ?? null,
          warning: null,
        } satisfies PreviewSource;
      },
    );
    ipcMain.handle(MEDIA_CACHE_CHANNEL, async (event, input: unknown) => {
      assertSender(event);
      if (!input || typeof input !== 'object')
        throw new Error('Invalid cache request.');
      const value = input as Record<string, unknown>;
      const keys = Object.keys(value).sort().join(',');
      if (
        ['status', 'cancel', 'clear', 'cleanup'].includes(
          String(value.action),
        ) &&
        keys === 'action'
      )
        return mediaClient!.request(String(value.action));
      if (value.action === 'configure' && keys === 'action,limits') {
        validateCacheLimits(
          value.limits as Parameters<typeof validateCacheLimits>[0],
        );
        return mediaClient!.request('configure', { limits: value.limits });
      }
      if (
        value.action === 'enable' &&
        keys === 'action,enabled' &&
        typeof value.enabled === 'boolean'
      )
        return mediaClient!.request('enable', { auto: value.enabled });
      if (
        value.action === 'generate' &&
        keys === 'action,assetId,expectedRevision,projectId'
      ) {
        const generation = timelineGeneration;
        const { path } = await projectSession.previewAsset(value.assetId, {
          projectId: value.projectId,
          expectedRevision: value.expectedRevision,
        });
        assertSender(event);
        if (generation !== timelineGeneration)
          throw new Error('Timeline project changed.');
        return mediaClient!.request('generate', { path });
      }
      throw new Error('Invalid cache request.');
    });
    // Artwork has its own admission limit, so it cannot consume paused playback slots.
    ipcMain.handle(CANCEL_TIMELINE_ARTWORK_CHANNEL, (event, id: unknown) => {
      assertSender(event);
      if (typeof id === 'number') artworkRequests.get(id)?.abort();
    });
    ipcMain.handle(
      TIMELINE_ARTWORK_CHANNEL,
      async (event, id: unknown, input: unknown) => {
        assertSender(event);
        if (
          typeof id !== 'number' ||
          !Number.isSafeInteger(id) ||
          id <= 0 ||
          !input ||
          typeof input !== 'object'
        )
          throw new Error('Invalid artwork request.');
        const value = input as Record<string, unknown>;
        const keys = Object.keys(value).sort().join(',');
        if (
          typeof value.assetId !== 'string' ||
          typeof value.projectId !== 'string' ||
          typeof value.expectedRevision !== 'number' ||
          !Number.isSafeInteger(value.expectedRevision) ||
          typeof value.start !== 'number' ||
          !Number.isFinite(value.start) ||
          value.start < 0 ||
          (value.kind === 'waveform'
            ? keys !== 'assetId,expectedRevision,kind,projectId,start' ||
              !Number.isSafeInteger(value.start) ||
              value.start % WAVEFORM_CHUNK_SECONDS !== 0
            : value.kind !== 'frame' ||
              keys !==
                'assetId,count,expectedRevision,interval,kind,projectId,start' ||
              typeof value.count !== 'number' ||
              !Number.isInteger(value.count) ||
              value.count < 1 ||
              value.count > 4 ||
              typeof value.interval !== 'number' ||
              !Number.isFinite(value.interval) ||
              (value.count === 1
                ? value.interval !== 0
                : value.interval <= 0 || value.interval > 1.5))
        )
          throw new Error('Invalid artwork request.');
        if (artworkRequests.size >= 2 || artworkRequests.has(id)) return null;
        const controller = new AbortController();
        artworkRequests.set(id, controller);
        try {
          const { asset, path } = await projectSession.previewAsset(
            value.assetId,
            {
              projectId: value.projectId,
              expectedRevision: value.expectedRevision,
            },
          );
          assertSender(event);
          const waveform = value.kind === 'waveform';
          if (
            controller.signal.aborted ||
            (waveform
              ? asset.metadata?.kind === 'image' ||
                asset.metadata?.hasAudio === false
              : !asset.mediaTypes.includes('video'))
          )
            return null;
          const result = await mediaClient!.request<TimelineArtworkResult>(
            waveform ? 'waveform' : 'thumbnail',
            {
              path,
              timestamp: value.start,
              count: value.count,
              interval: value.interval,
              hardware:
                Number(value.count) > 1 &&
                !!asset.metadata &&
                demandingMedia(asset.metadata) &&
                ['h264', 'hevc'].includes(asset.metadata.videoCodec ?? ''),
            },
            controller.signal,
          );
          assertSender(event);
          return controller.signal.aborted ? null : result;
        } catch {
          return null;
        } finally {
          artworkRequests.delete(id);
        }
      },
    );
    let pendingText = 0;
    ipcMain.handle(TIMELINE_TEXT_CHANNEL, async (event, input: unknown) => {
      assertSender(event);
      if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new Error('Invalid text preview request.');
      const { clipId, projectId, expectedRevision } = input as Record<
        string,
        unknown
      >;
      if (
        Object.keys(input).sort().join(',') !==
          'clipId,expectedRevision,projectId' ||
        typeof clipId !== 'string' ||
        typeof projectId !== 'string' ||
        typeof expectedRevision !== 'number' ||
        !Number.isSafeInteger(expectedRevision)
      )
        throw new Error('Invalid text preview request.');
      const request = projectSession.captureText({
        clipId,
        projectId,
        expectedRevision,
      });
      if (!request) return null;
      if (pendingText >= 8)
        throw new Error('Text preview request limit reached.');
      const generation = timelineGeneration;
      pendingText++;
      try {
        const result = await mediaClient!.request<TimelineTextImage>(
          'text',
          request,
        );
        assertSender(event);
        return generation === timelineGeneration ? result : null;
      } catch (error) {
        if (generation !== timelineGeneration) return null;
        throw error;
      } finally {
        pendingText--;
      }
    });
    ipcMain.on(DESKTOP_CONTROL_REPLY, (event, id: unknown, reply: unknown) => {
      if (
        event.sender !== mainWindow?.webContents ||
        event.senderFrame !== event.sender.mainFrame ||
        typeof id !== 'string' ||
        !reply ||
        typeof reply !== 'object'
      )
        return;
      desktopReplies.get(id)?.(reply as { value?: unknown; error?: string });
    });
    ipcMain.handle(TIMELINE_RENDER_CHANNEL, async (event, input: unknown) => {
      assertSender(event);
      if (
        !input ||
        typeof input !== 'object' ||
        Object.keys(input).sort().join(',') !==
          'expectedRevision,projectId,size,view'
      )
        throw new Error('Invalid timeline preview request.');
      const { projectId, expectedRevision, size, view } = input as {
        projectId: string;
        expectedRevision: number;
        size: number;
        view: number;
      };
      const snapshot = projectSession.captureExport({
        projectId,
        expectedRevision,
        view,
      });
      timelineRender?.abort();
      const controller = new AbortController();
      timelineRender = controller;
      const generation = timelineGeneration;
      try {
        const result = await renderPreviewCache(
          snapshot.project,
          snapshot.path,
          size,
          { signal: controller.signal },
        );
        assertSender(event);
        if (generation !== timelineGeneration || controller.signal.aborted)
          return null;
        const url = `opencut://media/${randomUUID()}.mp4`;
        timelineFiles.set(url, result.path);
        return {
          url,
          hit: result.hit,
          frameCount: result.frameCount,
          revision: result.revision,
        };
      } catch (error) {
        if (controller.signal.aborted) return null;
        throw error;
      } finally {
        if (timelineRender === controller) timelineRender = undefined;
      }
    });
    ipcMain.handle(TIMELINE_FRAME_CHANNEL, async (event, input: unknown) => {
      assertSender(event);
      const requests = frameRequests;
      if (!input || typeof input !== 'object' || requests.pending >= 2)
        return null;
      const value = input as Record<string, unknown>;
      if (
        Object.keys(value).sort().join(',') !==
          'assetId,expectedRevision,projectId,timestamp' ||
        typeof value.timestamp !== 'number' ||
        !Number.isFinite(value.timestamp) ||
        value.timestamp < 0
      )
        throw new Error('Invalid frame request.');
      const generation = timelineGeneration;
      const scope = {
        projectId: value.projectId,
        expectedRevision: value.expectedRevision,
      };
      if (!projectSession.matchesRevision(scope)) return null;
      const { path } = await projectSession.previewAsset(value.assetId, scope);
      if (requests.pending >= 2 || generation !== timelineGeneration)
        return null;
      requests.pending++;
      try {
        const result = await mediaClient!.request<string>('frame', {
          path,
          timestamp: value.timestamp,
        });
        assertSender(event);
        return generation === timelineGeneration ? result : null;
      } catch {
        return null;
      } finally {
        requests.pending--;
      }
    });
    ipcMain.handle(RELEASE_PREVIEW_CHANNEL, (event, ...args: unknown[]) => {
      assertSender(event);
      if (args.length !== 1 || typeof args[0] !== 'string')
        throw new Error('Expected one preview URL.');
      if (previewFile?.url === args[0]) previewFile = null;
      timelineFiles.delete(args[0]);
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

let mediaClosed = false;
app.on('before-quit', (event) => {
  if (mainWindow && exportSession.active) {
    event.preventDefault();
    void closeProjectWindow(mainWindow, true);
  } else if (!mediaClosed && mediaClient) {
    event.preventDefault();
    mediaClosed = true;
    void Promise.allSettled([
      projectSession.dispose(),
      exportSession.dispose(),
      definitionReview.close(),
      mediaClient.close(),
    ]).finally(() => app.quit());
  }
});

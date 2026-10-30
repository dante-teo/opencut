import { contextBridge, ipcRenderer, webUtils } from 'electron';
import {
  APP_INFO_CHANNEL,
  PROJECT_CHANGED_CHANNEL,
  IMPORT_PROGRESS_CHANNEL,
  THUMBNAIL_CHANNEL,
  PROJECT_CHANNELS,
  OPEN_PREVIEW_CHANNEL,
  PREVIEW_METRICS_CHANNEL,
  ASSET_PREVIEW_CHANNEL,
  RELEASE_PREVIEW_CHANNEL,
  TIMELINE_PREVIEW_CHANNEL,
  MEDIA_CACHE_CHANNEL,
  TIMELINE_FRAME_CHANNEL,
  type DesktopAPI,
} from '../bridge.js';

const api: DesktopAPI = {
  onProjectChanged: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      state: Parameters<typeof callback>[0],
    ) => callback(state);
    ipcRenderer.on(PROJECT_CHANGED_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(PROJECT_CHANGED_CHANNEL, listener);
    };
  },
  importMedia: (input) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.import, {
      projectId: input.projectId,
      expectedRevision: input.expectedRevision,
    }),
  importDroppedMedia: (input, files) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.import, {
      projectId: input.projectId,
      expectedRevision: input.expectedRevision,
      paths: files.map((file) => webUtils.getPathForFile(file)),
    }),
  onImportProgress: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      progress: Parameters<typeof callback>[0],
    ) => callback(progress);
    ipcRenderer.on(IMPORT_PROGRESS_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(IMPORT_PROGRESS_CHANNEL, listener);
    };
  },
  removeAsset: (input) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.removeAsset, input),
  addAssetClip: (input) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.addAssetClip, input),
  assetThumbnail: (id) => ipcRenderer.invoke(THUMBNAIL_CHANNEL, id),
  editTimeline: (input) => ipcRenderer.invoke(PROJECT_CHANNELS.edit, input),
  undoProject: (input) => ipcRenderer.invoke(PROJECT_CHANNELS.undo, input),
  redoProject: (input) => ipcRenderer.invoke(PROJECT_CHANNELS.redo, input),
  getProject: () => ipcRenderer.invoke(PROJECT_CHANNELS.current),
  createProject: (input) => ipcRenderer.invoke(PROJECT_CHANNELS.create, input),
  openProject: () => ipcRenderer.invoke(PROJECT_CHANNELS.open),
  saveProject: () => ipcRenderer.invoke(PROJECT_CHANNELS.save),
  closeProject: () => ipcRenderer.invoke(PROJECT_CHANNELS.close),
  getApplicationInfo: () => ipcRenderer.invoke(APP_INFO_CHANNEL),
  openPreview: () => ipcRenderer.invoke(OPEN_PREVIEW_CHANNEL),
  previewAsset: (assetId) => ipcRenderer.invoke(ASSET_PREVIEW_CHANNEL, assetId),
  timelinePreview: (input) =>
    ipcRenderer.invoke(TIMELINE_PREVIEW_CHANNEL, input),
  mediaCache: (input) => ipcRenderer.invoke(MEDIA_CACHE_CHANNEL, input),
  timelineFrame: (input) => ipcRenderer.invoke(TIMELINE_FRAME_CHANNEL, input),
  releasePreview: (url) => ipcRenderer.invoke(RELEASE_PREVIEW_CHANNEL, url),
  getPreviewMetrics: () => ipcRenderer.invoke(PREVIEW_METRICS_CHANNEL),
};
contextBridge.exposeInMainWorld('opencut', api);

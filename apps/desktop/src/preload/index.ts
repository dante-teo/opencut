import { contextBridge, ipcRenderer } from 'electron';
import {
  APP_INFO_CHANNEL,
  PROJECT_CHANNELS,
  OPEN_PREVIEW_CHANNEL,
  PREVIEW_METRICS_CHANNEL,
  ASSET_PREVIEW_CHANNEL,
  RELEASE_PREVIEW_CHANNEL,
  type DesktopAPI,
} from '../bridge.js';

const api: DesktopAPI = {
  getProject: () => ipcRenderer.invoke(PROJECT_CHANNELS.current),
  createProject: (input) => ipcRenderer.invoke(PROJECT_CHANNELS.create, input),
  openProject: () => ipcRenderer.invoke(PROJECT_CHANNELS.open),
  saveProject: () => ipcRenderer.invoke(PROJECT_CHANNELS.save),
  closeProject: () => ipcRenderer.invoke(PROJECT_CHANNELS.close),
  getApplicationInfo: () => ipcRenderer.invoke(APP_INFO_CHANNEL),
  openPreview: () => ipcRenderer.invoke(OPEN_PREVIEW_CHANNEL),
  previewAsset: (assetId) => ipcRenderer.invoke(ASSET_PREVIEW_CHANNEL, assetId),
  releasePreview: (url) => ipcRenderer.invoke(RELEASE_PREVIEW_CHANNEL, url),
  getPreviewMetrics: () => ipcRenderer.invoke(PREVIEW_METRICS_CHANNEL),
};
contextBridge.exposeInMainWorld('opencut', api);

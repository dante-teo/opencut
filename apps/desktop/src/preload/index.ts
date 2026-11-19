import { contextBridge, ipcRenderer } from 'electron';
import {
  APP_INFO_CHANNEL,
  DEFINITION_CHANNELS,
  OPEN_PREVIEW_CHANNEL,
  PREVIEW_METRICS_CHANNEL,
  RELEASE_PREVIEW_CHANNEL,
  type DesktopAPI,
} from '../bridge.js';

const api: DesktopAPI = {
  exportDefinition: (generation) =>
    ipcRenderer.invoke(DEFINITION_CHANNELS.export, generation),
  cancelDefinitionExport: () =>
    ipcRenderer.invoke(DEFINITION_CHANNELS.cancelExport),
  onDefinitionExportProgress(callback) {
    const listener = (_event: Electron.IpcRendererEvent, percent: number) =>
      callback(percent);
    ipcRenderer.on(DEFINITION_CHANNELS.progress, listener);
    return () =>
      ipcRenderer.removeListener(DEFINITION_CHANNELS.progress, listener);
  },
  createDialogueMix: () => ipcRenderer.invoke(DEFINITION_CHANNELS.createMix),
  applyDialogueMix: (generation, edit) =>
    ipcRenderer.invoke(DEFINITION_CHANNELS.applyMix, generation, edit),
  compareDialogueMix: (generation, comparison) =>
    ipcRenderer.invoke(DEFINITION_CHANNELS.compareMix, generation, comparison),
  loadDialogueMix: () => ipcRenderer.invoke(DEFINITION_CHANNELS.loadMix),
  saveDialogueMix: (edit) =>
    ipcRenderer.invoke(DEFINITION_CHANNELS.saveMix, edit),
  openDefinition: () => ipcRenderer.invoke(DEFINITION_CHANNELS.open),
  closeDefinition: () => ipcRenderer.invoke(DEFINITION_CHANNELS.close),
  onDefinitionChanged(callback) {
    const listener = (
      _event: Electron.IpcRendererEvent,
      state: Parameters<typeof callback>[0],
    ) => callback(state);
    ipcRenderer.on(DEFINITION_CHANNELS.changed, listener);
    return () =>
      ipcRenderer.removeListener(DEFINITION_CHANNELS.changed, listener);
  },
  getApplicationInfo: () => ipcRenderer.invoke(APP_INFO_CHANNEL),
  openPreview: () => ipcRenderer.invoke(OPEN_PREVIEW_CHANNEL),
  releasePreview: (url) => ipcRenderer.invoke(RELEASE_PREVIEW_CHANNEL, url),
  getPreviewMetrics: () => ipcRenderer.invoke(PREVIEW_METRICS_CHANNEL),
};
contextBridge.exposeInMainWorld('opencut', api);

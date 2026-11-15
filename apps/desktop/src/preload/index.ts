import { contextBridge, ipcRenderer } from 'electron';
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
  type DesktopAPI,
} from '../bridge.js';

const api: DesktopAPI = {
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
  renderTimeline: (input) => ipcRenderer.invoke(TIMELINE_RENDER_CHANNEL, input),
  onDesktopControl: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      id: string,
      control: Parameters<typeof callback>[0],
      view: number,
      revision: number,
    ) => {
      try {
        ipcRenderer.send(DESKTOP_CONTROL_REPLY, id, {
          value: callback(control, view, revision),
        });
      } catch (error) {
        ipcRenderer.send(DESKTOP_CONTROL_REPLY, id, { error: String(error) });
      }
    };
    ipcRenderer.on(DESKTOP_CONTROL_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(DESKTOP_CONTROL_CHANNEL, listener);
    };
  },
  chooseExportOutput: () => ipcRenderer.invoke(EXPORT_CHANNELS.choose),
  getExport: () => ipcRenderer.invoke(EXPORT_CHANNELS.current),
  startExport: (input) => ipcRenderer.invoke(EXPORT_CHANNELS.start, input),
  cancelExport: (id) => ipcRenderer.invoke(EXPORT_CHANNELS.cancel, id),
  onExportChanged: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      state: Parameters<typeof callback>[0],
    ) => callback(state);
    ipcRenderer.on(EXPORT_CHANGED_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(EXPORT_CHANGED_CHANNEL, listener);
    };
  },
  onProjectChanged: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      state: Parameters<typeof callback>[0],
      sequence: number,
    ) => callback(state, sequence);
    ipcRenderer.on(PROJECT_CHANGED_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(PROJECT_CHANGED_CHANNEL, listener);
    };
  },
  copyProject: (input) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.copyProject, input),
  exportFrame: (input) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.exportFrame, input),
  exportSubtitles: (input) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.exportSubtitles, input),
  assetThumbnail: (id) => ipcRenderer.invoke(THUMBNAIL_CHANNEL, id),
  getProject: () => ipcRenderer.invoke(PROJECT_CHANNELS.current),
  openProject: () => ipcRenderer.invoke(PROJECT_CHANNELS.open),
  closeProject: () => ipcRenderer.invoke(PROJECT_CHANNELS.close),
  getApplicationInfo: () => ipcRenderer.invoke(APP_INFO_CHANNEL),
  openPreview: () => ipcRenderer.invoke(OPEN_PREVIEW_CHANNEL),
  previewAsset: (assetId) => ipcRenderer.invoke(ASSET_PREVIEW_CHANNEL, assetId),
  timelinePreview: (input) =>
    ipcRenderer.invoke(TIMELINE_PREVIEW_CHANNEL, input),
  mediaCache: (input) => ipcRenderer.invoke(MEDIA_CACHE_CHANNEL, input),
  timelineFrame: (input) => ipcRenderer.invoke(TIMELINE_FRAME_CHANNEL, input),
  timelineText: (input) => ipcRenderer.invoke(TIMELINE_TEXT_CHANNEL, input),
  timelineArtwork: (id, input) =>
    ipcRenderer.invoke(TIMELINE_ARTWORK_CHANNEL, id, input),
  cancelTimelineArtwork: (id) =>
    ipcRenderer.invoke(CANCEL_TIMELINE_ARTWORK_CHANNEL, id),
  releasePreview: (url) => ipcRenderer.invoke(RELEASE_PREVIEW_CHANNEL, url),
  getPreviewMetrics: () => ipcRenderer.invoke(PREVIEW_METRICS_CHANNEL),
};
contextBridge.exposeInMainWorld('opencut', api);

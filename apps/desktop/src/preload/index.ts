import { contextBridge, ipcRenderer } from 'electron';
import { APP_INFO_CHANNEL, type DesktopAPI } from '../bridge.js';

const api: DesktopAPI = {
  getApplicationInfo: () => ipcRenderer.invoke(APP_INFO_CHANNEL),
};
contextBridge.exposeInMainWorld('opencut', api);

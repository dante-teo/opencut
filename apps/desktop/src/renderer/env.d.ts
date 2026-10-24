import type { DesktopAPI } from '../bridge.js';

declare global {
  interface Window {
    readonly opencut: DesktopAPI;
  }
}

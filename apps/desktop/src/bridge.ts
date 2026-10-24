import type { ApplicationInfo } from '@opencut/core';

export const APP_INFO_CHANNEL = 'app:get-info';
export const OPEN_PREVIEW_CHANNEL = 'preview:open';
export const PREVIEW_METRICS_CHANNEL = 'preview:metrics';

export interface PreviewSource {
  url: string;
  name: string;
  frameRate: number | null;
  videoEndSeconds: number | null;
  width: number | null;
  height: number | null;
  warning: string | null;
}

export interface PreviewMetrics {
  cpuPercent: number;
  workingSetMiB: number;
  processCount: number;
}

export interface DesktopAPI {
  getApplicationInfo(): Promise<ApplicationInfo>;
  openPreview(): Promise<PreviewSource | null>;
  getPreviewMetrics(): Promise<PreviewMetrics>;
}

import type { ApplicationInfo, Project, ProjectSettings } from '@opencut/core';

export const APP_INFO_CHANNEL = 'app:get-info';
export const OPEN_PREVIEW_CHANNEL = 'preview:open';
export const PREVIEW_METRICS_CHANNEL = 'preview:metrics';
export const ASSET_PREVIEW_CHANNEL = 'preview:asset';
export const RELEASE_PREVIEW_CHANNEL = 'preview:release';

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

export const PROJECT_CHANNELS = {
  current: 'project:current',
  create: 'project:create',
  open: 'project:open',
  save: 'project:save',
  close: 'project:close',
} as const;

export interface NewProjectInput {
  name: string;
  settings: ProjectSettings;
}

export interface DesktopProject {
  project: Project;
  path: string | null;
  dirty: boolean;
  media: { assetId: string; path: string; status: string; message: string }[];
}

export type ProjectReply =
  | { ok: true; state: DesktopProject | null; canceled: boolean }
  | { ok: false; error: string };

export interface DesktopAPI {
  getProject(): Promise<ProjectReply>;
  createProject(input: NewProjectInput): Promise<ProjectReply>;
  openProject(): Promise<ProjectReply>;
  saveProject(): Promise<ProjectReply>;
  closeProject(): Promise<ProjectReply>;
  getApplicationInfo(): Promise<ApplicationInfo>;
  openPreview(): Promise<PreviewSource | null>;
  previewAsset(assetId: string): Promise<PreviewSource>;
  releasePreview(url: string): Promise<void>;
  getPreviewMetrics(): Promise<PreviewMetrics>;
}

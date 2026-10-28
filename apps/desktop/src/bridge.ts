import type {
  ApplicationInfo,
  Project,
  ProjectSettings,
  EditOperation,
} from '@opencut/core';

export const APP_INFO_CHANNEL = 'app:get-info';
export const OPEN_PREVIEW_CHANNEL = 'preview:open';
export const PREVIEW_METRICS_CHANNEL = 'preview:metrics';
export const ASSET_PREVIEW_CHANNEL = 'preview:asset';
export const RELEASE_PREVIEW_CHANNEL = 'preview:release';

export interface PreviewSource {
  kind?: 'video' | 'audio' | 'image';
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
  edit: 'project:edit',
  undo: 'project:undo',
  redo: 'project:redo',
  import: 'project:import',
  removeAsset: 'project:remove-asset',
  addAssetClip: 'project:add-asset-clip',
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
  | {
      ok: true;
      state: DesktopProject | null;
      canceled: boolean;
      notice?: string;
    }
  | { ok: false; error: string };

export interface HistoryInput {
  projectId: string;
  expectedRevision: number;
}
export type TimelineOperation = Extract<
  EditOperation,
  {
    type:
      | 'clip.move'
      | 'clip.trim'
      | 'clip.split'
      | 'clip.remove'
      | 'clip.audio'
      | 'clip.visual';
  }
>;
export interface TimelineEditInput extends HistoryInput {
  operations: TimelineOperation[];
  label: string;
}

export const IMPORT_PROGRESS_CHANNEL = 'media:import-progress';
export const PROJECT_CHANGED_CHANNEL = 'project:changed';
export const THUMBNAIL_CHANNEL = 'media:thumbnail';
export interface ImportProgress {
  completed: number;
  total: number;
  name: string;
}
export interface AssetRemoveInput extends HistoryInput {
  assetId: string;
}
export interface AssetClipInput extends AssetRemoveInput {
  trackId?: string;
  mediaType: 'video' | 'audio';
  at: number;
}
export interface DesktopAPI {
  onProjectChanged(
    callback: (state: DesktopProject | null) => void,
  ): () => void;
  importMedia(input: HistoryInput): Promise<ProjectReply>;
  importDroppedMedia(input: HistoryInput, files: File[]): Promise<ProjectReply>;
  onImportProgress(callback: (progress: ImportProgress) => void): () => void;
  removeAsset(input: AssetRemoveInput): Promise<ProjectReply>;
  addAssetClip(input: AssetClipInput): Promise<ProjectReply>;
  assetThumbnail(assetId: string): Promise<string | null>;
  editTimeline(input: TimelineEditInput): Promise<ProjectReply>;
  undoProject(input: HistoryInput): Promise<ProjectReply>;
  redoProject(input: HistoryInput): Promise<ProjectReply>;
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

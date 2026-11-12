import type { ExportSettings } from './export-settings.js';
import type { CacheLimits, CacheStatus, RenderProgress } from '@opencut/media';
import type {
  ApplicationInfo,
  Project,
  ProjectSettings,
  EditOperation,
  SubtitleFormat,
} from '@opencut/core';

export const ONLINE_MEDIA_CHANNELS = {
  search: 'online-media:search',
  openSource: 'online-media:open-source',
} as const;
export type OnlineMediaProvider = 'commons' | 'openverse';
export type OnlineMediaKind = 'image' | 'audio' | 'video';
export interface OnlineMediaSearch {
  provider: OnlineMediaProvider;
  kind: OnlineMediaKind;
  query: string;
  page?: string;
}
export interface OnlineMediaResult {
  id: string;
  title: string;
  kind: OnlineMediaKind;
  creator: string | null;
  sourceUrl: string;
  license: string;
  licenseUrl: string;
  previewUrl: string | null;
  importable: boolean;
}
export interface OnlineMediaPage {
  results: OnlineMediaResult[];
  nextPage: string | null;
}

export const APP_INFO_CHANNEL = 'app:get-info';
export const OPEN_PREVIEW_CHANNEL = 'preview:open';
export const PREVIEW_METRICS_CHANNEL = 'preview:metrics';
export const ASSET_PREVIEW_CHANNEL = 'preview:asset';
export const TIMELINE_PREVIEW_CHANNEL = 'preview:timeline';
export const MEDIA_CACHE_CHANNEL = 'media:cache';
export const TIMELINE_ARTWORK_CHANNEL = 'media:timeline-artwork';
export const CANCEL_TIMELINE_ARTWORK_CHANNEL = 'media:cancel-timeline-artwork';
export type TimelineArtworkInput = HistoryInput & {
  assetId: string;
  start: number;
} & ({ kind: 'frame'; count: number; interval: number } | { kind: 'waveform' });
export type TimelineArtworkResult = string | Uint8Array | null;
export const TIMELINE_FRAME_CHANNEL = 'media:frame';
export const TIMELINE_TEXT_CHANNEL = 'media:text';
export interface TimelineTextImage {
  x: number;
  y: number;
  width: number;
  height: number;
  url: string | null;
  warning: string | null;
}
export type MediaCacheAction =
  | { action: 'status' | 'cancel' | 'clear' | 'cleanup' }
  | { action: 'configure'; limits: CacheLimits }
  | { action: 'enable'; enabled: boolean }
  | {
      action: 'generate';
      assetId: string;
      projectId: string;
      expectedRevision: number;
    };
export interface DesktopCacheStatus extends CacheStatus {
  enabled: boolean;
  revision: number;
  jobs: {
    name: string;
    state: string;
    progress: RenderProgress | null;
    error: string;
  }[];
}
export const RELEASE_PREVIEW_CHANNEL = 'preview:release';

export interface PreviewSource {
  proxy?: boolean;
  displayAspectRatio?: number;
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
  importOnline: 'project:import-online',
  importSubtitles: 'project:import-subtitles',
  exportSubtitles: 'project:export-subtitles',
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
      | 'clip.speed'
      | 'track.audio'
      | 'clip.visual'
      | `clip.keyframe.${string}`
      | 'text.add'
      | 'text.set'
      | Exclude<
          Extract<EditOperation['type'], `subtitle.${string}`>,
          'subtitle.import'
        >;
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
export const EXPORT_CHANNELS = {
  choose: 'export:choose',
  current: 'export:current',
  start: 'export:start',
  cancel: 'export:cancel',
} as const;
export const EXPORT_CHANGED_CHANNEL = 'export:changed';
export interface ExportInput extends HistoryInput {
  settings: ExportSettings;
}
export interface ExportState {
  id: string;
  projectId: string;
  projectName: string;
  revision: number;
  output: string;
  settings: ExportSettings;
  status:
    | 'validating'
    | 'rendering'
    | 'verifying'
    | 'cancelling'
    | 'succeeded'
    | 'validation_failed'
    | 'failed'
    | 'cancelled';
  progress: RenderProgress | null;
  elapsedSeconds: number;
  summary: {
    width: number;
    height: number;
    frameRate: { numerator: number; denominator: number };
    frameCount: number;
    durationSeconds: number;
    codec: string;
  } | null;
  warnings: string[];
  error: string;
}
export interface DesktopAPI {
  chooseExportOutput(): Promise<string | null>;
  getExport(): Promise<ExportState | null>;
  startExport(input: ExportInput): Promise<ExportState>;
  cancelExport(id: string): Promise<ExportState | null>;
  onExportChanged(callback: (state: ExportState) => void): () => void;
  onProjectChanged(
    callback: (state: DesktopProject | null) => void,
  ): () => void;
  importMedia(input: HistoryInput): Promise<ProjectReply>;
  searchOnlineMedia(input: OnlineMediaSearch): Promise<OnlineMediaPage>;
  openOnlineMediaSource(id: string): Promise<void>;
  importOnlineMedia(
    input: HistoryInput & { resultId: string },
  ): Promise<ProjectReply>;
  importSubtitles(input: HistoryInput): Promise<ProjectReply>;
  exportSubtitles(
    input: HistoryInput & { format: SubtitleFormat },
  ): Promise<ProjectReply>;
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
  timelinePreview(
    input: HistoryInput & { assetId: string; originalOnly?: boolean },
  ): Promise<PreviewSource>;
  mediaCache(input: MediaCacheAction): Promise<DesktopCacheStatus | null>;
  timelineFrame(
    input: HistoryInput & { assetId: string; timestamp: number },
  ): Promise<string | null>;
  timelineText(
    input: HistoryInput & { clipId: string },
  ): Promise<TimelineTextImage | null>;
  timelineArtwork(
    id: number,
    input: TimelineArtworkInput,
  ): Promise<TimelineArtworkResult>;
  cancelTimelineArtwork(id: number): Promise<void>;
  releasePreview(url: string): Promise<void>;
  getPreviewMetrics(): Promise<PreviewMetrics>;
}

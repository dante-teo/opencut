import type { ExportSettings } from './export-settings.js';
import type { CacheLimits, CacheStatus, RenderProgress } from '@opencut/media';
import type { ApplicationInfo, Project, SubtitleFormat } from '@opencut/core';

export const APP_INFO_CHANNEL = 'app:get-info';
export const DEFINITION_CHANNELS = {
  open: 'definition:open',
  close: 'definition:close',
  changed: 'definition:changed',
} as const;

export interface DefinitionReview {
  path: string;
  generation: number;
  status: 'compiling' | 'rendering' | 'ready' | 'error';
  error?: string;
  current: {
    generation: number;
    sourceRevision: string;
    project: Project;
    frameCount: number;
    url: string;
  } | null;
}
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
export const TIMELINE_RENDER_CHANNEL = 'media:render-timeline';
export const DESKTOP_CONTROL_CHANNEL = 'project:desktop-control';
export const DESKTOP_CONTROL_REPLY = 'project:desktop-control-reply';
export type DesktopControl = import('@opencut/core/node').DesktopControlRequest;
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
  open: 'project:open',
  close: 'project:close',
  copyProject: 'project:copy',
  exportSubtitles: 'project:export-subtitles',
  exportFrame: 'project:export-frame',
} as const;

export interface DesktopProject {
  project: Project;
  path: string;
  view: number;
  media: { assetId: string; path: string; status: string; message: string }[];
}

export type ProjectReply =
  | {
      ok: true;
      state: DesktopProject | null;
      canceled: boolean;
      notice?: string;
      sequence: number;
    }
  | { ok: false; error: string };

export interface HistoryInput {
  projectId: string;
  expectedRevision: number;
}
export interface ProjectViewInput extends HistoryInput {
  view: number;
}
export const PROJECT_CHANGED_CHANNEL = 'project:changed';
export const THUMBNAIL_CHANNEL = 'media:thumbnail';
export const EXPORT_CHANNELS = {
  choose: 'export:choose',
  current: 'export:current',
  start: 'export:start',
  cancel: 'export:cancel',
} as const;
export const EXPORT_CHANGED_CHANNEL = 'export:changed';
export interface ExportInput extends ProjectViewInput {
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
  openDefinition(): Promise<void>;
  closeDefinition(): Promise<void>;
  onDefinitionChanged(
    callback: (state: DefinitionReview | null) => void,
  ): () => void;
  renderTimeline(input: ProjectViewInput & { size: number }): Promise<{
    url: string;
    hit: boolean;
    frameCount: number;
    revision: number;
  } | null>;
  onDesktopControl(
    callback: (
      control: DesktopControl,
      view: number,
      revision: number,
    ) => unknown,
  ): () => void;
  chooseExportOutput(): Promise<string | null>;
  getExport(): Promise<ExportState | null>;
  startExport(input: ExportInput): Promise<ExportState>;
  cancelExport(id: string): Promise<ExportState | null>;
  onExportChanged(callback: (state: ExportState) => void): () => void;
  onProjectChanged(
    callback: (state: DesktopProject | null, sequence: number) => void,
  ): () => void;
  exportFrame(input: ProjectViewInput & { at: number }): Promise<ProjectReply>;
  exportSubtitles(
    input: ProjectViewInput & { format: SubtitleFormat },
  ): Promise<ProjectReply>;
  copyProject(
    input: ProjectViewInput & { bundle: boolean },
  ): Promise<ProjectReply>;
  assetThumbnail(assetId: string): Promise<string | null>;
  getProject(): Promise<ProjectReply>;
  openProject(): Promise<ProjectReply>;
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

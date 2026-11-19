import type { ApplicationInfo, Project } from '@opencut/core';
import type { AudioMixReport, VideoMixEdit } from '@opencut/core/video';

export const APP_INFO_CHANNEL = 'app:get-info';
export const DEFINITION_CHANNELS = {
  open: 'definition:open',
  close: 'definition:close',
  createMix: 'definition:create-mix',
  applyMix: 'definition:apply-mix',
  compareMix: 'definition:compare-mix',
  saveMix: 'definition:save-mix',
  loadMix: 'definition:load-mix',
  changed: 'definition:changed',
  export: 'definition:export',
  cancelExport: 'definition:cancel-export',
  progress: 'definition:progress',
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
    audioMix?: AudioMixReport;
    url: string;
  } | null;
}
export const OPEN_PREVIEW_CHANNEL = 'preview:open';
export const PREVIEW_METRICS_CHANNEL = 'preview:metrics';
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

export type DefinitionExportResult =
  { status: 'saved'; path: string } | { status: 'cancelled' };

export interface DesktopAPI {
  exportDefinition(generation: number): Promise<DefinitionExportResult>;
  cancelDefinitionExport(): Promise<void>;
  onDefinitionExportProgress(callback: (percent: number) => void): () => void;
  openDefinition(): Promise<void>;
  createDialogueMix(): Promise<void>;
  applyDialogueMix(
    generation: number,
    edit: VideoMixEdit | null,
  ): Promise<void>;
  compareDialogueMix(
    generation: number,
    comparison: 'before' | 'after',
  ): Promise<void>;
  saveDialogueMix(edit: VideoMixEdit): Promise<string | null>;
  loadDialogueMix(): Promise<VideoMixEdit | null>;
  closeDefinition(): Promise<void>;
  onDefinitionChanged(
    callback: (state: DefinitionReview | null) => void,
  ): () => void;
  getApplicationInfo(): Promise<ApplicationInfo>;
  openPreview(): Promise<PreviewSource | null>;
  releasePreview(url: string): Promise<void>;
  getPreviewMetrics(): Promise<PreviewMetrics>;
}

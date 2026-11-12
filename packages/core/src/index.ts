export {
  PROJECT_SCHEMA_VERSION,
  ProjectFormatError,
  createProject,
  deserializeProject,
  getProjectInfo,
  serializeProject,
  validateProject,
} from './project.js';
export type {
  CreateProjectOptions,
  MediaAsset,
  MediaReference,
  Project,
  ProjectIssue,
  ProjectMetadata,
  ProjectSettings,
  ProjectValidationResult,
  TimelineClip,
  Track,
} from './project.js';
export { addTimes, compareTimes, frameTime, subtractTimes } from './time.js';
export type { FrameRate, RationalTime } from './time.js';
export {
  clipDuration,
  clipTimelineEnd,
  clipSpeed,
  clipSourceTime,
  clipSourcePosition,
  clipTimelinePosition,
  parseClipSpeed,
  timelineToSourceOffset,
} from './clip-timing.js';
export type { ClipSpeed } from './clip-timing.js';

/** Shared application identity, introduced in T01. */
export interface ApplicationInfo {
  readonly name: string;
  readonly version: string;
}

export function getApplicationInfo(): ApplicationInfo {
  return { name: 'OpenCut', version: '0.1.0' };
}

export {
  TimelineError,
  addTrack,
  removeTrack,
  addClip,
  addText,
  moveClip,
  trimClip,
  setClipAudio,
  setClipSpeed,
  setTrackAudio,
  setClipVisual,
  editClipKeyframe,
  setText,
  setCanvas,
  splitClip,
  removeClip,
  listTimeline,
} from './timeline.js';
export type {
  AddTrackOptions,
  AddClipOptions,
  AddTextOptions,
  MoveClipOptions,
  TrimClipOptions,
  ClipAudioOptions,
  TrackAudioOptions,
  ClipVisualOptions,
} from './timeline.js';

export {
  EditError,
  parseEditTransaction,
  editTransactionJsonSchema,
  projectSnapshot,
  projectRevision,
  checkProjectRevision,
  commitEdit,
  executeTransaction,
  previewTransaction,
  undoEdit,
  redoEdit,
  getEditHistory,
} from './editing.js';
export type { EditOperation, EditTransaction } from './editing.js';
export type { KeyframeEdit } from './keyframes.js';
export type { TextLayer } from '@opencut/shared';
export type { ProjectSnapshot, HistoryEntry } from './project.js';

export { planProjectRender, RenderError } from './render-plan.js';
export type {
  ProjectRenderPlan,
  VisualRenderClip,
  AudioRenderClip,
} from './render-plan.js';

export {
  audioFadeEdges,
  audioFadeGain,
  baseAudioGain,
  resolveAudioFade,
} from './audio.js';
export type { AudioFade, AudioFadeEdge } from './audio.js';

export { addAssetClip } from './library.js';

export {
  evaluateTimeline,
  evaluateTimelineFrame,
  createTimelineEvaluator,
  createPlaybackTimelineEvaluator,
  resolveTimeline,
  continuesMediaRun,
} from './evaluation.js';
export type {
  TimelineEvaluation,
  EvaluatedTimelineClip,
  PlaybackTimelineClip,
  ResolvedTimelineClip,
  ResolvedMediaClip,
  ResolvedTextClip,
} from './evaluation.js';

export {
  inspectProject,
  inspectTimeline,
  inspectionJsonSchemas,
  projectInspectionSchema,
  timelineInspectionSchema,
  previewFrameSchema,
  previewClipSchema,
  previewSheetSchema,
} from './inspection.js';

export {
  SubtitleError,
  parseSubtitles,
  serializeSubtitles,
  subtitleFormat,
  parseSubtitleTime,
} from './subtitle-formats.js';
export type { SubtitleFormat } from './subtitle-formats.js';
export {
  effectiveSubtitleStyle,
  sortSubtitleCues,
  subtitleLanes,
  subtitleTextLayers,
} from './subtitles.js';
export type {
  SubtitleCue,
  SubtitleCueInput,
  SubtitleStyle,
  SubtitleTrack,
} from './subtitles.js';

export type {
  AnimatedProperty,
  KeyframeEasing,
  VisualKeyframe,
  VisualKeyframes,
} from '@opencut/shared';

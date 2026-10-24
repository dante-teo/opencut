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
  moveClip,
  trimClip,
  splitClip,
  removeClip,
  listTimeline,
  clipDuration,
  clipTimelineEnd,
} from './timeline.js';
export type {
  AddTrackOptions,
  AddClipOptions,
  MoveClipOptions,
  TrimClipOptions,
} from './timeline.js';

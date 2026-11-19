import manifest from '../package.json' with { type: 'json' };
export {
  ProjectFormatError,
  createProject,
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
  sampleClipSourceTime,
  clipSourcePosition,
  parseClipSpeed,
} from './clip-timing.js';
export { resolveTransition, transitionOwner } from './transitions.js';
export type { Transition, TransitionInput } from './transitions.js';
export type { ClipSpeed } from './clip-timing.js';

/** Shared application identity. */
export interface ApplicationInfo {
  readonly name: string;
  readonly version: string;
}

export function getApplicationInfo(): ApplicationInfo {
  return { name: 'OpenCut', version: manifest.version };
}

export type { TextLayer } from '@opencut/shared';

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
  keyframeGain,
  resolveAudioFade,
} from './audio.js';
export type { AudioEffect, AudioFade, AudioFadeEdge } from './audio.js';

export { listTimeline } from './timeline-view.js';

export {
  evaluateTimeline,
  evaluateTimelineFrame,
  createTimelineEvaluator,
  resolveTimeline,
  continuesMediaRun,
} from './evaluation.js';
export type {
  TimelineEvaluation,
  EvaluatedTimelineClip,
  ResolvedTimelineClip,
  ResolvedMediaClip,
  ResolvedTextClip,
} from './evaluation.js';

export {
  inspectProject,
  inspectTimeline,
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

export { defineVideo } from './video-definition.js';
export type { VideoDefinition } from './video-definition.js';

export { deliveryTargets, dialoguePresetControls } from '@opencut/shared';

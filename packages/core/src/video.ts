/** Node entrypoint for definition workflows. */
export {
  defineVideo,
  isVideoDefinitionPath,
  videoDefinitionFormats,
  videoId,
  videoParams,
} from './video-definition.js';
export { convertJsonVideoDefinition } from './convert-json-video.js';
export type { VideoDefinition, VideoParameters } from './video-definition.js';
export { inspectVideoLayout, VideoLayoutError } from './video-layout.js';
export type { LayoutAssertion } from './layout-assertion-schema.js';
export type {
  GraphicAssetDefinition,
  GraphicProps,
} from './video-graphics-contract.js';
export {
  contactTimelineSchema,
  describeProjectContactTimeline,
  readDefinitionContactTimeline,
} from './contact-timeline.js';
export type { ContactTimeline } from './contact-timeline.js';
export {
  fileFingerprintSchema,
  fingerprintFile,
  matchesFingerprint,
} from './video-integrity.js';
export { inspectProject, inspectTimeline } from './inspection.js';
export {
  parseSubtitles,
  serializeSubtitles,
  parseSubtitleTime,
} from './subtitle-formats.js';
export { OnlineMediaError, OnlineMediaLibrary } from './online-media.js';
export type {
  OnlineMediaPage,
  OnlineMediaResult,
  OnlineMediaSearch,
} from './online-media.js';
export { readSubtitleFile, writeSubtitleFile } from './subtitle-files.js';
export {
  compileVideo,
  inspectVideoBuild,
  inspectVideoRecipes,
} from './video-files.js';
export { VideoDefinitionError } from './video-definition.js';
export { buildNarration } from './narration.js';
export type { NarrationSegment } from './narration.js';
export type { CompiledVideo } from './video-compiler.js';
export {
  evenlySpacedFrames,
  previewVideo,
  VideoPreviewRangeError,
} from './video-preview.js';
export type {
  PreviewPosition,
  VideoPreviewOptions,
  VideoPreviewRange,
} from './video-preview.js';
export { renderVideo, renderCompiledVideo } from './video-render.js';
export { planVideoRender } from './video-render-plan.js';
export type {
  CompiledVideoRenderOptions,
  VideoRenderBuild,
  VideoRenderOptions,
} from './video-render.js';
export { watchVideo } from './video-watch.js';
export type {
  VideoWatchOptions,
  VideoWatchRevision,
  VideoWatchStatus,
} from './video-watch.js';

export type { VideoRecipe } from './video-recipe-schema.js';
export type {
  VideoProcessingOptions,
  VideoProcessingProgress,
} from './video-processing.js';
export type { VideoRecipeInspection } from './video-recipe.js';
export type {
  VideoBuild,
  VideoBuildInspection,
  VideoCompileOptions,
} from './video-files.js';
export { batchRenderVideo } from './video-batch.js';
export type {
  VideoBatchOptions,
  VideoBatchProgress,
  VideoBatchResult,
  VideoVariant,
  VideoVariantResult,
} from './video-batch.js';

export { inspectVideoDependencies } from './video-dependencies.js';
export { packageVideo, verifyVideoPackage } from './video-package.js';
export type { VideoPackageOptions } from './video-package.js';
export { packageEntryName } from './video-package-format.js';
export type { VideoPackageManifest } from './video-package-format.js';

export { analyzeVideoMix } from './video-audio-mix.js';
export type { AudioMixAnalysisOptions } from './video-audio-mix.js';
export {
  audioRoleSchema,
  professionalMixSchema,
  videoMixEditSchema,
} from './professional-mix.js';
export type {
  AudioRole,
  DeliveryPreset,
  DialoguePreset,
  MixAutomation,
  MixGainPoint,
  ProfessionalMix,
  VideoMixEdit,
} from '@opencut/shared';
export type { AudioMixReport } from '@opencut/media';
export {
  describeMusicComparison,
  musicSelectionSchema,
} from './music-comparison.js';
export type { MusicSelection } from './music-comparison.js';

export {
  cycleTime,
  ease,
  interpolate,
  interpolateColor,
  sampleMotion,
  seededVariation,
  sequenceTime,
  staggerTime,
} from '@opencut/shared';
export type {
  Extrapolation,
  MotionChannel,
  MotionCycle,
  MotionEasing,
  MotionKeyframe,
} from '@opencut/shared';

export { defineGraphicScene, sceneLimits } from './graphic-scene-schema.js';
export type {
  AnimatedNumber,
  GraphicScene,
  GraphicSceneNode,
  SceneColor,
  SceneMask,
  ScenePaint,
} from '@opencut/shared';

export type { AnimatedVector, ThreeScene } from '@opencut/shared';
export { graphicTemplates } from './video-graphics-contract.js';

export { createPresetScene, graphicScenePresets } from './scene-presets.js';
export type { ScenePreset } from './scene-presets.js';
export type {
  GraphicAudioAnalysis,
  GraphicAudioSample,
  VisualGroup,
  TransitionStyle,
} from '@opencut/shared';

export {
  inspectGraphicFrames,
  videoGraphicsCapabilities,
  videoGraphicsSchemas,
} from './graphics-inspection.js';

export {
  describeMotionGraphics,
  editMotionDefinition,
  motionEditSchema,
  saveMotionDefinition,
  validateMotionSplit,
} from './video-motion-edit.js';
export type { MotionEdit, MotionGraphics } from './video-motion-edit.js';

export {
  compareRevisionTimelines,
  inspectVideoRevision,
  preflightPictureReuse,
  revisionEvidenceSchema,
  revisionRenderSettings,
} from './video-revision.js';
export type {
  RevisionEvidence,
  RevisionTimeline,
  RevisionRenderSettings,
} from './video-revision.js';

export {
  reviewMarksSchema,
  reviewNotesSchema,
  reviewVideoRevisions,
} from './video-review.js';
export type { ReviewVersion } from './video-review.js';

export {
  patchVideoTimeline,
  timelinePatchSchema,
} from './video-timeline-patch.js';

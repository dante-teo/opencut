/** Node entrypoint for definition workflows. */
export { defineVideo, videoId, videoParams } from './video-definition.js';
export type { VideoDefinition, VideoParameters } from './video-definition.js';
export type {
  GraphicAssetDefinition,
  GraphicProps,
} from './video-graphics-contract.js';
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
  isVideoDefinitionPath,
} from './video-files.js';
export { VideoDefinitionError } from './video-definition.js';
export type { CompiledVideo } from './video-compiler.js';
export { previewVideo, VideoPreviewRangeError } from './video-preview.js';
export type {
  PreviewPosition,
  VideoPreviewOptions,
  VideoPreviewRange,
} from './video-preview.js';
export { renderVideo, renderCompiledVideo } from './video-render.js';
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

export { packageVideo, verifyVideoPackage } from './video-package.js';
export type { VideoPackageOptions } from './video-package.js';
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

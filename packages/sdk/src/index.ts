import { constants } from 'node:fs';
import { access, lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  checkProjectRevision,
  commitEdit,
  copyClips,
  clipClipboardSchema,
  createProject as createDocument,
  EditError,
  getEditHistory,
  inspectProject,
  inspectTimeline,
  previewTransaction,
  projectRevision,
  redoEdit,
  serializeProject,
  undoEdit,
} from '@opencut/core';
import type {
  CreateProjectOptions,
  EditOperation,
  Project,
} from '@opencut/core';
import {
  canonicalProjectFilePath,
  checkProjectMedia,
  controlDesktopProject,
  renderPreviewCache,
  type DesktopControlRequest,
  copyProjectFile,
  prepareMediaAsset,
  prepareOnlineMediaAsset,
  prepareFreezeFrame,
  prepareEmbeddedFont,
  prepareMediaRelink,
  ProjectFileError,
  OnlineMediaLibrary,
  readProjectFile,
  readSubtitleFile,
  writeSubtitleFile,
  removeAssetFromProject,
  resolveProjectRender,
  updateProjectFile,
  writeProjectFile,
} from '@opencut/core/node';
import type {
  AssetImportResult,
  AssetInfo,
  MediaAvailability,
  OnlineMediaSearch,
} from '@opencut/core/node';
import {
  renderContactSheet,
  separateDialogue,
  renderTimelineFrame,
  renderVideoTimeline,
} from '@opencut/media';
import type {
  RenderControls,
  VideoTimelineOptions,
  VideoTimelineResult,
} from '@opencut/media';

export {
  EditError,
  ProjectFormatError,
  RenderError,
  SubtitleError,
  parseSubtitles,
  serializeSubtitles,
  parseSubtitleTime,
  parseClipSpeed,
} from '@opencut/core';
export {
  AssetError,
  OnlineMediaError,
  ProjectFileError,
  SessionError,
} from '@opencut/core/node';
export type { DesktopControlRequest } from '@opencut/core/node';
export { MediaError, RenderCancelledError } from '@opencut/media';
export { defaultJobLimits, JobError, LocalJobs } from '@opencut/core/jobs';
export type {
  JobBackend,
  JobDetails,
  JobFailure,
  JobInputs,
  JobLimits,
  JobLog,
  JobProgress,
  JobResources,
  JobState,
  JobStatus,
  JobSubmissionOptions,
  JobToolIdentity,
  LocalJobRequest,
  LocalJobsOptions,
} from '@opencut/core/jobs';
export type {
  CreateProjectOptions,
  EditOperation,
  FrameRate,
  ClipSpeed,
  ClipClipboard,
  RippleScope,
  AnimatedProperty,
  KeyframeEasing,
  VisualKeyframe,
  VisualKeyframes,
  MediaAsset,
  MediaReference,
  ProjectSettings,
  RationalTime,
  SubtitleCue,
  SubtitleCueInput,
  SubtitleFormat,
  SubtitleStyle,
  SubtitleTrack,
  TextLayer,
  TimelineClip,
  Track,
  Transition,
  TransitionInput,
} from '@opencut/core';
export type { AssetImportResult, MediaAvailability } from '@opencut/core/node';
export type {
  RenderCodec,
  RenderProgress,
  RenderQuality,
  RenderResolution,
  VideoTimelineResult,
} from '@opencut/media';

export type ProjectInspection = ReturnType<typeof inspectProject>;
export type TimelineInspection = ReturnType<typeof inspectTimeline>;
export type EditHistory = ReturnType<typeof getEditHistory>;
export type FramePreviewResult = Awaited<
  ReturnType<typeof renderTimelineFrame>
>;
export type ContactSheetResult = Awaited<ReturnType<typeof renderContactSheet>>;

export interface PreviewOptions {
  /** Limit the canvas's longest side without upscaling. */
  maxDimension?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface ContactSheetOptions extends PreviewOptions {
  columns?: number | undefined;
}

export type RenderOptions = Pick<
  RenderControls,
  | 'codec'
  | 'outputFrameRate'
  | 'quality'
  | 'resolution'
  | 'outputSize'
  | 'videoBitrateKbps'
  | 'audioBitrateKbps'
  | 'audioSampleRate'
  | 'audioChannels'
  | 'signal'
  | 'onProgress'
> & { burnSubtitles?: boolean | undefined };

/** An in-memory view of one project. Only its owning editor can publish edits. */
export interface ProjectDraft {
  cachePreview(size?: number): ReturnType<typeof renderPreviewCache>;
  controlDesktop(
    request: DesktopControlRequest,
  ): ReturnType<typeof controlDesktopProject>;
  readonly path: string;
  inspect(): ProjectInspection;
  inspectTimeline(frame: number): TimelineInspection;
  /** History of the opened snapshot, or the planned history after undo/redo. */
  history(): EditHistory;
  checkMedia(): Promise<MediaAvailability[]>;
  importMedia(file: string): Promise<AssetImportResult>;
  searchOnlineMedia(
    input: OnlineMediaSearch,
  ): ReturnType<OnlineMediaLibrary['search']>;
  importOnlineMedia(
    resultId: string,
    directory: string,
  ): Promise<AssetImportResult>;
  relinkMedia(assetId: string, file: string): Promise<AssetInfo>;
  importFont(id: string, file: string): Promise<{ id: string; file: string }>;
  freezeFrame(
    clipId: string,
    at: number,
    frames: number,
    output: string,
  ): Promise<Awaited<ReturnType<typeof prepareFreezeFrame>>['result']>;
  separateDialogue(
    assetId: string,
    directory: string,
  ): ReturnType<typeof separateDialogue>;
  copyProject(
    destination: string,
    bundle?: boolean,
  ): ReturnType<typeof copyProjectFile>;
  removeMedia(assetId: string): void;
  importSubtitles(
    file: string,
  ): Promise<{ format: 'srt' | 'vtt'; cueCount: number }>;
  exportSubtitles(output: string): ReturnType<typeof writeSubtitleFile>;
  copyClips(ids: string[]): ReturnType<typeof copyClips>;
  cutClips(ids: string[]): ReturnType<typeof copyClips>;
  /** Apply one or more existing edit commands as an atomic group in the draft. */
  apply(
    ...operations: EditOperation[]
  ): ReturnType<typeof previewTransaction>['results'];
  /** Stage one history step. Save it separately from other edits. */
  undo(): void;
  redo(): void;
  previewFrame(
    frame: number,
    output: string,
    options?: PreviewOptions,
  ): Promise<FramePreviewResult>;
  previewContactSheet(
    frames: readonly number[],
    output: string,
    options?: ContactSheetOptions,
  ): Promise<ContactSheetResult>;
  render(output: string, options?: RenderOptions): Promise<VideoTimelineResult>;
}

export interface SaveOptions {
  label?: string | undefined;
  dryRun?: boolean | undefined;
}

export interface SaveResult {
  path: string;
  projectId: string;
  baseRevision: number;
  revision: number;
  changed: boolean;
  created: boolean;
  dryRun: boolean;
}

export interface ProjectEditor {
  readonly project: ProjectDraft;
  /** Save staged edits as one undo step, or validate the save without publishing. */
  save(options?: SaveOptions): Promise<SaveResult>;
}

export interface EditorOptions {
  /** Cancel FFmpeg jobs and saves before publication or active-session submission. */
  signal?: AbortSignal | undefined;
  /** Disable file-producing preview and render methods. Save always simulates. */
  dryRun?: boolean | undefined;
}

export interface OpenProjectOptions extends EditorOptions {
  expectedRevision?: number | undefined;
}

export class SdkError extends Error {
  override name = 'SdkError';
  constructor(
    public readonly code:
      'EDITOR_BUSY' | 'HISTORY_PENDING' | 'DRY_RUN_OUTPUT' | 'PROJECT_OUTPUT',
    message: string,
  ) {
    super(message);
  }
}

/** Open the current snapshot, using the active T22 writer if Electron owns it. */
export async function openProject(
  file: string,
  options: OpenProjectOptions = {},
): Promise<ProjectEditor> {
  const path = await canonicalProjectFilePath(resolve(file));
  const project = await readProjectFile(path);
  checkProjectRevision(project, options.expectedRevision);
  return editProject(path, project, false, options);
}

/** Prepare a new project. The destination is reserved only when save succeeds. */
export async function createProject(
  file: string,
  project: CreateProjectOptions,
  options: EditorOptions = {},
): Promise<ProjectEditor> {
  const path = await canonicalProjectFilePath(resolve(file));
  await checkNewDestination(path);
  return editProject(path, createDocument(project), true, options);
}

async function checkNewDestination(path: string): Promise<void> {
  try {
    const existing = await lstat(path).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return undefined;
      throw error;
    });
    if (existing) throw new Error('Project destination already exists.');
    await access(dirname(path), constants.W_OK | constants.X_OK);
  } catch (cause) {
    throw new ProjectFileError('WRITE_FAILED', path, { cause });
  }
}

function editProject(
  path: string,
  base: Project,
  isNew: boolean,
  { signal, dryRun }: EditorOptions,
): ProjectEditor {
  signal?.throwIfAborted();
  let draft = base;
  let baseline = serializeProject(base);
  let busy = false;
  let historyPending = false;
  const onlineMedia = new OnlineMediaLibrary();
  const ensureIdle = () => {
    signal?.throwIfAborted();
    if (busy)
      throw new SdkError(
        'EDITOR_BUSY',
        'Await the active SDK operation first.',
      );
  };
  const ensureEditable = () => {
    ensureIdle();
    if (historyPending)
      throw new SdkError(
        'HISTORY_PENDING',
        'Save the pending undo or redo before making another edit.',
      );
  };
  async function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    ensureIdle();
    busy = true;
    try {
      return await operation();
    } finally {
      busy = false;
    }
  }
  const restore = (direction: typeof undoEdit) => {
    ensureEditable();
    // The shared commit check also recognizes edits that cancel out.
    if (projectRevision(commitEdit(base, draft)) !== projectRevision(base))
      throw new SdkError(
        'HISTORY_PENDING',
        'Save staged edits before undo or redo.',
      );
    draft = direction(base);
    historyPending = true;
  };
  async function outputPath(file: string) {
    const destination = await canonicalProjectFilePath(resolve(file));
    // A new project's filename must remain available for the final save.
    if (
      destination === path ||
      ((process.platform === 'darwin' || process.platform === 'win32') &&
        destination.toLowerCase() === path.toLowerCase())
    )
      throw new SdkError(
        'PROJECT_OUTPUT',
        'Choose an output path different from the project file.',
      );
    return destination;
  }
  async function output<T>(
    file: string,
    jobSignal: AbortSignal | undefined,
    run: (options: VideoTimelineOptions) => Promise<T>,
    burnSubtitles = true,
  ): Promise<T> {
    return exclusive(async () => {
      if (dryRun)
        throw new SdkError(
          'DRY_RUN_OUTPUT',
          'Preview and render outputs are disabled in a dry run.',
        );
      const destination = await outputPath(file);
      const combined =
        signal && jobSignal
          ? AbortSignal.any([signal, jobSignal])
          : (signal ?? jobSignal);
      combined?.throwIfAborted();
      return run({
        ...(await resolveProjectRender(draft, path, { burnSubtitles })),
        output: destination,
        signal: combined,
      });
    });
  }
  const project: ProjectDraft = {
    path,
    inspect: () => inspectProject(draft, path),
    inspectTimeline: (frame) => inspectTimeline(draft, path, frame),
    history: () => getEditHistory(historyPending ? draft : base),
    checkMedia: () => checkProjectMedia(draft, path),
    cachePreview: (size) =>
      exclusive(async () => {
        if (dryRun) throw new Error('Preview caching writes an output file.');
        return renderPreviewCache(draft, path, size, { signal });
      }),
    controlDesktop: (request) =>
      exclusive(async () => {
        if (dryRun)
          throw new Error('Desktop control is unavailable in dry runs.');
        return controlDesktopProject(path, request);
      }),
    copyProject: (destination, bundle) =>
      exclusive(async () => {
        if (dryRun)
          throw new Error('A project copy requires writing output files.');
        if (
          projectRevision(commitEdit(base, draft)) !== projectRevision(base) ||
          historyPending
        )
          throw new Error('Save pending edits before copying the project.');
        return copyProjectFile(
          base,
          path,
          await outputPath(destination),
          bundle,
        );
      }),
    importMedia: async (file) => {
      ensureEditable();
      return exclusive(async () => {
        const prepared = await prepareMediaAsset(draft, path, file);
        signal?.throwIfAborted();
        draft = prepared.project;
        return structuredClone(prepared.result);
      });
    },
    searchOnlineMedia: (input) => onlineMedia.search(input),
    importOnlineMedia: (id, directory) => {
      ensureEditable();
      return exclusive(async () => {
        const { title, sourceUrl } = onlineMedia.source(id);
        const existing = draft.assets.find(
          (asset) =>
            asset.name === title && asset.provenance?.sourceUrl === sourceUrl,
        );
        if (existing) {
          const found = (await checkProjectMedia(draft, path)).find(
            (entry) =>
              entry.assetId === existing.id && entry.status === 'available',
          );
          if (found) {
            const prepared = await prepareMediaAsset(draft, path, found.path, {
              localMediaOnly: true,
            });
            return structuredClone(prepared.result);
          }
        }
        const download = await onlineMedia.download(id, resolve(directory));
        try {
          const prepared = await prepareOnlineMediaAsset(draft, path, download);
          signal?.throwIfAborted();
          if (dryRun) await download.discard();
          else draft = prepared.project;
          return structuredClone(prepared.result);
        } catch (error) {
          await download.discard();
          throw error;
        }
      });
    },
    removeMedia: (id) => {
      ensureEditable();
      draft = removeAssetFromProject(draft, id);
    },
    importFont: (id, file) => {
      ensureEditable();
      return exclusive(async () => {
        const prepared = await prepareEmbeddedFont(draft, id, resolve(file));
        signal?.throwIfAborted();
        draft = prepared.project;
        return prepared.result;
      });
    },
    freezeFrame: (id, at, frames, file) =>
      exclusive(async () => {
        if (dryRun) throw new Error('Freeze frames require an output PNG.');
        if (historyPending)
          throw new Error('Save the pending history operation first.');
        const prepared = await prepareFreezeFrame(
          draft,
          path,
          id,
          at,
          frames,
          await outputPath(file),
        );
        draft = prepared.project;
        return prepared.result;
      }),
    relinkMedia: async (id, file) => {
      ensureEditable();
      return exclusive(async () => {
        const prepared = await prepareMediaRelink(draft, path, id, file);
        signal?.throwIfAborted();
        draft = prepared.project;
        return structuredClone(prepared.result);
      });
    },
    separateDialogue: (id, directory) =>
      exclusive(async () => {
        if (dryRun)
          throw new Error('Dialogue separation requires output files.');
        const source = (await checkProjectMedia(draft, path)).find(
          (entry) => entry.assetId === id,
        );
        if (source?.status !== 'available')
          throw new Error('Choose an available audio or video asset.');
        return separateDialogue(source.path, directory, signal);
      }),
    importSubtitles: async (file) => {
      ensureEditable();
      return exclusive(async () => {
        const { format, cues } = await readSubtitleFile(file, signal);
        signal?.throwIfAborted();
        draft = previewTransaction(draft, {
          expectedRevision: projectRevision(base),
          operations: [{ type: 'subtitle.import', cues }],
        }).project;
        return { format, cueCount: cues.length };
      });
    },
    exportSubtitles: (file) =>
      exclusive(async () => {
        if (dryRun)
          throw new SdkError(
            'DRY_RUN_OUTPUT',
            'Sidecar export is disabled in a dry run.',
          );
        return writeSubtitleFile(
          await outputPath(file),
          draft.subtitles?.cues ?? [],
          signal,
        );
      }),
    copyClips: (ids) => copyClips(draft, ids),
    cutClips: (ids) => {
      const [result] = project.apply({ type: 'clips.cut', ids });
      return clipClipboardSchema.parse(result?.clipboard);
    },
    apply: (...operations) => {
      ensureEditable();
      const result = previewTransaction(draft, {
        expectedRevision: projectRevision(base),
        operations,
      });
      draft = result.project;
      return structuredClone(result.results);
    },
    undo: () => restore(undoEdit),
    redo: () => restore(redoEdit),
    previewFrame: (frame, file, options = {}) =>
      output(file, options.signal, (plan) =>
        renderTimelineFrame({
          ...plan,
          maxDimension: options.maxDimension,
          range: { startFrame: frame, endFrame: frame + 1 },
        }),
      ),
    previewContactSheet: (frames, file, options = {}) => {
      const samples = [...frames];
      return output(file, options.signal, (plan) =>
        renderContactSheet(
          { ...plan, maxDimension: options.maxDimension },
          samples,
          options.columns ?? Math.min(4, samples.length),
        ),
      );
    },
    render: (file, options = {}) =>
      output(
        file,
        options.signal,
        (plan) =>
          renderVideoTimeline({
            ...plan,
            codec: options.codec,
            outputSize: options.outputSize,
            videoBitrateKbps: options.videoBitrateKbps,
            audioBitrateKbps: options.audioBitrateKbps,
            audioSampleRate: options.audioSampleRate,
            audioChannels: options.audioChannels,
            outputFrameRate: options.outputFrameRate,
            quality: options.quality,
            resolution: options.resolution,
            ...(options.onProgress ? { onProgress: options.onProgress } : {}),
          }),
        options.burnSubtitles,
      ),
  };
  return {
    project,
    save: (options = {}) =>
      exclusive(async () => {
        const simulate = dryRun || (options.dryRun ?? false);
        const baseRevision = projectRevision(base);
        const next = historyPending
          ? draft
          : commitEdit(base, draft, options.label ?? 'script edit');
        if (isNew) {
          await checkNewDestination(path);
          signal?.throwIfAborted();
          if (!simulate) await writeProjectFile(next, path, signal);
        } else {
          await updateProjectFile(
            path,
            async (current) => {
              if (serializeProject(current) !== baseline)
                throw new EditError(
                  'REVISION_CONFLICT',
                  'Project content changed. Reopen the project before saving.',
                );
              return { project: next, result: undefined };
            },
            {
              expectedRevision: baseRevision,
              dryRun: simulate,
              history: 'restore',
              signal,
            },
          );
        }
        const revision = projectRevision(next);
        const result: SaveResult = {
          path,
          projectId: next.metadata.id,
          baseRevision,
          revision,
          changed: isNew || revision !== baseRevision,
          created: isNew,
          dryRun: simulate,
        };
        if (!simulate) {
          isNew = false;
          base = draft = next;
          baseline = serializeProject(next);
          historyPending = false;
        }
        return result;
      }),
  };
}

export interface ScriptContext {
  readonly project: ProjectDraft;
  readonly args: readonly string[];
  readonly dryRun: boolean;
  readonly signal: AbortSignal;
}

/** Default export of a script. Return JSON data to include it in the CLI result. */
export type OpenCutScript = (
  context: ScriptContext,
) => unknown | Promise<unknown>;

export { defineVideo } from '@opencut/core';
export type { VideoDefinition } from '@opencut/core';
export {
  compileVideo,
  migrateProject,
  VideoDefinitionError,
  VideoMigrationError,
} from '@opencut/core/node';
export type { CompiledVideo } from '@opencut/core/node';

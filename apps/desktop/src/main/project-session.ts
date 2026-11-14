import { usesLayerTransform } from '@opencut/shared';
import { isAbsolute, resolve, basename } from 'node:path';
import { renderTimelineFrame, separateDialogue } from '@opencut/media';
import {
  createProject,
  commitEdit,
  clipClipboardSchema,
  type ClipClipboard,
  addAssetClip,
  serializeProject,
  projectRevision,
  parseEditTransaction,
  checkProjectRevision,
  executeTransaction,
  undoEdit,
  redoEdit,
  subtitleTextLayers,
  subtitleFormat,
  type Project,
  type SubtitleFormat,
} from '@opencut/core';
import {
  canonicalProjectFilePath,
  prepareMediaAsset,
  prepareFreezeFrame,
  prepareEmbeddedFont,
  prepareMediaRelink,
  removeAssetFromProject,
  checkProjectMedia,
  copyProjectFile,
  readProjectFile,
  readSubtitleFile,
  writeSubtitleFile,
  writeProjectFile,
  inspectMediaFile,
  resolveMediaReference,
  resolveProjectRender,
  acquireProjectWriter,
  SessionError,
  type ProjectWriter,
  type DesktopControlRequest,
} from '@opencut/core/node';
import type {
  DesktopProject,
  NewProjectInput,
  ProjectReply,
  ImportProgress,
  AssetClipInput,
  HistoryInput,
} from '../bridge.js';
import { timelineOperationTypes } from '../bridge.js';
import type { OnlineMediaLibrary } from './online-media.js';

export interface ProjectDialogs {
  open(): Promise<string | null>;
  importMedia?(): Promise<string[] | null>;
  relinkMedia?(): Promise<string | null>;
  saveDialogue?(): Promise<string | null>;
  saveProjectCopy?(bundle: boolean): Promise<string | null>;
  saveFreezeFrame?(): Promise<string | null>;
  savePreviewFrame?(): Promise<string | null>;
  importFont?(): Promise<string | null>;
  importSubtitles?(): Promise<string | null>;
  exportSubtitles?(format: SubtitleFormat): Promise<string | null>;
  save(): Promise<string | null>;
  unsaved(): Promise<'save' | 'discard' | 'cancel'>;
}
export type ProjectAction =
  | 'current'
  | 'create'
  | 'open'
  | 'save'
  | 'close'
  | 'edit'
  | 'undo'
  | 'redo'
  | 'import'
  | 'importOnline'
  | 'importSubtitles'
  | 'exportSubtitles'
  | 'removeAsset'
  | 'relinkAsset'
  | 'separateDialogue'
  | 'copyProject'
  | 'freezeFrame'
  | 'importFont'
  | 'exportFrame'
  | 'addAssetClip';

/** Main-process session. React never submits a path or a replacement document. */
export class ProjectSession {
  private state: DesktopProject | null = null;
  // Readers see the last accepted state while a mutation is being persisted.
  private publishedState: DesktopProject | null = null;
  private baseline: string | null = null;
  private busy = false;
  private savedRevision = 0;
  private writer: ProjectWriter | null = null;
  private subtitleText = new WeakMap<
    Project,
    Map<string, ReturnType<typeof subtitleTextLayers>[number][number]>
  >();

  constructor(
    private readonly dialogs: ProjectDialogs,
    private readonly onProgress: (progress: ImportProgress) => void = () => {},
    private readonly onChange: (
      state: DesktopProject | null,
    ) => void = () => {},
    private readonly onlineMedia?: {
      source: OnlineMediaLibrary['source'];
      download: (id: string) => ReturnType<OnlineMediaLibrary['download']>;
    },
    private readonly desktopControl?: (
      control: DesktopControlRequest,
      state: DesktopProject,
    ) => Promise<unknown>,
  ) {}

  /** Also used on shutdown; OS ownership is released automatically after a crash. */
  async dispose() {
    await this.writer?.close();
    this.writer = null;
  }

  private async serve(writer: ProjectWriter) {
    await writer.serve(
      async ({ update, options }) => {
        if (!update && this.writer === writer && this.publishedState)
          return this.publishedState.project;
        if (this.busy)
          throw new SessionError(
            'SESSION_BUSY',
            'A project operation is in progress. Retry when it finishes.',
          );
        const state = this.state;
        if (!state || this.writer !== writer)
          throw new SessionError('SESSION_CHANGED', 'Project session changed.');
        if (!update) return state.project;
        this.busy = true;
        try {
          let next = state.project;
          let media = state.media;
          await writer.update(
            async (disk) => {
              if (serializeProject(disk) !== this.baseline)
                throw new SessionError(
                  'REVISION_CONFLICT',
                  'Project changed on disk. Reopen it before editing.',
                );
              const changed = update(state.project);
              next =
                options?.history === 'restore'
                  ? changed
                  : commitEdit(state.project, changed, options?.label);
              if (
                JSON.stringify(state.project.assets) !==
                JSON.stringify(next.assets)
              )
                media = await checkProjectMedia(next, writer.path);
              return { project: next, result: undefined };
            },
            { ...options, history: 'restore' },
          );
          const json = serializeProject(next);
          if (!options?.dryRun && json !== this.baseline) {
            this.state = { ...state, project: next, media, dirty: false };
            this.publishedState = this.state;
            this.baseline = json;
            this.savedRevision = projectRevision(next);
            this.onChange(structuredClone(this.state));
          }
          return this.state!.project;
        } finally {
          this.busy = false;
        }
      },
      async (control) => {
        const state = this.publishedState;
        if (
          !state ||
          this.writer !== writer ||
          this.busy ||
          !this.desktopControl
        )
          throw new SessionError(
            'SESSION_BUSY',
            'Desktop is not ready for a control request.',
          );
        return this.desktopControl(control, state);
      },
    );
  }

  captureExport(input: { projectId: string; expectedRevision: number }) {
    if (this.busy) throw new Error('Wait for the project operation to finish.');
    const state = this.publishedState;
    if (!state || input.projectId !== state.project.metadata.id)
      throw new Error('Project changed. Open the export settings again.');
    checkProjectRevision(state.project, input.expectedRevision);
    return structuredClone(state);
  }

  private scopedRequest(
    input: unknown,
    fields: string[],
    message: string,
    validFields: (request: Record<string, unknown>) => boolean,
  ) {
    const state = this.state;
    if (!state || !input || typeof input !== 'object') throw new Error(message);
    const request = input as Record<string, unknown>;
    const { projectId, expectedRevision } = request;
    if (
      Object.keys(request).sort().join(',') !==
        ['projectId', 'expectedRevision', ...fields].sort().join(',') ||
      projectId !== state.project.metadata.id ||
      !validFields(request) ||
      typeof expectedRevision !== 'number' ||
      !Number.isSafeInteger(expectedRevision)
    )
      throw new Error(message);
    checkProjectRevision(state.project, expectedRevision);
    return state;
  }

  captureText(input: HistoryInput & { clipId: string }) {
    const project = this.publishedState?.project;
    if (
      !project ||
      project.metadata.id !== input.projectId ||
      projectRevision(project) !== input.expectedRevision
    )
      return null;
    const clip = project.clips.find((entry) => entry.id === input.clipId);
    const { width, height } = project.settings;
    if (clip?.text)
      return {
        width,
        height,
        text: clip.text,
        visual: clip.visual ?? {},
        neutral: usesLayerTransform(clip.visual?.rotation, !!clip.keyframes),
      };
    let layers = this.subtitleText.get(project);
    if (!layers) {
      layers = new Map(
        subtitleTextLayers(project)
          .flat()
          .map((layer) => [layer.id, layer]),
      );
      this.subtitleText.set(project, layers);
    }
    const layer = layers.get(input.clipId);
    return layer
      ? {
          width,
          height,
          text: layer.text,
          visual: layer.visual,
          neutral: !!layer.keyframes,
        }
      : null;
  }

  async libraryAsset(id: unknown, scope?: HistoryInput) {
    const state = this.state;
    if (!state || typeof id !== 'string')
      throw new Error('Select a library asset.');
    if (scope) {
      if (scope.projectId !== state.project.metadata.id)
        throw new Error('Project changed.');
      checkProjectRevision(state.project, scope.expectedRevision);
    }
    const asset = state.project.assets.find((asset) => asset.id === id);
    if (!asset) throw new Error('Asset is not in the current project.');
    const path = resolveMediaReference(
      asset.file,
      state.path ?? resolve('Untitled.opencut.json'),
    );
    if ((await inspectMediaFile(path)).status !== 'available')
      throw new Error('Media source is unavailable.');
    if (this.state !== state) throw new Error('Project changed.');
    return { asset, path };
  }

  get needsCloseGuard(): boolean {
    return this.busy || this.state?.dirty === true;
  }

  /** Resolve only an ID in the active session; never accept a renderer path. */
  async previewAsset(id: unknown) {
    const state = this.state;
    if (this.busy) throw new Error('Wait for the project operation to finish.');
    if (!state) throw new Error('Open a project with imported video first.');
    if (typeof id !== 'string') throw new Error('Expected a media asset ID.');
    const asset = state.project.assets.find((asset) => asset.id === id);
    if (!asset) throw new Error('Video asset is not in the current project.');
    const path = resolveMediaReference(
      asset.file,
      state.path ?? resolve('Untitled.opencut.json'),
    );
    const availability = await inspectMediaFile(path);
    if (availability.status !== 'available')
      throw new Error(availability.message);
    if (this.state !== state || this.busy)
      throw new Error(
        'Project changed while opening the preview. Select the asset again.',
      );
    return { asset, path };
  }

  async run(action: ProjectAction, input?: unknown): Promise<ProjectReply> {
    if (action === 'current')
      return {
        ok: true,
        state: structuredClone(this.publishedState),
        canceled: false,
      };
    if (this.busy)
      return {
        ok: false,
        error: 'A project operation is already in progress. Please wait.',
      };
    this.busy = true;
    const priorState = this.state;
    let discardDownload: (() => Promise<void>) | undefined;
    let discardFreeze: (() => Promise<void>) | undefined;
    try {
      let canceled = false;
      let clipboard: ClipClipboard | undefined;
      let notice: string | undefined;
      switch (action) {
        case 'create': {
          // Reject unknown fields, then use the core schema for all model validation.
          if (
            !input ||
            typeof input !== 'object' ||
            Array.isArray(input) ||
            Object.keys(input).some(
              (key) => key !== 'name' && key !== 'settings',
            )
          )
            throw new Error('Expected a project name and settings.');
          const options = input as NewProjectInput;
          const project = createProject({
            name: options.name,
            settings: options.settings,
          });
          if (!(await this.confirmDiscard())) {
            canceled = true;
            break;
          }
          await this.dispose();
          this.state = { project, path: null, dirty: true, media: [] };
          this.baseline = null;
          break;
        }
        case 'open': {
          const selected = await this.dialogs.open();
          if (!selected) {
            canceled = true;
            break;
          }
          const path = await canonicalProjectFilePath(selected);
          // Validate before prompting, then reread under ownership to close the
          // CLI-write/open race. A second Electron window must not become a writer.
          if (this.writer?.path !== path) await readProjectFile(path);
          const writer =
            this.writer?.path === path
              ? this.writer
              : await acquireProjectWriter(path);
          try {
            const project = await writer.read();
            const media = await checkProjectMedia(project, path);
            if (!(await this.confirmDiscard())) {
              canceled = true;
              if (writer !== this.writer) await writer.close();
              break;
            }
            if (writer !== this.writer) {
              await this.serve(writer);
              await this.dispose();
              this.writer = writer;
            }
            this.state = { project, path, dirty: false, media };
            this.baseline = serializeProject(project);
            this.savedRevision = projectRevision(project);
          } catch (error) {
            if (writer !== this.writer) await writer.close();
            throw error;
          }
          break;
        }
        case 'import':
        case 'importOnline':
        case 'removeAsset':
        case 'relinkAsset':
        case 'separateDialogue':
        case 'addAssetClip': {
          const state = this.state;
          if (!state) throw new Error('Open or create a project first.');
          const allowed = [
            'projectId',
            'expectedRevision',
            ...(action === 'import'
              ? ['paths']
              : action === 'importOnline'
                ? ['resultId']
                : action === 'removeAsset' ||
                    action === 'relinkAsset' ||
                    action === 'separateDialogue'
                  ? ['assetId']
                  : ['assetId', 'trackId', 'mediaType', 'at', 'insert']),
          ];
          if (
            !input ||
            typeof input !== 'object' ||
            Array.isArray(input) ||
            Object.keys(input).some((key) => !allowed.includes(key))
          )
            throw new Error('Invalid media request.');
          const request = input as Record<string, unknown>;
          if (request.projectId !== state.project.metadata.id)
            throw new Error('Project changed. Retry in the current project.');
          if (typeof request.expectedRevision !== 'number')
            throw new Error('Expected a project revision.');
          checkProjectRevision(state.project, request.expectedRevision);
          const path = state.path ?? resolve('Untitled.opencut.json');
          let project = state.project;
          if (action === 'import' || action === 'importOnline') {
            const online = action === 'importOnline';
            let download:
              Awaited<ReturnType<OnlineMediaLibrary['download']>> | undefined;
            let paths: unknown;
            if (online) {
              if (typeof request.resultId !== 'string' || !this.onlineMedia)
                throw new Error('Choose an online search result.');
              const { title, sourceUrl } = this.onlineMedia.source(
                request.resultId,
              );
              const existing = project.assets.find(
                (asset) =>
                  asset.name === title &&
                  asset.provenance?.sourceUrl === sourceUrl,
              );
              if (
                existing &&
                (await this.libraryAsset(existing.id).catch(() => null))
              ) {
                notice = 'Media is already in the project.';
                break;
              }
              download = await this.onlineMedia.download(request.resultId);
              discardDownload = download.discard;
              paths = [download.path];
            } else {
              paths =
                request.paths === undefined
                  ? await this.dialogs.importMedia?.()
                  : request.paths;
              if (paths == null && request.paths === undefined) {
                canceled = true;
                break;
              }
            }
            if (
              !Array.isArray(paths) ||
              paths.length < 1 ||
              paths.length > 500 ||
              !paths.every(
                (source): source is string =>
                  typeof source === 'string' &&
                  isAbsolute(source) &&
                  source.length <= 32768,
              )
            )
              throw new Error('Choose between 1 and 500 local media files.');

            let imported = 0;
            for (const [index, source] of paths.entries()) {
              const progress = !online && {
                total: paths.length,
                name: basename(source),
              };
              if (progress) this.onProgress({ completed: index, ...progress });
              const prepared = await prepareMediaAsset(
                project,
                path,
                source,
                download && { localMediaOnly: true },
              );
              project = prepared.project;
              if (prepared.result.imported) {
                const { asset } = prepared.result;
                if (download) {
                  const metadata = asset.metadata;
                  const timedImage =
                    download.kind === 'image' &&
                    metadata?.kind === 'video' &&
                    (metadata.formatName === 'gif' ||
                      metadata.formatName === 'apng');
                  if (metadata?.kind !== download.kind && !timedImage)
                    throw new Error(
                      'The downloaded file does not match the selected media type.',
                    );
                  asset.name = download.title;
                  asset.provenance = download.provenance;
                }
                // Unsaved projects store absolute references so the first save can be anywhere.
                if (!state.path)
                  asset.file = {
                    type: 'absolute',
                    path: prepared.result.source.path,
                  };
                imported++;
              }
              if (progress)
                this.onProgress({ completed: index + 1, ...progress });
            }
            project = commitEdit(
              state.project,
              project,
              online ? 'Import online media' : 'Import media',
            );
            notice = online
              ? 'Online media added to the project.'
              : `${imported} imported, ${paths.length - imported} already in library.`;
          } else {
            if (typeof request.assetId !== 'string')
              throw new Error('Expected an asset ID.');
            if (action === 'separateDialogue') {
              const source = await this.libraryAsset(request.assetId);
              if (!source) throw new Error('Choose an available media file.');
              const directory = await this.dialogs.saveDialogue?.();
              if (!directory) {
                canceled = true;
                break;
              }
              const stems = await separateDialogue(source.path, directory);
              for (const file of [stems.dialogue, stems.background]) {
                const prepared = await prepareMediaAsset(project, path, file, {
                  localMediaOnly: true,
                });
                project = prepared.project;
                if (!state.path)
                  prepared.result.asset.file = { type: 'absolute', path: file };
              }
              project = commitEdit(state.project, project, 'Separate dialogue');
              notice = 'Dialogue and background added to the media library.';
            } else if (action === 'relinkAsset') {
              const file = await this.dialogs.relinkMedia?.();
              if (!file) {
                canceled = true;
                break;
              }
              const prepared = await prepareMediaRelink(
                project,
                path,
                request.assetId,
                file,
                !state.path,
              );
              project = commitEdit(project, prepared.project, 'Relink media');
              notice = 'Media relinked.';
            } else if (action === 'removeAsset') {
              project = commitEdit(
                project,
                removeAssetFromProject(project, request.assetId),
                'Remove media',
              );
            } else {
              if (
                (request.mediaType !== 'video' &&
                  request.mediaType !== 'audio') ||
                (request.insert !== undefined &&
                  typeof request.insert !== 'boolean') ||
                !Number.isSafeInteger(request.at) ||
                (request.at as number) < 0 ||
                (request.trackId !== undefined &&
                  typeof request.trackId !== 'string')
              )
                throw new Error('Invalid clip destination.');
              await this.libraryAsset(request.assetId);
              project = addAssetClip(
                project,
                request as unknown as AssetClipInput,
              );
              if (request.insert) notice = 'Media inserted.';
            }
          }
          const media = await checkProjectMedia(project, path);
          this.state = {
            ...state,
            project,
            media,
            dirty: serializeProject(project) !== this.baseline,
          };
          break;
        }
        case 'edit':
        case 'importSubtitles':
        case 'exportSubtitles':
        case 'undo':
        case 'redo': {
          if (!this.state) throw new Error('Open a project before editing.');
          const allowed =
            action === 'edit'
              ? ['projectId', 'expectedRevision', 'label', 'operations']
              : action === 'exportSubtitles'
                ? ['projectId', 'expectedRevision', 'format']
                : ['projectId', 'expectedRevision'];
          if (
            !input ||
            typeof input !== 'object' ||
            Array.isArray(input) ||
            Object.keys(input).some((key) => !allowed.includes(key))
          )
            throw new Error('Invalid editing request.');
          const { projectId, ...command } = input as Record<string, unknown>;
          if (projectId !== this.state.project.metadata.id)
            throw new Error('Project changed. Retry in the current project.');
          const before = this.state.project;
          if (typeof command.expectedRevision !== 'number')
            throw new Error('Expected a project revision.');
          checkProjectRevision(before, command.expectedRevision);
          let project;
          if (action === 'exportSubtitles') {
            const { format } = command;
            if (format !== 'srt' && format !== 'vtt')
              throw new Error('Choose SRT or WebVTT.');
            const file = await this.dialogs.exportSubtitles?.(format);
            if (!file) {
              canceled = true;
              break;
            }
            if (subtitleFormat(file) !== format)
              throw new Error(`Use the .${format} extension for this sidecar.`);
            const output = await writeSubtitleFile(
              file,
              before.subtitles?.cues ?? [],
            );
            notice = `Exported ${output.cueCount} subtitle cues to ${output.path}.`;
            break;
          } else if (action === 'importSubtitles') {
            const file = await this.dialogs.importSubtitles?.();
            if (!file) {
              canceled = true;
              break;
            }
            const { cues } = await readSubtitleFile(file);
            project = executeTransaction(before, {
              expectedRevision: command.expectedRevision,
              label: 'Import subtitles',
              operations: [{ type: 'subtitle.import', cues }],
            }).project;
            notice = `Imported ${cues.length} subtitle cues.`;
          } else if (action === 'edit') {
            const transaction = parseEditTransaction(command);
            if (
              transaction.operations.some(
                (operation) =>
                  !timelineOperationTypes.some(
                    (type) => type === operation.type,
                  ),
              )
            )
              throw new Error('Only timeline clip editing is available.');
            const result = executeTransaction(before, transaction);
            project = result.project;
            const cut = result.results.findLast(
              (entry) => entry.type === 'clips.cut',
            );
            if (cut) clipboard = clipClipboardSchema.parse(cut.clipboard);
            if (
              transaction.operations.some(
                (op) =>
                  op.type === 'clip.insert' ||
                  (op.type === 'clips.paste' && op.insert) ||
                  (op.type === 'clips.remove' && op.ripple) ||
                  op.type === 'timeline.close-gap',
              )
            )
              notice = transaction.label;
          } else {
            project =
              action === 'undo'
                ? undoEdit(before, command.expectedRevision)
                : redoEdit(before, command.expectedRevision);
          }
          const media =
            JSON.stringify(before.assets) !== JSON.stringify(project.assets)
              ? await checkProjectMedia(
                  project,
                  this.state.path ?? resolve('Untitled.opencut.json'),
                )
              : this.state.media;
          this.state = {
            ...this.state,
            project,
            media,
            dirty: serializeProject(project) !== this.baseline,
          };
          break;
        }
        case 'exportFrame': {
          const state = this.scopedRequest(
            input,
            ['at'],
            'Invalid frame export request.',
            ({ at }) =>
              typeof at === 'number' && Number.isSafeInteger(at) && at >= 0,
          );
          const { at } = input as { at: number };
          const path = await this.dialogs.savePreviewFrame?.();
          if (!path) {
            canceled = true;
            break;
          }
          const plan = await resolveProjectRender(
            state.project,
            state.path ?? resolve('Untitled.opencut.json'),
          );
          const frame = await renderTimelineFrame({
            ...plan,
            output: path,
            range: { startFrame: at, endFrame: at + 1 },
          });
          notice = `Saved frame to ${frame.path}`;
          break;
        }
        case 'importFont': {
          const state = this.scopedRequest(
            input,
            ['id'],
            'Invalid font import request.',
            ({ id }) => typeof id === 'string',
          );
          const { id } = input as { id: string };
          const file = await this.dialogs.importFont?.();
          if (!file) {
            canceled = true;
            break;
          }
          const prepared = await prepareEmbeddedFont(state.project, id, file);
          const project = commitEdit(
            state.project,
            prepared.project,
            'Import font',
          );
          this.state = {
            ...state,
            project,
            dirty: serializeProject(project) !== this.baseline,
          };
          notice = `Imported font ${prepared.result.file}`;
          break;
        }
        case 'freezeFrame': {
          const state = this.scopedRequest(
            input,
            ['at', 'clipId', 'frames'],
            'Invalid freeze-frame request.',
            ({ at, clipId, frames }) =>
              typeof clipId === 'string' &&
              typeof at === 'number' &&
              Number.isSafeInteger(at) &&
              at >= 0 &&
              typeof frames === 'number' &&
              Number.isSafeInteger(frames) &&
              frames >= 1,
          );
          const { clipId, at, frames } = input as {
            clipId: string;
            at: number;
            frames: number;
          };
          const file = await this.dialogs.saveFreezeFrame?.();
          if (!file) {
            canceled = true;
            break;
          }
          const path = state.path ?? resolve('Untitled.opencut.json');
          const prepared = await prepareFreezeFrame(
            state.project,
            path,
            clipId,
            at,
            frames,
            file,
            !state.path,
          );
          discardFreeze = prepared.discard;
          const project = commitEdit(
            state.project,
            prepared.project,
            'Freeze frame',
          );
          this.state = {
            ...state,
            project,
            dirty: true,
            media: await checkProjectMedia(project, path),
          };
          notice = 'Freeze frame inserted.';
          break;
        }
        case 'copyProject': {
          if (!this.state) throw new Error('Open or create a project first.');
          const state = this.scopedRequest(
            input,
            ['bundle'],
            'Invalid project copy request.',
            ({ bundle }) => typeof bundle === 'boolean',
          );
          const { bundle } = input as { bundle: boolean };
          const path = await this.dialogs.saveProjectCopy?.(bundle);
          if (!path) {
            canceled = true;
            break;
          }
          const result = await copyProjectFile(
            state.project,
            state.path ?? resolve('Untitled.opencut.json'),
            path,
            bundle,
          );
          notice = `Saved revision ${result.revision} to ${result.path}`;
          break;
        }
        case 'save':
          canceled = !(await this.save());
          break;
        case 'close':
          if (!(await this.confirmDiscard())) {
            canceled = true;
            break;
          }
          this.state = null;
          this.baseline = null;
          await this.dispose();
      }
      if (this.state?.path && this.state.dirty) await this.save();
      this.publishedState = this.state;
      return {
        ok: true,
        state: structuredClone(this.state),
        canceled,
        ...(notice ? { notice } : {}),
        ...(clipboard ? { clipboard } : {}),
      };
    } catch (error) {
      await discardDownload?.().catch(() => {});
      if (!(
        error instanceof SessionError && error.code === 'COMMIT_OUTCOME_UNKNOWN'
      ))
        await discardFreeze?.().catch(() => {});
      if (
        [
          'edit',
          'undo',
          'redo',
          'import',
          'importOnline',
          'importSubtitles',
          'removeAsset',
          'relinkAsset',
          'separateDialogue',
          'freezeFrame',
          'importFont',
          'addAssetClip',
        ].includes(action)
      )
        this.state = priorState;
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.busy = false;
    }
  }

  private async confirmDiscard(): Promise<boolean> {
    if (!this.state?.dirty) return true;
    const choice = await this.dialogs.unsaved();
    if (choice === 'cancel') return false;
    return choice === 'discard' || (await this.save());
  }

  private async save(): Promise<boolean> {
    const state = this.state;
    if (!state) throw new Error('Create or open a project before saving.');
    if (state.path) {
      // Even a no-op save must not overwrite a newer CLI/external document.
      if (!this.writer)
        throw new Error('Project writer is unavailable. Reopen the project.');
      await this.writer.update(
        async (current) => {
          if (serializeProject(current) !== this.baseline)
            throw new Error(
              'Project changed on disk. Open it again to reload before saving.',
            );
          return { project: state.project, result: undefined };
        },
        { expectedRevision: this.savedRevision, history: 'preserve' },
      );
    } else {
      const selected = await this.dialogs.save();
      if (!selected) return false;
      const path = await canonicalProjectFilePath(selected);
      const writer = await acquireProjectWriter(path);
      try {
        await writeProjectFile(state.project, path);
        await this.serve(writer);
      } catch (error) {
        await writer.close();
        throw error;
      }
      this.writer = writer;
      state.path = path;
    }
    state.dirty = false;
    this.baseline = serializeProject(state.project);
    this.savedRevision = projectRevision(state.project);
    return true;
  }
}

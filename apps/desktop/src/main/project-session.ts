import { isAbsolute, resolve, basename } from 'node:path';
import {
  createProject,
  commitEdit,
  addAssetClip,
  serializeProject,
  projectRevision,
  parseEditTransaction,
  checkProjectRevision,
  executeTransaction,
  undoEdit,
  redoEdit,
} from '@opencut/core';
import {
  canonicalProjectFilePath,
  prepareMediaAsset,
  removeAssetFromProject,
  checkProjectMedia,
  readProjectFile,
  writeProjectFile,
  inspectMediaFile,
  resolveMediaReference,
  acquireProjectWriter,
  SessionError,
  type ProjectWriter,
} from '@opencut/core/node';
import type {
  DesktopProject,
  NewProjectInput,
  ProjectReply,
  ImportProgress,
  AssetClipInput,
} from '../bridge.js';

export interface ProjectDialogs {
  open(): Promise<string | null>;
  importMedia?(): Promise<string[] | null>;
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
  | 'removeAsset'
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

  constructor(
    private readonly dialogs: ProjectDialogs,
    private readonly onProgress: (progress: ImportProgress) => void = () => {},
    private readonly onChange: (
      state: DesktopProject | null,
    ) => void = () => {},
  ) {}

  /** Also used on shutdown; OS ownership is released automatically after a crash. */
  async dispose() {
    await this.writer?.close();
    this.writer = null;
  }

  private async serve(writer: ProjectWriter) {
    await writer.serve(async ({ update, options }) => {
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
    });
  }

  async libraryAsset(id: unknown) {
    const state = this.state;
    if (!state || typeof id !== 'string')
      throw new Error('Select a library asset.');
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
    try {
      let canceled = false;
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
        case 'removeAsset':
        case 'addAssetClip': {
          const state = this.state;
          if (!state) throw new Error('Open or create a project first.');
          const allowed = [
            'projectId',
            'expectedRevision',
            ...(action === 'import'
              ? ['paths']
              : action === 'removeAsset'
                ? ['assetId']
                : ['assetId', 'trackId', 'mediaType', 'at']),
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
          if (action === 'import') {
            const paths =
              request.paths === undefined
                ? await this.dialogs.importMedia?.()
                : request.paths;
            if (paths == null && request.paths === undefined) {
              canceled = true;
              break;
            }
            if (
              !Array.isArray(paths) ||
              paths.length < 1 ||
              paths.length > 500 ||
              paths.some(
                (path) =>
                  typeof path !== 'string' ||
                  !isAbsolute(path) ||
                  path.length > 32768,
              )
            )
              throw new Error('Choose between 1 and 500 local media files.');
            let imported = 0;
            for (const [index, source] of paths.entries()) {
              this.onProgress({
                completed: index,
                total: paths.length,
                name: basename(source as string),
              });
              const prepared = await prepareMediaAsset(
                project,
                path,
                source as string,
              );
              project = prepared.project;
              // Unsaved projects store absolute references so the first save can be anywhere.
              if (!state.path && prepared.result.imported) {
                prepared.result.asset.file = {
                  type: 'absolute',
                  path: prepared.result.source.path,
                };
              }
              if (prepared.result.imported) imported++;
              this.onProgress({
                completed: index + 1,
                total: paths.length,
                name: basename(source as string),
              });
            }
            project = commitEdit(state.project, project, 'Import media');
            notice = `${imported} imported, ${paths.length - imported} already in library.`;
          } else {
            if (typeof request.assetId !== 'string')
              throw new Error('Expected an asset ID.');
            if (action === 'removeAsset') {
              project = commitEdit(
                project,
                removeAssetFromProject(project, request.assetId),
                'Remove media',
              );
            } else {
              if (
                (request.mediaType !== 'video' &&
                  request.mediaType !== 'audio') ||
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
        case 'undo':
        case 'redo': {
          if (!this.state) throw new Error('Open a project before editing.');
          const allowed =
            action === 'edit'
              ? ['projectId', 'expectedRevision', 'label', 'operations']
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
          if (action === 'edit') {
            const transaction = parseEditTransaction(command);
            if (
              transaction.operations.some(
                (operation) =>
                  ![
                    'clip.move',
                    'clip.trim',
                    'clip.split',
                    'clip.remove',
                    'clip.audio',
                    'clip.visual',
                  ].includes(operation.type),
              )
            )
              throw new Error('Only timeline clip editing is available.');
            project = executeTransaction(before, transaction).project;
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
      };
    } catch (error) {
      if (
        [
          'edit',
          'undo',
          'redo',
          'import',
          'removeAsset',
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

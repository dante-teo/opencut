import {
  createProject,
  serializeProject,
  projectRevision,
} from '@opencut/core';
import {
  canonicalProjectFilePath,
  checkProjectMedia,
  readProjectFile,
  updateProjectFile,
  writeProjectFile,
  inspectMediaFile,
  resolveMediaReference,
} from '@opencut/core/node';
import type {
  DesktopProject,
  NewProjectInput,
  ProjectReply,
} from '../bridge.js';

export interface ProjectDialogs {
  open(): Promise<string | null>;
  save(): Promise<string | null>;
  unsaved(): Promise<'save' | 'discard' | 'cancel'>;
}
export type ProjectAction = 'current' | 'create' | 'open' | 'save' | 'close';

/** Main-process session. React never submits a path or a replacement document. */
export class ProjectSession {
  private state: DesktopProject | null = null;
  private baseline: string | null = null;
  private busy = false;

  constructor(private readonly dialogs: ProjectDialogs) {}

  get needsCloseGuard(): boolean {
    return this.busy || this.state?.dirty === true;
  }

  /** Resolve only an ID in the active session; never accept a renderer path. */
  async previewAsset(id: unknown) {
    const state = this.state;
    if (this.busy) throw new Error('Wait for the project operation to finish.');
    if (!state?.path)
      throw new Error('Open a project with imported video first.');
    if (typeof id !== 'string') throw new Error('Expected a video asset ID.');
    const asset = state.project.assets.find((asset) => asset.id === id);
    if (!asset) throw new Error('Video asset is not in the current project.');
    if (!asset.mediaTypes.includes('video') || asset.metadata?.kind === 'image')
      throw new Error(
        'Select a video asset. Audio and still preview are not available.',
      );
    const path = resolveMediaReference(asset.file, state.path);
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
    if (this.busy)
      return {
        ok: false,
        error: 'A project operation is already in progress. Please wait.',
      };
    this.busy = true;
    try {
      let canceled = false;
      switch (action) {
        case 'current':
          break;
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
          const project = await readProjectFile(path);
          const media = await checkProjectMedia(project, path);
          if (!(await this.confirmDiscard())) {
            canceled = true;
            break;
          }
          this.state = { project, path, dirty: false, media };
          this.baseline = serializeProject(project);
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
      }
      return { ok: true, state: structuredClone(this.state), canceled };
    } catch (error) {
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
      await updateProjectFile(
        state.path,
        async (current) => {
          if (serializeProject(current) !== this.baseline)
            throw new Error(
              'Project changed on disk. Open it again to reload before saving.',
            );
          return { project: state.project, result: undefined };
        },
        { expectedRevision: projectRevision(state.project) },
      );
    } else {
      const selected = await this.dialogs.save();
      if (!selected) return false;
      const path = await canonicalProjectFilePath(selected);
      await writeProjectFile(state.project, path);
      state.path = path;
    }
    state.dirty = false;
    this.baseline = serializeProject(state.project);
    return true;
  }
}

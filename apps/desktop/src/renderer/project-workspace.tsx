import { useEffect, useRef, useState } from 'react';
import { Undo2, Redo2, FolderOpen, Plus, Save } from 'lucide-react';
import { StudioArtwork } from './studio-graphics.js';
import type {
  DesktopProject,
  ProjectReply,
  TimelineOperation,
} from '../bridge.js';
import { Preview } from './video-preview.js';
import { projectRevision, type RationalTime } from '@opencut/core';
import {
  sourceToTimeline,
  timelineToSource,
  ZERO,
} from './timeline-geometry.js';
import { ProjectTimeline } from './project-timeline.js';
import { MediaLibrary } from './media-library.js';
import { ProjectInspector } from './project-inspector.js';

export function ProjectWorkspace() {
  const [state, setState] = useState<DesktopProject | null>(null);
  const [busy, setBusy] = useState('Loading project…');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [creating, setCreating] = useState(false);
  const pending = useRef(false);
  const formDialog = useRef<HTMLDialogElement>(null);
  const [viewer, setViewer] = useState<'project' | 'source'>('project');
  const [previewAssetId, setPreviewAssetId] = useState<string | null>(null);
  const [previewRequest, setPreviewRequest] = useState(0);
  const [previewSession, setPreviewSession] = useState(0);
  const [playhead, setPlayhead] = useState<RationalTime>(ZERO);
  const [linkedClipId, setLinkedClipId] = useState<string | null>(null);
  const [previewPosition, setPreviewPosition] = useState<number | undefined>();
  const [previewSeekRequest, setPreviewSeekRequest] = useState(0);
  const linkedClip = state?.project.clips.find(
    (clip) => clip.id === linkedClipId,
  );
  function seekTimeline(time: RationalTime) {
    setPlayhead(time);
    if (!linkedClip) return;
    const sourceTime = timelineToSource(linkedClip, time);
    if (sourceTime === undefined) {
      setViewer('project');
      setLinkedClipId(null);
      setPreviewPosition(undefined);
    } else {
      setPreviewPosition(sourceTime);
      setPreviewSeekRequest((value) => value + 1);
    }
  }

  const sourceViewer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (sourceViewer.current) sourceViewer.current.scrollTop = 0;
  }, [previewRequest, previewSession]);
  const [selection, setSelection] = useState<{
    kind: 'asset' | 'clip';
    id: string;
  } | null>(null);

  async function run(
    label: string,
    operation: () => Promise<ProjectReply>,
    editing = false,
  ) {
    if (pending.current) return;
    pending.current = true;
    setBusy(label);
    setError('');
    setNotice('');
    try {
      const reply = await operation();
      if (!reply.ok) setError(reply.error);
      else {
        setState(reply.state);
        if (!reply.canceled) {
          setCreating(false);
          if (label !== 'Saving project…' && !editing) {
            setSelection(null);
            setPlayhead(ZERO);
            setLinkedClipId(null);
            setPreviewPosition(undefined);
            setPreviewAssetId(null);
            setPreviewSession((value) => value + 1);
          }
          if (editing) {
            const next = reply.state?.project;
            if (
              selection &&
              !(selection.kind === 'clip' ? next?.clips : next?.assets)?.some(
                (entry) => entry.id === selection.id,
              )
            )
              setSelection(null);
            if (
              previewAssetId &&
              !next?.assets.some((asset) => asset.id === previewAssetId)
            ) {
              setPreviewAssetId(null);
              setPreviewSession((value) => value + 1);
            }
            // Pause/unlink the source on edits so its old clock cannot overwrite
            // the project playhead after moving, trimming, deleting or restoring.
            setLinkedClipId(null);
            setPreviewPosition(undefined);
            setViewer('project');
          }
          setNotice(
            reply.notice ??
              (label === 'Saving project…' ? 'Project saved.' : ''),
          );
        }
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      pending.current = false;
      setBusy('');
    }
  }

  useEffect(
    () =>
      window.opencut.onImportProgress((progress) => {
        setBusy(
          `Importing ${progress.completed}/${progress.total} · ${progress.name}`,
        );
      }),
    [],
  );
  useEffect(() => {
    const prevent = (event: DragEvent) => {
      event.preventDefault();
    };
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);
  useEffect(() => {
    void run('Loading project…', () => window.opencut.getProject());
  }, []);
  useEffect(() => {
    document.title = state
      ? `${state.dirty ? '● ' : ''}${state.project.metadata.name} — OpenCut`
      : 'OpenCut';
  }, [state]);
  useEffect(() => {
    const dialog = formDialog.current;
    if (creating && !dialog?.open) dialog?.showModal();
    else if (!creating && dialog?.open) dialog.close();
  }, [creating]);
  const project = state?.project;
  function importMedia(files?: File[]) {
    if (!project) return;
    const input = {
      projectId: project.metadata.id,
      expectedRevision: projectRevision(project),
    };
    void run(
      'Importing media…',
      () =>
        files
          ? window.opencut.importDroppedMedia(input, files)
          : window.opencut.importMedia(input),
      true,
    );
  }
  function edit(operations: TimelineOperation[], label: string) {
    if (!project) return Promise.resolve();
    return run(
      label,
      () =>
        window.opencut.editTimeline({
          projectId: project.metadata.id,
          expectedRevision: projectRevision(project),
          operations,
          label,
        }),
      true,
    );
  }
  function history(direction: 'undo' | 'redo') {
    if (!project) return;
    const input = {
      projectId: project.metadata.id,
      expectedRevision: projectRevision(project),
    };
    void run(
      direction === 'undo' ? 'Undoing edit…' : 'Redoing edit…',
      () =>
        direction === 'undo'
          ? window.opencut.undoProject(input)
          : window.opencut.redoProject(input),
      true,
    );
  }
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.key.toLowerCase() !== 'z'
      )
        return;
      const target = event.target;
      if (
        (target instanceof Element &&
          target.closest(
            'input, select, textarea, [contenteditable="true"]',
          )) ||
        creating
      )
        return;
      event.preventDefault();
      if (!busy) history(event.shiftKey ? 'redo' : 'undo');
    }
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [project, busy, creating]);
  return (
    <div
      className="workspace"
      aria-label="Project workspace"
      aria-busy={!!busy}
    >
      <div className="project-toolbar">
        <div className="project-title">
          <span
            className={`save-indicator ${state?.dirty ? 'unsaved' : ''}`}
            aria-hidden="true"
          />
          <h1>{project?.metadata.name ?? 'No project'}</h1>
          <span className="project-save-state">
            {state?.dirty ? 'Unsaved changes' : project ? 'Saved project' : ''}
          </span>
        </div>
        <div className="project-actions">
          <button
            disabled={!!busy || !project?.editing?.undo.length}
            onClick={() => history('undo')}
          >
            <Undo2 aria-hidden="true" focusable="false" /> Undo
          </button>
          <button
            disabled={!!busy || !project?.editing?.redo.length}
            onClick={() => history('redo')}
          >
            <Redo2 aria-hidden="true" focusable="false" /> Redo
          </button>
          <button disabled={!!busy} onClick={() => setCreating(true)}>
            <Plus aria-hidden="true" focusable="false" /> New project
          </button>
          <button
            disabled={!!busy}
            onClick={() =>
              void run('Opening project…', () => window.opencut.openProject())
            }
          >
            <FolderOpen aria-hidden="true" focusable="false" /> Open project
          </button>
          <button
            className="primary-button"
            disabled={!!busy || !project}
            onClick={() =>
              void run('Saving project…', () => window.opencut.saveProject())
            }
          >
            <Save aria-hidden="true" focusable="false" /> Save project
          </button>
          <button
            disabled={!!busy || !project}
            onClick={() =>
              void run('Closing project…', () => window.opencut.closeProject())
            }
          >
            Close project
          </button>
        </div>
      </div>
      {(busy || error || notice) && (
        <div className="project-feedback">
          {busy && <span aria-live="polite">{busy}</span>}
          {error && <span role="alert">{error}</span>}
          {notice && <span aria-live="polite">{notice}</span>}
        </div>
      )}
      <div className="editor-panels">
        <MediaLibrary
          key={project?.metadata.id ?? 'empty'}
          state={state}
          busy={!!busy}
          selection={selection}
          revision={project ? projectRevision(project) : 0}
          onImport={() => importMedia()}
          onDrop={importMedia}
          onRemove={(assetId) => {
            if (project)
              void run(
                'Removing media…',
                () =>
                  window.opencut.removeAsset({
                    projectId: project.metadata.id,
                    expectedRevision: projectRevision(project),
                    assetId,
                  }),
                true,
              );
          }}
          onSelect={(id) => {
            setSelection({ kind: 'asset', id });
            setLinkedClipId(null);
            setPreviewPosition(undefined);
            setPreviewAssetId(id);
            setPreviewRequest((value) => value + 1);
            setViewer('source');
          }}
        />
        <section className="viewer-panel" aria-label="Viewer">
          <div className="panel-heading viewer-tabs">
            <div role="tablist" aria-label="Viewer mode">
              <button
                role="tab"
                aria-selected={viewer === 'project'}
                aria-controls="project-viewer"
                id="project-viewer-tab"
                onClick={() => setViewer('project')}
              >
                Project viewer
              </button>
              <button
                role="tab"
                aria-selected={viewer === 'source'}
                aria-controls="source-viewer"
                id="source-viewer-tab"
                onClick={() => setViewer('source')}
              >
                Source preview
              </button>
            </div>
          </div>
          <div
            id="project-viewer"
            role="tabpanel"
            aria-labelledby="project-viewer-tab"
            hidden={viewer !== 'project'}
            className="project-viewer"
          >
            <div className="viewer-stage">
              <svg
                className="project-canvas"
                viewBox={`0 0 ${project?.settings.width ?? 1920} ${project?.settings.height ?? 1080}`}
                aria-label="Project canvas placeholder"
              >
                <rect
                  width="100%"
                  height="100%"
                  fill={project?.settings.backgroundColor ?? '#000000'}
                />
              </svg>
              <div className="viewer-placeholder">
                <StudioArtwork />
                {project && <p>Project preview is not available yet.</p>}
                {!project && (
                  <button
                    className="primary-button"
                    disabled={!!busy}
                    onClick={() => setCreating(true)}
                  >
                    Start creating <span aria-hidden="true">↗</span>
                  </button>
                )}
              </div>
            </div>
            {project && (
              <div className="viewer-caption">
                <span>
                  {`${project.settings.width} × ${project.settings.height}`}
                </span>
                <span>
                  {`${project.settings.frameRate.numerator}/${project.settings.frameRate.denominator} fps`}
                </span>
              </div>
            )}
          </div>
          <div
            id="source-viewer"
            role="tabpanel"
            aria-labelledby="source-viewer-tab"
            hidden={viewer !== 'source'}
            className="source-viewer"
            ref={sourceViewer}
          >
            <Preview
              key={previewSession}
              assetId={previewAssetId}
              requestKey={previewRequest}
              projectFrameRate={project?.settings.frameRate}
              active={viewer === 'source'}
              positionSeconds={previewPosition}
              positionRequestKey={previewSeekRequest}
              onPositionChange={(seconds) => {
                if (linkedClip && viewer === 'source')
                  setPlayhead(
                    sourceToTimeline(
                      linkedClip,
                      seconds,
                      project!.settings.frameRate,
                    ),
                  );
              }}
              onOpenLocal={() => {
                setLinkedClipId(null);
                setPreviewPosition(undefined);
              }}
            />
          </div>
        </section>
        <ProjectInspector
          state={state}
          selection={selection}
          onClear={() => setSelection(null)}
        />
      </div>
      <ProjectTimeline
        key={previewSession}
        project={project}
        disabled={!!busy}
        onEdit={edit}
        onAddAsset={(input) =>
          run(
            'Adding media clip…',
            () => window.opencut.addAssetClip(input),
            true,
          )
        }
        position={playhead}
        onSeek={seekTimeline}
        linkedClipId={linkedClipId}
        onPreviewClip={(id) => {
          const clip = project?.clips.find((clip) => clip.id === id);
          if (!clip) return;
          setLinkedClipId(id);
          setPlayhead(clip.timelineStart);
          setPreviewPosition(
            clip.sourceIn.numerator / clip.sourceIn.denominator,
          );
          setPreviewAssetId(clip.assetId);
          setPreviewRequest((value) => value + 1);
          setViewer('source');
        }}
        selected={selection?.kind === 'clip' ? selection.id : null}
        onSelect={(id) => setSelection({ kind: 'clip', id })}
      />
      <dialog
        ref={formDialog}
        className="new-project-dialog"
        onCancel={(event) => {
          if (busy) event.preventDefault();
          else setCreating(false);
        }}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const fields = new FormData(event.currentTarget);
            const match = /^(\d+)(?:\/(\d+))?$/.exec(
              String(fields.get('frameRate')).trim(),
            );
            if (!match) {
              setError(
                'Frame rate must be an integer or ratio such as 30000/1001.',
              );
              return;
            }
            void run('Creating project…', () =>
              window.opencut.createProject({
                name: String(fields.get('name')),
                settings: {
                  width: Number(fields.get('width')),
                  height: Number(fields.get('height')),
                  frameRate: {
                    numerator: Number(match[1]),
                    denominator: Number(match[2] ?? 1),
                  },
                },
              }),
            );
          }}
        >
          <h2>New project settings</h2>
          <div className="project-fields">
            <label>
              Project name
              <input
                autoFocus
                required
                name="name"
                defaultValue="Untitled"
                disabled={!!busy}
              />
            </label>
            <label>
              Width
              <input
                type="number"
                min="1"
                step="1"
                required
                name="width"
                defaultValue="1920"
                disabled={!!busy}
              />
            </label>
            <label>
              Height
              <input
                type="number"
                min="1"
                step="1"
                required
                name="height"
                defaultValue="1080"
                disabled={!!busy}
              />
            </label>
            <label>
              Frame rate
              <input
                required
                name="frameRate"
                defaultValue="30"
                disabled={!!busy}
                placeholder="30000/1001"
              />
            </label>
          </div>
          {error && <p role="alert">{error}</p>}
          <div className="dialog-actions">
            <button
              disabled={!!busy}
              type="button"
              onClick={() => setCreating(false)}
            >
              Cancel
            </button>
            <button className="primary-button" disabled={!!busy} type="submit">
              Create project
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import type { DesktopProject, ProjectReply } from '../bridge.js';
import { Preview } from './video-preview.js';
import type { RationalTime } from '@opencut/core';
import {
  sourceToTimeline,
  timelineToSource,
  ZERO,
} from './timeline-geometry.js';
import { ProjectTimeline } from './project-timeline.js';
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

  async function run(label: string, operation: () => Promise<ProjectReply>) {
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
          if (label !== 'Saving project…') {
            setSelection(null);
            setPlayhead(ZERO);
            setLinkedClipId(null);
            setPreviewPosition(undefined);
            setPreviewAssetId(null);
            setPreviewSession((value) => value + 1);
          }
          setNotice(label === 'Saving project…' ? 'Project saved.' : '');
        }
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      pending.current = false;
      setBusy('');
    }
  }

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
          <h1>{project?.metadata.name ?? 'Your workspace'}</h1>
          <span className="project-save-state">
            {state?.dirty
              ? 'Unsaved changes'
              : project
                ? 'Saved project'
                : 'No project open'}
          </span>
        </div>
        <div className="project-actions">
          <button disabled={!!busy} onClick={() => setCreating(true)}>
            New project
          </button>
          <button
            disabled={!!busy}
            onClick={() =>
              void run('Opening project…', () => window.opencut.openProject())
            }
          >
            Open project
          </button>
          <button
            className="primary-button"
            disabled={!!busy || !project}
            onClick={() =>
              void run('Saving project…', () => window.opencut.saveProject())
            }
          >
            Save project
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
        <aside className="library-panel" aria-label="Media library">
          <div className="panel-heading">
            <h2>Media assets ({project?.assets.length ?? 0})</h2>
          </div>
          <div className="library-content">
            {!project?.assets.length ? (
              <div className="library-empty">
                <span className="empty-symbol" aria-hidden="true">
                  ▧
                </span>
                <h3>Your media lives here</h3>
                <p>
                  {project
                    ? 'No media assets. Import media through the CLI.'
                    : 'Create a project or open an existing OpenCut JSON file to get started.'}
                </p>
              </div>
            ) : (
              <ul className="asset-list">
                {project.assets.map((asset) => {
                  const availability = state?.media.find(
                    (item) => item.assetId === asset.id,
                  );
                  const offline = availability?.status !== 'available';
                  return (
                    <li key={asset.id}>
                      <button
                        aria-pressed={
                          selection?.kind === 'asset' &&
                          selection.id === asset.id
                        }
                        onClick={() => {
                          setSelection({ kind: 'asset', id: asset.id });
                          setLinkedClipId(null);
                          setPreviewPosition(undefined);
                          setPreviewAssetId(asset.id);
                          setPreviewRequest((value) => value + 1);
                          setViewer('source');
                        }}
                        disabled={!!busy}
                      >
                        <span
                          className={`asset-icon ${asset.metadata?.kind ?? asset.mediaTypes[0]}`}
                          aria-hidden="true"
                        >
                          {asset.metadata?.kind === 'audio' ||
                          asset.mediaTypes[0] === 'audio'
                            ? '♫'
                            : '▧'}
                        </span>
                        <span className="asset-label">
                          <strong>{asset.name}</strong>
                          <small>
                            {asset.metadata?.kind ??
                              asset.mediaTypes.join(', ')}{' '}
                            · {offline ? 'Offline' : 'Available'}
                          </small>
                        </span>
                      </button>
                      <p className="asset-availability">
                        {availability?.message}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <div className="panel-footnote">Project media · read only</div>
        </aside>
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
                <span aria-hidden="true">▣</span>
                <h2>Project viewer</h2>
                <p>
                  {project
                    ? 'Project preview is not available yet.'
                    : 'Open a project to begin'}
                </p>
              </div>
            </div>
            <div className="viewer-caption">
              <span>
                {project
                  ? `${project.settings.width} × ${project.settings.height}`
                  : 'No sequence loaded'}
              </span>
              <span>
                {project
                  ? `${project.settings.frameRate.numerator}/${project.settings.frameRate.denominator} fps`
                  : '—'}
              </span>
            </div>
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
          <p className="muted">Set up your project canvas and frame rate.</p>
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

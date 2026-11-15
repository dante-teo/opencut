import { useEffect, useRef, useState } from 'react';
import { frameTime } from '@opencut/core';
import type { RationalTime } from '@opencut/core';
import type { DefinitionReview } from '../bridge.js';
import { ProjectTimeline } from './project-timeline.js';
import { frameIndex } from './timeline-geometry.js';

function DefinitionPlayback({
  revision,
}: {
  revision: NonNullable<DefinitionReview['current']>;
}) {
  const { project, url, frameCount } = revision;
  const rate = project.settings.frameRate;
  const fps = rate.numerator / rate.denominator;
  const player = useRef<HTMLVideoElement>(null);
  const [frame, setFrame] = useState(0);
  const [selection, setSelection] = useState<string | null>(null);

  const clamp = (frame: number) => Math.max(0, Math.min(frameCount - 1, frame));
  function seek(next: number) {
    const video = player.current;
    if (!video || video.readyState < 1) return;
    video.pause();
    const position = clamp(next);
    // Seek inside the requested sample so browser timestamp rounding cannot
    // put the playhead back on the previous frame at fractional frame rates.
    video.currentTime = (position + 0.25) / fps;
    setFrame(position);
  }
  function seekTimeline(time: RationalTime) {
    seek(Number(frameIndex(time, rate)));
  }
  return (
    <>
      <section
        className="viewer-panel definition-viewer"
        aria-label="Definition viewer"
      >
        <video
          ref={player}
          src={url}
          controls
          preload="auto"
          aria-label="Compiled timeline preview"
          onTimeUpdate={(event) =>
            setFrame(clamp(Math.floor(event.currentTarget.currentTime * fps)))
          }
        />
        <div className="timeline-controls">
          <button onClick={() => seek(frame - 1)} disabled={frame === 0}>
            Previous frame
          </button>
          <output aria-label="Current frame">
            Frame {frame} / {frameCount - 1}
          </output>
          <button
            onClick={() => seek(frame + 1)}
            disabled={frame === frameCount - 1}
          >
            Next frame
          </button>
        </div>
      </section>
      <ProjectTimeline
        project={project}
        selected={selection}
        onSelect={setSelection}
        position={frameTime(frame, rate)}
        onSeek={seekTimeline}
      />
    </>
  );
}

export function DefinitionWorkspace({
  state,
  onOpen,
  onClose,
}: {
  state: DefinitionReview;
  onOpen: () => void;
  onClose: () => void;
}) {
  const { current, status } = state;
  const [progress, setProgress] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<{
    error?: string;
    message?: string;
  }>({});
  useEffect(() => window.opencut.onDefinitionExportProgress(setProgress), []);

  async function exportDefinition() {
    if (!current || progress !== null) return;
    setProgress(0);
    setFeedback({});
    try {
      const result = await window.opencut.exportDefinition(current.generation);
      if (result.status === 'saved')
        setFeedback({ message: `Saved ${result.path}` });
    } catch (error) {
      setFeedback({
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setProgress(null);
    }
  }
  return (
    <div className="workspace" aria-label="Definition review">
      <div className="project-toolbar">
        <div className="project-title">
          <h1>{current?.project.metadata.name ?? 'Video definition'}</h1>
          <span title={state.path}>{state.path.split(/[/\\]/).at(-1)}</span>
        </div>
        <div className="project-actions">
          <button onClick={onOpen} disabled={progress !== null}>
            Open definition
          </button>
          <button onClick={onClose} disabled={progress !== null}>
            Close definition
          </button>
          <button
            onClick={() => void exportDefinition()}
            disabled={!current || progress !== null}
          >
            Export MP4
          </button>
          {progress !== null && (
            <button
              onClick={() => void window.opencut.cancelDefinitionExport()}
            >
              Cancel export
            </button>
          )}
        </div>
      </div>
      <div className="project-feedback">
        <span role="status" aria-label="Compilation status">
          {status === 'ready'
            ? 'Preview ready'
            : status === 'error'
              ? 'Preview failed'
              : status === 'compiling'
                ? 'Compiling definition…'
                : 'Rendering preview…'}
          {current &&
            ` · ${status === 'ready' ? 'Revision' : 'Showing last valid revision'} ${current.generation} (${current.sourceRevision.slice(0, 12)})`}
        </span>
        {state.error && <pre role="alert">{state.error}</pre>}
        {progress !== null && (
          <progress max={100} value={progress} aria-label="Export progress" />
        )}
        {feedback.message && (
          <output aria-label="Export result">{feedback.message}</output>
        )}
        {feedback.error && <pre role="alert">{feedback.error}</pre>}
      </div>
      {current && <DefinitionPlayback key={current.url} revision={current} />}
    </div>
  );
}

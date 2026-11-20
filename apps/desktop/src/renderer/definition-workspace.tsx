import { useCallback, useEffect, useRef, useState } from 'react';
import { frameTime } from '@opencut/core';
import type { DefinitionReview } from '../bridge.js';
import type { MusicSelection } from '@opencut/core/video';
import { ProjectTimeline } from './project-timeline.js';
import { DialogueMix } from './dialogue-mix.js';
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
  const resumeTime = useRef(0);
  const [time, setTime] = useState(0);
  const [selection, setSelection] = useState<string | null>(null);
  const attachPlayer = useCallback((video: HTMLVideoElement | null) => {
    if (!video) return;
    player.current = video;
    return () => {
      // Capture the outgoing element before a rendered revision replaces it.
      if (video.readyState >= 1) resumeTime.current = video.currentTime;
      player.current = null;
    };
  }, []);
  const lastFrame = frameCount - 1;
  const clampFrame = (index: number) => Math.max(0, Math.min(lastFrame, index));
  const frameAt = (seconds: number) => Math.floor(seconds * fps);
  const frame = clampFrame(frameAt(time));

  function seekTime(seconds: number) {
    const video = player.current;
    const target =
      seconds >= frameCount / fps ? (lastFrame + 0.25) / fps : seconds;
    resumeTime.current = target;
    setTime(target);
    if (video && video.readyState >= 1) {
      video.pause();
      if (video.currentTime !== target) video.currentTime = target;
    }
  }

  function seek(index: number) {
    // Seek inside the sample to allow for browser timestamp rounding.
    seekTime((clampFrame(index) + 0.25) / fps);
  }
  return (
    <>
      <section
        className="viewer-panel definition-viewer"
        aria-label="Definition viewer"
      >
        <video
          key={url}
          ref={attachPlayer}
          onLoadedMetadata={() => seekTime(resumeTime.current)}
          src={url}
          controls
          preload="auto"
          aria-label="Compiled timeline preview"
          onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
        />
        <div className="timeline-controls">
          <button onClick={() => seek(frame - 1)} disabled={frame === 0}>
            Previous frame
          </button>
          <output aria-label="Current frame">
            Frame {frame} / {lastFrame}
          </output>
          <button
            onClick={() => seek(frame + 1)}
            disabled={frame === lastFrame}
          >
            Next frame
          </button>
        </div>
      </section>
      <ProjectTimeline
        project={project}
        selected={selection}
        onSelect={(id, start) => {
          setSelection(id);
          // Review the first project sample at or after the item's start.
          seek(Number(frameIndex(start, rate, 'ceil')));
        }}
        position={frameTime(frame, rate)}
        onSeek={(time) => seek(Number(frameIndex(time, rate)))}
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

  async function selectMusic(selection: MusicSelection) {
    if (!current || progress !== null) return;
    setFeedback({});
    try {
      await window.opencut.selectMusic(current.generation, selection);
    } catch (error) {
      setFeedback({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const music = current?.musicComparison;
  const selectedMusic = music?.candidates.find(
    ({ trackId }) => trackId === music.selected,
  );
  const musicBusy =
    progress !== null || status === 'compiling' || status === 'rendering';
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
      {current && (
        <>
          {music && (
            <div className="timeline-controls" aria-label="Music comparison">
              <label>
                Music candidate{' '}
                <select
                  disabled={musicBusy}
                  value={music.selected}
                  onChange={(event) =>
                    void selectMusic({ candidate: event.currentTarget.value })
                  }
                >
                  {music.candidates.map((candidate) => (
                    <option key={candidate.trackId} value={candidate.trackId}>
                      {candidate.name}
                      {(candidate.previouslyUsedIn.length > 0 ||
                        candidate.sources.some(
                          ({ reusedInProject }) => reusedInProject,
                        )) &&
                        ' (reused)'}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <input
                  type="checkbox"
                  disabled={musicBusy}
                  checked={music.matchLoudness}
                  onChange={(event) =>
                    void selectMusic({
                      matchLoudness: event.currentTarget.checked,
                    })
                  }
                />{' '}
                Match loudness
              </label>
              {selectedMusic?.previouslyUsedIn.length ? (
                <span>
                  Previously delivered in{' '}
                  {selectedMusic.previouslyUsedIn.join(', ')}
                </span>
              ) : null}
            </div>
          )}
          <DefinitionPlayback
            key={`${state.path}:playback`}
            revision={current}
          />
          <details className="dialogue-mix" key={`${state.path}:mix`}>
            <summary>Professional Dialogue Mix</summary>
            <DialogueMix
              key={current.dialogueMixRevision}
              revision={current}
              disabled={
                progress !== null ||
                status === 'compiling' ||
                status === 'rendering'
              }
            />
          </details>
        </>
      )}
    </div>
  );
}

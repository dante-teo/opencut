import { Camera, Play, Pause, StepBack, StepForward } from 'lucide-react';
import type { DesktopCacheStatus } from '../bridge.js';
import { gainDb } from './clip-properties.js';
import { MediaCacheControls } from './media-cache.js';
import {
  useEffect,
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from 'react';
import type { Project, RationalTime } from '@opencut/core';
import type { PreviewTransport } from './video-preview.js';
import {
  TimelinePlayback,
  type TimelineDiagnostics,
} from './timeline-playback.js';
import {
  frameIndex,
  framePosition,
  timelineTimecode,
} from './timeline-geometry.js';

export interface TimelineTransport extends PreviewTransport {
  seek(time: RationalTime): void;
  setPlaying(playing: boolean): void;
  renderPreview(): void;
  livePreview(): void;
  status(): { playing: boolean; cached: boolean; renderStatus: string };
}

export function TimelinePreview({
  project,
  active,
  interrupted,
  position,
  onPositionChange,
  transportRef,
  onExportFrame,
}: {
  project: Project;
  active: boolean;
  interrupted: boolean;
  position: RationalTime;
  onPositionChange(time: RationalTime): void;
  transportRef: Ref<TimelineTransport>;
  onExportFrame: (frame: number) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const player = useRef<TimelinePlayback | null>(null);
  const callback = useRef(onPositionChange);
  callback.current = onPositionChange;
  const initial = useRef(position);
  initial.current = position;
  const [diagnostics, setDiagnostics] = useState<TimelineDiagnostics | null>(
    null,
  );
  const [cacheEpoch, setCacheEpoch] = useState(0);
  const [previewSize, setPreviewSize] = useState(1920);
  const [exactPausedFrames, setExactPausedFrames] = useState(false);
  const [rendered, setRendered] = useState<{
    url: string;
    frameCount: number;
  } | null>(null);
  const [renderStatus, setRenderStatus] = useState('');
  const [renderedPlaying, setRenderedPlaying] = useState(false);
  const renderedVideo = useRef<HTMLVideoElement>(null);
  const generation = useRef(0);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    generation.current++;
    setRendered(null);
    setRenderStatus('');
    setReady(false);
    return () => {
      generation.current++;
    };
  }, [project, previewSize]);
  useEffect(
    () => () => {
      if (rendered) void window.opencut.releasePreview(rendered.url);
    },
    [rendered],
  );
  const renderPreview = () => {
    const current = ++generation.current;
    player.current?.pause();
    renderedVideo.current?.pause();
    setRenderStatus('Rendering full timeline…');
    void window.opencut
      .renderTimeline({
        projectId: project.metadata.id,
        expectedRevision: project.editing?.revision ?? 0,
        size: previewSize,
      })
      .then(
        (result) => {
          if (current !== generation.current) {
            if (result) void window.opencut.releasePreview(result.url);
            return;
          }
          setRenderStatus(
            result
              ? result.hit
                ? 'Using cached timeline'
                : 'Timeline preview ready'
              : '',
          );
          if (result) {
            setReady(false);
            setRenderedPlaying(false);
            setRendered(result);
          }
        },
        (error: unknown) => {
          if (current === generation.current) setRenderStatus(String(error));
        },
      );
  };
  const livePreview = () => {
    generation.current++;
    setRendered(null);
    setRenderStatus('');
  };
  const cacheSignature = useRef('');
  const memoryBudget = useRef(64 * 1024 ** 2);
  const onCacheStatus = useCallback((status: DesktopCacheStatus) => {
    memoryBudget.current = status.limits.memoryBytes;
    player.current?.setMemoryBudget(status.limits.memoryBytes);
    const signature = JSON.stringify([
      status.enabled,
      status.revision,
      status.limits.memoryBytes,
      status.entries
        .filter((entry) => entry.kind === 'proxy')
        .map((entry) => entry.key)
        .sort(),
    ]);
    if (!cacheSignature.current) {
      cacheSignature.current = signature;
      return;
    }
    if (
      cacheSignature.current !== signature &&
      !player.current?.clock.playing
    ) {
      cacheSignature.current = signature;
      setCacheEpoch((epoch) => epoch + 1);
    }
  }, []);
  useEffect(() => {
    if (!active || rendered) return;
    const playback = new TimelinePlayback(
      project,
      canvas.current!,
      host.current!,
      (time, report) => {
        setDiagnostics(report);
        callback.current(time);
      },
      memoryBudget.current,
      previewSize,
      exactPausedFrames,
    );
    player.current = playback;
    playback.seek(initial.current);
    return () => {
      playback.dispose();
      player.current = null;
    };
  }, [project, active, cacheEpoch, previewSize, exactPausedFrames, rendered]);
  useEffect(() => {
    if (!active || interrupted) {
      player.current?.pause();
      renderedVideo.current?.pause();
    }
  }, [active, interrupted, project]);
  const rate = project.settings.frameRate;
  const end = rendered
    ? framePosition(BigInt(rendered.frameCount), rate)
    : player.current?.clock.end;
  const frame = Number(frameIndex(position, rate));
  const seek = (time: RationalTime) => {
    const video = renderedVideo.current;
    if (video && rendered) {
      const index = Math.max(
        0,
        Math.min(rendered.frameCount, Number(frameIndex(time, rate))),
      );
      video.currentTime = Math.min(
        video.duration || Infinity,
        ((index + (index === rendered.frameCount ? 0 : 0.25)) *
          rate.denominator) /
          rate.numerator,
      );
      callback.current(framePosition(BigInt(index), rate));
    } else player.current?.seek(time);
  };
  const setPlaying = (playing: boolean) => {
    if (!active || interrupted) return;
    const video = renderedVideo.current;
    if (video) {
      if (playing)
        void video
          .play()
          .catch((error: unknown) => setRenderStatus(String(error)));
      else video.pause();
    } else if (player.current && playing !== player.current.clock.playing) {
      if (playing) void player.current.toggle();
      else player.current.pause();
    }
  };
  const toggle = () =>
    setPlaying(
      renderedVideo.current
        ? renderedVideo.current.paused
        : !player.current?.clock.playing,
    );
  const step = (direction: -1 | 1) => {
    if (interrupted || !active) return;
    if (!rendered) {
      player.current?.step(direction);
      return;
    }
    renderedVideo.current?.pause();
    seek(framePosition(BigInt(Math.max(0, frame + direction)), rate));
  };
  useImperativeHandle(transportRef, () => ({
    seek: (time) => {
      if (active && !interrupted) seek(time);
    },
    setPlaying,
    toggle,
    step,
    renderPreview,
    livePreview,
    status: () => ({
      playing: renderedVideo.current
        ? !renderedVideo.current.paused
        : !!player.current?.clock.playing,
      cached: !!rendered,
      renderStatus,
    }),
  }));
  const playing = rendered ? renderedPlaying : diagnostics?.playing;
  return (
    <div className="timeline-player" aria-label="Edited timeline preview">
      <div className="timeline-stage">
        {rendered ? (
          <video
            ref={renderedVideo}
            src={rendered.url}
            playsInline
            preload="auto"
            aria-label="Rendered timeline preview"
            onLoadedMetadata={() => {
              setReady(true);
              seek(initial.current);
            }}
            onPlay={() => setRenderedPlaying(true)}
            onPause={() => setRenderedPlaying(false)}
            onEnded={() => {
              setRenderedPlaying(false);
              callback.current(
                framePosition(BigInt(rendered.frameCount), rate),
              );
            }}
            onTimeUpdate={(event) => {
              if (!event.currentTarget.paused)
                callback.current(
                  framePosition(
                    BigInt(
                      Math.min(
                        rendered.frameCount,
                        Math.floor(
                          (event.currentTarget.currentTime * rate.numerator) /
                            rate.denominator +
                            1e-6,
                        ),
                      ),
                    ),
                    rate,
                  ),
                );
            }}
            onError={() =>
              setRenderStatus('The rendered preview could not be decoded.')
            }
            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          />
        ) : (
          <canvas ref={canvas} aria-label="Edited timeline canvas" />
        )}
      </div>
      <div ref={host} className="timeline-decoders" />
      <div className="transport">
        <button
          disabled={interrupted}
          onClick={() => step(-1)}
          aria-label="Previous frame"
        >
          <StepBack aria-hidden="true" />
        </button>
        <button
          disabled={
            interrupted ||
            (rendered !== null && !ready) ||
            (!project.clips.length && !project.subtitles?.cues.length)
          }
          onClick={toggle}
          aria-label={playing ? 'Pause' : 'Play'}
          title={playing ? 'Pause' : 'Play'}
        >
          {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
        </button>
        <button
          disabled={interrupted}
          onClick={() => step(1)}
          aria-label="Next frame"
        >
          <StepForward aria-hidden="true" />
        </button>
        <output data-testid="project-position">
          {timelineTimecode(position, rate)} NDF
        </output>
        <button
          type="button"
          aria-label="Export frame"
          title="Export frame"
          disabled={
            interrupted || !end || frame >= Number(frameIndex(end, rate))
          }
          onClick={() => onExportFrame(frame)}
        >
          <Camera aria-hidden="true" />
        </button>
        <input
          type="range"
          aria-label="Seek timeline"
          min={0}
          max={end ? Number(frameIndex(end, rate)) : 0}
          step={1}
          value={frame}
          disabled={interrupted}
          onChange={(event) =>
            seek(framePosition(BigInt(event.target.value), rate))
          }
        />
      </div>
      {!!diagnostics?.unavailable.length && (
        <p role="status" className="timeline-diagnostics">
          {diagnostics.unavailable.join('\n')}
        </p>
      )}
      <div className="viewer-utilities">
        <div className="audio-meters" role="group" aria-label="Playback peaks">
          {(['Left', 'Right'] as const).map((channel, i) => {
            const peak = diagnostics?.audioPeaks[i] ?? 0;
            const db =
              peak > 0
                ? Math.max(-60, Math.min(0, 20 * Math.log10(peak)))
                : -60;
            return (
              <label
                key={channel}
                title={`${channel} peak · ${gainDb(peak)}FS`}
              >
                <span aria-hidden="true">{channel[0]}</span>
                <meter
                  aria-label={`${channel} audio peak`}
                  aria-valuetext={`${gainDb(peak)}FS`}
                  min={-60}
                  max={0}
                  low={-18}
                  high={-3}
                  optimum={-24}
                  value={db}
                />
              </label>
            );
          })}
        </div>
        <MediaCacheControls project={project} onStatus={onCacheStatus} />
        <details name="viewer-utilities" className="preview-quality">
          <summary>Preview quality</summary>
          <div className="viewer-utility-content">
            <label>
              Preview size{' '}
              <select
                value={previewSize}
                onChange={(event) =>
                  setPreviewSize(Number(event.currentTarget.value))
                }
              >
                <option value={1920}>Full preview</option>
                <option value={960}>960 px</option>
                <option value={480}>480 px</option>
              </select>
            </label>
            <button
              type="button"
              onClick={renderPreview}
              disabled={
                interrupted || renderStatus === 'Rendering full timeline…'
              }
            >
              Render full timeline
            </button>
            {rendered && (
              <button type="button" onClick={livePreview}>
                Live preview
              </button>
            )}
            {renderStatus && <output>{renderStatus}</output>}
            <label>
              <input
                type="checkbox"
                checked={exactPausedFrames}
                onChange={(event) =>
                  setExactPausedFrames(event.currentTarget.checked)
                }
              />{' '}
              Exact paused frames
            </label>
          </div>
        </details>
        <details name="viewer-utilities" className="timeline-diagnostics">
          <summary>Playback diagnostics</summary>
          <div className="viewer-utility-content">
            <h3>Playback</h3>
            {diagnostics && (
              <>
                <output>
                  {diagnostics.paintedLayers}/{diagnostics.visibleLayers} layers
                  · {diagnostics.compositeFps.toFixed(1)} fps ·{' '}
                  {diagnostics.droppedFrames} dropped · {diagnostics.lateFrames}{' '}
                  late · {diagnostics.maxMediaSkewMs.toFixed(1)} ms maximum
                  media skew · {diagnostics.waitingEvents} waits
                </output>
                <dl
                  data-testid="timeline-diagnostics"
                  data-report={JSON.stringify(diagnostics)}
                  className="diagnostic-values"
                >
                  <dt>State</dt>
                  <dd>{diagnostics.playing ? 'Playing' : 'Paused'}</dd>
                  <dt>Seek</dt>
                  <dd>{diagnostics.lastSeekLatencyMs.toFixed(1)} ms</dd>
                  <dt>Audio skew</dt>
                  <dd>{diagnostics.maxAudioSkewMs.toFixed(1)} ms</dd>
                  <dt>Waiting</dt>
                  <dd>{diagnostics.waitingEvents}</dd>
                </dl>
              </>
            )}
          </div>
        </details>
      </div>
    </div>
  );
}

import { Play, Pause, StepBack, StepForward } from 'lucide-react';
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
}

export function TimelinePreview({
  project,
  active,
  interrupted,
  position,
  onPositionChange,
  transportRef,
}: {
  project: Project;
  active: boolean;
  interrupted: boolean;
  position: RationalTime;
  onPositionChange(time: RationalTime): void;
  transportRef: Ref<TimelineTransport>;
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
    if (!active) return;
    const playback = new TimelinePlayback(
      project,
      canvas.current!,
      host.current!,
      (time, report) => {
        setDiagnostics(report);
        callback.current(time);
      },
      memoryBudget.current,
    );
    player.current = playback;
    playback.seek(initial.current);
    return () => {
      playback.dispose();
      player.current = null;
    };
  }, [project, active, cacheEpoch]);
  useEffect(() => {
    if (!active || interrupted) player.current?.pause();
  }, [active, interrupted, project]);
  useImperativeHandle(
    transportRef,
    () => ({
      seek: (time) => {
        if (active && !interrupted) player.current?.seek(time);
      },
      toggle: () => {
        if (active && !interrupted) void player.current?.toggle();
      },
      step: (direction) => {
        if (active && !interrupted) player.current?.step(direction);
      },
    }),
    [active, interrupted],
  );
  const rate = project.settings.frameRate;
  const end = player.current?.clock.end;
  const frame = Number(frameIndex(position, rate));
  return (
    <div className="timeline-player" aria-label="Edited timeline preview">
      <div className="timeline-stage">
        <canvas ref={canvas} aria-label="Edited timeline canvas" />
      </div>
      <div ref={host} className="timeline-decoders" />
      <div className="transport">
        <button
          disabled={interrupted}
          onClick={() => player.current?.step(-1)}
          aria-label="Previous frame"
        >
          <StepBack aria-hidden="true" />
        </button>
        <button
          disabled={
            interrupted ||
            (!project.clips.length && !project.subtitles?.cues.length)
          }
          onClick={() => void player.current?.toggle()}
          aria-label={diagnostics?.playing ? 'Pause' : 'Play'}
          title={diagnostics?.playing ? 'Pause' : 'Play'}
        >
          {diagnostics?.playing ? (
            <Pause aria-hidden="true" />
          ) : (
            <Play aria-hidden="true" />
          )}
        </button>
        <button
          disabled={interrupted}
          onClick={() => player.current?.step(1)}
          aria-label="Next frame"
        >
          <StepForward aria-hidden="true" />
        </button>
        <output data-testid="project-position">
          {timelineTimecode(position, rate)} NDF
        </output>
        <input
          type="range"
          aria-label="Seek timeline"
          min={0}
          max={end ? Number(frameIndex(end, rate)) : 0}
          step={1}
          value={frame}
          disabled={interrupted}
          onChange={(event) =>
            player.current?.seek(
              framePosition(BigInt(event.target.value), rate),
            )
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

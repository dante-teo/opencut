import {
  useEffect,
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
    );
    player.current = playback;
    playback.seek(initial.current);
    return () => {
      playback.dispose();
      player.current = null;
    };
  }, [project, active]);
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
          ◀│
        </button>
        <button
          disabled={interrupted || !project.clips.length}
          onClick={() => void player.current?.toggle()}
        >
          {diagnostics?.playing ? 'Pause' : 'Play'}
        </button>
        <button
          disabled={interrupted}
          onClick={() => player.current?.step(1)}
          aria-label="Next frame"
        >
          │▶
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
      <details className="timeline-diagnostics">
        <summary>Playback diagnostics</summary>
        <p>
          Single visual layer · Chromium decoding · Media skew is observed
          timing, not speaker loopback.
        </p>
        {diagnostics && (
          <>
            <output>
              {diagnostics.droppedFrames} dropped · {diagnostics.lateFrames}{' '}
              late · {diagnostics.maxMediaSkewMs.toFixed(1)} ms maximum media
              skew · {diagnostics.waitingEvents} waits
            </output>
            <pre data-testid="timeline-diagnostics">
              {JSON.stringify(diagnostics, null, 2)}
            </pre>
          </>
        )}
      </details>
    </div>
  );
}

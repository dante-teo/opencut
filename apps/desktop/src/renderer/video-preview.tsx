import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { PreviewSource } from '../bridge.js';
import {
  benchmarkPreview,
  frameAt,
  frameTarget,
  lastFrameIndex,
  seekPresented,
  type PreviewBenchmark,
} from './preview.js';

function Player({
  source,
  opening,
  onBusyChange,
}: {
  source: PreviewSource;
  opening: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const latestPresented = useRef<number | null>(null);
  const cancelSeekDrag = useRef<(() => void) | null>(null);
  const [seekDraft, setSeekDraft] = useState<number | null>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [presented, setPresented] = useState<number | null>(null);
  const [duration, setDuration] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [report, setReport] = useState<PreviewBenchmark | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const fps = source.frameRate;
  const videoEnd = Math.min(duration, source.videoEndSeconds ?? duration);
  useEffect(() => {
    const video = ref.current!;
    let callback = 0;
    const observe: VideoFrameRequestCallback = (_now, metadata) => {
      latestPresented.current = metadata.mediaTime;
      setPresented(metadata.mediaTime);
      setTime(video.currentTime);
      callback = video.requestVideoFrameCallback(observe);
    };
    callback = video.requestVideoFrameCallback(observe);
    return () => {
      cancelSeekDrag.current?.();
      video.cancelVideoFrameCallback(callback);
      video.pause();
    };
  }, []);
  async function perform(action: (video: HTMLVideoElement) => Promise<void>) {
    if (busy || opening || cancelSeekDrag.current || !ref.current) return;
    setBusy(true);
    onBusyChange(true);
    setError('');
    try {
      await action(ref.current);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }
  async function seek(video: HTMLVideoElement, target: number) {
    video.pause();
    if (Math.abs(video.currentTime - target) < 0.000001) return;
    if (
      fps &&
      latestPresented.current !== null &&
      frameAt(latestPresented.current, fps) === Math.floor(target * fps)
    )
      return;
    const sample = await seekPresented(video, target);
    setTime(video.currentTime);
    latestPresented.current = sample.presentedSeconds;
    setPresented(sample.presentedSeconds);
    setLatency(sample.presentedMs);
  }
  async function step(video: HTMLVideoElement, direction: -1 | 1) {
    if (!fps) return;
    const frame =
      frameAt(latestPresented.current ?? video.currentTime, fps) + direction;
    await seek(video, frameTarget(frame, fps, videoEnd));
  }
  async function seekFromSlider(video: HTMLVideoElement, value: number) {
    await seek(
      video,
      fps
        ? frameTarget(value, fps, videoEnd)
        : Math.min(value, duration - 0.001),
    );
  }
  function beginSeekDrag(event: ReactPointerEvent<HTMLInputElement>) {
    if (disabled || cancelSeekDrag.current) return;
    const input = event.currentTarget;
    const pointerId = event.pointerId;
    ref.current?.pause();
    setSeekDraft(Number(input.value));
    onBusyChange(true);
    const cleanup = () => {
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('blur', cancel);
      cancelSeekDrag.current = null;
    };
    const cancel = () => {
      cleanup();
      setSeekDraft(null);
      onBusyChange(false);
    };
    const finish = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      if (event.type === 'pointercancel') {
        cancel();
        return;
      }
      const value = Number(input.value);
      cleanup();
      setSeekDraft(null);
      void perform((video) => seekFromSlider(video, value));
    };
    cancelSeekDrag.current = cancel;
    // Window listeners also finish a drag released outside the input.
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('blur', cancel);
  }
  const disabled = !ready || busy || opening;
  const transportDisabled = disabled || seekDraft !== null;
  const lastFrame = fps ? lastFrameIndex(videoEnd, fps) : 0;
  const seekPosition =
    seekDraft ?? (fps ? Math.min(lastFrame, Math.floor(time * fps)) : time);
  const seekTime =
    seekDraft === null ? time : fps ? seekDraft / fps : seekDraft;
  return (
    <div className="player" aria-busy={busy}>
      <h2>{source.name}</h2>
      <p className="media-detail">
        {source.width && source.height
          ? `${source.width} × ${source.height} · `
          : ''}
        {fps ? `${fps.toFixed(3)} fps average` : 'Frame rate unknown'}
      </p>
      <video
        ref={ref}
        src={source.url}
        preload="auto"
        playsInline
        onLoadedData={() => {
          const video = ref.current!;
          if (
            !Number.isFinite(video.duration) ||
            video.duration <= 0 ||
            !video.videoWidth
          ) {
            setError('This file has no supported finite-duration video.');
            return;
          }
          setDuration(video.duration);
          setReady(true);
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={() => setTime(ref.current!.currentTime)}
        onError={() => {
          setReady(false);
          setError(
            'Unable to decode this video. Try H.264/AAC MP4 or a supported WebM file.',
          );
        }}
      />
      <div className="transport">
        <button
          disabled={transportDisabled || !fps}
          onClick={() => void perform((video) => step(video, -1))}
        >
          Previous frame
        </button>
        <button
          disabled={transportDisabled}
          onClick={() =>
            void perform(async (video) => {
              if (video.paused) await video.play();
              else video.pause();
            })
          }
        >
          {playing ? 'Pause' : 'Play'}
        </button>
        <button
          disabled={transportDisabled || !fps}
          onClick={() => void perform((video) => step(video, 1))}
        >
          Next frame
        </button>
      </div>
      <label className="seek-label">
        Seek
        <input
          aria-label="Seek"
          type="range"
          min="0"
          max={fps ? lastFrame : duration}
          step={fps ? 1 : 0.01}
          value={seekPosition}
          aria-valuetext={`${seekTime.toFixed(3)} seconds`}
          disabled={disabled}
          onPointerDown={beginSeekDrag}
          onChange={(event) => {
            const value = Number(event.currentTarget.value);
            if (cancelSeekDrag.current) setSeekDraft(value);
            else void perform((video) => seekFromSlider(video, value));
          }}
        />
      </label>
      <output data-testid="position">
        Time {time.toFixed(3)} / {duration.toFixed(3)} s · Presented{' '}
        {presented === null ? '—' : presented.toFixed(6)} s · Frame{' '}
        {fps && presented !== null ? frameAt(presented, fps) : '—'} (nominal,
        zero based)
      </output>
      {latency !== null && (
        <p className="media-detail">
          Last seek to presented frame: {latency.toFixed(1)} ms
        </p>
      )}
      <p className="media-detail">
        Frame stepping uses average FPS. Variable frame rate and stream offsets
        can make frame numbers approximate.
      </p>
      {source.warning && <p role="note">{source.warning}</p>}
      <button
        disabled={transportDisabled}
        onClick={() =>
          void perform(async (video) => {
            setReport(null);
            setReport(
              await benchmarkPreview(video, fps, () =>
                window.opencut.getPreviewMetrics(),
              ),
            );
          })
        }
      >
        Run performance validation
      </button>
      {busy && (
        <p role="note">
          Working… Keep this window visible. Validation runs 30 seeks and up to
          8 seconds of playback.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {report && (
        <div className="measurements">
          <p>
            Seek to presented frame: median{' '}
            {report.seek.presentedMs.median.toFixed(1)} ms · p95{' '}
            {report.seek.presentedMs.p95.toFixed(1)} ms
          </p>
          <p>
            Playback: {report.playback.droppedFrames} /{' '}
            {report.playback.totalFrames} dropped frames (
            {report.playback.droppedPercent.toFixed(2)}%) ·{' '}
            {report.playback.waitingEvents} waiting events
          </p>
          <details>
            <summary>Measurement JSON</summary>
            <pre data-testid="benchmark-result">
              {JSON.stringify(report, null, 2)}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}

export function Preview() {
  const [source, setSource] = useState<PreviewSource | null>(null);
  const [opening, setOpening] = useState(false);
  const [playerBusy, setPlayerBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <section className="preview">
      <h2>Video preview</h2>
      <p className="intro">
        Independent source preview · select a local video.
      </p>
      <button
        disabled={opening || playerBusy}
        onClick={() => {
          setOpening(true);
          setError('');
          void window.opencut
            .openPreview()
            .then((next) => {
              if (next) setSource(next);
            })
            .catch((error: unknown) =>
              setError(error instanceof Error ? error.message : String(error)),
            )
            .finally(() => setOpening(false));
        }}
      >
        {opening ? 'Opening…' : 'Open video'}
      </button>
      {error && <p role="alert">{error}</p>}
      {source && (
        <Player
          key={source.url}
          source={source}
          opening={opening}
          onBusyChange={setPlayerBusy}
        />
      )}
    </section>
  );
}

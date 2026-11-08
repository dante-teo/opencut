import { useEffect, useMemo, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { planProjectRender, projectRevision } from '@opencut/core';
import type { DesktopProject, ExportState } from '../bridge.js';
import {
  exportPresets,
  exportRates,
  type ExportSettings,
} from '../export-settings.js';

const active = (job: ExportState | null) =>
  !!job &&
  ['validating', 'rendering', 'verifying', 'cancelling'].includes(job.status);
const time = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const statusText: Record<ExportState['status'], string> = {
  validating: 'Validating export…',
  rendering: 'Exporting…',
  verifying: 'Verifying output…',
  cancelling: 'Cancelling…',
  succeeded: 'Export complete',
  validation_failed: 'Validation failed',
  failed: 'Export failed',
  cancelled: 'Export cancelled',
};

export function ExportPanel({
  state,
  disabled,
}: {
  state: DesktopProject | null;
  disabled: boolean;
}) {
  const panel = useRef<HTMLDialogElement>(null);
  const [settings, setSettings] = useState<ExportSettings>(
    exportPresets[0]!.settings,
  );
  const [output, setOutput] = useState('');
  const [job, setJob] = useState<ExportState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [clock, setClock] = useState(0);
  const running = active(job);
  useEffect(() => {
    // Restore job history, but require a fresh native destination for the next export.
    let live = true;
    let received = false;
    const remove = window.opencut.onExportChanged((next) => {
      if (!received) {
        setSettings(next.settings);
      }
      received = true;
      setJob(next);
    });
    void window.opencut
      .getExport()
      .then((next) => {
        if (live && !received) {
          setJob(next);
          if (next) {
            setSettings(next.settings);
          }
        }
      })
      .catch(() => {});
    return () => {
      live = false;
      remove();
    };
  }, []);
  useEffect(() => {
    if (!running) return;
    const started = performance.now();
    const base = job?.elapsedSeconds ?? 0;
    setClock(base);
    const timer = window.setInterval(
      () => setClock(base + (performance.now() - started) / 1000),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [running, job?.elapsedSeconds]);
  const estimatedDuration = useMemo(() => {
    if (!state) return null;
    try {
      const plan = planProjectRender(state.project);
      const rate =
        settings.frameRate === 'project'
          ? state.project.settings.frameRate
          : {
              numerator: Number(settings.frameRate.split('/')[0]),
              denominator: Number(settings.frameRate.split('/')[1] ?? 1),
            };
      const duration =
        (plan.frameCount * plan.frameRate.denominator) /
        plan.frameRate.numerator;
      return (
        (Math.ceil((duration * rate.numerator) / rate.denominator - 1e-9) *
          rate.denominator) /
        rate.numerator
      );
    } catch {
      return null;
    }
  }, [state, settings.frameRate]);
  async function perform(operation: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  const preset = exportPresets.findIndex(
    (entry) => JSON.stringify(entry.settings) === JSON.stringify(settings),
  );
  function update<K extends keyof ExportSettings>(
    key: K,
    value: ExportSettings[K],
  ) {
    setSettings((previous) => ({ ...previous, [key]: value }));
  }
  return (
    <>
      <button
        disabled={disabled || (!state && !job)}
        onClick={() => {
          if (!panel.current?.open) panel.current?.show();
        }}
      >
        <Download aria-hidden="true" focusable="false" />{' '}
        {running ? 'Exporting…' : 'Export'}
      </button>
      <dialog
        ref={panel}
        className="export-panel"
        aria-labelledby="export-heading"
      >
        <div className="export-heading">
          <h2 id="export-heading">Export video</h2>
          <button
            aria-label="Hide export"
            onClick={() => panel.current?.close()}
          >
            ×
          </button>
        </div>
        <div className="export-body">
          <p className="export-project-info">
            {state
              ? `${state.project.metadata.name} · ${state.project.settings.width} × ${state.project.settings.height} · ${state.project.settings.frameRate.numerator}/${state.project.settings.frameRate.denominator} fps · ${state.project.clips.length} clips`
              : 'No project open'}
            {estimatedDuration !== null &&
              ` · ${estimatedDuration.toFixed(3)} s output`}
          </p>
          {job && (
            <section className="export-progress" aria-label="Export status">
              <strong role="status">{statusText[job.status]}</strong>
              <span>
                {job.projectName} · revision {job.revision}
              </span>
              <span className="export-path">{job.output}</span>
              <progress
                aria-label="Export progress"
                max="100"
                value={
                  job.status === 'succeeded'
                    ? 100
                    : (job.progress?.percent ?? 0)
                }
              />
              <span>
                {job.progress ? `${Math.floor(job.progress.percent)}% · ` : ''}
                {time(running ? clock : job.elapsedSeconds)} elapsed
                {job.progress?.remainingSeconds != null &&
                job.status === 'rendering'
                  ? ` · ~${time(job.progress.remainingSeconds)} remaining`
                  : ''}
              </span>
              {job.summary && (
                <span>
                  {job.summary.width} × {job.summary.height} ·{' '}
                  {job.summary.frameRate.numerator}/
                  {job.summary.frameRate.denominator} fps ·{' '}
                  {job.summary.durationSeconds.toFixed(3)} s ·{' '}
                  {job.summary.codec.toUpperCase()}
                </span>
              )}
              {job.error && <p role="alert">{job.error}</p>}
              {job.warnings.length > 0 && (
                <ul aria-label="Export warnings">
                  {job.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              )}
            </section>
          )}
          <fieldset disabled={running || busy || !state}>
            <label>
              Preset
              <select
                aria-label="Preset"
                value={preset < 0 ? 'custom' : String(preset)}
                onChange={(event) => {
                  const selected = exportPresets[Number(event.target.value)];
                  if (selected) setSettings(selected.settings);
                }}
              >
                <option value="custom" disabled>
                  Custom
                </option>
                {exportPresets.map((entry, index) => (
                  <option key={entry.name} value={index}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="export-settings-grid">
              <label>
                Resolution
                <select
                  aria-label="Resolution"
                  value={settings.resolution}
                  onChange={(event) =>
                    update(
                      'resolution',
                      event.target.value as ExportSettings['resolution'],
                    )
                  }
                >
                  <option value="project">Project</option>
                  <option value="720p">720p</option>
                  <option value="1080p">1080p</option>
                </select>
              </label>
              <label>
                Frame rate
                <select
                  aria-label="Export frame rate"
                  value={settings.frameRate}
                  onChange={(event) =>
                    update(
                      'frameRate',
                      event.target.value as ExportSettings['frameRate'],
                    )
                  }
                >
                  {exportRates.map((rate) => (
                    <option key={rate} value={rate}>
                      {rate === 'project' ? 'Project' : `${rate} fps`}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Codec
                <select
                  aria-label="Codec"
                  value={settings.codec}
                  onChange={(event) =>
                    update(
                      'codec',
                      event.target.value as ExportSettings['codec'],
                    )
                  }
                >
                  <option value="h264">H.264 / AAC · MP4</option>
                  <option value="hevc">HEVC / AAC · MP4</option>
                </select>
              </label>
              <label>
                Quality
                <select
                  aria-label="Quality"
                  value={settings.quality}
                  onChange={(event) =>
                    update(
                      'quality',
                      event.target.value as ExportSettings['quality'],
                    )
                  }
                >
                  <option value="draft">Draft</option>
                  <option value="balanced">Balanced</option>
                  <option value="high">High</option>
                </select>
              </label>
            </div>
            <label>
              Output file
              <input
                aria-label="Output file"
                readOnly
                value={output}
                placeholder="Choose a new .mp4 file"
              />
            </label>
            <button
              onClick={() =>
                void perform(async () => {
                  const selected = await window.opencut.chooseExportOutput();
                  if (selected) setOutput(selected);
                })
              }
            >
              Choose output…
            </button>
          </fieldset>
          <p className="export-note">
            Exports use original media. Existing files are never replaced.
          </p>
          {error && <p role="alert">{error}</p>}
        </div>
        <div className="dialog-actions">
          {running ? (
            <button
              disabled={busy || job?.status === 'cancelling'}
              onClick={() =>
                void perform(async () => {
                  if (job) await window.opencut.cancelExport(job.id);
                })
              }
            >
              Cancel export
            </button>
          ) : (
            <button
              className="primary-button"
              disabled={busy || disabled || !state || !output}
              onClick={() =>
                void perform(async () => {
                  if (!state) return;
                  await window.opencut.startExport({
                    projectId: state.project.metadata.id,
                    expectedRevision: projectRevision(state.project),
                    settings,
                  });
                })
              }
            >
              Export video
            </button>
          )}
          <button onClick={() => panel.current?.close()}>
            {running ? 'Hide' : 'Done'}
          </button>
        </div>
      </dialog>
    </>
  );
}

import { useEffect, useState } from 'react';
import { projectRevision, type Project } from '@opencut/core';
import type { DesktopCacheStatus, MediaCacheAction } from '../bridge.js';

export function MediaCacheControls({
  project,
  onStatus,
}: {
  project: Project;
  onStatus(status: DesktopCacheStatus): void;
}) {
  const [status, setStatus] = useState<DesktopCacheStatus | null>(null);
  const [error, setError] = useState('');
  const [disk, setDisk] = useState('2048');
  const [memory, setMemory] = useState('64');
  useEffect(() => {
    let disposed = false;
    let pending = false;
    let initial = true;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const value = await window.opencut.mediaCache({ action: 'status' });
        if (disposed || !value) return;
        setStatus(value);
        onStatus(value);
        if (initial) {
          initial = false;
          setDisk(String(value.limits.diskBytes / 1024 ** 2));
          setMemory(String(value.limits.memoryBytes / 1024 ** 2));
        }
      } catch (error) {
        if (!disposed) setError(String(error));
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [onStatus]);
  const run = async (action: MediaCacheAction) => {
    try {
      setError('');
      await window.opencut.mediaCache(action);
    } catch (error) {
      setError(String(error));
    }
  };
  return (
    <details name="viewer-utilities" className="media-cache-controls">
      <summary>Proxy &amp; cache</summary>
      <div className="viewer-utility-content">
        <h3>Preview cache</h3>
        <label>
          <input
            type="checkbox"
            checked={status?.enabled ?? true}
            onChange={(event) => {
              const enabled = event.target.checked;
              setStatus((current) =>
                current ? { ...current, enabled } : current,
              );
              void run({ action: 'enable', enabled });
            }}
          />
          Use proxies
        </label>
        <output data-testid="cache-status">
          {status
            ? `${(status.diskBytes / 1024 ** 2).toFixed(1)} MiB disk · ${(status.memoryBytes / 1024 ** 2).toFixed(1)} MiB frames · ${status.entries.filter((entry) => entry.kind === 'proxy').length} proxies · ${status.hits} hits`
            : 'Loading cache…'}
        </output>
        <div className="transport">
          <label>
            Disk MiB{' '}
            <input
              aria-label="Disk cache MiB"
              type="number"
              min="1"
              max="1048576"
              value={disk}
              onChange={(event) => setDisk(event.target.value)}
            />
          </label>
          <label>
            Frame memory MiB{' '}
            <input
              aria-label="Frame memory MiB"
              type="number"
              min="1"
              max="1024"
              value={memory}
              onChange={(event) => setMemory(event.target.value)}
            />
          </label>
          <button
            onClick={() =>
              void run({
                action: 'configure',
                limits: {
                  diskBytes: Number(disk) * 1024 ** 2,
                  memoryBytes: Number(memory) * 1024 ** 2,
                },
              })
            }
          >
            Apply limits
          </button>
        </div>
        <div className="transport">
          <button
            onClick={() => {
              for (const asset of project.assets.filter(
                (asset) => asset.metadata?.kind === 'video',
              ))
                void run({
                  action: 'generate',
                  assetId: asset.id,
                  projectId: project.metadata.id,
                  expectedRevision: projectRevision(project),
                });
            }}
          >
            Regenerate proxies
          </button>
          <button onClick={() => void run({ action: 'cancel' })}>
            Cancel generation
          </button>
          <button onClick={() => void run({ action: 'cleanup' })}>
            Clean stale cache
          </button>
          <button onClick={() => void run({ action: 'clear' })}>
            Clear cache
          </button>
        </div>
        {status?.jobs.map((job, index) => (
          <p key={index}>
            {job.name}: {job.state}
            {job.progress && ['generating', 'queued'].includes(job.state)
              ? ` ${job.progress.percent.toFixed(0)}%`
              : ''}
            {job.error ? ` · ${job.error}` : ''}
          </p>
        ))}
        {error && <p role="status">{error}</p>}
      </div>
    </details>
  );
}

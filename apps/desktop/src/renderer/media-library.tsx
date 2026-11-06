import { useEffect, useState } from 'react';
import {
  Film,
  Image,
  Music2,
  Upload,
  Trash2,
  Library,
  LoaderCircle,
} from 'lucide-react';
import { LibraryArtwork } from './studio-graphics.js';
import type { MediaAsset } from '@opencut/core';
import type { DesktopProject } from '../bridge.js';

export const ASSET_DRAG_TYPE = 'application/x-opencut-asset';
export interface AssetDrag {
  projectId: string;
  assetId: string;
  revision: number;
}
export function readAssetDrag(value: string): AssetDrag {
  const data: unknown = JSON.parse(value);
  if (
    !data ||
    typeof data !== 'object' ||
    !('projectId' in data) ||
    !('assetId' in data) ||
    !('revision' in data) ||
    typeof data.projectId !== 'string' ||
    typeof data.assetId !== 'string' ||
    typeof data.revision !== 'number'
  )
    throw new Error('Invalid library drag.');
  return data as AssetDrag;
}
function Thumbnail({ asset }: { asset: MediaAsset }) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(asset.mediaTypes.includes('video'));
  useEffect(() => {
    let active = true;
    if (asset.mediaTypes.includes('video')) {
      setLoading(true);
      void window.opencut
        .assetThumbnail(asset.id)
        .then((url) => {
          if (active) setUrl(url);
        })
        .catch(() => {})
        .finally(() => {
          if (active) setLoading(false);
        });
    }
    return () => {
      active = false;
    };
  }, [asset.id, asset.file.path]);
  return (
    <span
      className={`asset-icon ${asset.metadata?.kind ?? asset.mediaTypes[0]}`}
      aria-hidden="true"
      aria-busy={loading}
    >
      {url ? (
        <img src={url} alt="" draggable={false} />
      ) : loading ? (
        <LoaderCircle aria-hidden="true" focusable="false" />
      ) : asset.mediaTypes[0] === 'audio' ? (
        <Music2 aria-hidden="true" focusable="false" />
      ) : asset.metadata?.kind === 'image' ? (
        <Image aria-hidden="true" focusable="false" />
      ) : (
        <Film aria-hidden="true" focusable="false" />
      )}
    </span>
  );
}
export function MediaLibrary({
  state,
  busy,
  selection,
  onSelect,
  onImport,
  onDrop,
  onRemove,
  revision,
}: {
  state: DesktopProject | null;
  busy: boolean;
  selection: { kind: string; id: string } | null;
  onSelect: (id: string) => void;
  onImport: () => void;
  onDrop: (files: File[]) => void;
  onRemove: (id: string) => void;
  revision: number;
}) {
  const [over, setOver] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const project = state?.project;
  const assets =
    project?.assets.filter(
      (asset) =>
        asset.name
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase()) &&
        (filter === 'all' ||
          (filter === 'image'
            ? asset.metadata?.kind === 'image'
            : asset.metadata?.kind !== 'image' &&
              asset.mediaTypes.includes(filter as 'video' | 'audio'))),
    ) ?? [];
  const selectedAsset =
    selection?.kind === 'asset'
      ? project?.assets.find((asset) => asset.id === selection.id)
      : undefined;
  const referenced = project?.clips.some(
    (clip) => clip.assetId === selectedAsset?.id,
  );
  return (
    <aside
      className={`library-panel ${over ? 'drop-active' : ''}`}
      aria-label="Media library"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault();
          event.dataTransfer.dropEffect = busy || !project ? 'none' : 'copy';
          setOver(!busy && !!project);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setOver(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        if (!busy && project && event.dataTransfer.files.length)
          onDrop(Array.from(event.dataTransfer.files));
      }}
    >
      <div className="panel-heading">
        <h2 aria-label={`Media assets (${project?.assets.length ?? 0})`}>
          <Library aria-hidden="true" focusable="false" /> Media{' '}
          <span className="count-badge">{project?.assets.length ?? 0}</span>
        </h2>
      </div>
      <div className="library-actions">
        <button
          className="import-button"
          disabled={busy || !project}
          onClick={onImport}
        >
          <Upload aria-hidden="true" focusable="false" /> Import media
        </button>
        <button
          aria-label="Remove asset"
          className="remove-asset-button"
          disabled={busy || !selectedAsset || referenced}
          title={
            referenced
              ? 'Used by timeline clips'
              : 'Remove selected asset from library'
          }
          onClick={() => selectedAsset && onRemove(selectedAsset.id)}
        >
          <Trash2 aria-hidden="true" focusable="false" />
        </button>
      </div>
      <div className="library-search">
        <input
          type="search"
          aria-label="Search media"
          placeholder="Search your media…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          aria-label="Filter media type"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        >
          <option value="all">All media</option>
          <option value="video">Video</option>
          <option value="audio">Audio</option>
          <option value="image">Images</option>
        </select>
      </div>
      <div className="library-content">
        {!project?.assets.length ? (
          <div className="library-empty">
            <LibraryArtwork />
            <h3>No media</h3>
            {project && <p>Drop files here</p>}
          </div>
        ) : assets.length === 0 ? (
          <div className="library-empty">
            <h3>No matching media</h3>
            <button
              onClick={() => {
                setQuery('');
                setFilter('all');
              }}
            >
              Clear filters
            </button>
          </div>
        ) : (
          <ul className="asset-list">
            {assets.map((asset) => {
              const availability = state?.media.find(
                (item) => item.assetId === asset.id,
              );
              const offline = availability?.status !== 'available';
              const duration =
                asset.metadata?.kind === 'image'
                  ? 'Still · 5s default'
                  : asset.duration
                    ? `${(asset.duration.numerator / asset.duration.denominator).toFixed(2)}s`
                    : 'Unknown duration';
              return (
                <li key={asset.id}>
                  <button
                    disabled={busy}
                    draggable={!busy && !offline}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = 'copy';
                      event.dataTransfer.setData('text/plain', asset.name);
                      event.dataTransfer.setData(
                        ASSET_DRAG_TYPE,
                        JSON.stringify({
                          projectId: project.metadata.id,
                          assetId: asset.id,
                          revision,
                        }),
                      );
                    }}
                    aria-pressed={
                      selection?.kind === 'asset' && selection.id === asset.id
                    }
                    onClick={() => onSelect(asset.id)}
                  >
                    <Thumbnail asset={asset} />
                    <span className="asset-label">
                      <strong>{asset.name}</strong>
                      <small>
                        {asset.metadata?.kind ?? asset.mediaTypes.join(', ')} ·{' '}
                        {duration}
                        {offline ? ' · Offline' : ''}
                      </small>
                    </span>
                  </button>
                  {offline && (
                    <p className="asset-availability">
                      {availability?.message}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}

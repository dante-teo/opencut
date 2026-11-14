import { useEffect, useState } from 'react';
import { Film, Image, Music2, Library, LoaderCircle } from 'lucide-react';
import type { MediaAsset } from '@opencut/core';
import type { DesktopProject } from '../bridge.js';

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
  selection,
  onSelect,
}: {
  state: DesktopProject | null;
  selection: { kind: 'asset' | 'clip'; id: string } | null;
  onSelect: (id: string) => void;
}) {
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const assets = state?.project.assets ?? [];
  const shown = assets.filter(
    (asset) =>
      asset.name.toLowerCase().includes(query.trim().toLowerCase()) &&
      (filter === 'all' ||
        (filter === 'image'
          ? asset.metadata?.kind === 'image'
          : asset.metadata?.kind !== 'image' &&
            asset.mediaTypes.some((type) => type === filter))),
  );
  return (
    <aside className="library-panel" aria-label="Media library">
      <div className="panel-heading">
        <h2>
          <Library aria-hidden="true" /> Media library
        </h2>
      </div>
      <input
        type="search"
        aria-label="Search media"
        placeholder="Search media"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
      />
      {assets.length > 0 && (
        <label>
          Media type{' '}
          <select
            aria-label="Media type"
            value={filter}
            onChange={(event) => setFilter(event.currentTarget.value)}
          >
            <option value="all">All media</option>
            <option value="video">Video</option>
            <option value="audio">Audio</option>
            <option value="image">Images</option>
          </select>
        </label>
      )}
      <ul className="asset-list">
        {shown.map((asset) => {
          const availability = state?.media.find(
            ({ assetId }) => assetId === asset.id,
          );
          return (
            <li key={asset.id}>
              <button
                type="button"
                className="asset-button"
                aria-pressed={
                  selection?.kind === 'asset' && selection.id === asset.id
                }
                onClick={() => onSelect(asset.id)}
              >
                <Thumbnail
                  key={
                    String(state?.view) +
                    ':' +
                    (state?.project.editing?.revision ?? 0)
                  }
                  asset={asset}
                />
                <span>{asset.name}</span>
                {availability?.status !== 'available' && (
                  <span title={availability?.message}>
                    {availability?.status}
                  </span>
                )}
              </button>
              {asset.provenance && (
                <small className="asset-credit">
                  {asset.provenance.creator && asset.provenance.creator + ' · '}
                  {asset.provenance.license}
                </small>
              )}
            </li>
          );
        })}
      </ul>
      {!shown.length && <p>No media</p>}
    </aside>
  );
}

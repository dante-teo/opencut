import { useState } from 'react';
import type {
  OnlineMediaKind,
  OnlineMediaPage,
  OnlineMediaProvider,
  OnlineMediaResult,
} from '../bridge.js';

function onlineError(error: unknown) {
  return error instanceof Error
    ? error.message.replace(
        /^Error invoking remote method '[^']+': (?:Error: )?/,
        '',
      )
    : String(error);
}

function OnlinePreview({ result }: { result: OnlineMediaResult }) {
  const [failed, setFailed] = useState(false);
  if (failed || !result.previewUrl)
    return <p>Preview unavailable. Open the source to view this file.</p>;
  const onError = () => setFailed(true);
  if (result.kind === 'image')
    return <img src={result.previewUrl} alt={result.title} onError={onError} />;
  if (result.kind === 'audio')
    return <audio src={result.previewUrl} controls onError={onError} />;
  return (
    <video src={result.previewUrl} controls playsInline onError={onError} />
  );
}

export function OnlineMediaLibrary({
  busy,
  onImport,
}: {
  busy: boolean;
  onImport: (id: string) => void;
}) {
  const [provider, setProvider] = useState<OnlineMediaProvider>('commons');
  const [kind, setKind] = useState<OnlineMediaKind>('image');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{
    page: OnlineMediaPage;
    query: string;
    tokens: (string | undefined)[];
  } | null>(null);
  const page = results?.page;
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  function resetResults() {
    setResults(null);
    setError('');
    setPreviewId(null);
  }

  async function search(term: string, history: (string | undefined)[]) {
    if (loading || !term.trim()) return;
    setLoading(true);
    setError('');
    setPreviewId(null);
    const token = history.at(-1);
    try {
      const result = await window.opencut.searchOnlineMedia({
        provider,
        kind,
        query: term,
        ...(token ? { page: token } : {}),
      });
      setResults({ page: result, query: term, tokens: history });
    } catch (error) {
      setError(onlineError(error));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <form
        className="library-search online-search"
        onSubmit={(event) => {
          event.preventDefault();
          void search(query, [undefined]);
        }}
      >
        <div className="online-search-filters">
          <select
            aria-label="Online media provider"
            disabled={loading}
            value={provider}
            onChange={(event) => {
              const next = event.target.value as OnlineMediaProvider;
              setProvider(next);
              if (next === 'openverse' && kind === 'video') setKind('image');
              resetResults();
            }}
          >
            <option value="commons">Wikimedia Commons</option>
            <option value="openverse">Openverse</option>
          </select>
          <select
            aria-label="Online media type"
            disabled={loading}
            value={kind}
            onChange={(event) => {
              setKind(event.target.value as OnlineMediaKind);
              resetResults();
            }}
          >
            <option value="image">Images</option>
            <option value="audio">Audio</option>
            {provider === 'commons' && <option value="video">Video</option>}
          </select>
        </div>
        <div className="online-search-row">
          <input
            type="search"
            aria-label="Search online media"
            placeholder="Search online…"
            maxLength={200}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button type="submit" disabled={loading || !query.trim()}>
            Search
          </button>
        </div>
      </form>
      <div className="library-content online-results" aria-busy={loading}>
        {loading && <p role="status">Searching…</p>}
        {error && <p role="alert">{error}</p>}
        {!loading && page?.results.length === 0 && (
          <p>No matching media on this page.</p>
        )}
        {page && page.results.length > 0 && (
          <ul>
            {page.results.map((result) => {
              const previewing = previewId === result.id;
              return (
                <li key={result.id}>
                  <strong title={result.title}>{result.title}</strong>
                  <small>
                    {result.creator && `${result.creator} · `}
                    {result.license}
                  </small>
                  <div className="online-result-actions">
                    {result.previewUrl && (
                      <button
                        aria-expanded={previewing}
                        onClick={() =>
                          setPreviewId(previewing ? null : result.id)
                        }
                      >
                        {previewing ? 'Hide preview' : 'Preview'}
                      </button>
                    )}
                    {result.importable && (
                      <button
                        disabled={busy}
                        onClick={() => onImport(result.id)}
                      >
                        Add to project
                      </button>
                    )}
                    <button
                      onClick={() => {
                        void window.opencut
                          .openOnlineMediaSource(result.id)
                          .catch((error: unknown) =>
                            setError(onlineError(error)),
                          );
                      }}
                    >
                      Open source
                    </button>
                  </div>
                  {previewing && <OnlinePreview result={result} />}
                </li>
              );
            })}
          </ul>
        )}
        {results && (results.tokens.length > 1 || results.page.nextPage) && (
          <div className="online-page-actions">
            <button
              disabled={loading || results.tokens.length === 1}
              onClick={() =>
                void search(results.query, results.tokens.slice(0, -1))
              }
            >
              Previous
            </button>
            <button
              disabled={loading || !results.page.nextPage}
              onClick={() => {
                const next = results.page.nextPage;
                if (next) void search(results.query, [...results.tokens, next]);
              }}
            >
              Next
            </button>
          </div>
        )}
      </div>
    </>
  );
}

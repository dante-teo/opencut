import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ApplicationInfo } from '@opencut/core';
import './style.css';
import appIcon from '../../resources/opencut-icon.png';
import { Preview } from './video-preview.js';
import { DefinitionWorkspace } from './definition-workspace.js';
import type { DefinitionReview } from '../bridge.js';

function App() {
  const [info, setInfo] = useState<ApplicationInfo | null>(null);
  const [error, setError] = useState(false);
  const [definition, setDefinition] = useState<DefinitionReview | null>(null);
  const [definitionError, setDefinitionError] = useState('');
  useEffect(() => window.opencut.onDefinitionChanged(setDefinition), []);
  function openDefinition() {
    setDefinitionError('');
    void window.opencut
      .openDefinition()
      .catch((error: Error) => setDefinitionError(error.message));
  }
  useEffect(() => {
    window.opencut
      .getApplicationInfo()
      .then(setInfo)
      .catch(() => setError(true));
  }, []);
  return (
    <main className="app-shell">
      <header>
        <span className="mark" aria-hidden="true">
          <img src={appIcon} alt="" draggable={false} />
        </span>
        <span className="brand-name">
          OpenCut<span className="brand-dot">.</span>
        </span>
      </header>
      {definition ? (
        <DefinitionWorkspace
          state={definition}
          onOpen={openDefinition}
          onClose={() => {
            setDefinitionError('');
            void window.opencut
              .closeDefinition()
              .catch((error: Error) => setDefinitionError(error.message));
          }}
        />
      ) : (
        <section className="workspace" aria-label="Review workspace">
          <div className="project-toolbar">
            <h1>Review</h1>
            <button onClick={openDefinition}>Open definition</button>
          </div>
          <Preview />
        </section>
      )}
      {definitionError && <p role="alert">{definitionError}</p>}
      <p
        className={`status ${info && !error ? 'status-ready' : ''}`}
        role="status"
      >
        <span className="dot" aria-hidden="true" />
        {error
          ? 'Unable to connect to the application'
          : info
            ? `${info.name} is running · v${info.version}`
            : 'Starting OpenCut…'}
      </p>
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing application root.');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

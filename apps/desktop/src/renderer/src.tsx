import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ApplicationInfo } from '@opencut/core';
import './style.css';
import appIcon from '../../resources/opencut-icon.png';
import { ProjectWorkspace } from './project-workspace.js';

function App() {
  const [info, setInfo] = useState<ApplicationInfo | null>(null);
  const [error, setError] = useState(false);
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
      <ProjectWorkspace />
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

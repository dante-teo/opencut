import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ApplicationInfo } from '@opencut/core';
import './style.css';

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
    <main>
      <header>
        <span className="mark" aria-hidden="true">
          OC
        </span>
        <span>OpenCut</span>
      </header>
      <section>
        <p className="eyebrow">DESKTOP + COMMAND LINE</p>
        <h1>A place for your next cut.</h1>
        <p className="intro">One editing core. Two ways to create.</p>
        <p className="status" role="status">
          <span className="dot" aria-hidden="true" />
          {error
            ? 'Unable to connect to the application'
            : info
              ? `${info.name} is running · v${info.version}`
              : 'Starting OpenCut…'}
        </p>
        <div className="note">
          <span className="badge">T01</span>
          <div>
            <h2>Foundation ready</h2>
            <p>
              The application shell is ready. Video editing is not implemented
              yet.
            </p>
          </div>
        </div>
      </section>
      <footer>OpenCut / Development preview</footer>
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

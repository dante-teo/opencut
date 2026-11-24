import './anime.js';

const unsupported = () => {
  throw new Error(
    'Composition timers are unavailable. Register a host-controlled Anime.js timeline.',
  );
};
for (const api of [
  'setTimeout',
  'setInterval',
  'requestAnimationFrame',
  'requestIdleCallback',
])
  Object.defineProperty(window, api, {
    value: unsupported,
    configurable: false,
    writable: false,
  });

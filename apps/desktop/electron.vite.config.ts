import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';

export default defineConfig(({ command }) => ({
  main: {
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'media-worker': resolve('src/main/media-worker.ts'),
        },
      },
    },
  },
  // CommonJS is required for Electron's sandboxed preload environment.
  preload: {
    build: {
      outDir: 'dist/preload',
      rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    server: { host: '127.0.0.1', port: 5173, strictPort: true },
    build: { outDir: resolve('dist/renderer') },
    plugins: [
      {
        name: 'opencut-csp',
        transformIndexHtml(html) {
          const development = command === 'serve';
          const policy = [
            "default-src 'none'",
            "script-src 'self'",
            development
              ? "style-src 'self' 'unsafe-inline'"
              : "style-src 'self'",
            "img-src 'self' data: opencut://media",
            'media-src opencut://media',
            development
              ? "connect-src 'self' ws://127.0.0.1:5173"
              : "connect-src 'none'",
            "base-uri 'none'",
            "form-action 'none'",
            "object-src 'none'",
          ].join('; ');
          return html.replace('__CSP__', policy);
        },
      },
    ],
  },
}));

import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import type {
  Browser,
  BrowserContext,
  BrowserServer,
  Page,
} from 'playwright-core';
import type { GraphicFrame } from './browser.js';
import type { ReactGraphicBundle } from './compiler.js';
import { graphicsDiagnostics } from './diagnostics.js';

import { adapterVersions, reactGraphicsBackend } from './compiler.js';
export { compileReactGraphic } from './compiler.js';
export { parseTemplateProps } from './template-props.js';
export type { GraphicTemplate } from './template-props.js';
export type { BuiltinGraphic, ReactGraphicBundle } from './compiler.js';

const browserChannel = 'chromium-headless-shell';
// Use the pinned Playwright registry so launch and readiness resolve the same binary.
const { registry } = createRequire(import.meta.url)(
  'playwright-core/lib/coreBundle',
) as {
  registry: {
    registry: {
      findExecutable(name: string): { executablePath(): string | undefined };
    };
  };
};

const origin = 'https://graphics.opencut.invalid';
const startTimeout = 15_000;
const frameTimeout = 10_000;
const html =
  '<!doctype html><meta charset=utf-8><link rel=stylesheet href="/graphic.css"><div id=graphic></div><script defer src="/graphic.js"></script>';
const policy =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; font-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export async function graphicsRuntime() {
  const path =
    registry.registry.findExecutable(browserChannel).executablePath() ?? '';
  const installed = await access(path, constants.X_OK).then(
    () => true,
    () => false,
  );
  return {
    installed,
    path,
    backend: reactGraphicsBackend,
    adapters: adapterVersions(),
  };
}

interface Surface {
  key: string;
  context: BrowserContext;
  page: Page;
  error?: string;
}

export function openReactGraphics(
  cjkFont: () => Promise<Buffer>,
  track: (pid: number | undefined, stop: (error: Error) => void) => () => void,
) {
  let worker:
    Promise<{ server: BrowserServer; browser: Promise<Browser> }> | undefined;
  let view: Surface | undefined;
  let webgl = false;
  let closePromise: Promise<void> | undefined;
  let budgetError: Error | undefined;
  let active = false;
  let serial = 0;

  const close = () =>
    (closePromise ??= (async () => {
      const running = await worker?.catch(() => undefined);
      if (!running) return;
      try {
        if (!active && view) await disposeSurface(view);
      } finally {
        await running.server.kill();
      }
    })());

  async function disposeSurface(surface: Surface) {
    // Use a bounded Playwright operation. The context still closes if a
    // component's disposal throws or misses its deadline.
    const disposal = surface.page
      .evaluate(async () => window.disposeOpenCutGraphic?.())
      .catch(() => {});
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 1000);
      void disposal.then(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  async function browser(needsWebgl: boolean) {
    if (closePromise) throw new Error('The graphics renderer is closed.');
    if (worker && needsWebgl && !webgl) {
      const previous = await worker;
      await previous.server.kill();
      worker = undefined;
    }
    webgl = webgl || needsWebgl;
    const running = await (worker ??= chromium
      .launchServer({
        host: '127.0.0.1',
        chromiumSandbox: true,
        // The caller owns the foreground cancellation and temporary outputs.
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        channel: browserChannel,
        headless: true,
        timeout: startTimeout,
        args: [
          '--force-color-profile=srgb',
          '--disable-background-networking',
          ...(webgl
            ? [
                '--use-gl=angle',
                '--use-angle=swiftshader',
                '--enable-unsafe-swiftshader',
              ]
            : []),
        ],
      })
      .then((server) => {
        const untrack = track(server.process().pid, (error) => {
          budgetError = error;
          void close().catch(() => {});
        });
        server.once('close', untrack);
        return {
          server,
          browser: chromium.connect(server.wsEndpoint(), {
            timeout: startTimeout,
          }),
        };
      }));
    return running.browser;
  }

  async function surface(
    bundle: ReactGraphicBundle,
    { width, height }: GraphicFrame['timing'],
    key: string,
  ) {
    if (bundle.backend !== reactGraphicsBackend)
      throw new Error(
        `Graphics bundle requires '${bundle.backend}'. Install the matching OpenCut runtime.`,
      );
    if (view?.key === key) return view;
    const previous = view;
    view = undefined;
    try {
      if (previous) await disposeSurface(previous);
    } finally {
      // Let a close issued in the same turn win before opening a browser.
      await previous?.context.close();
    }
    const context = await (
      await browser(bundle.adapter === 'three')
    ).newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
      acceptDownloads: false,
      serviceWorkers: 'block',
      offline: true,
      locale: 'en-US',
      timezoneId: 'UTC',
      reducedMotion: 'no-preference',
    });
    const page = await context.newPage();
    const next: Surface = { key, context, page };
    const diagnostic = graphicsDiagnostics(bundle.sourceMap);
    view = next;
    await context.routeWebSocket('**/*', (socket) => socket.close());
    const files: Record<string, [string, string | (() => Promise<Buffer>)]> = {
      [origin + '/cjk.ttf']: ['font/ttf', cjkFont],
      [origin + '/']: ['text/html; charset=utf-8', html],
      [origin + '/graphic.js']: [
        'application/javascript; charset=utf-8',
        bundle.js,
      ],
      [origin + '/graphic.css']: [
        'text/css; charset=utf-8',
        '@font-face{font-family:"OpenCut CJK";src:url("/cjk.ttf") format("truetype");font-weight:100 900;unicode-range:U+2E80-2FFF,U+3000-30FF,U+31C0-31EF,U+3400-9FFF,U+F900-FAFF,U+FF00-FFEF,U+20000-2FFFF}' +
          'html{font-family:"OpenCut CJK",system-ui,sans-serif}html,body,#graphic{margin:0;width:100%;height:100%;overflow:hidden}*,*::before,*::after{animation:none!important;transition:none!important}\n' +
          bundle.css,
      ],
    };
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = request.url();
      const resource = files[url];
      if (
        !resource ||
        request.method() !== 'GET' ||
        (request.isNavigationRequest() &&
          (url !== origin + '/' || page.url() !== 'about:blank'))
      ) {
        next.error ??=
          'A graphics component requested an unavailable resource or navigation.';
        return route.abort('blockedbyclient');
      }
      await route.fulfill({
        contentType: resource[0],
        body:
          typeof resource[1] === 'string' ? resource[1] : await resource[1](),
        headers: {
          'content-security-policy': policy,
          'x-content-type-options': 'nosniff',
        },
      });
    });
    context.on('page', (popup) => {
      next.error ??= 'A graphics component attempted to open a window.';
      void popup.close().catch(() => {});
    });
    page.on('pageerror', (error) => {
      next.error ??= diagnostic(error);
    });
    await page.goto(origin + '/', { waitUntil: 'load', timeout: startTimeout });
    await page.evaluate(
      (resources) => window.setOpenCutGraphicResources(resources),
      bundle.resources,
    );
    return next;
  }

  return {
    close,
    async frame(
      bundle: ReactGraphicBundle,
      request: GraphicFrame,
      signal?: AbortSignal,
    ) {
      signal?.throwIfAborted();
      if (closePromise) throw new Error('The graphics renderer is closed.');
      if (active)
        throw new Error('The graphics renderer already has a pending frame.');
      const { width, height } = request.timing;
      const key = JSON.stringify([bundle.key, width, height]);
      const limit = AbortSignal.timeout(
        view?.key === key ? frameTimeout : 2 * startTimeout + frameTimeout,
      );
      const controller = signal ? AbortSignal.any([signal, limit]) : limit;
      controller.throwIfAborted();
      active = true;
      const requestId = ++serial;
      const abort = () => {
        void close().catch(() => {});
      };
      controller.addEventListener('abort', abort, { once: true });
      try {
        const current = await surface(bundle, request.timing, key);
        const { page } = current;
        controller.throwIfAborted();
        const completed = await page.evaluate(
          ({ request, requestId }) =>
            window.renderOpenCutGraphic(request, requestId),
          { request, requestId },
        );
        if (bundle.version === 2 && completed !== requestId)
          throw new Error('Chromium returned a stale graphics frame.');
        const png = await page.screenshot({
          omitBackground: true,
          timeout: frameTimeout,
        });
        if (current.error) throw new Error(current.error);
        if (page.url() !== origin + '/')
          throw new Error('Graphics navigation is disabled.');
        controller.throwIfAborted();
        return png;
      } catch (cause) {
        if (budgetError) throw budgetError;
        signal?.throwIfAborted();
        if (limit.aborted)
          throw new Error('Graphics frame timed out.', { cause });
        throw new Error(
          `Chromium graphics render failed: ${view?.error ?? graphicsDiagnostics(bundle.sourceMap)(cause)}`,
          { cause },
        );
      } finally {
        controller.removeEventListener('abort', abort);
        active = false;
      }
    },
  };
}

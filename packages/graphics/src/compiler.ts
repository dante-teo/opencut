import { createRequire } from 'node:module';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { context, version } from 'esbuild';
import type { Loader } from 'esbuild';
import { templateEntry } from './template-entry.js';
import type { GraphicScene, ThreeScene } from '@opencut/shared';
import type { IntrinsicRange } from './intrinsic-time.js';
import type { LottieClock } from './lottie-adapter.js';
import { bundleDependencyNotices } from './bundle-dependencies.js';
import type { GraphicTemplate } from './template-props.js';

const resolveRuntime = createRequire(import.meta.url).resolve;
const browserRuntime = fileURLToPath(new URL('./browser.js', import.meta.url));
const reactHooks = fileURLToPath(new URL('./react.js', import.meta.url));
const sharedRuntime = fileURLToPath(import.meta.resolve('@opencut/shared'));
const runtimeFile = (name: string) =>
  JSON.stringify(fileURLToPath(new URL(name, import.meta.url)));
const templates = fileURLToPath(new URL('./templates.js', import.meta.url));
const runtime = createRequire(import.meta.url)(
  'playwright-core/package.json',
) as { version: string };
export const reactGraphicsBackend = `react-graphic-v1/playwright-${runtime.version}`;

const mime: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
};

const loaders: Record<string, Loader> = {
  ...Object.fromEntries(
    Object.keys(mime).map((suffix) => [suffix, 'dataurl' as const]),
  ),
  '.js': 'js',
  '.cjs': 'js',
  '.mjs': 'js',
  '.jsx': 'jsx',
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.json': 'json',
  '.css': 'css',
};

export interface ReactGraphicBundle {
  version: 1 | 2;
  template?: GraphicTemplate | undefined;
  adapter?: 'scene' | 'lottie' | 'three' | undefined;
  backend: string;
  key: string;
  js: string;
  css: string;
  sourceMap?: string | undefined;
  notices?: Record<string, string> | undefined;
  resources: Record<string, string>;
}

export type BuiltinGraphic =
  | { kind: 'template'; name: GraphicTemplate }
  | { kind: 'scene'; scene: GraphicScene }
  | { kind: 'lottie'; clock: LottieClock; range: IntrinsicRange }
  | { kind: 'three'; scene: ThreeScene };

function builtinEntry(graphic: BuiltinGraphic) {
  if (graphic.kind === 'template')
    return `import { ${graphic.name} as Component } from ${JSON.stringify(templates)};
      installGraphic(Component);`;
  if (graphic.kind === 'scene')
    return `import {createElement} from 'react';
      import {SceneGraphic} from ${runtimeFile('./scene.js')};
      import {useGraphicResources} from ${JSON.stringify(reactHooks)};
      installGraphic(() => createElement(SceneGraphic, { scene: ${JSON.stringify(graphic.scene)}, resources: useGraphicResources() }), true);`;
  const source =
    graphic.kind === 'lottie'
      ? {
          entry: './lottie-adapter.js',
          factory: 'lottieFrameAdapter',
          args: [graphic.clock, graphic.range],
        }
      : {
          entry: './three-adapter.js',
          factory: 'threeFrameAdapter',
          args: [graphic.scene],
        };
  return `import { installFrameAdapter } from ${runtimeFile('./frame-adapter.js')};
    import { ${source.factory} as makeAdapter } from ${runtimeFile(source.entry)};
    installFrameAdapter(makeAdapter(${source.args.map((item) => JSON.stringify(item)).join(',')}));`;
}

export async function compileReactGraphic(
  path: string,
  resources: Record<string, string>,
  read: (file: string, runtime?: boolean) => Promise<Buffer>,
  signal?: AbortSignal,
  missing?: (path: string) => void,
  builtin?: BuiltinGraphic,
): Promise<ReactGraphicBundle> {
  signal?.throwIfAborted();
  const inputs = new Map<string, string>();
  const snapshot = async (path: string, runtime?: boolean) => {
    const bytes = await read(path, runtime);
    inputs.set(path, createHash('sha256').update(bytes).digest('hex'));
    return bytes;
  };
  const captured = Object.fromEntries(
    await Promise.all(
      Object.entries(resources).map(async ([id, file]) => {
        const type = mime[extname(file).toLowerCase()];
        if (!type) throw new Error(`Unsupported graphics resource '${file}'.`);
        const bytes = await snapshot(file);
        if (type === 'application/json') JSON.parse(bytes.toString('utf8'));
        return [id, `data:${type};base64,${bytes.toString('base64')}`];
      }),
    ),
  );
  const template =
    builtin?.kind === 'template'
      ? builtin.name
      : builtin
        ? undefined
        : templateEntry(path, (await snapshot(path)).toString('utf8'));
  const adapter =
    builtin && builtin.kind !== 'template' ? builtin.kind : undefined;
  if (adapter === 'three' || adapter === 'lottie')
    assertAdapterInstalled(adapter);
  const directory = dirname(path);
  const outdir = join(directory, '.opencut-graphic');
  const compile = await context({
    absWorkingDir: directory,
    stdin: {
      contents: `import { installGraphic } from ${JSON.stringify(browserRuntime)};
        ${
          builtin
            ? builtinEntry(builtin)
            : `import Component from ${JSON.stringify(path)}; installGraphic(Component);`
        }`,
      sourcefile: 'opencut-graphic-entry.js',
      resolveDir: directory,
    },
    outdir,
    entryNames: 'graphic',
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    target: 'es2023',
    jsx: 'automatic',
    minify: true,
    sourcemap: 'external',
    sourcesContent: false,
    logLevel: 'silent',
    legalComments: 'inline',
    tsconfigRaw: { compilerOptions: {} },
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [
      {
        name: 'opencut-graphics',
        setup(plugin) {
          const delegated = {};
          // Observe unresolved local inputs so creating the missing file can recover a watch.
          if (missing)
            plugin.onResolve({ filter: /^\.\.?\// }, async (args) => {
              if (args.pluginData === delegated) return;
              const result = await plugin.resolve(args.path, {
                kind: args.kind,
                importer: args.importer,
                resolveDir: args.resolveDir,
                pluginData: delegated,
              });
              if (result.errors.length) {
                const base = resolve(args.resolveDir, args.path);
                missing(base);
                if (!extname(base)) {
                  for (const suffix of [
                    '.ts',
                    '.tsx',
                    '.js',
                    '.jsx',
                    '.mjs',
                    '.json',
                    '.css',
                  ]) {
                    missing(base + suffix);
                    missing(join(base, 'index' + suffix));
                  }
                }
              }
              return result;
            });
          plugin.onResolve(
            {
              filter:
                /^(?:@opencut|@dantea\/opencut)\/graphics\/(react|templates)$/,
            },
            ({ path }) => ({
              path: path.endsWith('/react') ? reactHooks : templates,
            }),
          );
          plugin.onResolve({ filter: /^@opencut\/shared$/ }, () => ({
            path: sharedRuntime,
          }));
          plugin.onResolve(
            { filter: /^(react|react-dom)(\/|$)/ },
            ({ path }) => ({
              path: resolveRuntime(path),
            }),
          );
          plugin.onLoad(
            { filter: /.*/, namespace: 'file' },
            async ({ path }) => {
              const loader = loaders[extname(path).toLowerCase()];
              if (!loader)
                throw new Error(`Unsupported graphics import '${path}'.`);
              return {
                contents: await snapshot(
                  path,
                  dirname(path) === dirname(browserRuntime) ||
                    dirname(path) === dirname(sharedRuntime) ||
                    path.split(/[\\/]/).includes('node_modules'),
                ),
                loader,
                resolveDir: dirname(path),
              };
            },
          );
        },
      },
    ],
  });
  const deadline = AbortSignal.timeout(30_000);
  const control = signal ? AbortSignal.any([deadline, signal]) : deadline;
  const cancel = () => {
    void compile.cancel().catch(() => {});
  };
  control.addEventListener('abort', cancel, { once: true });
  const bundled = await (async () => {
    try {
      control.throwIfAborted();
      const result = await compile.rebuild();
      control.throwIfAborted();
      return result;
    } catch (cause) {
      signal?.throwIfAborted();
      if (deadline.aborted)
        throw new Error('Graphics compilation timed out.', { cause });
      throw cause;
    } finally {
      control.removeEventListener('abort', cancel);
      await compile.dispose();
    }
  })();
  if (bundled.warnings.length)
    throw new Error(bundled.warnings.map(({ text }) => text).join('\n'));
  const js = bundled.outputFiles.find(({ path }) => path.endsWith('.js'))!.text;
  const css =
    bundled.outputFiles.find(({ path }) => path.endsWith('.css'))?.text ?? '';
  const map = JSON.parse(
    bundled.outputFiles.find(({ path }) => path.endsWith('.js.map'))!.text,
  ) as { sources: string[] };
  map.sources = map.sources.map((file) =>
    relative(directory, resolve(outdir, file)).replaceAll('\\', '/'),
  );
  const sourceMap = JSON.stringify(map);
  const notices = await bundleDependencyNotices(inputs.keys(), snapshot);
  const key = createHash('sha256')
    .update(
      JSON.stringify([
        reactGraphicsBackend,
        version,
        [...inputs.values()].sort(),
        js,
        css,
        sourceMap,
        template,
        adapter,
        captured,
      ]),
    )
    .digest('hex');
  return {
    version: 2,
    ...(template && { template }),
    ...(adapter && { adapter }),
    backend: reactGraphicsBackend,
    key,
    js,
    css,
    sourceMap,
    resources: captured,
    notices,
  };
}

const adapters = {
  lottie: ['lottie-web', '5.13.0'],
  three: ['three', '0.184.0'],
} as const;

export function adapterVersions() {
  return Object.fromEntries(
    Object.entries(adapters).map(([id, [name, version]]) => {
      try {
        resolveRuntime(name);
        return [id, { version, status: 'available' }];
      } catch {
        return [
          id,
          {
            version,
            status: 'missing',
            hint: `Install OpenCut with optional ${name}@${version}.`,
          },
        ];
      }
    }),
  );
}

function assertAdapterInstalled(adapter: keyof typeof adapters) {
  const [name, version] = adapters[adapter];
  try {
    resolveRuntime(name);
  } catch (cause) {
    throw new Error(
      `Install OpenCut with the optional ${name}@${version} adapter dependency.`,
      { cause },
    );
  }
}

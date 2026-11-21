import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { create as createTar } from 'tar';
import { fileURLToPath, URL } from 'node:url';
import { readManifest, stageRuntime, writeManifest } from './stage.mjs';

const root = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
const [target = 'all', output = join(root, 'dist/release')] =
  process.argv.slice(2);
if (!['cli', 'desktop', 'all'].includes(target) || process.argv.length > 4)
  throw new Error(
    'Usage: pnpm release:pack [cli|desktop|all] [output-directory]',
  );
if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw new Error('Release builds require native Apple Silicon macOS.');

const { version, engines } = readManifest(root);
const archiveTime = new Date('1985-10-26T08:15:00Z');
if (!/^\d+\.\d+\.\d+$/.test(version))
  throw new Error('Release requires a major.minor.patch version.');
const out = resolve(output);
mkdirSync(out, { recursive: true });
const cliArchive = 'opencut-cli-' + version + '-macos-arm64.tgz';
const localApp = 'OpenCut-Review-' + version + '-macos-arm64-local.zip';
const buildCli = target !== 'desktop';
const buildDesktop = target !== 'cli';
const artifacts = [
  ...(buildCli ? [cliArchive, 'opencut.rb'] : []),
  ...(buildDesktop ? [localApp] : []),
];
for (const name of ['SHA256SUMS', ...artifacts])
  if (existsSync(join(out, name)))
    throw new Error('Release output already exists: ' + join(out, name));

const work = mkdtempSync(join(tmpdir(), 'opencut-pack-'));
const digest = (file) =>
  createHash('sha256').update(readFileSync(file)).digest('hex');
const run = (command, args, options) =>
  execFileSync(command, args, { encoding: 'utf8', ...options });
try {
  if (buildCli) await packCli();
  if (buildDesktop) await packDesktop();
  writeFileSync(
    join(out, 'SHA256SUMS'),
    artifacts.map((name) => digest(join(out, name)) + '  ' + name).join('\n') +
      '\n',
    { flag: 'wx' },
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}

function stage(name) {
  const app = join(root, 'apps', name);
  const manifest = readManifest(app);
  if (manifest.version !== version)
    throw new Error(
      manifest.name + ' version does not match OpenCut ' + version,
    );
  const path = join(work, name);
  mkdirSync(path);
  const dependencies = stageRuntime(root, path, app, manifest);
  auditNative(path, name === 'cli');
  return { manifest, path, dependencies };
}

async function packCli() {
  const { manifest, path, dependencies } = stage('cli');
  const adapters = ['sdk'];
  if (dependencies['@opencut/graphics'])
    adapters.push('graphics/react', 'graphics/templates');
  const exports = Object.fromEntries(
    adapters.map((name) => {
      const base = './dist/' + name.replace('/', '-');
      const source = "export * from '@opencut/" + name + "';\n";
      const types = base + '.d.ts';
      const entry = base + '.js';
      writeFileSync(join(path, types), source);
      writeFileSync(join(path, entry), source);
      return ['./' + name, { types, import: entry }];
    }),
  );
  writeFileSync(
    join(path, 'README.md'),
    '# OpenCut\n\n[Installation and requirements](docs/INSTALL.md)\n\n' +
      '[Agent Skill](skills/video-editor/SKILL.md)\n\n' +
      '[CLI reference](docs/CLI.md) · [TypeScript SDK](docs/SDK.md)\n',
  );
  mkdirSync(join(path, 'docs'));
  for (const name of [
    'INSTALL',
    'CLI',
    'SDK',
    'AUDIO_MIX',
    'GRAPHICS',
    'VIDEO_DEFINITIONS',
  ]) {
    const file = 'docs/' + name + '.md';
    copyFileSync(join(root, file), join(path, file));
  }
  for (const directory of [
    'skills/video-editor',
    'examples/video',
    'examples/graphics',
    'examples/motion',
  ])
    cpSync(join(root, directory), join(path, directory), { recursive: true });
  writeManifest(path, {
    name: '@dantea/opencut',
    version,
    description:
      'OpenCut video-as-code CLI and TypeScript SDK for Apple Silicon',
    license: 'MIT',
    type: 'module',
    repository: {
      type: 'git',
      url: 'git+https://github.com/dante-teo/opencut.git',
      directory: 'apps/cli',
    },
    engines: { node: engines.node },
    os: ['darwin'],
    cpu: ['arm64'],
    bin: manifest.bin,
    exports,
    files: ['dist', 'docs', 'skills', 'examples'],
    dependencies,
    bundledDependencies: Object.keys(dependencies),
    publishConfig: { access: 'public' },
  });
  const candidate = join(work, cliArchive);
  const files = readdirSync(path, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => join(entry.parentPath, entry.name).slice(path.length + 1))
    .sort();
  const archive = join(out, cliArchive);
  // Preserve modes for native workers that aren't npm bins.
  await createTar(
    {
      cwd: path,
      prefix: 'package',
      file: candidate,
      portable: true,
      gzip: true,
      mtime: archiveTime,
      strict: true,
    },
    files,
  );
  copyFileSync(candidate, archive, constants.COPYFILE_EXCL);
  const formula = readFileSync(
    join(import.meta.dirname, 'opencut.rb.in'),
    'utf8',
  )
    .replaceAll('@VERSION@', version)
    .replace('@NPM_ARCHIVE@', cliArchive)
    .replace('@NPM_SHA256@', digest(archive));
  writeFileSync(join(out, 'opencut.rb'), formula, { flag: 'wx' });
}

async function packDesktop() {
  const { manifest, path } = stage('desktop');
  writeManifest(path, {
    name: 'opencut-review',
    version,
    type: manifest.type,
    main: manifest.main,
    author: 'OpenCut',
    license: 'MIT',
  });
  const icon = join(root, 'apps/desktop/resources/opencut-icon.png');
  mkdirSync(join(path, 'resources'));
  copyFileSync(icon, join(path, 'resources/opencut-icon.png'));
  const icons = join(work, 'OpenCut.iconset');
  mkdirSync(icons);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = String(size * scale);
      const file =
        'icon_' + size + 'x' + size + (scale === 2 ? '@2x' : '') + '.png';
      run('/usr/bin/sips', [
        '-z',
        pixels,
        pixels,
        icon,
        '--out',
        join(icons, file),
      ]);
    }
  }
  const appIcon = join(work, 'OpenCut.icns');
  run('/usr/bin/iconutil', ['-c', 'icns', icons, '-o', appIcon]);
  const { packager } = await import('@electron/packager');
  const [app] = await packager({
    dir: path,
    out: work,
    platform: 'darwin',
    arch: 'arm64',
    electronVersion: manifest.devDependencies.electron,
    name: 'OpenCut Review',
    appBundleId: 'com.danteteo.opencut.review',
    appVersion: version,
    icon: appIcon,
    extendInfo: { LSMinimumSystemVersion: '15.0' },
    prune: false,
    asar: false,
  });
  const bundle = join(app, 'OpenCut Review.app');
  for (const entry of ['', ...readdirSync(bundle, { recursive: true })]) {
    lutimesSync(join(bundle, entry), archiveTime, archiveTime);
  }
  run(
    '/usr/bin/ditto',
    ['-c', '-k', '--norsrc', '--keepParent', bundle, join(out, localApp)],
    { env: { ...process.env, TZ: 'UTC' } },
  );
}

function auditNative(path, cli) {
  const binaries = ['process-memory', 'video-enhance', 'video-interpolate'].map(
    (name) => join(path, 'node_modules/@opencut/media/dist', name),
  );
  if (cli) binaries.push(join(path, 'dist/system-probe'));
  for (const file of binaries) {
    if (run(file, ['--version']).trim() !== version)
      throw new Error('Native binary version does not match OpenCut: ' + file);
  }
  const modules = join(path, 'node_modules');
  const addons = readdirSync(modules, { recursive: true })
    .filter((name) => /\.(node|dylib)$/.test(name))
    .map((name) => join(modules, name));
  for (const file of [...binaries, ...addons]) {
    if (
      !run('/usr/bin/lipo', ['-archs', file])
        .trim()
        .split(' ')
        .includes('arm64')
    )
      throw new Error('Native file lacks an arm64 slice: ' + file);
    const loadCommands = run('/usr/bin/otool', ['-l', file]);
    const minimum = /^\s*minos (\d+(?:\.\d+)*)$/m.exec(loadCommands)?.[1];
    if (
      !minimum ||
      Number(minimum.split('.')[0]) > 15 ||
      /^15\.[1-9]/.test(minimum)
    )
      throw new Error(
        'Unexpected macOS deployment target ' + minimum + ' in ' + file,
      );
    const dylibId = run('/usr/bin/otool', ['-D', file]).split('\n')[1];
    const libraries = run('/usr/bin/otool', ['-L', file])
      .split('\n')
      .filter((line) => line.startsWith('\t'))
      .map((line) => line.trim().split(' (')[0])
      .filter((library) => library !== dylibId);
    const rpaths = [
      ...loadCommands.matchAll(
        /^\s*path (@loader_path\/.*?) \(offset \d+\)$/gm,
      ),
    ].map((match) => match[1].replace('@loader_path', dirname(file)));
    for (const library of libraries) {
      const candidates = library.startsWith('@rpath/')
        ? rpaths.map((directory) =>
            join(directory, library.slice('@rpath/'.length)),
          )
        : [library.replace('@loader_path', dirname(file))];
      if (
        !/^(?:\/System\/Library\/|\/usr\/lib\/)/.test(library) &&
        !candidates.some(
          (candidate) =>
            resolve(candidate).startsWith(path + '/') && existsSync(candidate),
        )
      )
        throw new Error(
          'Nonportable native dependency ' + library + ' in ' + file,
        );
    }
  }
}

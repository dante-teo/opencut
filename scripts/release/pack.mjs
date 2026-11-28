import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { create as createTar } from 'tar';
import { fileURLToPath, URL } from 'node:url';
import { readManifest, stageRuntime, writeManifest } from './stage.mjs';

const root = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
const [target = 'cli', output = join(root, 'dist/release')] =
  process.argv.slice(2);
if (!['cli', 'all'].includes(target) || process.argv.length > 4)
  throw new Error('Usage: pnpm release:pack [cli|all] [output-directory]');
if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw new Error('Release builds require native Apple Silicon macOS.');

const { version, engines } = readManifest(root);
const archiveTime = new Date('1985-10-26T08:15:00Z');
if (!/^\d+\.\d+\.\d+$/.test(version))
  throw new Error('Release requires a major.minor.patch version.');
const out = resolve(output);
mkdirSync(out, { recursive: true });
const cliArchive = 'opencut-cli-' + version + '-macos-arm64.tgz';
const formulaName = 'opencut.rb';
const checksumsName = 'SHA256SUMS';
for (const name of [checksumsName, cliArchive, formulaName])
  if (existsSync(join(out, name)))
    throw new Error('Release output already exists: ' + join(out, name));

const work = mkdtempSync(join(tmpdir(), 'opencut-pack-'));
const digest = (file) =>
  createHash('sha256').update(readFileSync(file)).digest('hex');
const run = (command, args) =>
  execFileSync(command, args, { encoding: 'utf8' });
try {
  const candidate = await createCliArchive();
  const archive = join(out, cliArchive);
  copyFileSync(candidate, archive, constants.COPYFILE_EXCL);
  const archiveDigest = digest(archive);

  const formula = readFileSync(
    join(import.meta.dirname, 'opencut.rb.in'),
    'utf8',
  )
    .replaceAll('@VERSION@', version)
    .replace('@ARCHIVE@', cliArchive)
    .replace('@ARCHIVE_SHA256@', archiveDigest);
  const formulaFile = join(out, formulaName);
  writeFileSync(formulaFile, formula, { flag: 'wx' });
  writeFileSync(
    join(out, checksumsName),
    `${archiveDigest}  ${cliArchive}\n${digest(formulaFile)}  ${formulaName}\n`,
    { flag: 'wx' },
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}

async function createCliArchive() {
  const app = join(root, 'apps/cli');
  const manifest = readManifest(app);
  if (manifest.version !== version)
    throw new Error(
      manifest.name + ' version does not match OpenCut ' + version,
    );
  const path = join(work, 'cli');
  mkdirSync(path);
  stageRuntime(root, path, app, manifest);
  auditNative(path);
  stageRustLicenses(path);
  writeFileSync(
    join(path, 'README.md'),
    '# OpenCut\n\n[Installation and requirements](docs/INSTALL.md)\n\n' +
      '[Agent Skill](skills/video-editor/SKILL.md)\n\n' +
      '[CLI reference](docs/CLI.md) · [TypeScript SDK](docs/SDK.md)\n',
  );
  mkdirSync(join(path, 'docs'));
  for (const name of [
    'INSTALL',
    'ARCHITECTURE',
    'EXPORT',
    'PREVIEW_EXPORT_CONSISTENCY',
    'CLI',
    'SDK',
    'AUDIO_MIX',
    'BEAUTY',
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
    cpSync(join(root, directory), join(path, directory), {
      recursive: true,
      filter: (source) => basename(source) !== '.DS_Store',
    });
  writeManifest(path, {
    name: manifest.name,
    version,
    private: true,
    type: manifest.type,
    engines: { node: engines.node },
  });
  const candidate = join(work, cliArchive);
  const files = readdirSync(path, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => join(entry.parentPath, entry.name).slice(path.length + 1))
    .sort();
  // Preserve executable modes for the bundled native workers.
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
  return candidate;
}

function stageRustLicenses(path) {
  const { packages } = JSON.parse(
    run('cargo', [
      'metadata',
      '--format-version',
      '1',
      '--manifest-path',
      join(root, 'Cargo.toml'),
      '--locked',
      '--offline',
    ]),
  );
  const output = join(path, 'licenses', 'rust');
  mkdirSync(output, { recursive: true });
  for (const dependency of packages.filter(({ source }) => source !== null)) {
    const source = dirname(dependency.manifest_path);
    const target = join(output, `${dependency.name}-${dependency.version}`);
    mkdirSync(target);
    const licenses = new Set(
      readdirSync(source, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isFile() &&
            /^(?:LICENSE|COPYING|NOTICE)(?:[.-]|$)/i.test(entry.name),
        )
        .map((entry) => entry.name),
    );
    if (dependency.license_file) licenses.add(dependency.license_file);
    if (!licenses.size)
      throw new Error('Missing Rust license files for ' + dependency.name);
    for (const file of licenses)
      copyFileSync(resolve(source, file), join(target, basename(file)));
  }
}

function auditNative(path) {
  const binaries = [
    ...[
      'opencut-media-engine',
      'process-memory',
      'video-enhance',
      'video-interpolate',
    ].map((name) => join(path, 'node_modules/@opencut/media/dist', name)),
    join(path, 'dist/system-probe'),
  ];
  for (const file of binaries) {
    if (run(file, ['--version']).trim() !== version)
      throw new Error('Native binary version does not match OpenCut: ' + file);
  }
  if (run(binaries[0], ['--protocol']).trim() !== `${version} 1`)
    throw new Error('Native media engine protocol does not match OpenCut.');
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

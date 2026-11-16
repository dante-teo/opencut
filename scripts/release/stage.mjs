import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

export function readManifest(directory) {
  return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
}

export function writeManifest(directory, manifest) {
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
}

function resolvePackage(parent, name) {
  const paths =
    createRequire(join(parent, 'package.json')).resolve.paths(name) ?? [];
  const path = paths.find((path) =>
    existsSync(join(path, name, 'package.json')),
  );
  return path && realpathSync(join(path, name));
}

function copyBuild(from, to, matchSources = true) {
  cpSync(join(from, 'dist'), join(to, 'dist'), {
    recursive: true,
    filter(path) {
      if (path.endsWith('.map')) return false;
      if (!matchSources) return true;
      // Match emitted modules to current sources so stale output cannot ship.
      const match = /\/dist\/(.+?)(?:\.d\.ts|\.js)$/.exec(path);
      return !match || existsSync(join(from, 'src', match[1] + '.ts'));
    },
  });
}

function runtimeDependencies(manifest) {
  return new Map([
    ...Object.keys(manifest.dependencies ?? {}).map((name) => [name, false]),
    ...Object.keys(manifest.peerDependencies ?? {}).map((name) => [
      name,
      !!manifest.peerDependenciesMeta?.[name]?.optional,
    ]),
    ...Object.keys(manifest.optionalDependencies ?? {}).map((name) => [
      name,
      true,
    ]),
  ]);
}

export function stageRuntime(root, destination, app, appManifest) {
  const { version } = appManifest;
  const packages = new Map();
  const sdk = join(root, 'packages/sdk');

  function visit(path) {
    const manifest = readManifest(path);
    if (packages.has(manifest.name)) {
      if (packages.get(manifest.name).path !== path)
        throw new Error('Cannot flatten two installations of ' + manifest.name);
      return;
    }
    const internal = path.startsWith(join(root, 'packages') + '/');
    if (internal && manifest.version !== version)
      throw new Error(
        manifest.name + ' version does not match OpenCut ' + version,
      );
    packages.set(manifest.name, { path, manifest, internal });
    visitDependencies(path, manifest);
  }

  function visitDependencies(parent, manifest) {
    for (const [name, optional] of runtimeDependencies(manifest)) {
      const path = resolvePackage(parent, name);
      if (path) visit(path);
      else if (!optional)
        throw new Error(
          'Missing runtime package ' + name + ' for ' + manifest.name,
        );
    }
  }

  visitDependencies(app, appManifest);
  visit(sdk);

  for (const name of [
    '@napi-rs/canvas-darwin-arm64',
    '@img/sharp-darwin-arm64',
    '@img/sharp-libvips-darwin-arm64',
  ]) {
    if (!packages.has(name)) throw new Error('Missing prebuilt addon ' + name);
  }
  const dependencies = {};
  for (const name of [...packages.keys()].sort()) {
    const { path, manifest, internal } = packages.get(name);
    dependencies[name] = manifest.version;
    const target = join(destination, 'node_modules', name);
    if (internal) {
      mkdirSync(target, { recursive: true });
      copyBuild(path, target);
      if (existsSync(join(path, 'fonts')))
        cpSync(join(path, 'fonts'), join(target, 'fonts'), { recursive: true });
      const pins = Object.fromEntries(
        [...runtimeDependencies(manifest).keys()].map((key) => [
          key,
          packages.get(key).manifest.version,
        ]),
      );
      writeManifest(target, {
        name,
        version,
        type: manifest.type,
        exports: manifest.exports,
        ...(Object.keys(pins).length && { dependencies: pins }),
        license: 'MIT',
      });
      cpSync(join(root, 'LICENSE'), join(target, 'LICENSE'));
    } else {
      cpSync(path, target, {
        recursive: true,
        filter: (file) =>
          !file
            .slice(path.length + 1)
            .split('/')
            .some((part) =>
              [
                'node_modules',
                'test',
                'tests',
                '__tests__',
                '__fixtures__',
                '.github',
              ].includes(part),
            ),
      });
    }
  }

  copyBuild(app, destination, app.endsWith('/cli'));
  cpSync(join(root, 'LICENSE'), join(destination, 'LICENSE'));
  return dependencies;
}

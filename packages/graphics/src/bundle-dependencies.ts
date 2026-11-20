import { readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, parse, sep } from 'node:path';

const require = createRequire(import.meta.url);
const { satisfies } = require('semver') as {
  satisfies(version: string, range: string): boolean;
};
const reactVersions = {
  react: (require('react/package.json') as { version: string }).version,
  'react-dom': (require('react-dom/package.json') as { version: string })
    .version,
};

function packageDirectory(path: string) {
  const { root } = parse(path);
  const parts = path.slice(root.length).split(sep);
  const index = parts.lastIndexOf('node_modules');
  if (index === -1 || parts.length < index + 3) return;
  return join(
    root,
    ...parts.slice(0, index + (parts[index + 1]?.startsWith('@') ? 3 : 2)),
  );
}

export async function bundleDependencyNotices(
  files: Iterable<string>,
  snapshot: (path: string, runtime?: boolean) => Promise<Buffer>,
) {
  const roots = new Set(
    [...files].flatMap((file) => packageDirectory(file) ?? []),
  );
  const notices: Record<string, string> = Object.create(null);
  for (const root of [...roots].sort()) {
    const manifest = JSON.parse(
      (await snapshot(join(root, 'package.json'), true)).toString('utf8'),
    ) as {
      name: string;
      version: string;
      license?: string;
      peerDependencies?: Record<string, string>;
    };
    const id = `${manifest.name}@${manifest.version}`;
    for (const [dependency, installed] of Object.entries(reactVersions)) {
      const required = manifest.peerDependencies?.[dependency];
      if (required && !satisfies(installed, required))
        throw new Error(
          `Graphics dependency '${id}' requires ${dependency} '${required}'. OpenCut supplies ${installed}.`,
        );
    }
    const entries = await readdir(root, { withFileTypes: true });
    for (const file of entries
      .filter(
        (entry) =>
          entry.isFile() && /^(?:licen[cs]e|notice|copying)/i.test(entry.name),
      )
      .map(({ name }) => name)
      .sort()) {
      const data = await snapshot(join(root, file), true);
      notices[`${id}/${file}`] = data.toString('utf8');
    }
    if (manifest.license) notices[id] = manifest.license;
  }
  return notices;
}

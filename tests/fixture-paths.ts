import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
export const generatedFixtures = join(
  repository,
  'tests',
  'fixtures',
  'generated',
);

export function resolveFixtureDirectory(
  candidate = process.env.OPENCUT_TEST_FIXTURES ?? generatedFixtures,
) {
  const directory = resolve(candidate);
  const fromGenerated = relative(generatedFixtures, directory);
  const invalid = () =>
    new Error(
      'Fixture directory must be inside tests/fixtures/generated and must not traverse symlinks.',
    );
  if (isAbsolute(fromGenerated) || fromGenerated.split(sep)[0] === '..')
    throw invalid();

  // Walk from the physical checkout so even a symlink at the generated root,
  // or a dangling symlink on the way to a new directory, is rejected.
  let current = repository;
  for (const component of relative(repository, directory).split(sep)) {
    current = join(current, component);
    const info = lstatSync(current, { throwIfNoEntry: false });
    if (!info) break;
    if (!info.isDirectory()) throw invalid();
  }
  return directory;
}

export const fixtureDirectory = resolveFixtureDirectory();

export function videoExample(filename: string) {
  return join(
    process.env.OPENCUT_TEST_EXAMPLES ?? resolve('examples/video'),
    filename,
  );
}

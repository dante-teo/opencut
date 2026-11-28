import { spawnSync } from 'node:child_process';
import { copyFileSync, renameSync, rmSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const targetDir = fileURLToPath(new URL('../../../target/', import.meta.url));
const result = spawnSync(
  'cargo',
  [
    'build',
    '--locked',
    '--release',
    '--manifest-path',
    `${root}Cargo.toml`,
    '--target-dir',
    targetDir,
    '-p',
    'opencut-media-engine',
  ],
  {
    cwd: root,
    stdio: 'inherit',
  },
);
if (result.error?.code === 'ENOENT')
  throw new Error('OpenCut requires Rust and Cargo to build the media engine.');
if (result.error) throw result.error;
if (result.status !== 0)
  throw new Error(
    `Cargo could not build the media engine (${result.signal ?? result.status}).`,
  );

const name = 'opencut-media-engine';
const output = `dist/${name}`;
const stage = `${output}.${process.pid}.build`;
try {
  copyFileSync(`${targetDir}release/${name}`, stage);
  renameSync(stage, output);
} finally {
  rmSync(stage, { force: true });
}

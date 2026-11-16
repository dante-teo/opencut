import process from 'node:process';
import { warn } from 'node:console';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, rmSync } from 'node:fs';

chmodSync('dist/index.js', 0o755);
const binary = 'dist/system-probe';
rmSync(binary, { force: true });
if (process.platform === 'darwin') {
  const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
  const sdk =
    process.env.SDKROOT ||
    spawnSync('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path'], {
      encoding: 'utf8',
      timeout: 10000,
    }).stdout?.trim();
  const headers =
    sdk &&
    `${sdk}/System/Library/Frameworks/VideoToolbox.framework/Versions/A/Headers`;
  if (
    !headers ||
    !existsSync(`${headers}/VTFrameProcessor_TemporalNoiseFilter.h`)
  ) {
    warn('OpenCut: skipping the native system probe (macOS 26+ SDK required).');
  } else {
    const { status, error } = spawnSync(
      '/usr/bin/clang',
      [
        '-O2',
        '-DOPENCUT_VERSION=' + JSON.stringify(version),
        '-fobjc-arc',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-mmacosx-version-min=13.0',
        '-isysroot',
        sdk,
        ...[
          'Foundation',
          'Metal',
          'VideoToolbox',
          'CoreMedia',
          'CoreVideo',
        ].flatMap((framework) => ['-framework', framework]),
        'native/system-probe.m',
        '-o',
        binary,
      ],
      { stdio: 'inherit' },
    );
    if (error) throw error;
    if (status !== 0) process.exit(status ?? 1);
  }
}

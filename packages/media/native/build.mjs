import { spawnSync } from 'node:child_process';
import { warn } from 'node:console';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import process from 'node:process';

const workers = ['video-interpolate', 'video-enhance'];
for (const worker of [...workers, 'process-memory'])
  rmSync(`dist/${worker}`, { force: true });
if (process.platform === 'darwin') {
  const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
  const sdk =
    process.env.SDKROOT ||
    spawnSync('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path'], {
      encoding: 'utf8',
      timeout: 10000,
    }).stdout?.trim();
  if (!sdk)
    throw new Error(
      'OpenCut: A macOS SDK is required to build the RSS sampler.',
    );
  const compilerFlags = [
    '-O2',
    '-DOPENCUT_VERSION=' + JSON.stringify(version),
    '-Wall',
    '-Wextra',
    '-Werror',
    '-mmacosx-version-min=13.0',
    '-isysroot',
    sdk,
  ];
  function compile(sources, output, flags = []) {
    const { status, error } = spawnSync(
      '/usr/bin/clang',
      [...compilerFlags, ...flags, ...sources, '-o', output],
      { stdio: 'inherit' },
    );
    if (error) throw error;
    if (status !== 0) process.exit(status ?? 1);
  }
  compile(['native/process-memory.c'], 'dist/process-memory');
  if (process.arch !== 'arm64') process.exit(0);
  if (
    !existsSync(
      `${sdk}/System/Library/Frameworks/VideoToolbox.framework/Headers/VTFrameProcessor_LowLatencyFrameInterpolation.h`,
    )
  ) {
    warn('OpenCut: VideoToolbox AI recipes require a macOS 26+ SDK to build.');
  } else {
    for (const worker of workers) {
      compile(
        [`native/${worker}.m`, 'native/pixel-transfer.m'],
        `dist/${worker}`,
        [
          '-fobjc-arc',
          ...[
            'Foundation',
            'VideoToolbox',
            'CoreMedia',
            'CoreVideo',
            'Accelerate',
          ].flatMap((framework) => ['-framework', framework]),
        ],
      );
    }
  }
}

import { spawnSync } from 'node:child_process';
import { warn } from 'node:console';
import { existsSync, rmSync } from 'node:fs';
import process from 'node:process';

const workers = ['video-interpolate', 'video-enhance'];
for (const worker of workers) rmSync(`dist/${worker}`, { force: true });
if (process.platform === 'darwin' && process.arch === 'arm64') {
  const sdk =
    process.env.SDKROOT ||
    spawnSync('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path'], {
      encoding: 'utf8',
      timeout: 10000,
    }).stdout?.trim();
  if (
    !sdk ||
    !existsSync(
      `${sdk}/System/Library/Frameworks/VideoToolbox.framework/Headers/VTFrameProcessor_LowLatencyFrameInterpolation.h`,
    )
  ) {
    warn('OpenCut: VideoToolbox AI recipes require a macOS 26+ SDK to build.');
  } else {
    for (const worker of workers) {
      const { status, error } = spawnSync(
        '/usr/bin/clang',
        [
          '-O2',
          '-fobjc-arc',
          '-Wall',
          '-Wextra',
          '-Werror',
          '-mmacosx-version-min=13.0',
          '-isysroot',
          sdk,
          ...['Foundation', 'VideoToolbox', 'CoreMedia', 'CoreVideo'].flatMap(
            (framework) => ['-framework', framework],
          ),
          `native/${worker}.m`,
          '-o',
          `dist/${worker}`,
        ],
        { stdio: 'inherit' },
      );
      if (error) throw error;
      if (status !== 0) process.exit(status ?? 1);
    }
  }
}

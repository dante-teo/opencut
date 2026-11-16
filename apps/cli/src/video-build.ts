import {
  inspectVideoBuild,
  packageVideo,
  verifyVideoPackage,
} from '@opencut/core/video';
import { withCommandCancellation } from './cancellation.js';
import { commandUsage } from './commands.js';
import type { CommandOptions } from './commands.js';
import { readParams } from './json-argument.js';
import { parseProcessingControls } from './recipe-options.js';
import { parseRenderQuality } from './render-options.js';
import { UsageError } from './usage.js';
import { withDefinitionConsole } from './video.js';

export async function runBuildCommand(
  command: 'package' | 'package verify' | 'build inspect',
  file: string,
  values: CommandOptions,
) {
  if (command === 'package' && !values.output?.trim())
    throw new UsageError(`Usage: ${commandUsage(command)}`);
  await withCommandCancellation(async (signal) => {
    if (command === 'build inspect') {
      const params = await readParams(values.params, signal);
      const result = await withDefinitionConsole(() =>
        inspectVideoBuild(file, {
          signal,
          params,
          processing: parseProcessingControls(values),
          preview: values['no-subtitles'] === true,
          quality: parseRenderQuality(values.quality, 'quality'),
        }),
      );
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const result =
      command === 'package verify'
        ? await verifyVideoPackage(file, { signal })
        : await withDefinitionConsole(async () =>
            packageVideo(file, values.output!, {
              signal,
              ...(values.root !== undefined && { root: values.root }),
              ...(values.resource !== undefined && {
                resources: values.resource,
              }),
              params: await readParams(values.params, signal),
            }),
          );
    console.log(
      values.json
        ? JSON.stringify({ ok: true, ...result }, null, 2)
        : `${command === 'package' ? 'Created' : 'Verified'} package: ${result.directory}\nBuild entry: ${result.entry}`,
    );
  });
}

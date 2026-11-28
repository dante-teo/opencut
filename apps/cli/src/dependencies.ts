import { inspectVideoDependencies } from '@opencut/core/video';
import { withCommandCancellation } from './cancellation.js';
import { parseProcessingControls } from './recipe-options.js';
import { readParams } from './json-argument.js';
import type { CommandOptions } from './commands.js';
import { withDefinitionConsole } from './video.js';

export function runDependencies(file: string, values: CommandOptions) {
  return withCommandCancellation(async (signal) => {
    const params = await readParams(values.params, signal);
    const { cacheDirectory: recipeCache } = parseProcessingControls(values);
    const result = await withDefinitionConsole(() =>
      inspectVideoDependencies(file, {
        signal,
        params,
        recipeCache,
        artifactRoots: values['artifact-root'],
        renderReport: values['render-report'],
        cleanupPlan: values['cleanup-plan'],
      }),
    );
    console.log(JSON.stringify(result, null, 2));
  });
}

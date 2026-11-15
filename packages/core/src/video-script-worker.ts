import { parentPort, workerData } from 'node:worker_threads';
import type { VideoParameters } from './video-definition.js';
import { readDefinitionScript } from './video-script.js';

const port = parentPort!;
const { path, params } = workerData as {
  path: string;
  params?: VideoParameters;
};
try {
  const result = await readDefinitionScript(
    path,
    (input) => port.postMessage({ input }),
    params,
  );
  port.postMessage({ result });
} catch (error) {
  port.postMessage({
    error: error instanceof Error ? error.message : String(error),
  });
}

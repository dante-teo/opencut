import { parentPort, workerData } from 'node:worker_threads';
import { findSourceChange } from '@opencut/media';
import type { VideoParameters } from './video-definition.js';
import { readDefinitionScript } from './video-script.js';

const port = parentPort!;
const { path, params, traceImports } = workerData as {
  path: string;
  traceImports: boolean;
  params?: VideoParameters;
};
try {
  const result = await readDefinitionScript(
    path,
    (input) => port.postMessage({ input }),
    params,
    traceImports ? (edge) => port.postMessage({ edge }) : undefined,
  );
  port.postMessage({ result });
} catch (error) {
  port.postMessage({
    error: error instanceof Error ? error.message : String(error),
    sourceChange: findSourceChange(error)?.change,
  });
}

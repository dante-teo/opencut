import { parentPort, workerData } from 'node:worker_threads';
import { readDefinitionScript } from './video-script.js';

const port = parentPort!;
try {
  const value = await readDefinitionScript(workerData as string, (input) =>
    port.postMessage({ input }),
  );
  port.postMessage({ value });
} catch (error) {
  port.postMessage({
    error: error instanceof Error ? error.message : String(error),
  });
}

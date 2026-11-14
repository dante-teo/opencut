/** Own the signal handlers for the lifetime of one foreground command. */
export async function withCommandCancellation(
  run: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const controller = new AbortController();
  let exitCode: number | undefined;
  const removeHandlers = () => {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  };
  const cancel = (signal: NodeJS.Signals) => {
    // An awaited TypeScript import cannot be aborted. Let a second signal
    // terminate a definition that never returns.
    removeHandlers();
    exitCode = signal === 'SIGINT' ? 130 : 143;
    controller.abort();
  };
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try {
    await run(controller.signal);
  } catch (error) {
    if (exitCode !== undefined) process.exitCode = exitCode;
    throw error;
  } finally {
    removeHandlers();
  }
}

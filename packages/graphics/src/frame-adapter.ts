import type { GraphicFrame } from './browser.js';

export interface GraphicFrameSession {
  seek(frame: GraphicFrame, signal: AbortSignal): Promise<void> | void;
  dispose(): Promise<void> | void;
}

/** The host owns the scope, resources, request clock, and lifetime. */
export type GraphicFrameAdapter = (input: {
  host: HTMLElement;
  frame: GraphicFrame;
  resources: Readonly<Record<string, string>>;
  signal: AbortSignal;
}) => Promise<GraphicFrameSession> | GraphicFrameSession;

export function installFrameAdapter(prepare: GraphicFrameAdapter) {
  const host = document.getElementById('graphic')!;
  let resources: Record<string, string> = {};
  let session: Promise<GraphicFrameSession> | undefined;
  const lifetime = new AbortController();
  let generation = 0;

  window.setOpenCutGraphicResources = (captured) => {
    if (session)
      throw new Error('Graphics resources are pinned after prepare.');
    resources = Object.freeze({ ...captured });
  };
  window.renderOpenCutGraphic = async (frame, requestId) => {
    if (requestId <= generation)
      throw new Error('Stale graphics frame request.');
    generation = requestId;
    const { signal } = lifetime;
    signal.throwIfAborted();
    const current = await (session ??= Promise.resolve(
      prepare({ host, frame, resources, signal }),
    ));
    signal.throwIfAborted();
    await current.seek(frame, signal);
    signal.throwIfAborted();
    if (generation !== requestId)
      throw new Error('Stale graphics frame completion.');
    return requestId;
  };
  window.disposeOpenCutGraphic = async () => {
    lifetime.abort();
    const current = await session?.catch(() => undefined);
    await current?.dispose();
    host.replaceChildren();
  };
}

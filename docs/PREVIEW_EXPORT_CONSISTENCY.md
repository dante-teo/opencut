# Preview and export consistency

OpenCut runs the same timeline planner and media engine for frame, clip,
watch, desktop, and final export. Frame numbers use the authored canvas
rate. A preview clip keeps the selected time range with an exclusive end.
A single-frame PNG and MP4 decoded at the same position can differ slightly
from lossy encoding and chroma subsampling. Watched playback also uses a
size cap and draft encoding.

CLI and Electron watchers stage referenced media for each revision so a
file changing in place cannot mix old and new input within one published
preview. A failed or superseded rebuild leaves the last complete playback
available. Desktop export renders the selected revision using its staged
inputs and retains those inputs while the render is active.

Run `pnpm test:consistency` for TypeScript and JSON parity, frame
and audio alignment, preview recovery, and a byte comparison
of an Electron export with a foreground SDK render.

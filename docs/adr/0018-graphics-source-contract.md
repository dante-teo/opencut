# 0018. Graphics source contract

A version 2 video definition can declare a graphic with a relative entry path,
a renderer, and a logical surface. Omitted surface dimensions use the project
canvas. Static SVG has no intrinsic duration. React has a positive duration in
project frames and accepts JSON props and named local resources. A placement
can replace top-level props. The normalized data contains no component
functions, DOM objects, or browser handles.

The shared timeline maps each visible project frame to an exact source position.
The graphic samples the floor of that source position on the project frame
rate. A placement starting at source frame 30 samples frame 30 at its first
aligned timeline frame. Its component sees the full source duration. The
existing clip-local keyframes transform the completed surface.

Definition loading pins graphics once for build receipts and quality profiles.
Timeline source binding attaches raster dimensions, source duration and merged
props to each graphic layer. The compositor then requests samples from that
immutable revision through the existing layer staging path.

Each render owns its sampler and closes its browser under the render budget.
Watched playback uses the private media copies owned by its revision. The
media adapter loads the React renderer for React work. Browser readiness
and launch resolve the same pinned Chromium Headless Shell through
Playwright. Static SVG uses validated XML and Sharp.

Props and timing identify graphic samples independently of timeline position.
OpenCut keeps a bounded memory cache and uses the existing atomic media cache
for optional disk reuse. Version 2 packages can carry captured React bundles
so the authoring module graph stays out of offline playback. The manifest
maps stable asset IDs to generated portable bundle paths.

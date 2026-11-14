# 0016 — Headless project ownership

Status: accepted for T41. Supersedes [ADR 0011](0011-shared-project-session.md).

The named project file is the authority. CLI and SDK readers read one complete
file and writers acquire the existing SQLite sidecar lock for each transaction.
Expected revisions, SDK snapshot checks and atomic publication protect history
and prevent silent overwrites. The project schema is unchanged.

Electron watches the project path with a 125 ms polling interval. It serializes
reloads, verifies project identity and increasing revision, and can coalesce
multiple commits. Failed reads retain the accepted snapshot. Explicit Open can
load a replaced project or older backup. Media availability is checked on open
and when asset references change. The renderer orders IPC events and replies
using the publication sequence.

Project changes revoke preview capabilities and cancel obsolete preview work.
Rendered timeline results carry the revision. Their cache can reuse content
across revisions where the renderer's cache key proves identical inputs.
An export matches the open view and revision before capturing a detached
project snapshot for asynchronous rendering.
Its revision and settings stay fixed while subsequent commits refresh the
viewer. Source media remains referenced in place.

On macOS and Linux, desktop review controls use a separate private Unix socket
and an endpoint lock that lives outside the project directory. The endpoint
accepts only playback and inspection commands. Multiple viewers may read a
project. A viewer without the endpoint can try again by reopening the project.
Socket setup failures leave review and export available.

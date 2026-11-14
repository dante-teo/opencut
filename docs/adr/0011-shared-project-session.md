# 0011 — One writer for GUI and CLI project sessions

Status: superseded by [ADR 0016](0016-headless-project-ownership.md) in T41. Accepted for T22. This supersedes T21's proposed task ordering for T22;
playback, composition and rendering remain outside this change.

## Decision

The core Node persistence adapter discovers a local Electron session before
reading or updating a project. Existing CLI commands and asset operations use
that adapter without a second command dispatcher. The pure editing core and T09
snapshot/history model remain unchanged.

A session owns a permanent `<project-file>.opencut-lock` SQLite sidecar with an
exclusive transaction. SQLite's OS lock disappears on process death; the inode
must never be unlinked while writers might exist. Standalone CLI mutations hold
the same lock for their operation. Read-only queries do not acquire it. This uses
the SQLite implementation bundled with pinned Node/Electron, adds no dependency,
and avoids heartbeat leases that can expire while a writer is suspended. Native
flock packages were considered; available prebuilts did not match Electron 45's
ABI. This sidecar stores no project content and does not change the JSON schema.

Transport is newline-delimited, versioned JSON over a Unix domain socket in
`/tmp/oc-session-<uid>`, owned by the user with mode 0700; sockets are mode 0600.
The endpoint is a hash of the canonical project path. Only the lock owner may
replace a stale endpoint. Messages are bounded to 64 MiB with a 30-second idle
timeout. The trust boundary is the local OS account, not other applications
running as that same account. Symlinked/shared ownership sidecars are rejected.

Clients read a snapshot and prepare an edit with the existing headless functions.
The session checks its incarnation ID and the entire base snapshot fingerprint
before accepting the proposed result. The authority validates project/history,
revision advancement and identity, persists atomically, then updates GUI state and
pushes a typed preload event. No client writes the project while a session owns
it. Concurrent proposals can fail with a conflict or busy error; they are never
silently merged or retried. Existing explicit expected revisions still apply.

Every successful edit to a named project is saved, including GUI edits and
undo/redo. This makes acknowledged history survive an application crash without
a separate recovery journal. Untitled projects still use Save/Discard/Cancel.
Save on a named project remains an explicit consistency check. Out-of-band edits
are detected and require reopening; arbitrary tools do not participate in the lock.

Renderer reply ordering is scoped to a project path and ID: a newer snapshot
pushed during a pending IPC request can supersede its delayed reply. The state
that existed before the request does not override an explicit Open result;
opening an older backup legitimately selects a lower revision and its history,
including when restored at the same path. Timeline replacement and source-preview
invalidation have separate lifecycles. Pushed CLI edits invalidate source preview
while preserving timeline zoom, both scroll axes and snapping preferences;
explicit project opens reset timeline view state.

## Failure semantics and limits

Once a session request has been sent, a disconnect never triggers an offline
retry. Its outcome may be unknown: query history/content before reconsidering the
edit. A later invocation can acquire released ownership after a crash and read
the complete last-published JSON. Stale sockets are replaced by the next owner.
Legacy `.lock` files are refused rather than guessed stale; stop old-version
writers before removing them. Do not run old and new OpenCut writers together.

Updates sync the temporary JSON, atomically rename it and sync the parent
directory. Storage hardware failures and noncooperating external writers are not
covered. A crash can leave an unused `.opencut-update-*` directory; it is never
treated as authoritative recovery data. Use a local filesystem that supports
SQLite locking and preserves the sidecar's device and inode identity during
lock acquisition. On macOS, first Save in Electron can fail on exFAT with
`Writer sidecar changed during acquisition` before writing the project file.
CLI and SDK creation can still publish a new project there through the
exclusive-copy fallback. Existing-project updates require the writer lock.
See the [project file persistence contract](../PROJECT_FORMAT.md#api-and-errors).
Network filesystems and Windows session transport are unsupported. Unix
transport targets macOS/Linux. Only macOS has live desktop validation.

History travels as complete snapshots, so large histories incur serialization,
IPC and save costs and can exceed the transport bound. No watcher/polling loop,
network server, media change, playback engine or T23 editing feature is added.

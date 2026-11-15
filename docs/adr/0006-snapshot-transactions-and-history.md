# ADR 0006: Atomic transactions with persistent snapshot history

Status: Accepted

Date: 2026-10-25

## Context

T09 needs atomic editing batches, undo/redo across reloads, and stale-write
protection for scripts and future GUI callers. T08 already provides pure timeline
operations and a Node adapter with a writer lock and atomic file replacement.
A batch can change the intermediate state without changing its final content.

## Decision

Dispatch batches through the existing filesystem-free timeline operations.
Validate every operation against the preceding result; any failure discards the
whole batch. Individual timeline and media mutations share the same history.

Store full before/after project-content snapshots in undo/redo stacks alongside
the current content in the project JSON. Exclude history and revision from each
snapshot. Persist all three together through one atomic replacement. Undo/redo
restore exact IDs, ordering, rational representations and timestamps without
replaying operations, probing media or generating replacement IDs.

Use a nonnegative safe-integer revision that advances once per changed apply,
undo or redo. Undoing to earlier content never reuses its earlier revision.
Batches require the expected revision; individual CLI mutations and undo/redo
accept it as an optional guard when acting on prior inspection. Keep the existing
writer lock and outside-change checks. Dry-run validates and plans the same edit
and history but skips publication.

Treat a batch as a no-op when its final content equals the original, ignoring
only the automatically refreshed `metadata.updatedAt`. Preserve the original
revision, timestamps, both stacks and file bytes. Changed edits clear redo;
no-ops and failed edits retain it. No-op batches still validate all operations
and revision checks, and may return intermediate operation results. History
integrity checks continue to use exact snapshots, including timestamps.

Extend prerelease schema version 1 with optional `editing` rather than introducing
a migration framework. Its absence means revision 0 and empty history. Files
without it retain their previous representation until the first changed edit.

## T18 desktop integration

Desktop gestures preview the same core commands against cached, validated project
content without history. Commit still checks the authoritative revision and full
history. This keeps preview cost independent of the number of stored snapshots
without weakening commit validation.

A desktop session can accumulate several completed transactions before Save.
Persist them with `history: 'preserve'`, retaining each undo step and guarding
against the revision and serialized content last read from disk. Saving does not
add another history entry. See the persistence contract
for the distinction from single-transaction `history: 'restore'`.

## Consequences and alternatives

- Full snapshots favor reliable restoration over storage efficiency. History is
  retained without automatic pruning, so file size grows with editing history.
- Inverse commands and event replay would require additional correctness rules
  for generated IDs, removed entities and future operations; T09 does not need
  that complexity. Existing Zod and Node APIs cover validation and persistence.
- One project JSON avoids independently committed sidecar history. Atomic rename
  does not guarantee power-loss durability or protect against arbitrary outside
  writers in the final check/rename window.
- Older strict binaries reject the optional `editing` field. Use a T09-capable
  reader for projects containing history. No silent upgrade or downgrade occurs.
- Source media stays unchanged; undo/redo restores references and metadata only.

The [CLI contract](../CLI.md#transactions-undo-and-redo) defines batch operations,
results and exit codes. The core API contract
defines persistence options, history structure and errors.

The saved project format was retired. See [video definitions](../VIDEO_DEFINITIONS.md) for current authoring.

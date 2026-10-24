# ADR 0005: Explicit timeline edits with exact time and no ripple

Status: Accepted

Date: 2026-10-25

## Context

T08 introduces editing through the CLI over the shared project model. Scripts
need predictable changes and reusable core operations before a GUI timeline,
undo history or project renderer exists. The model already supports rational
seconds, stable IDs, offline media and guarded atomic file updates.

## Decision

Keep editing in the filesystem-free core. Each operation validates and copies
its input, applies one explicit edit and returns a validated project and result.
The CLI parses arguments, converts frame indices and persists through the
existing Node update adapter. Inspection and exact no-op moves/trims do not write.

Use nonnegative integer project-frame indices for all CLI edit times, including
source points; keep the core API in exact rational seconds so callers can retain
sample offsets and mixed-rate boundaries. Source out and timeline end are
exclusive. Reject arithmetic that cannot fit safe rational JSON components.

Allow gaps and cross-track overlap, but reject overlap within any video or audio
track on edits, load and save. Move preserves source mapping; trim fixes timeline
start. Split takes an absolute timeline position, retains the left clip ID and
assigns a new right ID while preserving source mapping and total duration.
Removing a populated track requires explicit clip moves/removals. No edit shifts
neighbors, creates linked audio/video clips or chooses a replacement position.

Enforce recorded asset duration when known. Unknown-duration assets, including
images, require explicit ranges without an inferred finite bound. Editing uses
stored metadata without probing media or requiring its files to be online.

## Rationale and alternatives

- Rejecting same-track overlap avoids introducing mixing, compositing or implicit
  replacement rules before a renderer exists. Separate compatible tracks remain
  available when clips need overlapping timeline positions.
- Ripple edits and cascading track removal would affect entities beyond the
  requested edit. Explicit operations keep scripts predictable without requiring
  undo history or multi-command transactions.
- One CLI time unit avoids implicit interpretation of seconds versus source or
  project frames. Rational core inputs retain precision beyond that CLI grid;
  frame indices do not establish actual VFR frame timestamps or preview accuracy.
- Requiring source-file availability would unnecessarily block offline editing.
  Accepting explicit unknown-duration ranges preserves that workflow, while
  making no promise of physical decodability.

## Consequences

T08 tightens prerelease schema version 1 validation without adding stored fields.
Older documents with same-track overlaps or unsafe derived times are rejected;
users must explicitly correct their positions/ranges. There is no silent migration.
Each CLI edit is saved independently using the existing writer lock and atomic
replacement guarantees, not a transaction spanning several commands.

Undo/redo, project rendering and GUI timeline integration remain deferred. The
[CLI contract](../CLI.md#timeline-editing) and
[core API contract](../PROJECT_FORMAT.md#timeline-editing-api) define the supported
commands, results, invariants and error behavior.

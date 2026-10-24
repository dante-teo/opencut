# ADR 0004: Versioned projects with rational time and separate file access

Status: Accepted

Date: 2026-10-25

## Context

The shared headless core needs a serializable project model before editing
commands are introduced. Projects must preserve references and exact timing
across save/load, support mixed media rates, and remain usable when media is
offline. The CLI and desktop must be able to consume the same model later
without making either interface or FFmpeg a dependency of core.

## Decision

Store projects as human-readable JSON with an explicit `schemaVersion`, starting
at version 1. Use stable, globally unique IDs for projects, assets, tracks and
clips. Preserve array order and validate references by ID. One strict Zod schema
defines structural validation and the corresponding TypeScript types; semantic
checks then validate uniqueness, references, media compatibility and ranges.
Reject unknown fields and unsupported versions rather than discarding data.

Represent source ranges and timeline positions as rational seconds using safe
JSON integers. Frame rate is also rational. Use bigint for intermediate frame
conversion and time comparison, keeping bigint values out of the JSON format.
Clips have half-open source ranges and implicit 1× duration derived from those
ranges. Do not store a second duration that could disagree with the source range.

Keep creation, validation and serialization in the main `@opencut/core` entry
point. Put filesystem access and path resolution in the optional
`@opencut/core/node` entry point. Data validation and project loading do not
check whether media exists. A separate read-only availability check reports
missing, unreadable, non-file and foreign-platform references without removing
assets or clips.

Prefer valid relative media references anchored to the containing project
directory. Retain an absolute reference when a relative reference cannot be
represented, including POSIX filenames containing colons. Project-file creation
is exclusive. T07 adds guarded updates to existing regular project files through
the Node adapter: lock cooperating writers, validate the updated data, sync a
temporary file and atomically rename it over the destination. Refuse project
symlinks/hard links and detected outside edits. This guarantees complete JSON
visibility, without promising power-loss durability or arbitrary external-writer
coordination. Handled failures clean owned temporary data and locks; forced
termination can leave stale artifacts.

Use the physical containing directory consistently for import, asset inspection,
media availability checks and writer locks. Directory symlinks must resolve to
the same source and lock as the physical project path, including for references
containing `..`. Canonicalize the parent only; retaining the filename lets update
guards detect and refuse project-file symlinks. Keep the standalone portable path
helpers lexical for inspecting path syntax without filesystem access.

T07 also adds optional asset probe metadata within prerelease schema version 1.
Existing documents remain readable; older strict readers reject the new field.
Only the Node adapter uses the headless media package for import probing. The
main project API still has no filesystem or media-tool access. Imported images
use visual (`video`) media types with a metadata kind of `image`; no image track
or timeline editing behavior is introduced.

The full schema and API contract live in [PROJECT_FORMAT.md](../PROJECT_FORMAT.md).

## Rationale and alternatives

- Decimal seconds can accumulate rounding error at frame boundaries. Rational
  seconds preserve fractional rates such as 30000/1001 without that conversion.
- A timeline expressed only in project-frame indices would require another
  representation for exact audio sample positions and source boundaries at
  different rates. Rational seconds cover those cases with one representation;
  future operations can define their own snapping policy.
- JSON supports direct inspection and version control without a database or
  binary container. Fixed object-field order and preserved array order make
  serialization deterministic without reordering project data.
- A shared runtime schema avoids maintaining separate handwritten structural
  validators and TypeScript models. Domain checks remain explicit core logic.
- Checking file existence during deserialization would prevent work with offline
  media and make pure model operations depend on the host filesystem.

## Consequences

The main project API needs no Electron, React, filesystem or media-tool access.
Consumers opt into the Node adapter when they need file access. Relative
references survive moving the containing folder structure; absolute references
retain their original location and may require relinking after a move.

Exact representation does not imply frame-accurate browser seeking, a VFR frame
index, or timeline compositing behavior. T05 does not add editing commands,
undo/redo, project rendering or desktop/CLI project integration. Schema migrations
can be added at the version boundary when an actual incompatible version exists;
no migration framework is introduced now. Windows/UNC path handling is tested
lexically; Windows/Linux runtime support remains a separate validation task.

T08 follow-up: [ADR 0005](0005-explicit-timeline-editing.md) adds shared editing
operations without changing stored fields. It tightens prerelease version 1
validation to reject same-track overlap and unsafe derived times. The CLI uses
project-frame indices; the core retains exact rational inputs and offline editing.

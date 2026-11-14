# Timeline editing

Select a clip by clicking it. Cmd-click on macOS or Ctrl-click on other
platforms toggles a clip. Shift-click extends a selection through a range on
the same track or adds the clicked clip on another track. Drag a selected
clip to move the selection while keeping its relative timing. Group moves
across tracks must preserve each clip's track type and relative row.

| Action                           | Shortcut                        |
| -------------------------------- | ------------------------------- |
| Copy, cut, paste at playhead     | Cmd/Ctrl+C, X, V                |
| Duplicate after the selection    | Cmd/Ctrl+D                      |
| Insert clipboard at playhead     | Cmd/Ctrl+Shift+V                |
| Delete, leaving space            | Delete or Backspace             |
| Ripple delete on selected tracks | Shift+Delete or Shift+Backspace |
| Add marker at playhead           | M                               |

The **Edit clips** menu also offers ripple delete on all unlocked tracks,
close gap, and link/unlink. Close gap removes the shared empty interval under
the playhead on the tracks of the selected clips. To edit linked clips together,
select them and choose **Link clips**. Newly detached audio is linked to its
video. Previously detached clips can be linked manually. Unlink first to
change a single member's source or timing independently. Subtitles and
markers keep their absolute positions during ripple and insert edits.

Copy, cut, paste and duplicate preserve asset references and clip settings.
Copying includes a cross-dissolve only when both of its clips are included.
Clipboard contents are scoped to the project and live in the desktop session.
Paste requires available space. Insert opens space for the full selection span
and splits a clip at the insert point when necessary. Enable **Insert drops**
to insert library media when dropping it on a track.

Ripple removes the union of selected clip intervals. On selected tracks, the
scope includes the tracks of any linked clips in the selection. All unlocked
tracks adds every unlocked media track. An unselected clip spanning a removed
interval, a resulting invalid transition, or a shift that would break a link
rejects the whole edit. Use the lock button in the track header to protect
clips and transitions on that track. Locks also apply to CLI edits while
Electron has the project open. Freeze-frame insertion on a locked track
fails before any PNG is created.

Snap uses a screen pixel threshold and considers eligible frame-aligned
edges, project markers and the playhead. The guide identifies the snapped
edge, including when a different clip in a group supplies that edge.
Right-click a marker to remove it.

## CLI and SDK

Use opencut edit apply PROJECT BATCH --json with the current expectedRevision,
or pass the same operations to SDK project.apply and save. Run
opencut help edit apply --json for the schema and opencut timeline list
PROJECT --json to inspect the result.

| Operation                  | Fields                                                                      |
| -------------------------- | --------------------------------------------------------------------------- |
| clips.move                 | ids, frames, optional backwards and tracks (source-to-target track map)     |
| clips.remove               | ids, optional ripple (selected-tracks or all-unlocked)                      |
| clips.copy / clips.cut     | ids, returns a clipboard in the operation result                            |
| clips.paste                | clipboard, at, optional insert (selected-tracks or all-unlocked) and tracks |
| clips.duplicate            | ids, optional at (defaults to end of selection)                             |
| clips.link                 | ids, linked                                                                 |
| clip.insert                | assetId, trackId, at, in, out, scope (selected-tracks or all-unlocked)      |
| timeline.close-gap         | trackIds, at (inside the common gap)                                        |
| track.lock                 | id, locked                                                                  |
| marker.add / marker.remove | at and name (optional id on add), or id on remove                           |

The singular `clip remove` command and `clip.remove` operation reject members of a
linked group. Use `clips.remove` to delete the group.

In CLI JSON output, `clips.copy` and `clips.cut` return their clipboard in
`results[].clipboard`. Pass that object as the `clipboard` field of a later
`clips.paste` operation for the same project. Copy creates no history entry.
Each successful edit that changes the project creates one history entry per
desktop command, CLI batch, or SDK save. The project persists clip links,
locks, markers and edit history.

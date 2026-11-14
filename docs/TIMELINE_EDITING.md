# Timeline editing

Use the CLI or TypeScript SDK to move, split, trim, link, remove, or insert
clips. Electron displays the result in the read-only timeline as each revision
is committed. Select clips and seek the playhead for inspection. Markers appear on the ruler.

When moving a group, preserve the relative timing and compatible track types.
Ripple removes the union of the selected intervals. On selected tracks, the
scope includes linked clips' tracks. All unlocked tracks adds every unlocked
media track. Operations reject overlapping unselected clips or invalid
transitions or links. Subtitles and markers retain their absolute times.

Copy, cut, paste and duplicate retain asset references and clip settings.
A cross-dissolve is copied when both participating clips are included.
Paste requires space. Insert opens space and can split a clip at the insert
point. Lock tracks with the headless track lock operation to protect their
clips and transitions. Freeze-frame insertion onto a locked track fails
before it creates a PNG.

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

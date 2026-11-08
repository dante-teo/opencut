# Creator workflows

## Rough cut with music and an image overlay

This recipe creates a two-second, 30 fps sequence. Start with a camera clip and
a music file that each have at least three seconds of usable media, plus a PNG
such as a logo or title card. Choose new project and output filenames.

```sh
PROJECT=rough-cut.opencut.json
opencut project create "$PROJECT" --name "Rough cut" --width 640 --height 360 --fps 30 --json
opencut media import "$PROJECT" camera.mp4 --json
opencut media import "$PROJECT" music.wav --json
opencut media import "$PROJECT" logo.png --json
opencut project inspect "$PROJECT" --json
```

Use the returned revision and asset IDs to fill in this batch. Save it to
`rough-cut.json`. The camera starts at source frame zero, then loses its first
15 source frames when trimmed. The split at timeline frame 30 preserves source
continuity. The logo appears from timeline frame 15 through 44. Its scale and
offset are relative to the fitted canvas, so check the placement visually.

```json
{
  "expectedRevision": 3,
  "label": "Trim, split and layer the cut",
  "operations": [
    {
      "type": "track.add",
      "id": "main",
      "name": "Camera",
      "mediaType": "video"
    },
    { "type": "track.add", "id": "top", "name": "Logo", "mediaType": "video" },
    {
      "type": "track.add",
      "id": "music",
      "name": "Music",
      "mediaType": "audio"
    },
    {
      "type": "clip.add",
      "id": "take",
      "assetId": "CAMERA_ID",
      "trackId": "main",
      "at": 0,
      "in": 0,
      "out": 75
    },
    { "type": "clip.trim", "id": "take", "in": 15 },
    { "type": "clip.split", "id": "take", "at": 30, "rightId": "take-right" },
    {
      "type": "clip.add",
      "id": "logo",
      "assetId": "LOGO_ID",
      "trackId": "top",
      "at": 15,
      "in": 0,
      "out": 30,
      "visual": { "scale": 0.25 }
    },
    {
      "type": "clip.add",
      "id": "bed",
      "assetId": "MUSIC_ID",
      "trackId": "music",
      "at": 0,
      "in": 0,
      "out": 60,
      "volume": 0.25
    }
  ]
}
```

Dry-run and commit, then compare the composition at the overlay start, the
split and the overlay end. Review the generated PNG and MP4 with available
image and playback tools.

```sh
opencut edit apply "$PROJECT" rough-cut.json --dry-run --json
opencut edit apply "$PROJECT" rough-cut.json --json
opencut timeline inspect "$PROJECT" --frame 30 --json
opencut preview contact-sheet "$PROJECT" --from 0 --to 60 --count 5 --columns 3 --output rough-sheet.png --json
opencut preview frame "$PROJECT" --frame 30 --output rough-frame.png --json
opencut preview clip "$PROJECT" --from 0 --to 60 --output rough-preview.mp4 --json
```

For reusable automation, pass the same operations to
`project.apply(...operations)` in the [SDK](sdk.md). Use
`previewContactSheet([14, 15, 29, 30, 44, 45], path)` to sample both sides of the
boundaries. Then [validate and export](cli.md#visual-review-and-export).

## Photo slideshows and vertical edits

For a 20-second portrait story at 30 fps, create a 1080×1920 canvas and place
five stills for 120 frames each on the same video track. For stills, use
`in: 0`, `out: 120` and timeline positions 0, 120, 240, 360 and 480.
Put badges or inset photos on a later video track. Use `contain` for the whole
image and `cover` when a crop suits the subject. Inspect faces and text after
scaling. A music bed goes on its own audio track. Choose an available source
range and keep its endpoint within the intended final duration.

## Screen recordings and personal footage

Probe recordings first. Keep text and cursor activity legible and preserve the
full screen with `contain` where needed. Preview around edits that remove
pauses to check the action and audio still make sense. Place a camera inset or
an editable title on a higher video track. Check that it leaves menus
and captions visible. Set music gain below the primary narration and listen
to an overlap in a short preview. For variable frame rate sources, examine
actual composited frames around cuts while keeping edit times on the project grid.

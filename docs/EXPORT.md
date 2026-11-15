# Export

Render a definition to MP4 with the CLI or SDK. The default uses the
definition's canvas and rate, H.264 video and stereo AAC. The export
dialog in Electron renders the displayed revision at its authored size and
rate. Use the CLI or SDK for the full set of output controls.

```sh
opencut render edit.video.ts --output final.mp4
opencut render edit.video.json --output portrait.mp4 --width 1080 --height 1920 --fps 30000/1001 --quality high
```

`opencut render --help` lists the quality, resolution, codec, bitrate, audio
settings, `--no-subtitles`, and `--overwrite` options. A rate override
resamples the completed composition. Clip boundaries and source samples are
first selected on the authored timeline grid. H.264 exports flatten
transparency over black. The renderer supports SDR and does not promise
preservation of arbitrary source color spaces or HDR metadata.

Choose an output path in an existing directory. The renderer stages output
beside the destination and publishes it after encoding and verification. An
existing file is refused unless explicitly authorized with `--overwrite`.
With overwrite enabled, a failed or cancelled render leaves the prior file
in place. Sources are read only. Foreground cancellation uses SIGINT or
SIGTERM in the CLI, or an AbortSignal in the SDK. Forced termination can
leave a staging directory behind.

Use `opencut subtitles export edit.video.ts --output captions.srt` for a
sidecar. See the [definition format](VIDEO_DEFINITIONS.md) for supported
effects and the [preview comparison](PREVIEW_EXPORT_CONSISTENCY.md) for
sampling and playback limits.

#!/usr/bin/env bash
set -euo pipefail
if [[ "$#" != 3 ]]; then
  printf '%s\n' 'Usage: verify-installed.sh /path/to/opencut relocated-package-directory new-output-directory' >&2
  exit 2
fi
opencut_bin="$1"
relocated="$2"
out="$3"
mkdir "$out"
for scene in field-notes prism waterline signal relay parallax; do
  bundle="$relocated/$scene"
  if [[ "$scene" == field-notes && -d "$relocated/field-notes-pcm" ]]; then
    bundle="$relocated/field-notes-pcm"
  fi
  if [[ "$scene" == prism && -d "$relocated/prism-window" ]]; then
    bundle="$relocated/prism-window"
  fi
  "$opencut_bin" package verify "$bundle" --json > "$out/$scene.verify.json"
  "$opencut_bin" render "$bundle/opencut.bundle.video.ts" --output "$out/$scene.mp4" --json > "$out/$scene.render.json"
done

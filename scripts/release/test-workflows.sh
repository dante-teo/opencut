#!/bin/bash
set -euo pipefail

cli="$(realpath "$1")"
project="$2"
shift 2
root="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$root/tests/fixtures/generated"
media="$(mktemp -d "$root/tests/fixtures/generated/installed-workflows.XXXXXX")"
trap 'rm -rf "$media"' EXIT

python3 "$root/tests/distribution/fixtures.py" "$media"
python3 "$root/tests/distribution/workflows.py" "$cli" "$project" "$media" "$@"

if [[ -n "${PLAYWRIGHT_BROWSERS_PATH:-}" ]]; then
  # mktemp may return macOS's /var alias. Package inputs require physical paths.
  graphics="$(realpath "$project")/graphics"
  mkdir "$graphics"
  cp "$root"/tests/distribution/{graphics.video.ts,Graphic.tsx,Badge.svg} "$graphics/"
  "$cli" validate "$graphics/graphics.video.ts"
  "$cli" package "$graphics/graphics.video.ts" --output "$graphics/portable"
  mkdir "$graphics/relocated"
  mv "$graphics/portable" "$graphics/relocated/project"
  rm "$graphics/Graphic.tsx" "$graphics/Badge.svg"
  "$cli" package verify "$graphics/relocated/project"
  "$cli" render "$graphics/relocated/project/opencut.bundle.video.ts" -o "$graphics/final.mp4"
  test "$(ffprobe -v error -select_streams v:0 -show_entries stream=nb_frames -of csv=p=0 "$graphics/final.mp4")" = 12
fi

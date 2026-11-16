#!/bin/bash
set -euo pipefail

archive="$(realpath "$1")"
root="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(realpath "$(mktemp -d)")"
server=''
cleanup() {
  if [[ -n "$server" ]]; then kill "$server" 2>/dev/null || true; fi
  rm -rf "$work"
}
trap cleanup EXIT
node_dir="$(dirname "$(command -v node)")"
ffmpeg_dir="$(dirname "$(command -v ffmpeg)")"
ffprobe_dir="$(dirname "$(command -v ffprobe)")"

export HOME="$work/home" XDG_CACHE_HOME="$work/cache"
export PATH="$node_dir:$ffmpeg_dir:$ffprobe_dir:/usr/bin:/bin"
export npm_config_cache="$work/npm-cache" npm_config_userconfig=/dev/null
export npm_config_fund=false npm_config_audit=false
export npm_config_globalconfig="$work/global.npmrc" npm_config_update_notifier=false
export DEVELOPER_DIR=/var/empty
export OPENCUT_DIALOGUE_PYTHON="$work/missing-python"
unset NODE_PATH NODE_OPTIONS SDKROOT
mkdir -p "$HOME" "$work/project" "$work/caller"
cp "$root"/tests/distribution/*.ts "$work/project/"
printf '{"type":"module","private":true}\n' > "$work/project/package.json"
cd "$work/caller"

npm --offline --prefix "$work/prefix" install --global "$archive"
cli="$work/prefix/bin/opencut"
"$cli" --version
"$cli" doctor --json > doctor.json
PATH=/usr/bin:/bin "$node_dir/node" "$cli" doctor --json > without-ffmpeg.json
node --input-type=module - <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const doctor = read('doctor.json');
assert(doctor.media.ready, JSON.stringify(doctor.media));
assert.equal(doctor.system.videoToolbox.status, 'probed');
assert.equal(doctor.system.videoToolbox.version, doctor.application.version);
for (const worker of Object.values(doctor.ai.videoToolbox.workers)) {
  assert.equal(worker.status, 'available');
  assert.equal(worker.version, doctor.application.version);
}
assert.equal(doctor.ai.dialogue.model.status, 'missing');
assert.equal(doctor.ai.dialogue.backend.status, 'missing');
assert.equal(read('without-ffmpeg.json').media.ffmpeg.status, 'missing');
JS

definition="$work/project/smoke.video.ts"
"$cli" validate "$definition" --json > inspected.json
"$cli" preview frame "$definition" --frame 0 -o fast.png > fast.json
"$cli" preview contact-sheet "$definition" --count 2 -o sheet.png > sheet.json
"$cli" render "$definition" -o final.mp4
"$cli" render "$definition" --quality maximum -o maximum.mp4
for video in final.mp4 maximum.mp4; do
  test "$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height,nb_frames -of csv=p=0 "$video")" = "h264,160,90,12"
done
test -s fast.png && test -s sheet.png
"$cli" package "$definition" -o bundle
"$cli" render bundle/opencut.bundle.video.ts -o bundled.mp4

# Exercise the exact scoped install and npx spelling against the same bytes
# through an isolated loopback registry, without publishing to npm.
node "$root/scripts/release/serve-artifact.mjs" "$archive" "$work/port" &
server=$!
for ((attempt=0; attempt<100; attempt++)); do
  [[ -s "$work/port" ]] && break
  sleep 0.1
done
registry_port="$(cat "$work/port")"
export npm_config_registry="http://127.0.0.1:$registry_port"
npm --cache "$work/named-cache" --prefix "$work/named" install --global @opencut/cli
"$work/named/bin/opencut" --version
npx --yes --cache "$work/npx-cache" @opencut/cli --version
(
  cd "$work/project"
  npm install --offline "$archive"
  node --input-type=module -e 'import {defineVideo} from "@opencut/cli/sdk"; if (typeof defineVideo !== "function") process.exit(1)'
  sed 's|@opencut/sdk|@opencut/cli/sdk|' smoke.video.ts > typed.video.ts
  node node_modules/@opencut/cli/node_modules/typescript/lib/tsc.js --noEmit \
    --module NodeNext --skipLibCheck --allowImportingTsExtensions --strict typed.video.ts
)
test ! -e "$work/prefix/lib/node_modules/@opencut/cli/node_modules/electron"
npm --offline --prefix "$work/prefix" uninstall --global @opencut/cli
test ! -e "$cli"

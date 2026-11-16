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
pnpm_dir="$(dirname "$(command -v pnpm)")"
pnpm_version="$(pnpm --version)"
export COREPACK_HOME="${COREPACK_HOME:-${XDG_CACHE_HOME:-$HOME/.cache}/node/corepack}"

export HOME="$work/home" XDG_CACHE_HOME="$work/cache"
export XDG_CONFIG_HOME="$work/config" XDG_STATE_HOME="$work/state"
export PNPM_HOME="$work/pnpm"
export PATH="$PNPM_HOME/bin:$node_dir:$pnpm_dir:$ffmpeg_dir:$ffprobe_dir:/usr/bin:/bin"
export COREPACK_ENABLE_NETWORK=0
export DEVELOPER_DIR=/var/empty
export OPENCUT_DIALOGUE_PYTHON="$work/missing-python"
unset NODE_PATH NODE_OPTIONS SDKROOT
mkdir -p "$HOME" "$work/project" "$work/caller"
cp "$root"/tests/distribution/{smoke.video,title}.ts "$work/project/"
printf '{"type":"module","private":true,"packageManager":"pnpm@%s"}\n' "$pnpm_version" > "$work/project/package.json"
cp "$work/project/package.json" "$work/caller/package.json"
cd "$work/caller"

pnpm add --offline -g "$archive"
cli="$PNPM_HOME/bin/opencut"
package_dir="$(pnpm list -g --json @dantea/opencut | node -p \
  'JSON.parse(require("node:fs").readFileSync(0, "utf8"))[0].dependencies["@dantea/opencut"].path')"
"$cli" --version
"$cli" doctor --json > doctor.json
PATH=/usr/bin:/bin "$node_dir/node" "$package_dir/dist/index.js" doctor --json > without-ffmpeg.json
node --input-type=module - <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const doctor = read('doctor.json');
assert(doctor.media.ready, JSON.stringify(doctor.media));
assert.deepEqual(doctor.media.rssHelper, { status: 'available', version: doctor.application.version });
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

rss_helper="$package_dir/node_modules/@opencut/media/dist/process-memory"
mv "$rss_helper" "$work/process-memory"
"$cli" doctor --json > without-rss-helper.json
mv "$work/process-memory" "$rss_helper"
node --input-type=module - <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const { media } = JSON.parse(readFileSync('without-rss-helper.json', 'utf8'));
assert.equal(media.ready, false);
assert.equal(media.rssHelper.status, 'missing');
assert.match(media.hint, /Reinstall OpenCut/);
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

test ! -e "$package_dir/node_modules/electron"
bash "$root/scripts/release/test-workflows.sh" "$cli" \
  "${OPENCUT_RELEASE_EVALUATION_DIR:-$work/evaluation}" --package-dir "$package_dir"

# Exercise the documented registry commands against the same bytes through a
# loopback registry.
node "$root/scripts/release/serve-artifact.mjs" "$archive" "$work/port" &
server=$!
for ((attempt=0; attempt<100; attempt++)); do
  [[ -s "$work/port" ]] && break
  sleep 0.1
done
registry_port="$(cat "$work/port")"
export pnpm_config_registry="http://127.0.0.1:$registry_port"
export pnpm_config_minimum_release_age=0
export pnpm_config_trust_policy=off
pnpm dlx @dantea/opencut --help
pnpm remove -g @dantea/opencut
test ! -e "$cli"
pnpm add -g @dantea/opencut
"$cli" --version
(
  cd "$work/project"
  pnpm add @dantea/opencut
  node --input-type=module -e 'import {defineVideo} from "@dantea/opencut/sdk"; if (typeof defineVideo !== "function") process.exit(1)'
  sed 's|@opencut/sdk|@dantea/opencut/sdk|' smoke.video.ts > typed.video.ts
  node node_modules/@dantea/opencut/node_modules/typescript/lib/tsc.js --noEmit \
    --module NodeNext --skipLibCheck --allowImportingTsExtensions --strict typed.video.ts
)
pnpm remove -g @dantea/opencut
test ! -e "$cli"

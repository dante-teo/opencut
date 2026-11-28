#!/bin/bash
set -euo pipefail

if [[ $# != 2 && $# != 4 ]]; then
  printf '%s\n' "Usage: $0 archive formula [previous-archive previous-formula]" >&2
  exit 2
fi
archive="$(realpath "$1")"
formula="$(realpath "$2")"
root="$(cd "$(dirname "$0")/../.." && pwd)"
previous_archive=''
previous_formula=''
if [[ $# == 4 ]]; then
  previous_archive="$(realpath "$3")"
  previous_formula="$(realpath "$4")"
fi
formula_name="local/opencut-release/opencut"
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1
export HOMEBREW_NO_INSTALL_UPGRADE=1 HOMEBREW_NO_AUTOREMOVE=1 HOMEBREW_NO_ANALYTICS=1
work="$(mktemp -d)"
server=''
tapped=''
cleanup() {
  if [[ "$tapped" == yes ]]; then
    brew uninstall --force "$formula_name" >/dev/null 2>&1 || true
    brew untap local/opencut-release >/dev/null 2>&1 || true
  fi
  if [[ -n "$server" ]]; then
    kill "$server" 2>/dev/null || true
    wait "$server" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT
export XDG_CONFIG_HOME="$work/config"
brew_prefix="$(brew --prefix)"
brew_cellar="$(brew --cellar)"
if [[ -n "${OPENCUT_TEST_BREW_PREFIX:-}" ]] &&
   [[ "$brew_prefix" != "$OPENCUT_TEST_BREW_PREFIX" || "$brew_cellar" != "$brew_prefix/Cellar" ]]; then
  printf '%s\n' "Homebrew prefix and Cellar do not match the requested test installation." >&2
  exit 1
fi
if brew list --formula --versions opencut >/dev/null 2>&1 || brew tap | grep -qx 'local/opencut-release'; then
  printf '%s\n' "Use a Homebrew installation without an existing OpenCut keg or test tap." >&2
  exit 1
fi

mkdir -p "$work/tap/Formula" "$work/project"
cp "$root"/tests/distribution/{smoke.video,title}.ts "$work/project/"
printf '{"type":"module","private":true}\n' > "$work/project/package.json"
cd "$work/project"
export XDG_CACHE_HOME="$work/cache" HOMEBREW_CACHE="${HOMEBREW_CACHE:-$work/brew-cache}"
node "$root/scripts/release/serve-artifact.mjs" "$archive" "$work/port" ${previous_archive:+"$previous_archive"} &
server=$!
for ((attempt=0; attempt<100; attempt++)); do
  [[ -s "$work/port" ]] && break
  sleep 0.1
done
test -s "$work/port"
port="$(cat "$work/port")"
local_formula() {
  sed -E "s#^  url .*#  url \"http://127.0.0.1:$port/$(basename "$1")\"#" "$2"
}
local_formula "$archive" "$formula" > "$work/opencut.rb"
if [[ -n "$previous_archive" ]]; then
  local_formula "$previous_archive" "$previous_formula" > "$work/tap/Formula/opencut.rb"
else
  # Exercise the lifecycle for a first release using a synthetic older keg.
  sed -E 's/^  version .*/  version "0.0.0"/' "$work/opencut.rb" > "$work/tap/Formula/opencut.rb"
fi
git -C "$work/tap" init -q
git -C "$work/tap" add Formula
git -C "$work/tap" -c user.name=OpenCut -c user.email=test@example.invalid -c commit.gpgsign=false commit -qm "Install fixture"
brew tap local/opencut-release "$work/tap"
tapped=yes
brew install "$formula_name"
bin="$brew_prefix/bin/opencut"
old_executable="$(realpath "$bin")"
if [[ -n "$previous_archive" ]]; then
  brew test "$formula_name"
fi
tap_path="$(brew --repository local/opencut-release)"
cp "$work/opencut.rb" "$tap_path/Formula/opencut.rb"
brew upgrade "$formula_name"
brew test "$formula_name"
prefix="$(brew --prefix "$formula_name")"
test "$(realpath "$bin")" = "$(realpath "$prefix/bin/opencut")"
test "$(realpath "$bin")" != "$old_executable"
"$bin" render smoke.video.ts -o final.mp4
test "$(ffprobe -v error -select_streams v:0 -show_entries stream=nb_frames -of csv=p=0 final.mp4)" = 12

# Exercise the documented SDK link in a project outside the installed keg.
node_bin="$(brew --prefix node@24)/bin/node"
mkdir -p "$work/sdk/node_modules/@opencut"
ln -s "$prefix/libexec/node_modules/@opencut/sdk" "$work/sdk/node_modules/@opencut/sdk"
cp smoke.video.ts title.ts package.json "$work/sdk/"
(
  cd "$work/sdk"
  "$node_bin" "$prefix/libexec/node_modules/typescript/lib/tsc.js" --noEmit \
    --module NodeNext --skipLibCheck --allowImportingTsExtensions --strict smoke.video.ts
  "$node_bin" --input-type=module -e 'import { defineVideo } from "@opencut/sdk"; if (typeof defineVideo !== "function") process.exit(1)'
)

bash "$root/scripts/release/test-workflows.sh" "$bin" \
  "${OPENCUT_RELEASE_EVALUATION_DIR:-$work/evaluation}" --package-dir "$prefix/libexec"
brew cleanup "$formula_name"
brew uninstall "$formula_name"
test ! -e "$bin"
test ! -L "$bin"
test ! -e "$prefix"
test ! -L "$prefix"
test ! -d "$brew_cellar/opencut"

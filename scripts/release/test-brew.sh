#!/bin/bash
set -euo pipefail

archive="$(realpath "$1")"
formula="$(realpath "$2")"
root="$(cd "$(dirname "$0")/../.." && pwd)"
formula_name="local/opencut-release/opencut"
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1
export HOMEBREW_NO_INSTALL_UPGRADE=1 HOMEBREW_NO_ANALYTICS=1
if brew list --formula --versions opencut >/dev/null 2>&1 || brew tap | grep -qx 'local/opencut-release'; then
  printf '%s\n' "Use a Homebrew installation without an existing OpenCut keg or test tap." >&2
  exit 1
fi

work="$(mktemp -d)"
server=''
tapped=''
cleanup() {
  if [[ "$tapped" == yes ]]; then
    brew uninstall --force "$formula_name" >/dev/null 2>&1 || true
    brew untap local/opencut-release >/dev/null 2>&1 || true
  fi
  if [[ -n "$server" ]]; then kill "$server" 2>/dev/null || true; fi
  rm -rf "$work"
}
trap cleanup EXIT
mkdir -p "$work/tap/Formula" "$work/project"
cp "$root"/tests/distribution/{smoke.video,title}.ts "$work/project/"
printf '{"type":"module","private":true}\n' > "$work/project/package.json"
cd "$work/project"
export XDG_CACHE_HOME="$work/cache" HOMEBREW_CACHE="$work/brew-cache"
node "$root/scripts/release/serve-artifact.mjs" "$archive" "$work/port" &
server=$!
for ((attempt=0; attempt<100; attempt++)); do
  [[ -s "$work/port" ]] && break
  sleep 0.1
done
port="$(cat "$work/port")"
sed -E "s#^  url .*#  url \"http://127.0.0.1:$port/$(basename "$archive")\"#" "$formula" > "$work/opencut.rb"
# A first release has no older archive. Start with an older keg version using
# the same bytes to exercise Homebrew's upgrade and linked executable handling.
sed -E 's/^  version .*/  version "0.0.0"/' "$work/opencut.rb" > "$work/tap/Formula/opencut.rb"
git -C "$work/tap" init -q
git -C "$work/tap" add Formula
git -C "$work/tap" -c user.name=OpenCut -c user.email=test@example.invalid -c commit.gpgsign=false commit -qm "Install fixture"
brew tap local/opencut-release "$work/tap"
tapped=yes
brew install "$formula_name"
tap_path="$(brew --repository local/opencut-release)"
cp "$work/opencut.rb" "$tap_path/Formula/opencut.rb"
brew upgrade "$formula_name"
brew test "$formula_name"
prefix="$(brew --prefix "$formula_name")"
bin="$prefix/bin/opencut"
"$bin" render smoke.video.ts -o final.mp4
test "$(ffprobe -v error -select_streams v:0 -show_entries stream=nb_frames -of csv=p=0 final.mp4)" = 12
bash "$root/scripts/release/test-workflows.sh" "$bin" \
  "${OPENCUT_RELEASE_EVALUATION_DIR:-$work/evaluation}" --package-dir "$prefix/libexec"
brew uninstall "$formula_name"
test ! -e "$bin"

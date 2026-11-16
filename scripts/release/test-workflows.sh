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

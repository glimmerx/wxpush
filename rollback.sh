#!/bin/sh
set -eu

BASE=52e2051a93e6042bc7155065cc12dd3c64d0d70f
REPO=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DEST=${1:-}

if [ -z "$DEST" ] || [ -e "$DEST" ]; then
  printf '%s\n' 'Usage: ./rollback.sh /path/to/new-empty-destination' >&2
  exit 2
fi

mkdir -p -- "$DEST"
git -C "$REPO" archive "$BASE" | tar -x -C "$DEST"
ACTUAL=$(shasum -a 256 "$DEST/src/index.js" | awk '{print $1}')
EXPECTED=795aba8d9fcb72d7f379118850dc300257ed37650a529393c07c03876e20a4fe
if [ "$ACTUAL" != "$EXPECTED" ]; then
  printf '%s\n' 'Rollback verification failed: source hash mismatch' >&2
  exit 1
fi
printf 'Restored upstream %s into %s\n' "$BASE" "$DEST"
printf 'Verified src/index.js SHA-256: %s\n' "$ACTUAL"

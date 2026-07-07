#!/usr/bin/env bash
# Ad-hoc sign the macOS app bundles that are staged for packaging.

set -euo pipefail

UPSTREAM_DIR="${1:-$(cd "$(dirname "$0")/../upstream" && pwd)}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[macos-sign] skip: not macOS"
  exit 0
fi

if [[ ! -d "$UPSTREAM_DIR" ]]; then
  echo "[macos-sign] missing upstream dir: $UPSTREAM_DIR" >&2
  exit 1
fi

shopt -s nullglob
apps=("$UPSTREAM_DIR"/obj-*/dist/firefox/*.app)
shopt -u nullglob

if [[ ${#apps[@]} -eq 0 ]]; then
  echo "[macos-sign] no staged dist/firefox/*.app bundles found"
  exit 0
fi

for app in "${apps[@]}"; do
  echo "[macos-sign] clear xattrs: $app"
  find "$app" -print0 | xargs -0 xattr -c 2>/dev/null || true

  echo "[macos-sign] ad-hoc sign: $app"
  codesign --force --deep --sign - "$app"

  echo "[macos-sign] verify: $app"
  codesign --verify --deep --strict --verbose=4 "$app"
done

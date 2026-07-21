#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
upstream=${UPSTREAM_DIR:-"$repo_root/upstream"}
mozconfig="$repo_root/configs/mozconfig.linux-arm64"

if [[ $(uname -s) != Linux ]]; then
  echo "Linux ARM64 cross-build requires a Linux build host." >&2
  exit 1
fi

if [[ ! -x "$upstream/mach" ]]; then
  echo "Firefox source tree not found at $upstream" >&2
  exit 1
fi

export MOZCONFIG="$mozconfig"
export MOZ_BUILD_DATE=${MOZ_BUILD_DATE:-$(date -u +%Y%m%d%H%M%S)}

rm -f "$upstream/obj-aarch64-linux/buildid.h"
cd "$upstream"
./mach build
./mach package

package=$(find "$upstream/obj-aarch64-linux/dist" -maxdepth 1 -type f \
  -name 'firefox-*.linux-aarch64.tar.*' -print -quit)
if [[ -z "$package" ]]; then
  echo "Linux ARM64 package was not generated." >&2
  exit 1
fi

echo "$package"

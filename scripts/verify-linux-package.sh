#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <amd64|arm64> <firefox-linux-package.tar.xz>" >&2
  exit 2
fi

arch=$1
package=$2
case "$arch" in
  amd64) marker='x86-64' ;;
  arm64) marker='ARM aarch64' ;;
  *) echo "unsupported architecture: $arch" >&2; exit 2 ;;
esac

test -f "$package"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
tar -xJf "$package" -C "$tmp"

binary=$(find "$tmp" -type f -path '*/firefox/firefox' -print -quit)
omni=$(find "$tmp" -type f -path '*/firefox/browser/omni.ja' -print -quit)
test -n "$binary"
test -n "$omni"
file "$binary" | grep -F "$marker"
unzip -l "$omni" | grep -F 'ReasoningEffort.sys.mjs'
unzip -l "$omni" | grep -F 'EnvironmentBackend.sys.mjs'

echo "verified $arch package: $package"

#!/usr/bin/env bash
# Repack a cross-compiled DMG after applying an ad-hoc signature on macOS.

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[macos-repack] this script must run on macOS" >&2
  exit 1
fi

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "usage: $0 <input.dmg> <output.dmg> [arm64|x86_64]" >&2
  exit 2
fi

input="$1"
output="$2"
expected_arch="${3:-}"

if [[ ! -f "$input" ]]; then
  echo "[macos-repack] missing input: $input" >&2
  exit 1
fi
if [[ "$input" == "$output" ]]; then
  echo "[macos-repack] input and output must be different files" >&2
  exit 1
fi

work_dir="$(mktemp -d /tmp/frx-dmg-repack.XXXXXX)"
mount_dir="$work_dir/mount"
stage_dir="$work_dir/stage"
mkdir -p "$mount_dir" "$stage_dir"
attached=0

cleanup() {
  if [[ "$attached" -eq 1 ]]; then
    hdiutil detach "$mount_dir" >/dev/null 2>&1 || true
  fi
  rm -rf "$work_dir"
}
trap cleanup EXIT

echo "[macos-repack] attach: $input"
hdiutil attach "$input" -mountpoint "$mount_dir" -nobrowse -readonly >/dev/null
attached=1
/usr/bin/ditto "$mount_dir" "$stage_dir"
hdiutil detach "$mount_dir" >/dev/null
attached=0

shopt -s nullglob
apps=("$stage_dir"/*.app)
shopt -u nullglob
if [[ ${#apps[@]} -eq 0 ]]; then
  echo "[macos-repack] no app bundle found in $input" >&2
  exit 1
fi

for app in "${apps[@]}"; do
  echo "[macos-repack] ad-hoc sign: $app"
  xattr -cr "$app"
  codesign --force --deep --sign - "$app"
  codesign --verify --deep --strict --verbose=4 "$app"
done

mkdir -p "$(dirname "$output")"
rm -f "$output"
echo "[macos-repack] create: $output"
hdiutil create \
  -srcfolder "$stage_dir" \
  -volname "Firefox Reverse" \
  -format UDZO \
  -imagekey zlib-level=9 \
  -ov "$output" >/dev/null

verify_args=()
if [[ -n "$expected_arch" ]]; then
  verify_args+=(--arch "$expected_arch")
fi
"$(cd "$(dirname "$0")" && pwd)/macos-verify-dmg.sh" "${verify_args[@]}" "$output"
echo "[macos-repack] ready: $output"

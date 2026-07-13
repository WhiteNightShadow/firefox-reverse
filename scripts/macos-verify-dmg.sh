#!/usr/bin/env bash
# Verify that macOS DMGs contain app bundles with valid resource signatures.

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[macos-dmg-verify] skip: not macOS"
  exit 0
fi

expected_arch=""
if [[ "${1:-}" == "--arch" ]]; then
  expected_arch="${2:-}"
  shift 2
fi

if [[ $# -eq 0 ]]; then
  echo "usage: $0 [--arch arm64|x86_64] <dmg> [<dmg> ...]" >&2
  exit 2
fi

for dmg in "$@"; do
  if [[ ! -f "$dmg" ]]; then
    echo "[macos-dmg-verify] missing dmg: $dmg" >&2
    exit 1
  fi

  mount_dir="$(mktemp -d /tmp/frx-dmg-verify.XXXXXX)"
  attached=0
  cleanup() {
    if [[ "$attached" -eq 1 ]]; then
      hdiutil detach "$mount_dir" >/dev/null 2>&1 || true
    fi
    rmdir "$mount_dir" >/dev/null 2>&1 || true
  }
  trap cleanup RETURN

  echo "[macos-dmg-verify] attach: $dmg"
  hdiutil attach "$dmg" -mountpoint "$mount_dir" -nobrowse -readonly >/dev/null
  attached=1

  shopt -s nullglob
  apps=("$mount_dir"/*.app)
  shopt -u nullglob
  if [[ ${#apps[@]} -eq 0 ]]; then
    echo "[macos-dmg-verify] no app bundle found in $dmg" >&2
    exit 1
  fi

  for app in "${apps[@]}"; do
    executable_name="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")"
    executable="$app/Contents/MacOS/$executable_name"
    architectures="$(lipo -archs "$executable")"
    echo "[macos-dmg-verify] architectures: $architectures"
    if [[ -n "$expected_arch" && "$architectures" != "$expected_arch" ]]; then
      echo "[macos-dmg-verify] expected $expected_arch, got $architectures: $executable" >&2
      exit 1
    fi

    echo "[macos-dmg-verify] codesign: $app"
    codesign --verify --deep --strict --verbose=4 "$app"
  done

  cleanup
  attached=0
  trap - RETURN
done

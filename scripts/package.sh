#!/usr/bin/env bash
# 打包构建产物。多端打包请用 ../firefox-reverse-build/。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UPSTREAM_DIR="${UPSTREAM_DIR:-$REPO_ROOT/upstream}"
DIST_DIR="${DIST_DIR:-$REPO_ROOT/dist}"

cd "$UPSTREAM_DIR"
./mach package

mkdir -p "$DIST_DIR"
cp -v obj-*/dist/firefox-*.{tar.xz,dmg,zip,exe,deb} "$DIST_DIR/" 2>/dev/null || true

echo "[package] artifacts → $DIST_DIR"

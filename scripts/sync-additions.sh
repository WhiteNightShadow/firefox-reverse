#!/usr/bin/env bash
# Idempotently sync additions/ into an existing Firefox source tree.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UPSTREAM_DIR="${UPSTREAM_DIR:-$REPO_ROOT/upstream}"

if [[ ! -x "$UPSTREAM_DIR/mach" ]]; then
  echo "[sync-additions] $UPSTREAM_DIR 不是可用的 Firefox 源码树" >&2
  exit 1
fi

if [[ ! -d "$REPO_ROOT/additions" ]]; then
  echo "[sync-additions] additions/ 不存在，无需同步"
  exit 0
fi

echo "[sync-additions] copying additions/ to $UPSTREAM_DIR"
rsync -a --exclude README.md --exclude node_modules --exclude dev \
  --exclude '*.jsx' --exclude 'package*.json' --exclude .gitignore \
  "$REPO_ROOT/additions/" "$UPSTREAM_DIR/"

if ! cmp -s \
  "$REPO_ROOT/additions/browser/components/agent-sidebar/moz.build" \
  "$UPSTREAM_DIR/browser/components/agent-sidebar/moz.build"; then
  echo "[sync-additions] agent-sidebar/moz.build 同步失败" >&2
  exit 1
fi

echo "[sync-additions] done."

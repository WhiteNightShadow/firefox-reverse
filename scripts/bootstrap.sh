#!/usr/bin/env bash
# 浅克隆 mozilla-firefox/firefox 到 upstream/，作为后续 patch + build 的源码基线。
#
# 环境变量：
#   UPSTREAM_REPO  默认 https://github.com/mozilla-firefox/firefox.git
#   UPSTREAM_REF   默认 Firefox Reverse 锁定 commit；可显式覆盖
#   UPSTREAM_DIR   默认 upstream

set -euo pipefail

UPSTREAM_REPO="${UPSTREAM_REPO:-https://github.com/mozilla-firefox/firefox.git}"
UPSTREAM_REF="${UPSTREAM_REF:-cebc55aab4d2661d1f6c2d1526362947ec4016c1}"
UPSTREAM_DIR="${UPSTREAM_DIR:-upstream}"

if [[ -d "$UPSTREAM_DIR/.git" ]]; then
  echo "[bootstrap] $UPSTREAM_DIR 已存在，跳过 clone。如需重新拉取：make reset 或 rm -rf $UPSTREAM_DIR"
  exit 0
fi

echo "[bootstrap] fetch $UPSTREAM_REPO @ $UPSTREAM_REF → $UPSTREAM_DIR (shallow)"
git init "$UPSTREAM_DIR"
git -C "$UPSTREAM_DIR" remote add origin "$UPSTREAM_REPO"
git -C "$UPSTREAM_DIR" fetch --depth 1 origin "$UPSTREAM_REF"
git -C "$UPSTREAM_DIR" checkout --detach FETCH_HEAD
echo "[bootstrap] source=$(git -C "$UPSTREAM_DIR" rev-parse HEAD)"

echo "[bootstrap] done. 下一步：./scripts/apply-patches.sh"

#!/usr/bin/env bash
# 浅克隆 mozilla-firefox/firefox 到 upstream/，作为后续 patch + build 的源码基线。
#
# 环境变量：
#   UPSTREAM_REPO  默认 https://github.com/mozilla-firefox/firefox.git
#   UPSTREAM_REF   默认 main（建议改成具体 tag / commit 以锁定基线）
#   UPSTREAM_DIR   默认 upstream

set -euo pipefail

UPSTREAM_REPO="${UPSTREAM_REPO:-https://github.com/mozilla-firefox/firefox.git}"
UPSTREAM_REF="${UPSTREAM_REF:-main}"
UPSTREAM_DIR="${UPSTREAM_DIR:-upstream}"

if [[ -d "$UPSTREAM_DIR/.git" ]]; then
  echo "[bootstrap] $UPSTREAM_DIR 已存在，跳过 clone。如需重新拉取：make reset 或 rm -rf $UPSTREAM_DIR"
  exit 0
fi

echo "[bootstrap] git clone $UPSTREAM_REPO @ $UPSTREAM_REF → $UPSTREAM_DIR (shallow)"
git clone --depth 1 --branch "$UPSTREAM_REF" "$UPSTREAM_REPO" "$UPSTREAM_DIR"

echo "[bootstrap] done. 下一步：./scripts/apply-patches.sh"

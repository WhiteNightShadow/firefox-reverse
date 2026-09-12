#!/usr/bin/env bash
# 按 patches/README.md 顺序应用所有补丁，并把 additions/ 下的新文件 copy 到 upstream/。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UPSTREAM_DIR="${UPSTREAM_DIR:-$REPO_ROOT/upstream}"

# 应用顺序（见 patches/README.md）
MODULES=(
  property-trace
  network-analysis
  cookie-js-analysis
  fingerprint
  proxy
  jsvmp-trace
  agent-ui
  branding
)

if [[ ! -d "$UPSTREAM_DIR" ]]; then
  echo "[apply-patches] $UPSTREAM_DIR 不存在，先执行 ./scripts/bootstrap.sh" >&2
  exit 1
fi

cd "$UPSTREAM_DIR"

for module in "${MODULES[@]}"; do
  patches_dir="$REPO_ROOT/patches/$module"
  if [[ -d "$patches_dir" ]]; then
    shopt -s nullglob
    files=("$patches_dir"/*.patch)
    if (( ${#files[@]} == 0 )); then
      echo "[apply-patches] $module: 无 .patch 文件，跳过"
      continue
    fi
    echo "[apply-patches] $module: applying ${#files[@]} patches"
    for p in "${files[@]}"; do
      git apply --index "$p"
    done
  fi
done

# 拷贝 additions/；独立脚本也供日常二次开发安全重复执行。
bash "$REPO_ROOT/scripts/sync-additions.sh"

python3 "$REPO_ROOT/scripts/apply-fingerprint-config.py" "$UPSTREAM_DIR"

echo "[apply-patches] done."

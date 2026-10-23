#!/usr/bin/env bash
# 按 patches/README.md 顺序应用所有补丁，把 additions/ 同步到 upstream/，再跑源码补丁器。
# 可重复执行：已应用的 git 补丁跳过；additions 只复制有变化的文件并清掉已删除的；Python 补丁器幂等。
# 本地、CI 和编译机的长期源码树都用这一个入口，保证三处打出来的源码一致。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UPSTREAM_DIR="${UPSTREAM_DIR:-$REPO_ROOT/upstream}"
SIDEBAR_DIR="$REPO_ROOT/additions/browser/components/agent-sidebar"
PYTHON="${PYTHON:-python3}"

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

UPSTREAM_DIR="$(cd "$UPSTREAM_DIR" && pwd)"
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
    echo "[apply-patches] $module: ${#files[@]} patches"
    for p in "${files[@]}"; do
      # 能整体反向应用 = 已经打过，跳过；否则正向应用。两者都不行说明源码树和补丁对不上，直接失败。
      if git apply --reverse --check "$p" >/dev/null 2>&1; then
        echo "  [skip] $(basename "$p") (already applied)"
        continue
      fi
      git apply --index "$p"
      echo "  [done] $(basename "$p")"
    done
  fi
done

if [[ -d "$SIDEBAR_DIR" ]]; then
  # 侧栏 bundle 和生成的 PageAccessibility.sys.mjs 不入库：每次现编，避免把旧 bundle 打进安装包。
  # 依赖缺失或 package-lock.json 比已装依赖新时才 npm ci。
  (
    cd "$SIDEBAR_DIR"
    if [[ ! -f node_modules/.package-lock.json || package-lock.json -nt node_modules/.package-lock.json ]]; then
      npm ci
    fi
    npm run build
    test -f content/agent-sidebar.bundle.js
  )
fi

# 同步 additions/（前端开发文件、文档等由 sync-additions.py 的默认排除规则过滤）
"$PYTHON" "$REPO_ROOT/scripts/sync-additions.py" "$REPO_ROOT/additions" "$UPSTREAM_DIR"

"$PYTHON" "$REPO_ROOT/scripts/apply-fingerprint-config.py" "$UPSTREAM_DIR"
"$PYTHON" "$REPO_ROOT/scripts/apply-phase-b.py" "$UPSTREAM_DIR"

echo "[apply-patches] done."

#!/usr/bin/env bash
# 在编译机上出正式包，编译机怎么准备见 docs/build-host.md，整个发布流程见 docs/release-process.md。
#
#   activate         把本仓库当前提交的补丁打到锁定基线源码树，每次发布做一次
#   build <目标>     按 configs/ 编一个目标，做 zh-CN 重打包，按发布文件名放进候选目录
#   mozconfig <目标> 只打印 build 要用的 mozconfig
#
# 目标：macos-arm64 macos-x86_64 linux-x86_64 linux-arm64 windows-x86_64
#
# 环境变量：
#   UPSTREAM_DIR    锁定基线源码树（scripts/bootstrap.sh 拉取），必填
#   FRX_L10N_BASE   mozilla-l10n/firefox-l10n 的检出，build 和 mozconfig 必填
#   MOZ_BUILD_DATE  BuildID，五个目标共用一个，格式同 date -u +%Y%m%d%H%M%S，build 必填
#   FRX_OBJDIR      objdir 的绝对路径，默认 <源码树>/<mozconfig 里的目录名>
#   FRX_DIST_DIR    候选目录，默认 <仓库>/dist/v<版本>-candidate
#   FRX_BUILD_JOBS  mach build 的并行数，默认 16
#   UPSTREAM_REF、FRX_L10N_REF  换掉锁定的基线和 l10n 提交，只给测试用
#
# build 在候选目录里留下发布文件、mozconfig.<目标> 和 <目标>.sha256。

set -euo pipefail
export GIT_PAGER=cat PAGER=cat

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASELINE_REF="${UPSTREAM_REF:-cebc55aab4d2661d1f6c2d1526362947ec4016c1}"
L10N_REF="${FRX_L10N_REF:-53be390d96a531cf526f5db0fa83c02f12465abb}"
SOURCE_REPO=https://github.com/WhiteNightShadow/firefox-reverse
TARGETS="macos-arm64 macos-x86_64 linux-x86_64 linux-arm64 windows-x86_64"

fail() {
  echo "[release-build] $*" >&2
  exit 1
}

usage() {
  echo "usage: $0 activate | build <target> | mozconfig <target>" >&2
  echo "targets: $TARGETS" >&2
  exit 2
}

need() {
  local name
  for name in "$@"; do
    command -v "$name" >/dev/null || fail "缺少命令：$name"
  done
}

# 确认变量指向一个目录，并把它改写成绝对路径。
require_dir() {
  local value=${!1:-}
  [[ -n "$value" ]] || fail "需要设置 $1"
  [[ -d "$value" ]] || fail "$1 不是目录：$value"
  value=$(cd "$value" && pwd)
  [[ "$value" != *[[:space:]]* ]] || fail "$1 的路径里不能有空白：$value"
  printf -v "$1" '%s' "$value"
}

select_target() {
  case "$1" in
    macos-arm64) CONFIG=$REPO_ROOT/configs/mozconfig.macos-arm64 ;;
    macos-x86_64) CONFIG=$REPO_ROOT/configs/mozconfig.macos-x64 ;;
    linux-x86_64) CONFIG=$REPO_ROOT/configs/mozconfig.linux-x64 ;;
    linux-arm64) CONFIG=$REPO_ROOT/configs/mozconfig.linux-arm64 ;;
    windows-x86_64) CONFIG=$REPO_ROOT/configs/mozconfig.windows-x64 ;;
    *) usage ;;
  esac
  TARGET=$1
}

select_objdir() {
  if [[ -n "${FRX_OBJDIR:-}" ]]; then
    [[ "$FRX_OBJDIR" == /* ]] || fail "FRX_OBJDIR 要写绝对路径：$FRX_OBJDIR"
    OBJDIR=${FRX_OBJDIR%/}
  else
    local name
    name=$(sed -n 's|^mk_add_options MOZ_OBJDIR=@TOPSRCDIR@/||p' "$CONFIG")
    [[ -n "$name" ]] || fail "$CONFIG 里没有 mk_add_options MOZ_OBJDIR=@TOPSRCDIR@/<目录名>"
    OBJDIR=$UPSTREAM_DIR/$name
  fi
  [[ "$OBJDIR" != *[[:space:]]* ]] || fail "objdir 的路径里不能有空白：$OBJDIR"
}

# 仓库里的 mozconfig，objdir 换成绝对路径，再加上本机的 l10n 检出。
print_mozconfig() {
  [[ $(grep -c '^mk_add_options MOZ_OBJDIR=' "$CONFIG") == 1 ]] || fail "$CONFIG 要有且只有一行 MOZ_OBJDIR"
  grep -Fqx 'ac_add_options --with-branding=browser/branding/unofficial' "$CONFIG" \
    || fail "$CONFIG 没有用 unofficial 品牌"
  if grep -Eq '^[[:space:]]*ac_add_options[[:space:]]+--with-l10n-base' "$CONFIG"; then
    fail "$CONFIG 里不能写死 --with-l10n-base"
  fi
  local line
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "mk_add_options MOZ_OBJDIR="* ]]; then
      line="mk_add_options MOZ_OBJDIR=$OBJDIR"
    fi
    printf '%s\n' "$line"
  done < "$CONFIG"
  printf '\nac_add_options --with-l10n-base=%s\n' "$FRX_L10N_BASE"
}

require_baseline() {
  [[ -x "$UPSTREAM_DIR/mach" ]] || fail "$UPSTREAM_DIR 里没有 mach，先用 scripts/bootstrap.sh 拉锁定基线"
  local head
  head=$(git -C "$UPSTREAM_DIR" rev-parse HEAD) || fail "$UPSTREAM_DIR 不是 git 检出"
  [[ "$head" == "$BASELINE_REF" ]] || fail "源码树 HEAD 是 ${head}，不是锁定基线 $BASELINE_REF"
}

require_l10n() {
  local head
  head=$(git -C "$FRX_L10N_BASE" rev-parse HEAD) || fail "FRX_L10N_BASE 不是 git 检出：$FRX_L10N_BASE"
  [[ "$head" == "$L10N_REF" ]] || fail "l10n 检出的 HEAD 是 ${head}，不是锁定的 $L10N_REF"
  [[ -d "$FRX_L10N_BASE/zh-CN" ]] || fail "$FRX_L10N_BASE 里没有 zh-CN"
  [[ -z "$(git -C "$FRX_L10N_BASE" status --porcelain)" ]] || fail "l10n 检出有改动：$FRX_L10N_BASE"
}

require_clean_checkout() {
  git -C "$REPO_ROOT" diff --quiet && git -C "$REPO_ROOT" diff --cached --quiet \
    || fail "仓库检出有未提交的改动，正式包只能从干净的提交出"
}

read_version() {
  VERSION=$(sed -n 's/^pref("extensions\.firefox-reverse\.version", "\([^"]*\)");$/\1/p' \
    "$REPO_ROOT/additions/browser/components/agent-sidebar/preferences/frx-locale.js")
  [[ -n "$VERSION" ]] || fail "frx-locale.js 里没有 extensions.firefox-reverse.version"
}

# activate 独占 tree.lock，build 共享它，所以激活和编译不会同时进行。
# 每个目标另有一把锁；打包段排队用 package.lock。
open_locks() {
  LOCKS=$UPSTREAM_DIR/.frx-release-locks
  mkdir -p "$LOCKS"
}

# 每行：<objdir/dist 里的文件名模式> <发布文件名里版本号之后的部分>
assets() {
  case "$TARGET" in
    macos-*) echo "firefox-*.mac.dmg $TARGET.dmg" ;;
    linux-x86_64) echo "firefox-*.linux-x86_64.tar.xz $TARGET.tar.xz" ;;
    linux-arm64) echo "firefox-*.linux-aarch64.tar.xz $TARGET.tar.xz" ;;
    windows-x86_64)
      echo "firefox-*.win64.zip $TARGET.zip"
      echo "firefox-*.win64.installer.exe $TARGET-installer.exe"
      ;;
  esac
}

# 只收这次打包新生成的文件，旧包留在 dist 里也不会被误拿。
collect() {
  local marker=$1 pattern=$2 output=$3 found=() file
  while IFS= read -r -d '' file; do
    found+=("$file")
  done < <(find "$OBJDIR/dist" -maxdepth 1 -type f -name "$pattern" -newer "$marker" -print0)
  [[ ${#found[@]} -eq 1 ]] || fail "$OBJDIR/dist 里应该有一个新打出的 ${pattern}，实际有 ${#found[@]} 个"
  cp "${found[0]}" "$output"
  echo "[release-build] ${found[0]##*/} -> ${output##*/}"
}

verify_packages() {
  local prefix=$1
  case "$TARGET" in
    linux-x86_64) bash "$REPO_ROOT/scripts/verify-linux-package.sh" amd64 "$prefix.tar.xz" ;;
    linux-arm64) bash "$REPO_ROOT/scripts/verify-linux-package.sh" arm64 "$prefix.tar.xz" ;;
    windows-x86_64)
      python3 "$REPO_ROOT/scripts/verify-windows-installer.py" --installer "$prefix-installer.exe" \
        --zip "$prefix.zip" --output "${prefix%/*}/windows-installer-check.json"
      ;;
  esac
}

activate() {
  require_dir UPSTREAM_DIR
  require_baseline
  need node npm python3 flock
  require_clean_checkout
  open_locks
  exec 7>"$LOCKS/tree.lock"
  flock -n -x 7 || fail "有目标正在编译，等编完再激活"

  local commit previous
  commit=$(git -C "$REPO_ROOT" rev-parse HEAD)
  previous=$(cat "$UPSTREAM_DIR/.frx-release-applied" 2>/dev/null || echo 无)
  echo "[release-build] 源码树上次激活的提交：$previous"
  # 激活中途失败时不留标记，build 会拒绝只打了一半补丁的源码树。
  rm -f "$UPSTREAM_DIR/.frx-release-applied"

  npm --prefix "$REPO_ROOT/additions/browser/components/agent-sidebar" ci --no-audit --no-fund
  bash "$REPO_ROOT/scripts/selftest-agent-tools.sh"
  require_clean_checkout
  UPSTREAM_DIR="$UPSTREAM_DIR" bash "$REPO_ROOT/scripts/apply-patches.sh"
  require_clean_checkout
  node "$REPO_ROOT/scripts/check-branding-assets.mjs" "$UPSTREAM_DIR"
  printf '%s\n' "$commit" > "$UPSTREAM_DIR/.frx-release-applied"
  echo "ACTIVATED $commit"
}

build() {
  select_target "$1"
  [[ "${MOZ_BUILD_DATE:-}" =~ ^[0-9]{14}$ ]] \
    || fail "MOZ_BUILD_DATE 要设成五个目标共用的 BuildID，格式 YYYYMMDDHHMMSS"
  require_dir UPSTREAM_DIR
  require_dir FRX_L10N_BASE
  select_objdir
  require_baseline
  require_l10n
  need node python3 flock sha256sum file unzip tar
  if [[ "$TARGET" == windows-x86_64 ]]; then
    command -v 7zz >/dev/null || command -v 7z >/dev/null || [[ -x "$HOME/.mozbuild/7zz/7zz" ]] \
      || fail "缺少 7-Zip，检查 windows 安装程序要用"
  fi
  require_clean_checkout

  local commit dist marker names=() pattern suffix
  commit=$(git -C "$REPO_ROOT" rev-parse HEAD)
  [[ "$(cat "$UPSTREAM_DIR/.frx-release-applied" 2>/dev/null || true)" == "$commit" ]] \
    || fail "源码树不是按 $commit 激活的，先运行 activate"
  read_version
  dist=${FRX_DIST_DIR:-$REPO_ROOT/dist/v$VERSION-candidate}
  mkdir -p "$dist"
  dist=$(cd "$dist" && pwd)

  open_locks
  exec 7>"$LOCKS/tree.lock"
  flock -n -s 7 || fail "源码树正在激活"
  exec 8>"$LOCKS/$TARGET.lock"
  flock -n 8 || fail "$TARGET 已经在编译"

  print_mozconfig > "$dist/mozconfig.$TARGET"
  export MOZCONFIG=$dist/mozconfig.$TARGET
  export MOZ_SOURCE_REPO=$SOURCE_REPO MOZ_SOURCE_CHANGESET=$commit MOZ_BUILD_DATE
  export UPLOAD_DIR=$dist
  export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"
  cd "$UPSTREAM_DIR"
  ./mach configure
  python3 "$REPO_ROOT/scripts/verify-branding.py" --objdir "$OBJDIR"
  bash "$REPO_ROOT/scripts/force-build-id-relink.sh" "$OBJDIR"
  ./mach build -j"${FRX_BUILD_JOBS:-16}"
  grep -Fx "SourceStamp=$commit" "$OBJDIR/dist/bin/application.ini" \
    || fail "application.ini 的 SourceStamp 不是 $commit"
  grep -Fx "BuildID=$MOZ_BUILD_DATE" "$OBJDIR/dist/bin/application.ini" \
    || fail "application.ini 的 BuildID 不是 $MOZ_BUILD_DATE"

  exec 9>"$LOCKS/package.lock"
  flock 9
  marker=$(mktemp "$OBJDIR/.frx-package-start.XXXXXX")
  UPSTREAM_DIR="$UPSTREAM_DIR" bash "$REPO_ROOT/scripts/repack-zh-cn.sh"
  while read -r pattern suffix; do
    collect "$marker" "$pattern" "$dist/firefox-reverse-v$VERSION-$suffix"
    names+=("firefox-reverse-v$VERSION-$suffix")
  done < <(assets)
  rm -f "$marker"
  flock -u 9
  exec 9>&-

  verify_packages "$dist/firefox-reverse-v$VERSION-$TARGET"
  (cd "$dist" && sha256sum "${names[@]}") | tee "$dist/$TARGET.sha256"
  echo "COMPLETE $TARGET $commit $MOZ_BUILD_DATE"
}

case "${1:-}" in
  activate)
    [[ $# -eq 1 ]] || usage
    activate
    ;;
  build)
    [[ $# -eq 2 ]] || usage
    build "$2"
    ;;
  mozconfig)
    [[ $# -eq 2 ]] || usage
    select_target "$2"
    require_dir UPSTREAM_DIR
    require_dir FRX_L10N_BASE
    select_objdir
    print_mozconfig
    ;;
  *)
    usage
    ;;
esac

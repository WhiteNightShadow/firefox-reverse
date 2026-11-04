#!/usr/bin/env bash
# Acceptance of one final package on the machine this runs on: docs/release-process.md step 5 on macOS, and the
# Linux runs of build-host.md. Package identity first (scripts/prepare-native-candidate.py), then the page, lifecycle,
# fingerprint and global-prompt checks against the unmodified package (plus the 15 app-data scenarios on macOS),
# isolated from the user's own profile: temporary HOME, app data and TMPDIR, headless, synthetic fixtures only.
# Afterwards it checks that the run left the package alone (macOS signature, XUL/libxul hash, no leftover browser)
# and writes <out>/acceptance.json with the result of every step and the counts the release notes need.
#
# usage: scripts/release-accept.sh --package <final .dmg or .tar.xz> --target <target> --commit <version commit>
#          --build-id <BuildID> --mcp-root <frx-director-mcp checkout, built> --out <report dir>
#          [--sidebar-bundle <built agent-sidebar.bundle.js>] [--skip-appdata] [--keep-stage] [--timeout <s per check>]
#   target: macos-arm64 | macos-x86_64 | linux-x86_64 | linux-arm64 (macos-x86_64 runs under Rosetta on Apple silicon)
#
# Run it from a clean checkout of the version commit with the sidebar bundle built (npm ci && npm run build in
# additions/browser/components/agent-sidebar); the checks and the package identity are bound to that commit. The
# release tag comes from the package name (firefox-reverse-<tag>-<target>.<ext>). The macOS app-data step compiles a
# small test dylib: when the Command Line Tools' default SDK does not match the linker, export CC/CXX with -isysroot.
set -uo pipefail

usage() { sed -n '9,13p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
PACKAGE= TARGET= COMMIT= BUILD_ID= MCP_ROOT= OUT= BUNDLE= SKIP_APPDATA=0 KEEP_STAGE=0 TIMEOUT=900
while [ $# -gt 0 ]; do
  case $1 in
    --package) PACKAGE=$2; shift 2 ;;
    --target) TARGET=$2; shift 2 ;;
    --commit) COMMIT=$2; shift 2 ;;
    --build-id) BUILD_ID=$2; shift 2 ;;
    --mcp-root) MCP_ROOT=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    --sidebar-bundle) BUNDLE=$2; shift 2 ;;
    --skip-appdata) SKIP_APPDATA=1; shift ;;
    --keep-stage) KEEP_STAGE=1; shift ;;
    --timeout) TIMEOUT=$2; shift 2 ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done
[ -n "$PACKAGE" ] && [ -n "$TARGET" ] && [ -n "$COMMIT" ] && [ -n "$BUILD_ID" ] && [ -n "$MCP_ROOT" ] && [ -n "$OUT" ] || usage
die() { echo "release-accept: $*" >&2; exit 1; }

REPO=$(cd "$(dirname "$0")/.." && pwd)
case $TARGET in
  macos-arm64|macos-x86_64) EXT=dmg; [ "$(uname -s)" = Darwin ] || die "$TARGET runs on macOS" ;;
  linux-x86_64) EXT=tar.xz; [ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || die "$TARGET runs on x86_64 Linux" ;;
  linux-arm64) EXT=tar.xz; [ "$(uname -s)" = Linux ] && [ "$(uname -m)" = aarch64 ] || die "$TARGET runs on arm64 Linux" ;;
  *) die "unknown target: $TARGET" ;;
esac
[ -f "$PACKAGE" ] || die "package not found: $PACKAGE"
NAME=$(basename "$PACKAGE")
TAG=${NAME#firefox-reverse-}
TAG=${TAG%-"$TARGET.$EXT"}
[ "firefox-reverse-$TAG-$TARGET.$EXT" = "$NAME" ] && [ -n "$TAG" ] || die "package name must be firefox-reverse-<tag>-$TARGET.$EXT: $NAME"
[ -f "$MCP_ROOT/dist/bridge/marionetteWire.js" ] || die "frx-director-mcp is not built: $MCP_ROOT/dist/bridge/marionetteWire.js"
BUNDLE=${BUNDLE:-$REPO/additions/browser/components/agent-sidebar/content/agent-sidebar.bundle.js}
[ -f "$BUNDLE" ] || die "sidebar bundle not built: $BUNDLE (npm ci && npm run build in additions/browser/components/agent-sidebar)"
git -C "$REPO" cat-file -e "$COMMIT^{commit}" 2>/dev/null || die "commit $COMMIT is not in this checkout"
command -v node >/dev/null && command -v python3 >/dev/null || die "node and python3 are required"
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

mkdir -p "$OUT" || die "cannot create $OUT"
OUT=$(cd "$OUT" && pwd)
# Only what this script writes, so an existing report directory can be reused.
rm -rf "$OUT/global-system-prompt"
for file in acceptance.json PACKAGE-IDENTITY.json PAGE-REPORT.json ENVIRONMENT-LIFECYCLE.json FINGERPRINT-REPORT.json MACOS-APPDATA.json \
            prepare.log page-interaction.log lifecycle.log fingerprint.log global-prompt.log macos-appdata.log codesign.log page-fixture.png github-env; do
  rm -f "$OUT/$file"
done
ISO=$(mktemp -d "${TMPDIR:-/tmp}/frx-accept.XXXXXX") || die "mktemp failed"
trap 'rm -rf "$ISO"' EXIT
mkdir -p "$ISO/home" "$ISO/appdata" "$ISO/localdata" "$ISO/tmp" "$ISO/wrapper"
cd "$REPO" || die "cannot enter $REPO"

echo "=== package identity ($NAME)"
SHA=$(sha256 "$PACKAGE")
mkdir -p candidate
rm -rf candidate-stage
[ "$(cd "$(dirname "$PACKAGE")" && pwd)/$NAME" = "$REPO/candidate/$NAME" ] || cp "$PACKAGE" "candidate/$NAME"
if RELEASE_TAG=$TAG PACKAGE_TARGET=$TARGET SOURCE_COMMIT=$COMMIT EXPECTED_BUILD_ID=$BUILD_ID \
   PACKAGE_CHECKSUMS="{\"$NAME\":\"$SHA\"}" GITHUB_ENV="$OUT/github-env" EXPECTED_SIDEBAR_BUNDLE="$BUNDLE" \
   python3 scripts/prepare-native-candidate.py > "$OUT/prepare.log" 2>&1; then
  echo "PASS package identity"
  IDENTITY=passed
else
  echo "FAIL package identity"; tail -20 "$OUT/prepare.log"
  IDENTITY=failed
fi
[ -f native-report/PACKAGE-IDENTITY.json ] && mv native-report/PACKAGE-IDENTITY.json "$OUT/PACKAGE-IDENTITY.json"
rmdir native-report 2>/dev/null
FRX_TEST_BINARY= FRX_TEST_XUL_SHA= FRX_TEST_BUNDLE_SHA=
if [ "$IDENTITY" = passed ]; then
  # GITHUB_ENV lines are KEY=VALUE, not shell syntax: the macOS app path contains a space.
  while IFS='=' read -r key value; do
    case $key in FRX_TEST_BINARY|FRX_TEST_XUL_SHA|FRX_TEST_BUNDLE_SHA) printf -v "$key" '%s' "$value" ;; esac
  done < "$OUT/github-env"
fi

if [ "${TARGET%%-*}" = macos ]; then
  APP=$FRX_TEST_BINARY
  XUL="$APP/Contents/MacOS/XUL"
  # The fingerprint check wants a directory with firefox and libxul.so; a symlink to the executable itself
  # fails with "Couldn't load XPCOM", so the wrapper execs it.
  printf '#!/bin/sh\nexec "%s/Contents/MacOS/firefox" "$@"\n' "$APP" > "$ISO/wrapper/firefox"
  chmod +x "$ISO/wrapper/firefox"
  ln -sf "$XUL" "$ISO/wrapper/libxul.so"
  FINGERPRINT_FIREFOX="$ISO/wrapper/firefox"
  PROCESS_PATTERN="$APP/Contents/MacOS/firefox"
  run_limited() { local seconds=$1; shift; perl -e 'alarm shift; exec @ARGV or die "exec failed: $!\n"' "$seconds" "$@"; }
  ISOLATED=(env -u MOZ_DISABLE_CONTENT_SANDBOX HOME="$ISO/home" MOZ_APP_DATA="$ISO/appdata" MOZ_LOCAL_APP_DATA="$ISO/localdata"
    TMPDIR="$ISO/tmp/" MOZ_HEADLESS=1)
else
  XUL="$(dirname "$FRX_TEST_BINARY")/libxul.so"
  FINGERPRINT_FIREFOX=$FRX_TEST_BINARY
  PROCESS_PATTERN=$FRX_TEST_BINARY
  run_limited() { local seconds=$1; shift; timeout "$seconds" "$@"; }
  ISOLATED=(env -u MOZ_DISABLE_CONTENT_SANDBOX HOME="$ISO/home" TMPDIR="$ISO/tmp/" MOZ_HEADLESS=1)
fi

STEPS=()
# step <name> <report that must exist afterwards> <command...>: a missing report fails the step even on exit 0.
step() {
  local name=$1 report=$2 code
  shift 2
  echo "=== $name"
  run_limited "$TIMEOUT" "$@" > "$OUT/$name.log" 2>&1
  code=$?
  if [ $code -eq 0 ] && [ -s "$report" ]; then
    echo "PASS $name"; STEPS+=("$name=passed")
  else
    echo "FAIL $name (exit $code, report $( [ -s "$report" ] && echo present || echo missing ))"; tail -20 "$OUT/$name.log"
    STEPS+=("$name=failed")
  fi
}
if [ "$IDENTITY" = passed ]; then
  step page-interaction "$OUT/PAGE-REPORT.json" "${ISOLATED[@]}" node scripts/verify-page-interaction.mjs --firefox "$FRX_TEST_BINARY" \
    --xul-sha256 "$FRX_TEST_XUL_SHA" --mcp-root "$MCP_ROOT" --output "$OUT/PAGE-REPORT.json" --screenshot "$OUT/page-fixture.png"
  step lifecycle "$OUT/ENVIRONMENT-LIFECYCLE.json" "${ISOLATED[@]}" node scripts/verify-environment-lifecycle.mjs --firefox "$FRX_TEST_BINARY" \
    --xul-sha256 "$FRX_TEST_XUL_SHA" --mcp-root "$MCP_ROOT" --output "$OUT/ENVIRONMENT-LIFECYCLE.json"
  step fingerprint "$OUT/FINGERPRINT-REPORT.json" "${ISOLATED[@]}" node scripts/verify-native-fingerprint.mjs --firefox "$FINGERPRINT_FIREFOX" \
    --xul-sha256 "$FRX_TEST_XUL_SHA" --mcp-root "$MCP_ROOT" --allow-unavailable-webgl --context-type tab --report-output "$OUT/FINGERPRINT-REPORT.json"
  step global-prompt "$OUT/global-system-prompt/report.json" "${ISOLATED[@]}" python3 scripts/verify-global-system-prompt.py --app "$FRX_TEST_BINARY" \
    --source-commit "$COMMIT" --build-id "$BUILD_ID" --bundle-sha256 "$FRX_TEST_BUNDLE_SHA" --output "$OUT/global-system-prompt"
  if [ "${TARGET%%-*}" = macos ] && [ $SKIP_APPDATA -eq 0 ]; then
    # The app-data scenarios choose the data directory themselves, so MOZ_APP_DATA must not be set. Their test dylib
    # is injected into the app, so it is built for the app's architecture (x86_64 under Rosetta on Apple silicon).
    ARCH=$([ "$TARGET" = macos-x86_64 ] && echo x86_64 || echo arm64)
    step macos-appdata "$OUT/MACOS-APPDATA.json" env -u MOZ_APP_DATA -u MOZ_LOCAL_APP_DATA -u MOZ_DISABLE_CONTENT_SANDBOX \
      CC="${CC:-cc} -arch $ARCH" CXX="${CXX:-c++} -arch $ARCH" \
      python3 scripts/verify-macos-appdata.py --app "$FRX_TEST_BINARY" --xul-sha256 "$FRX_TEST_XUL_SHA" --output "$OUT/MACOS-APPDATA.json"
  fi

  echo "=== package after the run"
  SIGNATURE=not-applicable
  if [ "${TARGET%%-*}" = macos ]; then
    codesign --verify --deep --strict "$FRX_TEST_BINARY" > "$OUT/codesign.log" 2>&1 && SIGNATURE=passed || SIGNATURE=failed
  fi
  [ "$(sha256 "$XUL")" = "$FRX_TEST_XUL_SHA" ] && XUL_UNCHANGED=true || XUL_UNCHANGED=false
  sleep 2
  LEFTOVER=$(pgrep -f "$PROCESS_PATTERN" | wc -l | tr -d ' ')
  echo "signature $SIGNATURE, XUL unchanged $XUL_UNCHANGED, leftover browser processes $LEFTOVER"
else
  SIGNATURE=skipped XUL_UNCHANGED=false LEFTOVER=0
fi

STEP_ARGS=(--step "package-identity=$IDENTITY")
for item in ${STEPS[@]+"${STEPS[@]}"}; do STEP_ARGS+=(--step "$item"); done  # bash 3.2 treats an empty array as unset
CODESIGN_ARGS=()
case $SIGNATURE in passed|failed) CODESIGN_ARGS=(--codesign "$SIGNATURE") ;; esac
python3 scripts/release-reports.py acceptance --dir "$OUT" --target "$TARGET" --package "$NAME" --sha256 "$SHA" \
  --commit "$COMMIT" --build-id "$BUILD_ID" "${STEP_ARGS[@]}" ${CODESIGN_ARGS[@]+"${CODESIGN_ARGS[@]}"} \
  --xul-unchanged "$XUL_UNCHANGED" --leftover "$LEFTOVER"
STATUS=$?
if [ $KEEP_STAGE -eq 0 ]; then
  rm -rf candidate-stage
  [ "$(cd "$(dirname "$PACKAGE")" && pwd)/$NAME" = "$REPO/candidate/$NAME" ] || rm -f "candidate/$NAME"
  rmdir candidate 2>/dev/null
fi
exit $STATUS

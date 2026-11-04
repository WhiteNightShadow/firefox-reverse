#!/usr/bin/env bash
# Windows acceptance of the final ZIP on a Windows machine reachable over ssh (docs/release-process.md step 6): packs
# this checkout at the version commit (a shallow .git plus the built sidebar bundle), pushes it with the ZIP, the
# built frx-director-mcp and optional portable Python/Git, runs scripts/release-accept-windows.ps1 in the logged-on
# desktop session through a scheduled task (Firefox started from the ssh session has no window station), waits, copies
# the reports back to --out and writes <out>/acceptance.json.
#
# usage: scripts/release-accept-windows-vm.sh --ssh <user@host> [--port <port>] --zip <final windows ZIP>
#          --commit <version commit> --build-id <BuildID> --mcp-root <frx-director-mcp checkout, built> --out <report dir>
#          [--sidebar-bundle <built agent-sidebar.bundle.js>] [--python-zip <embeddable Python 3.11+ zip>]
#          [--git-zip <MinGit zip>] [--node-dir <Node.js directory on the machine>] [--root <work dir, default C:\frx>]
#          [--timeout-min <minutes, default 60>] [--wait-min <minutes to wait for ssh and the desktop>]
#          [--ssh-option <ssh -o option, repeatable>] [--keep]
#
# The machine needs OpenSSH with public-key login and a desktop session logged on as the ssh user; Node.js comes from
# PATH or --node-dir, Python and Git from the zips or PATH. An emulated x64 Windows (QEMU TCG) needs --timeout-min 240.
# Without --keep the work directory and the scheduled task are removed afterwards, together with the empty
# remote-settings-startup-bundle-* files and the empty mozilla-temp-files directory the browser leaves in %TEMP%.
set -uo pipefail

usage() { sed -n '8,13p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
SSH_TARGET= PORT=22 ZIP= COMMIT= BUILD_ID= MCP_ROOT= OUT= BUNDLE= PYTHON_ZIP= GIT_ZIP= NODE_DIR= ROOT='C:\frx' TIMEOUT_MIN=60 WAIT_MIN=0 KEEP=0
SSH_OPTIONS=()
while [ $# -gt 0 ]; do
  case $1 in
    --ssh) SSH_TARGET=$2; shift 2 ;;
    --port) PORT=$2; shift 2 ;;
    --zip) ZIP=$2; shift 2 ;;
    --commit) COMMIT=$2; shift 2 ;;
    --build-id) BUILD_ID=$2; shift 2 ;;
    --mcp-root) MCP_ROOT=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    --sidebar-bundle) BUNDLE=$2; shift 2 ;;
    --python-zip) PYTHON_ZIP=$2; shift 2 ;;
    --git-zip) GIT_ZIP=$2; shift 2 ;;
    --node-dir) NODE_DIR=$2; shift 2 ;;
    --root) ROOT=$2; shift 2 ;;
    --timeout-min) TIMEOUT_MIN=$2; shift 2 ;;
    --wait-min) WAIT_MIN=$2; shift 2 ;;
    --ssh-option) SSH_OPTIONS+=(-o "$2"); shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done
[ -n "$SSH_TARGET" ] && [ -n "$ZIP" ] && [ -n "$COMMIT" ] && [ -n "$BUILD_ID" ] && [ -n "$MCP_ROOT" ] && [ -n "$OUT" ] || usage
die() { echo "release-accept-windows-vm: $*" >&2; exit 1; }

REPO=$(cd "$(dirname "$0")/.." && pwd)
[ -f "$ZIP" ] || die "ZIP not found: $ZIP"
NAME=$(basename "$ZIP")
TAG=${NAME#firefox-reverse-}
TAG=${TAG%-windows-x86_64.zip}
[ "firefox-reverse-$TAG-windows-x86_64.zip" = "$NAME" ] && [ -n "$TAG" ] || die "ZIP name must be firefox-reverse-<tag>-windows-x86_64.zip: $NAME"
[ -f "$MCP_ROOT/dist/bridge/marionetteWire.js" ] && [ -f "$MCP_ROOT/package.json" ] || die "frx-director-mcp is not built: $MCP_ROOT"
BUNDLE=${BUNDLE:-$REPO/additions/browser/components/agent-sidebar/content/agent-sidebar.bundle.js}
[ -f "$BUNDLE" ] || die "sidebar bundle not built: $BUNDLE"
git -C "$REPO" cat-file -e "$COMMIT^{commit}" 2>/dev/null || die "commit $COMMIT is not in this checkout"
for zip in "$PYTHON_ZIP" "$GIT_ZIP"; do [ -z "$zip" ] || [ -f "$zip" ] || die "not found: $zip"; done
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
SHA=$(sha256 "$ZIP")
mkdir -p "$OUT" || die "cannot create $OUT"
OUT=$(cd "$OUT" && pwd)

OPTS=(-o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=30 ${SSH_OPTIONS[@]+"${SSH_OPTIONS[@]}"})
# Remote PowerShell through -EncodedCommand (UTF-16LE base64): no quoting trouble, whatever the ssh default shell is.
# Progress records are switched off: over ssh they arrive as CLIXML on stderr and bury the real output.
remote() {
  local encoded
  encoded=$(printf '%s' "\$ProgressPreference = 'SilentlyContinue'
$1" | iconv -t UTF-16LE | base64 | tr -d '\n')
  ssh "${OPTS[@]}" -p "$PORT" "$SSH_TARGET" "powershell -NoProfile -NonInteractive -EncodedCommand $encoded"
}
SCP_ROOT=$(printf '%s' "$ROOT" | tr '\\' '/')
copy_to() { scp "${OPTS[@]}" -P "$PORT" -q "$@"; }
psq() { printf "'%s'" "${1//\'/\'\'}"; }  # a PowerShell single-quoted string literal

WORK=$(mktemp -d "${TMPDIR:-/tmp}/frx-win-accept.XXXXXX") || die "mktemp failed"
trap 'rm -rf "$WORK"' EXIT
echo "=== payload"
git init -q "$WORK/repo" && git -C "$WORK/repo" fetch -q --depth 1 "file://$REPO" "$COMMIT" && git -C "$WORK/repo" checkout -q FETCH_HEAD \
  || die "cannot check out $COMMIT from $REPO"
cp "$BUNDLE" "$WORK/repo/additions/browser/components/agent-sidebar/content/agent-sidebar.bundle.js"
# COPYFILE_DISABLE: macOS tar would add ._* AppleDouble files for extended attributes, which git then trips over.
COPYFILE_DISABLE=1 tar -cf "$WORK/repo.tar" -C "$WORK" repo
mkdir -p "$WORK/mcp" && cp -R "$MCP_ROOT/dist" "$MCP_ROOT/package.json" "$WORK/mcp/"
echo "repo $(git -C "$WORK/repo" rev-parse --short HEAD), $(du -h "$WORK/repo.tar" | cut -f1); package $NAME $SHA"

echo "=== machine"
WAIT_START=$(date +%s)
until remote "if (@(Get-Process explorer -ErrorAction SilentlyContinue).Count) { 'ready' }" 2>/dev/null | grep -q ready; do
  [ $(( $(date +%s) - WAIT_START )) -lt $(( WAIT_MIN * 60 )) ] || break
  sleep 20
done
remote "\$o = Get-CimInstance Win32_OperatingSystem; \$o.Caption + ' ' + \$o.Version + ' ' + \$o.OSArchitecture
if (-not @(Get-Process explorer -ErrorAction SilentlyContinue).Count) { Write-Error 'no logged-on desktop session'; exit 3 }
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $(psq "$ROOT")
New-Item -ItemType Directory -Force -Path $(psq "$ROOT") | Out-Null" || die "machine not ready (ssh, desktop session)"

echo "=== push"
UPLOADS=("$WORK/repo.tar" "$REPO/scripts/release-accept-windows.ps1")
[ -n "$PYTHON_ZIP" ] && UPLOADS+=("$PYTHON_ZIP")
[ -n "$GIT_ZIP" ] && UPLOADS+=("$GIT_ZIP")
copy_to "${UPLOADS[@]}" "$SSH_TARGET:$SCP_ROOT/" || die "upload failed"
copy_to -r "$WORK/mcp" "$SSH_TARGET:$SCP_ROOT/mcp" || die "upload of frx-director-mcp failed"
UNPACK="Set-Location $(psq "$ROOT"); tar -xf repo.tar; Remove-Item repo.tar
New-Item -ItemType Directory -Force -Path repo\\candidate | Out-Null"
[ -n "$PYTHON_ZIP" ] && UNPACK+="
Expand-Archive -Force $(psq "$(basename "$PYTHON_ZIP")") python; Remove-Item $(psq "$(basename "$PYTHON_ZIP")")"
[ -n "$GIT_ZIP" ] && UNPACK+="
Expand-Archive -Force $(psq "$(basename "$GIT_ZIP")") git; Remove-Item $(psq "$(basename "$GIT_ZIP")")"
remote "$UNPACK" || die "unpacking on the machine failed"
copy_to "$ZIP" "$SSH_TARGET:$SCP_ROOT/repo/candidate/" || die "upload of the ZIP failed"

echo "=== run (desktop session, scheduled task FrxReleaseAccept)"
ARGS="-NoProfile -ExecutionPolicy Bypass -File \"$ROOT\\release-accept-windows.ps1\" -Root \"$ROOT\" -Tag $TAG -Commit $COMMIT -BuildId $BUILD_ID -PackageSha $SHA"
[ -n "$NODE_DIR" ] && ARGS+=" -NodeDir \"$NODE_DIR\""
remote "Unregister-ScheduledTask -TaskName FrxReleaseAccept -Confirm:\$false -ErrorAction SilentlyContinue
\$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $(psq "$ARGS") -WorkingDirectory $(psq "$ROOT")
\$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
\$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes $((TIMEOUT_MIN + 30))) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName FrxReleaseAccept -Action \$action -Principal \$principal -Settings \$settings -Force | Out-Null
Start-ScheduledTask -TaskName FrxReleaseAccept" || die "cannot start the scheduled task"
START=$(date +%s)
while :; do
  if remote "if (Select-String -Path $(psq "$ROOT\\out\\run.log") -Pattern '\] DONE$' -Quiet -ErrorAction SilentlyContinue) { 'yes' }" 2>/dev/null | grep -q yes; then
    break
  fi
  if [ $(( $(date +%s) - START )) -gt $(( TIMEOUT_MIN * 60 )) ]; then echo "timed out after $TIMEOUT_MIN min"; break; fi
  sleep 30
done
echo "elapsed $(( ( $(date +%s) - START ) / 60 )) min"

echo "=== reports"
rm -rf "$OUT/windows-native-report" "$OUT/global-system-prompt"
scp "${OPTS[@]}" -P "$PORT" -q -r "$SSH_TARGET:$SCP_ROOT/out/*" "$OUT/" || echo "copying the reports failed"
grep -E '\] (host:|tools:|PASS|FAIL|  \||xul unchanged|leftover|DONE)' "$OUT/run.log" 2>/dev/null | cut -c1-240

if [ $KEEP -eq 0 ]; then
  remote "Unregister-ScheduledTask -TaskName FrxReleaseAccept -Confirm:\$false -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $(psq "$ROOT")
Get-ChildItem \$env:TEMP -Filter 'remote-settings-startup-bundle-*' -File -ErrorAction SilentlyContinue | Where-Object { \$_.Length -eq 0 } | Remove-Item -Force -ErrorAction SilentlyContinue
\$d = Join-Path \$env:TEMP 'mozilla-temp-files'
if ((Test-Path \$d) -and -not (Get-Process firefox -ErrorAction SilentlyContinue) -and -not (Get-ChildItem \$d -Force -ErrorAction SilentlyContinue)) { Remove-Item -Force \$d }" \
    || echo "cleanup on the machine failed; remove $ROOT and the FrxReleaseAccept task by hand"
fi

STEP_ARGS=()
while read -r state name; do
  STEP_ARGS+=(--step "$name=$( [ "$state" = PASS ] && echo passed || echo failed )")
done < <(sed -nE 's/^\[[0-9:]+\] (PASS|FAIL) ([a-z-]+).*/\1 \2/p' "$OUT/run.log" 2>/dev/null)
HOST=$(sed -nE 's/^\[[0-9:]+\] host: (.*)$/\1/p' "$OUT/run.log" 2>/dev/null | head -1 | tr -d '\r')
XUL=$(sed -nE 's/^\[[0-9:]+\] xul unchanged: (True|False).*/\1/p' "$OUT/run.log" 2>/dev/null | head -1)
LEFTOVER=$(sed -nE 's/^\[[0-9:]+\] leftover firefox: ([0-9]+).*/\1/p' "$OUT/run.log" 2>/dev/null | head -1)
python3 "$REPO/scripts/release-reports.py" acceptance --dir "$OUT" --target windows-x86_64 --package "$NAME" --sha256 "$SHA" \
  --commit "$COMMIT" --build-id "$BUILD_ID" ${STEP_ARGS[@]+"${STEP_ARGS[@]}"} \
  --xul-unchanged "$( [ "$XUL" = True ] && echo true || echo false )" --leftover "${LEFTOVER:-1}" ${HOST:+--host "$HOST"}

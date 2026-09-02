#!/usr/bin/env bash
# Force Gecko's generated build metadata and runtime library to relink.
# Deleting only <objdir>/buildid.h can leave gToolkitBuildID stale in XUL, while
# keeping source-repo.h can leave SourceStamp pinned to an older release.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <objdir>" >&2
  exit 2
fi

objdir="$(cd "$1" && pwd)"
if [[ ! -f "$objdir/config.status" || ! -d "$objdir/toolkit/library" ]]; then
  echo "[force-build-id] not a configured Firefox object directory: $objdir" >&2
  exit 1
fi

rm -f \
  "$objdir/buildid.h" \
  "$objdir/source-repo.h" \
  "$objdir/.deps/source-repo.h.stub" \
  "$objdir/.deps/source-repo.h.pp" \
  "$objdir/toolkit/library/buildid.cpp" \
  "$objdir/toolkit/library/buildid.o" \
  "$objdir/toolkit/library/.deps/buildid.cpp.stub" \
  "$objdir/toolkit/library/.deps/buildid.cpp.pp" \
  "$objdir/toolkit/library/.deps/buildid.o.pp"

for dir in "$objdir/toolkit/library/build" "$objdir/dist/bin"; do
  [[ -d "$dir" ]] || continue
  find "$dir" -maxdepth 1 -type f \
    \( -name XUL -o -name libxul.so -o -name xul.dll \) -delete
done

echo "[force-build-id] cleared generated build metadata and runtime library inputs: $objdir"
echo "[force-build-id] rebuild with explicit MOZ_BUILD_DATE/MOZ_SOURCE_CHANGESET, then verify application.ini and runtime parentBuildID."

#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
upstream=${UPSTREAM_DIR:-"$repo_root/upstream"}
locale=${FRX_UI_LOCALE:-zh-CN}

if [[ ! "$locale" =~ ^[A-Za-z]{2,3}(-[A-Za-z0-9]+)*$ ]]; then
  echo "invalid Firefox locale: $locale" >&2
  exit 2
fi
if [[ ! -x "$upstream/mach" ]]; then
  echo "Firefox source tree not found at $upstream" >&2
  exit 1
fi

cd "$upstream"
# Keep an already checked-out l10n repository pinned by default. Set
# FRX_L10N_UPDATE=1 explicitly when a release should pull newer translations.
if [[ ${FRX_L10N_UPDATE:-0} != 1 ]]; then
  export MOZ_AUTOMATION=1
fi
export MOZ_SOURCE_REPO=${MOZ_SOURCE_REPO:-https://github.com/WhiteNightShadow/firefox-reverse}
export MOZ_SOURCE_CHANGESET=${MOZ_SOURCE_CHANGESET:-$(git -C "$repo_root" rev-parse HEAD)}
export MOZ_BUILD_DATE=${MOZ_BUILD_DATE:-$(date -u +%Y%m%d%H%M%S)}
export MH_BRANCH=${MH_BRANCH:-firefox-reverse}
# The custom branding intentionally reuses one logo bitmap in several Firefox
# branding slots. Multi-locale packaging enables automation's byte-for-byte
# duplicate scan, which rejects those known brand aliases. Keep all normal
# packager errors fatal while disabling only that optional duplicate report.
export RUN_FIND_DUPES=
export RUN_MOZHARNESS_ZIP=

objdir=$(./mach environment --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["topobjdir"])')

# package-multi-locale builds locale resources into the current object tree and
# packages the locally compiled binaries. Unlike installers-<locale>, it never
# substitutes a Mozilla Taskcluster browser artifact for Firefox Reverse.
./mach package-multi-locale --locales "$locale"
"$repo_root/scripts/verify-zh-cn-stage.sh" "$objdir/dist/firefox" "$locale"

echo "localized packages:"
find "$objdir/dist" -maxdepth 2 -type f \
  \( -name 'firefox-*.dmg' -o -name 'firefox-*.tar.*' -o -name 'firefox-*.zip' -o -name 'firefox-*.exe' \) \
  -print | sort

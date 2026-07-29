#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "usage: $0 <dist/l10n-stage> [locale]" >&2
  exit 2
fi

stage=$1
locale=${2:-zh-CN}
test -d "$stage"

browser_omni=$(find "$stage" -type f -path '*/browser/omni.ja' -print -quit)
core_omni=$(find "$stage" -type f -name omni.ja ! -path '*/browser/omni.ja' -print -quit)
greprefs=$(find "$stage" -type f -name greprefs.js -print -quit)
test -n "$browser_omni" || { echo "browser omni.ja not found in $stage" >&2; exit 1; }
test -n "$core_omni" || { echo "core omni.ja not found in $stage" >&2; exit 1; }

context_path="localization/$locale/browser/browserContext.ftl"
if ! unzip -l "$browser_omni" | grep -F "$context_path" >/dev/null; then
  echo "missing $context_path in browser omni.ja" >&2
  exit 1
fi
if ! unzip -p "$browser_omni" "$context_path" | grep -F 'main-context-menu-back' >/dev/null; then
  echo "missing main-context-menu-back in $context_path" >&2
  exit 1
fi
if ! unzip -p "$browser_omni" "$context_path" | grep -F '右击或下拉显示历史' >/dev/null; then
  echo "missing expected Simplified Chinese context-menu text in $context_path" >&2
  exit 1
fi
if ! unzip -l "$core_omni" | grep -F "localization/$locale/toolkit/global/" >/dev/null; then
  echo "missing $locale toolkit localization in core omni.ja" >&2
  exit 1
fi
if [[ -n "$greprefs" ]]; then
  if ! grep -F 'pref("intl.locale.requested", "zh-CN")' "$greprefs" >/dev/null; then
    echo "missing zh-CN locale preference in $greprefs" >&2
    exit 1
  fi
else
  if unzip -p "$core_omni" defaults/pref/frx-locale.js 2>/dev/null \
      | grep -F 'pref("intl.locale.requested", "zh-CN")' >/dev/null; then
    :
  elif unzip -p "$core_omni" greprefs.js \
      | grep -F 'pref("intl.locale.requested", "zh-CN")' >/dev/null; then
    :
  else
    echo "missing zh-CN locale preference in core omni.ja" >&2
    exit 1
  fi
fi

echo "verified localized Firefox stage: $locale"

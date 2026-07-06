#!/usr/bin/env python3
"""
Apply Firefox-Reverse environment fingerprint config patches to firefox upstream.
Idempotent: re-running is safe.

Usage: python3 apply-fingerprint-config.py <firefox-src-root>
"""

import os
import sys

if len(sys.argv) != 2:
    print("Usage: apply-fingerprint-config.py <firefox-src-root>", file=sys.stderr)
    sys.exit(1)

ROOT = sys.argv[1]


def patch_file(path, transformations):
    content = open(path, encoding="utf-8").read()
    changed = False
    for desc, old, new in transformations:
        if desc == "export FRX fingerprint header":
            if '"FrxFingerprintConfig.h"' in content:
                print(f"  [skip] {desc} (already applied)")
                continue
        if desc == "export NavigatorUAData header":
            if '"NavigatorUAData.h"' in content:
                print(f"  [skip] {desc} (already applied)")
                continue
        if new in content:
            print(f"  [skip] {desc} (already applied)")
            continue
        if old not in content:
            if desc == "override User-Agent request header":
                print(f"  [skip] {desc} (source already changed)")
                continue
            if desc == "add frx fingerprint config static pref group":
                print(f"  [skip] {desc} (source already has frx pref group)")
                continue
            print(f"  [FAIL] {desc}: old pattern not found", file=sys.stderr)
            sys.exit(1)
        content = content.replace(old, new, 1)
        changed = True
        print(f"  [done] {desc}")
    if changed:
        open(path, "w", encoding="utf-8").write(content)


print("==> modules/libpref/moz.build")
patch_file(
    os.path.join(ROOT, "modules/libpref/moz.build"),
    [
        (
            "register frx static pref group",
            '    "font",\n    "full_screen_api",\n',
            '    "font",\n    "frx",\n    "full_screen_api",\n',
        ),
    ],
)


print("==> modules/libpref/init/StaticPrefList.yaml")
patch_file(
    os.path.join(ROOT, "modules/libpref/init/StaticPrefList.yaml"),
    [
        (
            "add frx fingerprint config static pref group",
            '#---------------------------------------------------------------------------\n'
            '# Prefs starting with "full-screen-api."\n'
            '#---------------------------------------------------------------------------\n',
            '#---------------------------------------------------------------------------\n'
            '# Prefs starting with "frx."\n'
            '#---------------------------------------------------------------------------\n'
            "\n"
            "- name: frx.fingerprint.config.path\n"
            "  type: DataMutexString\n"
            '  value: ""\n'
            "  mirror: always\n"
            "\n"
            "- name: frx.fingerprint.config.json\n"
            "  type: DataMutexString\n"
            '  value: ""\n'
            "  mirror: always\n"
            "\n"
            '#---------------------------------------------------------------------------\n'
            '# Prefs starting with "full-screen-api."\n'
            '#---------------------------------------------------------------------------\n',
        ),
        (
            "add frx fingerprint inline JSON static pref",
            "- name: frx.fingerprint.config.path\n"
            "  type: DataMutexString\n"
            '  value: ""\n'
            "  mirror: always\n"
            "\n",
            "- name: frx.fingerprint.config.path\n"
            "  type: DataMutexString\n"
            '  value: ""\n'
            "  mirror: always\n"
            "\n"
            "- name: frx.fingerprint.config.json\n"
            "  type: DataMutexString\n"
            '  value: ""\n'
            "  mirror: always\n"
            "\n",
        ),
    ],
)


print("==> dom/base/moz.build")
patch_file(
    os.path.join(ROOT, "dom/base/moz.build"),
    [
        (
            "export FRX fingerprint header",
            '    "FromParser.h",\n',
            '    "FromParser.h",\n    "FrxFingerprintConfig.h",\n',
        ),
        (
            "export NavigatorUAData header",
            '    "Navigator.h",\n',
            '    "Navigator.h",\n    "NavigatorUAData.h",\n',
        ),
        (
            "add FRX fingerprint sources",
            "# these files couldn't be in UNIFIED_SOURCES for now for reasons given below:\n",
            'SOURCES += [\n    "FrxFingerprintConfig.cpp",\n    "NavigatorUAData.cpp",\n]\n\n'
            "# these files couldn't be in UNIFIED_SOURCES for now for reasons given below:\n",
        ),
        (
            "add jsoncpp include to dom/base",
            '    "/third_party/xsimd/include",\n',
            '    "/third_party/xsimd/include",\n    "/toolkit/components/jsoncpp/include",\n',
        ),
        (
            "add xpcom string include to dom/base",
            '    "/xpcom/ds",\n',
            '    "/xpcom/ds",\n    "/xpcom/string",\n',
        ),
        (
            "link jsoncpp from dom/base",
            'if CONFIG["MOZ_WEBRTC"]:\n',
            'USE_LIBS += [\n    "jsoncpp",\n]\n\nif CONFIG["MOZ_WEBRTC"]:\n',
        ),
    ],
)


print("==> dom/webidl/moz.build")
patch_file(
    os.path.join(ROOT, "dom/webidl/moz.build"),
    [
        (
            "register NavigatorUAData.webidl",
            '    "Navigator.webidl",\n',
            '    "Navigator.webidl",\n    "NavigatorUAData.webidl",\n',
        ),
    ],
)


print("==> dom/webidl/Navigator.webidl")
patch_file(
    os.path.join(ROOT, "dom/webidl/Navigator.webidl"),
    [
        (
            "expose navigator.userAgentData",
            "  readonly attribute boolean pdfViewerEnabled;\n};\n",
            "  readonly attribute boolean pdfViewerEnabled;\n"
            '  [Func="NavigatorUAData::IsEnabled", SameObject]\n'
            "  readonly attribute NavigatorUAData userAgentData;\n"
            "};\n",
        ),
    ],
)


print("==> dom/webidl/WorkerNavigator.webidl")
patch_file(
    os.path.join(ROOT, "dom/webidl/WorkerNavigator.webidl"),
    [
        (
            "expose worker navigator.userAgentData",
            "[Exposed=Worker]\n"
            "interface WorkerNavigator {\n"
            "};\n\n"
            "WorkerNavigator includes NavigatorID;\n",
            "[Exposed=Worker]\n"
            "interface WorkerNavigator {\n"
            "};\n\n"
            "[Exposed=Worker]\n"
            "partial interface WorkerNavigator {\n"
            '  [Func="NavigatorUAData::IsEnabled", SameObject]\n'
            "  readonly attribute NavigatorUAData userAgentData;\n"
            "};\n\n"
            "WorkerNavigator includes NavigatorID;\n",
        ),
    ],
)


print("==> dom/base/Navigator.cpp")
patch_file(
    os.path.join(ROOT, "dom/base/Navigator.cpp"),
    [
        (
            "include FrxFingerprintConfig.h in Navigator.cpp",
            '#include "mozilla/dom/WindowGlobalChild.h"\n',
            '#include "mozilla/dom/WindowGlobalChild.h"\n#include "mozilla/dom/FrxFingerprintConfig.h"\n',
        ),
        (
            "include NavigatorUAData.h in Navigator.cpp",
            '#include "mozilla/dom/NavigatorLogin.h"\n',
            '#include "mozilla/dom/NavigatorUAData.h"\n#include "mozilla/dom/NavigatorLogin.h"\n',
        ),
        (
            "cycle collect navigator.userAgentData unlink",
            "  NS_IMPL_CYCLE_COLLECTION_UNLINK(mWindow)\n"
            "  NS_IMPL_CYCLE_COLLECTION_UNLINK(mSharePromise)\n"
            "  NS_IMPL_CYCLE_COLLECTION_UNLINK_PRESERVED_WRAPPER\n",
            "  NS_IMPL_CYCLE_COLLECTION_UNLINK(mWindow)\n"
            "  NS_IMPL_CYCLE_COLLECTION_UNLINK(mSharePromise)\n"
            "  NS_IMPL_CYCLE_COLLECTION_UNLINK(mUserAgentData)\n"
            "  NS_IMPL_CYCLE_COLLECTION_UNLINK_PRESERVED_WRAPPER\n",
        ),
        (
            "cycle collect navigator.userAgentData traverse",
            "  NS_IMPL_CYCLE_COLLECTION_TRAVERSE(mServiceWorkerContainer)\n"
            "  NS_IMPL_CYCLE_COLLECTION_TRAVERSE(mMediaCapabilities)\n",
            "  NS_IMPL_CYCLE_COLLECTION_TRAVERSE(mServiceWorkerContainer)\n"
            "  NS_IMPL_CYCLE_COLLECTION_TRAVERSE(mUserAgentData)\n"
            "  NS_IMPL_CYCLE_COLLECTION_TRAVERSE(mMediaCapabilities)\n",
        ),
        (
            "clear navigator.userAgentData on invalidate",
            "  mServiceWorkerContainer = nullptr;\n\n"
            "  if (mMediaKeySystemAccessManager) {\n",
            "  mServiceWorkerContainer = nullptr;\n"
            "  mUserAgentData = nullptr;\n\n"
            "  if (mMediaKeySystemAccessManager) {\n",
        ),
        (
            "implement navigator.userAgentData getter",
            "  if (NS_WARN_IF(NS_FAILED(rv))) {\n"
            "    aRv.Throw(rv);\n"
            "  }\n"
            "}\n\n"
            "void Navigator::GetAppCodeName",
            "  if (NS_WARN_IF(NS_FAILED(rv))) {\n"
            "    aRv.Throw(rv);\n"
            "  }\n"
            "}\n\n"
            "NavigatorUAData* Navigator::UserAgentData() {\n"
            "  if (!mUserAgentData && mWindow) {\n"
            "    mUserAgentData = MakeRefPtr<NavigatorUAData>(mWindow->AsGlobal());\n"
            "  }\n"
            "  return mUserAgentData;\n"
            "}\n\n"
            "void Navigator::GetAppCodeName",
        ),
        (
            "override navigator.language from fingerprint config",
            "void Navigator::GetLanguage(nsAString& aLanguage) {\n  nsTArray<nsString> languages;\n",
            "void Navigator::GetLanguage(nsAString& aLanguage) {\n"
            "  if (FrxFingerprintConfig::GetNavigatorLanguage(aLanguage)) {\n"
            "    return;\n"
            "  }\n\n"
            "  nsTArray<nsString> languages;\n",
        ),
        (
            "override navigator.languages from fingerprint config",
            "  aLanguages.Clear();\n\n  // E.g. \"de-de, en-us,en\".\n",
            "  aLanguages.Clear();\n\n"
            "  if (FrxFingerprintConfig::GetNavigatorLanguages(aLanguages)) {\n"
            "    return;\n"
            "  }\n\n"
            "  // E.g. \"de-de, en-us,en\".\n",
        ),
        (
            "override navigator.platform from fingerprint config",
            "  MOZ_ASSERT(NS_IsMainThread());\n\n  // navigator.platform is the same",
            "  MOZ_ASSERT(NS_IsMainThread());\n\n"
            "  if (FrxFingerprintConfig::GetNavigatorPlatform(aPlatform)) {\n"
            "    return NS_OK;\n"
            "  }\n\n"
            "  // navigator.platform is the same",
        ),
        (
            "override navigator.userAgent from fingerprint config",
            "  MOZ_ASSERT(NS_IsMainThread());\n\n  /*\n    ResistFingerprinting",
            "  MOZ_ASSERT(NS_IsMainThread());\n\n"
            "  if (FrxFingerprintConfig::GetNavigatorUserAgent(aUserAgent)) {\n"
            "    return NS_OK;\n"
            "  }\n\n"
            "  /*\n    ResistFingerprinting",
        ),
        (
            "override navigator.appCodeName",
            "void Navigator::GetAppCodeName(nsAString& aAppCodeName, ErrorResult& aRv) {\n"
            "  nsresult rv;\n",
            "void Navigator::GetAppCodeName(nsAString& aAppCodeName, ErrorResult& aRv) {\n"
            "  if (FrxFingerprintConfig::GetNavigatorAppCodeName(aAppCodeName)) {\n"
            "    return;\n"
            "  }\n\n"
            "  nsresult rv;\n",
        ),
        (
            "override navigator.appVersion",
            "void Navigator::GetAppVersion(nsAString& aAppVersion, CallerType aCallerType,\n"
            "                              ErrorResult& aRv) const {\n"
            "  nsCOMPtr<Document> doc = mWindow->GetExtantDoc();\n",
            "void Navigator::GetAppVersion(nsAString& aAppVersion, CallerType aCallerType,\n"
            "                              ErrorResult& aRv) const {\n"
            "  if (FrxFingerprintConfig::GetNavigatorAppVersion(aAppVersion)) {\n"
            "    return;\n"
            "  }\n\n"
            "  nsCOMPtr<Document> doc = mWindow->GetExtantDoc();\n",
        ),
        (
            "override navigator.appName",
            'void Navigator::GetAppName(nsAString& aAppName) const {\n'
            '  aAppName.AssignLiteral("Netscape");\n'
            '}\n',
            'void Navigator::GetAppName(nsAString& aAppName) const {\n'
            "  if (FrxFingerprintConfig::GetNavigatorAppName(aAppName)) {\n"
            "    return;\n"
            "  }\n\n"
            '  aAppName.AssignLiteral("Netscape");\n'
            '}\n',
        ),
        (
            "override navigator.oscpu",
            "void Navigator::GetOscpu(nsAString& aOSCPU, CallerType aCallerType,\n"
            "                         ErrorResult& aRv) const {\n"
            "  if (aCallerType != CallerType::System) {\n",
            "void Navigator::GetOscpu(nsAString& aOSCPU, CallerType aCallerType,\n"
            "                         ErrorResult& aRv) const {\n"
            "  if (FrxFingerprintConfig::GetNavigatorOscpu(aOSCPU)) {\n"
            "    return;\n"
            "  }\n\n"
            "  if (aCallerType != CallerType::System) {\n",
        ),
        (
            "override navigator vendor/product fields",
            "void Navigator::GetVendor(nsAString& aVendor) { aVendor.Truncate(); }\n\n"
            "void Navigator::GetVendorSub(nsAString& aVendorSub) { aVendorSub.Truncate(); }\n\n"
            "void Navigator::GetProduct(nsAString& aProduct) {\n"
            '  aProduct.AssignLiteral("Gecko");\n'
            "}\n\n"
            "void Navigator::GetProductSub(nsAString& aProductSub) {\n"
            "  // Legacy build date hardcoded for backward compatibility (bug 776376)\n"
            "  aProductSub.AssignLiteral(LEGACY_UA_GECKO_TRAIL);\n"
            "}\n",
            "void Navigator::GetVendor(nsAString& aVendor) {\n"
            "  if (FrxFingerprintConfig::GetNavigatorVendor(aVendor)) {\n"
            "    return;\n"
            "  }\n"
            "  aVendor.Truncate();\n"
            "}\n\n"
            "void Navigator::GetVendorSub(nsAString& aVendorSub) {\n"
            "  if (FrxFingerprintConfig::GetNavigatorVendorSub(aVendorSub)) {\n"
            "    return;\n"
            "  }\n"
            "  aVendorSub.Truncate();\n"
            "}\n\n"
            "void Navigator::GetProduct(nsAString& aProduct) {\n"
            "  if (FrxFingerprintConfig::GetNavigatorProduct(aProduct)) {\n"
            "    return;\n"
            "  }\n"
            '  aProduct.AssignLiteral("Gecko");\n'
            "}\n\n"
            "void Navigator::GetProductSub(nsAString& aProductSub) {\n"
            "  if (FrxFingerprintConfig::GetNavigatorProductSub(aProductSub)) {\n"
            "    return;\n"
            "  }\n\n"
            "  // Legacy build date hardcoded for backward compatibility (bug 776376)\n"
            "  aProductSub.AssignLiteral(LEGACY_UA_GECKO_TRAIL);\n"
            "}\n",
        ),
        (
            "override navigator.pdfViewerEnabled",
            "bool Navigator::PdfViewerEnabled() {\n"
            "  return !StaticPrefs::pdfjs_disabled() ||\n",
            "bool Navigator::PdfViewerEnabled() {\n"
            "  bool frxPdfViewerEnabled = false;\n"
            "  if (FrxFingerprintConfig::GetNavigatorPdfViewerEnabled(\n"
            "          &frxPdfViewerEnabled)) {\n"
            "    return frxPdfViewerEnabled;\n"
            "  }\n\n"
            "  return !StaticPrefs::pdfjs_disabled() ||\n",
        ),
        (
            "override navigator.cookieEnabled",
            "bool Navigator::CookieEnabled() {\n"
            "  // Check whether an exception overrides the global cookie behavior\n",
            "bool Navigator::CookieEnabled() {\n"
            "  bool frxCookieEnabled = false;\n"
            "  if (FrxFingerprintConfig::GetNavigatorCookieEnabled(&frxCookieEnabled)) {\n"
            "    return frxCookieEnabled;\n"
            "  }\n\n"
            "  // Check whether an exception overrides the global cookie behavior\n",
        ),
        (
            "override navigator.buildID",
            "void Navigator::GetBuildID(nsAString& aBuildID, CallerType aCallerType,\n"
            "                           ErrorResult& aRv) const {\n"
            "  if (aCallerType != CallerType::System) {\n",
            "void Navigator::GetBuildID(nsAString& aBuildID, CallerType aCallerType,\n"
            "                           ErrorResult& aRv) const {\n"
            "  if (FrxFingerprintConfig::GetNavigatorBuildID(aBuildID)) {\n"
            "    return;\n"
            "  }\n\n"
            "  if (aCallerType != CallerType::System) {\n",
        ),
        (
            "override navigator.doNotTrack",
            "void Navigator::GetDoNotTrack(nsAString& aResult) {\n"
            "  if (StaticPrefs::privacy_donottrackheader_enabled()) {\n",
            "void Navigator::GetDoNotTrack(nsAString& aResult) {\n"
            "  if (FrxFingerprintConfig::GetNavigatorDoNotTrack(aResult)) {\n"
            "    return;\n"
            "  }\n\n"
            "  if (StaticPrefs::privacy_donottrackheader_enabled()) {\n",
        ),
        (
            "override navigator.maxTouchPoints",
            "uint32_t Navigator::MaxTouchPoints(CallerType aCallerType) {\n"
            "  nsIDocShell* docshell = GetDocShell();\n",
            "uint32_t Navigator::MaxTouchPoints(CallerType aCallerType) {\n"
            "  uint32_t frxMaxTouchPoints = 0;\n"
            "  if (FrxFingerprintConfig::GetNavigatorMaxTouchPoints(&frxMaxTouchPoints)) {\n"
            "    return frxMaxTouchPoints;\n"
            "  }\n\n"
            "  nsIDocShell* docshell = GetDocShell();\n",
        ),
        (
            "override navigator.hardwareConcurrency",
            "uint64_t Navigator::HardwareConcurrency() {\n  workerinternals::RuntimeService* rts =\n",
            "uint64_t Navigator::HardwareConcurrency() {\n"
            "  uint64_t frxHardwareConcurrency = 0;\n"
            "  if (FrxFingerprintConfig::GetHardwareConcurrency(&frxHardwareConcurrency)) {\n"
            "    return frxHardwareConcurrency;\n"
            "  }\n\n"
            "  workerinternals::RuntimeService* rts =\n",
        ),
        (
            "override navigator.webdriver",
            "bool Navigator::Webdriver() {\n#ifdef ENABLE_WEBDRIVER\n",
            "bool Navigator::Webdriver() {\n"
            "  bool frxWebdriver = false;\n"
            "  if (FrxFingerprintConfig::GetNavigatorWebdriver(&frxWebdriver)) {\n"
            "    return frxWebdriver;\n"
            "  }\n\n"
            "#ifdef ENABLE_WEBDRIVER\n",
        ),
    ],
)


print("==> dom/base/Navigator.h")
patch_file(
    os.path.join(ROOT, "dom/base/Navigator.h"),
    [
        (
            "forward declare NavigatorUAData",
            "class NavigatorLogin;\nclass PrivateAttribution;\n",
            "class NavigatorLogin;\nclass NavigatorUAData;\nclass PrivateAttribution;\n",
        ),
        (
            "declare navigator.userAgentData getter",
            "  void GetUserAgent(nsAString& aUserAgent, CallerType aCallerType,\n"
            "                    ErrorResult& aRv) const;\n"
            "  bool OnLine();\n",
            "  void GetUserAgent(nsAString& aUserAgent, CallerType aCallerType,\n"
            "                    ErrorResult& aRv) const;\n"
            "  NavigatorUAData* UserAgentData();\n"
            "  bool OnLine();\n",
        ),
        (
            "store navigator.userAgentData object",
            "  RefPtr<ServiceWorkerContainer> mServiceWorkerContainer;\n"
            "  nsCOMPtr<nsPIDOMWindowInner> mWindow;\n",
            "  RefPtr<ServiceWorkerContainer> mServiceWorkerContainer;\n"
            "  RefPtr<NavigatorUAData> mUserAgentData;\n"
            "  nsCOMPtr<nsPIDOMWindowInner> mWindow;\n",
        ),
    ],
)


print("==> dom/workers/WorkerNavigator.cpp")
patch_file(
    os.path.join(ROOT, "dom/workers/WorkerNavigator.cpp"),
    [
        (
            "include FrxFingerprintConfig.h in WorkerNavigator.cpp",
            '#include "mozilla/dom/WorkerCommon.h"\n',
            '#include "mozilla/dom/WorkerCommon.h"\n#include "mozilla/dom/FrxFingerprintConfig.h"\n',
        ),
        (
            "include NavigatorUAData.h in WorkerNavigator.cpp",
            '#include "mozilla/dom/Navigator.h"\n',
            '#include "mozilla/dom/Navigator.h"\n#include "mozilla/dom/NavigatorUAData.h"\n',
        ),
        (
            "cycle collect worker navigator.userAgentData",
            "  NS_IMPL_CYCLE_COLLECTION_TRAVERSE(mWebGpu)\n"
            "  NS_IMPL_CYCLE_COLLECTION_TRAVERSE(mLocks)\n"
            "  NS_IMPL_CYCLE_COLLECTION_TRAVERSE(mPermissions)\n",
            "  NS_IMPL_CYCLE_COLLECTION_TRAVERSE(mWebGpu)\n"
            "  NS_IMPL_CYCLE_COLLECTION_TRAVERSE(mLocks)\n"
            "  NS_IMPL_CYCLE_COLLECTION_TRAVERSE(mUserAgentData)\n"
            "  NS_IMPL_CYCLE_COLLECTION_TRAVERSE(mPermissions)\n",
        ),
        (
            "clear worker navigator.userAgentData",
            "    mLocks->Shutdown();\n"
            "    mLocks = nullptr;\n"
            "  }\n\n"
            "  mPermissions = nullptr;\n",
            "    mLocks->Shutdown();\n"
            "    mLocks = nullptr;\n"
            "  }\n\n"
            "  mUserAgentData = nullptr;\n\n"
            "  mPermissions = nullptr;\n",
        ),
        (
            "override worker navigator identity fields",
            "void WorkerNavigator::SetLanguages(const nsTArray<nsString>& aLanguages) {\n"
            "  WorkerNavigator_Binding::ClearCachedLanguagesValue(this);\n"
            "  mProperties.mLanguages = aLanguages.Clone();\n"
            "}\n\n"
            "void WorkerNavigator::GetAppVersion",
            "void WorkerNavigator::SetLanguages(const nsTArray<nsString>& aLanguages) {\n"
            "  WorkerNavigator_Binding::ClearCachedLanguagesValue(this);\n"
            "  mProperties.mLanguages = aLanguages.Clone();\n"
            "}\n\n"
            "void WorkerNavigator::GetAppCodeName(nsString& aAppCodeName,\n"
            "                                     ErrorResult& /* unused */) const {\n"
            "  if (FrxFingerprintConfig::GetNavigatorAppCodeName(aAppCodeName)) {\n"
            "    return;\n"
            "  }\n\n"
            '  aAppCodeName.AssignLiteral("Mozilla");\n'
            "}\n\n"
            "void WorkerNavigator::GetAppName(nsString& aAppName) const {\n"
            "  if (FrxFingerprintConfig::GetNavigatorAppName(aAppName)) {\n"
            "    return;\n"
            "  }\n\n"
            '  aAppName.AssignLiteral("Netscape");\n'
            "}\n\n"
            "void WorkerNavigator::GetAppVersion",
        ),
        (
            "override worker navigator.appVersion",
            "void WorkerNavigator::GetAppVersion(nsString& aAppVersion,\n"
            "                                    CallerType aCallerType,\n"
            "                                    ErrorResult& aRv) const {\n"
            "  WorkerPrivate* workerPrivate = GetCurrentThreadWorkerPrivate();\n",
            "void WorkerNavigator::GetAppVersion(nsString& aAppVersion,\n"
            "                                    CallerType aCallerType,\n"
            "                                    ErrorResult& aRv) const {\n"
            "  if (FrxFingerprintConfig::GetNavigatorAppVersion(aAppVersion)) {\n"
            "    return;\n"
            "  }\n\n"
            "  WorkerPrivate* workerPrivate = GetCurrentThreadWorkerPrivate();\n",
        ),
        (
            "override worker navigator.product",
            "  aAppVersion = mProperties.mAppVersion;\n"
            "}\n\n"
            "void WorkerNavigator::GetPlatform",
            "  aAppVersion = mProperties.mAppVersion;\n"
            "}\n\n"
            "void WorkerNavigator::GetProduct(nsString& aProduct) const {\n"
            "  if (FrxFingerprintConfig::GetNavigatorProduct(aProduct)) {\n"
            "    return;\n"
            "  }\n\n"
            '  aProduct.AssignLiteral("Gecko");\n'
            "}\n\n"
            "void WorkerNavigator::GetPlatform",
        ),
        (
            "override worker navigator.platform",
            "  WorkerPrivate* workerPrivate = GetCurrentThreadWorkerPrivate();\n"
            "  MOZ_ASSERT(workerPrivate);\n\n"
            "  // navigator.platform is the same for default and spoofed values.",
            "  WorkerPrivate* workerPrivate = GetCurrentThreadWorkerPrivate();\n"
            "  MOZ_ASSERT(workerPrivate);\n\n"
            "  if (FrxFingerprintConfig::GetNavigatorPlatform(aPlatform)) {\n"
            "    return;\n"
            "  }\n\n"
            "  // navigator.platform is the same for default and spoofed values.",
        ),
        (
            "add worker navigator language overrides",
            "}  // namespace\n\nvoid WorkerNavigator::GetUserAgent",
            "}  // namespace\n\n"
            "void WorkerNavigator::GetLanguage(nsString& aLanguage) const {\n"
            "  if (FrxFingerprintConfig::GetNavigatorLanguage(aLanguage)) {\n"
            "    return;\n"
            "  }\n\n"
            "  nsTArray<nsString> languages;\n"
            "  GetLanguages(languages);\n"
            "  MOZ_ASSERT(languages.Length() >= 1);\n"
            "  aLanguage.Assign(languages[0]);\n"
            "}\n\n"
            "void WorkerNavigator::GetLanguages(nsTArray<nsString>& aLanguages) const {\n"
            "  if (FrxFingerprintConfig::GetNavigatorLanguages(aLanguages)) {\n"
            "    return;\n"
            "  }\n\n"
            "  aLanguages = mProperties.mLanguages.Clone();\n"
            "}\n\n"
            "void WorkerNavigator::GetUserAgent",
        ),
        (
            "override worker navigator.hardwareConcurrency",
            "uint64_t WorkerNavigator::HardwareConcurrency() const {\n  RuntimeService* rts = RuntimeService::GetService();\n",
            "uint64_t WorkerNavigator::HardwareConcurrency() const {\n"
            "  uint64_t frxHardwareConcurrency = 0;\n"
            "  if (FrxFingerprintConfig::GetHardwareConcurrency(&frxHardwareConcurrency)) {\n"
            "    return frxHardwareConcurrency;\n"
            "  }\n\n"
            "  RuntimeService* rts = RuntimeService::GetService();\n",
        ),
        (
            "implement worker navigator.userAgentData getter",
            "  runnable->Dispatch(workerPrivate, Canceling, aRv);\n"
            "}\n\n"
            "uint64_t WorkerNavigator::HardwareConcurrency",
            "  runnable->Dispatch(workerPrivate, Canceling, aRv);\n"
            "}\n\n"
            "NavigatorUAData* WorkerNavigator::UserAgentData() {\n"
            "  if (!mUserAgentData) {\n"
            "    WorkerPrivate* workerPrivate = GetCurrentThreadWorkerPrivate();\n"
            "    MOZ_ASSERT(workerPrivate);\n"
            "    mUserAgentData = MakeRefPtr<NavigatorUAData>(workerPrivate->GlobalScope());\n"
            "  }\n"
            "  return mUserAgentData;\n"
            "}\n\n"
            "uint64_t WorkerNavigator::HardwareConcurrency",
        ),
    ],
)


print("==> dom/workers/WorkerNavigator.h")
patch_file(
    os.path.join(ROOT, "dom/workers/WorkerNavigator.h"),
    [
        (
            "declare worker navigator identity getters",
            "  void GetAppCodeName(nsString& aAppCodeName, ErrorResult& /* unused */) const {\n"
            '    aAppCodeName.AssignLiteral("Mozilla");\n'
            "  }\n"
            "  void GetAppName(nsString& aAppName) const {\n"
            '    aAppName.AssignLiteral("Netscape");\n'
            "  }\n\n"
            "  void GetAppVersion(nsString& aAppVersion, CallerType aCallerType,\n"
            "                     ErrorResult& aRv) const;\n\n"
            "  void GetPlatform(nsString& aPlatform, CallerType aCallerType,\n"
            "                   ErrorResult& aRv) const;\n\n"
            '  void GetProduct(nsString& aProduct) const { aProduct.AssignLiteral("Gecko"); }\n',
            "  void GetAppCodeName(nsString& aAppCodeName, ErrorResult& aRv) const;\n"
            "  void GetAppName(nsString& aAppName) const;\n\n"
            "  void GetAppVersion(nsString& aAppVersion, CallerType aCallerType,\n"
            "                     ErrorResult& aRv) const;\n\n"
            "  void GetPlatform(nsString& aPlatform, CallerType aCallerType,\n"
            "                   ErrorResult& aRv) const;\n\n"
            "  void GetProduct(nsString& aProduct) const;\n",
        ),
        (
            "forward declare worker NavigatorUAData",
            "class LockManager;\nclass Permissions;\n",
            "class LockManager;\nclass NavigatorUAData;\nclass Permissions;\n",
        ),
        (
            "store worker navigator.userAgentData object",
            "  RefPtr<dom::LockManager> mLocks;\n"
            "  RefPtr<dom::Permissions> mPermissions;\n",
            "  RefPtr<dom::LockManager> mLocks;\n"
            "  RefPtr<NavigatorUAData> mUserAgentData;\n"
            "  RefPtr<dom::Permissions> mPermissions;\n",
        ),
        (
            "declare worker navigator.userAgentData getter",
            "  void GetUserAgent(nsString& aUserAgent, CallerType aCallerType,\n"
            "                    ErrorResult& aRv) const;\n\n"
            "  bool OnLine() const { return mOnline; }\n",
            "  void GetUserAgent(nsString& aUserAgent, CallerType aCallerType,\n"
            "                    ErrorResult& aRv) const;\n\n"
            "  NavigatorUAData* UserAgentData();\n\n"
            "  bool OnLine() const { return mOnline; }\n",
        ),
        (
            "declare worker navigator language getters",
            "  void GetLanguage(nsString& aLanguage) const {\n"
            "    MOZ_ASSERT(mProperties.mLanguages.Length() >= 1);\n"
            "    aLanguage.Assign(mProperties.mLanguages[0]);\n"
            "  }\n\n"
            "  void GetLanguages(nsTArray<nsString>& aLanguages) const {\n"
            "    aLanguages = mProperties.mLanguages.Clone();\n"
            "  }\n",
            "  void GetLanguage(nsString& aLanguage) const;\n\n"
            "  void GetLanguages(nsTArray<nsString>& aLanguages) const;\n",
        ),
    ],
)


print("==> dom/base/nsScreen.h")
patch_file(
    os.path.join(ROOT, "dom/base/nsScreen.h"),
    [
        (
            "make screen.colorDepth configurable",
            "  int32_t ColorDepth() { return PixelDepth(); }\n",
            "  int32_t ColorDepth();\n",
        ),
    ],
)


print("==> dom/base/nsScreen.cpp")
patch_file(
    os.path.join(ROOT, "dom/base/nsScreen.cpp"),
    [
        (
            "include FrxFingerprintConfig.h in nsScreen.cpp",
            '#include "mozilla/dom/Document.h"\n',
            '#include "mozilla/dom/Document.h"\n#include "mozilla/dom/FrxFingerprintConfig.h"\n',
        ),
        (
            "override screen.pixelDepth",
            "int32_t nsScreen::PixelDepth() {\n  // Return 24 to prevent fingerprinting.\n",
            "int32_t nsScreen::PixelDepth() {\n"
            "  int32_t frxPixelDepth = 0;\n"
            "  if (FrxFingerprintConfig::GetScreenPixelDepth(&frxPixelDepth)) {\n"
            "    return frxPixelDepth;\n"
            "  }\n\n"
            "  // Return 24 to prevent fingerprinting.\n",
        ),
        (
            "add screen.colorDepth override",
            "nsPIDOMWindowOuter* nsScreen::GetOuter() const {\n",
            "int32_t nsScreen::ColorDepth() {\n"
            "  int32_t frxColorDepth = 0;\n"
            "  if (FrxFingerprintConfig::GetScreenColorDepth(&frxColorDepth)) {\n"
            "    return frxColorDepth;\n"
            "  }\n"
            "  return PixelDepth();\n"
            "}\n\n"
            "nsPIDOMWindowOuter* nsScreen::GetOuter() const {\n",
        ),
        (
            "override screen rect",
            "CSSIntRect nsScreen::GetRect() {\n  // Return window inner rect to prevent fingerprinting.\n",
            "CSSIntRect nsScreen::GetRect() {\n"
            "  int32_t frxWidth = 0;\n"
            "  int32_t frxHeight = 0;\n"
            "  if (FrxFingerprintConfig::GetScreenWidth(&frxWidth) &&\n"
            "      FrxFingerprintConfig::GetScreenHeight(&frxHeight)) {\n"
            "    return {0, 0, frxWidth, frxHeight};\n"
            "  }\n\n"
            "  // Return window inner rect to prevent fingerprinting.\n",
        ),
        (
            "override screen available rect",
            "CSSIntRect nsScreen::GetAvailRect() {\n  // Return window inner rect to prevent fingerprinting.\n",
            "CSSIntRect nsScreen::GetAvailRect() {\n"
            "  int32_t frxAvailWidth = 0;\n"
            "  int32_t frxAvailHeight = 0;\n"
            "  if (FrxFingerprintConfig::GetScreenAvailWidth(&frxAvailWidth) &&\n"
            "      FrxFingerprintConfig::GetScreenAvailHeight(&frxAvailHeight)) {\n"
            "    return {0, 0, frxAvailWidth, frxAvailHeight};\n"
            "  }\n\n"
            "  // Return window inner rect to prevent fingerprinting.\n",
        ),
    ],
)


print("==> dom/base/nsGlobalWindowInner.cpp")
patch_file(
    os.path.join(ROOT, "dom/base/nsGlobalWindowInner.cpp"),
    [
        (
            "include FrxFingerprintConfig.h in nsGlobalWindowInner.cpp",
            '#include "mozilla/AlreadyAddRefed.h"\n',
            '#include "mozilla/AlreadyAddRefed.h"\n#include "mozilla/dom/FrxFingerprintConfig.h"\n',
        ),
        (
            "override window.devicePixelRatio",
            "double nsGlobalWindowInner::GetDevicePixelRatio(CallerType aCallerType,\n                                                ErrorResult& aError) {\n  ENSURE_ACTIVE_DOCUMENT(aError, 0.0);\n\n",
            "double nsGlobalWindowInner::GetDevicePixelRatio(CallerType aCallerType,\n                                                ErrorResult& aError) {\n"
            "  ENSURE_ACTIVE_DOCUMENT(aError, 0.0);\n\n"
            "  double frxDevicePixelRatio = 0.0;\n"
            "  if (FrxFingerprintConfig::GetDevicePixelRatio(&frxDevicePixelRatio)) {\n"
            "    return frxDevicePixelRatio;\n"
            "  }\n\n",
        ),
    ],
)


print("==> dom/canvas/ClientWebGLContext.cpp")
patch_file(
    os.path.join(ROOT, "dom/canvas/ClientWebGLContext.cpp"),
    [
        (
            "include FrxFingerprintConfig.h in ClientWebGLContext.cpp",
            '#include "mozilla/dom/GeneratePlaceholderCanvasData.h"\n',
            '#include "mozilla/dom/GeneratePlaceholderCanvasData.h"\n#include "mozilla/dom/FrxFingerprintConfig.h"\n',
        ),
        (
            "override WebGL unmasked renderer from fingerprint config",
            "    const auto GetUnmaskedRenderer = [&]() {\n"
            "      const auto prefLock = StaticPrefs::webgl_override_unmasked_renderer();\n"
            "      if (!prefLock->IsEmpty()) {\n"
            "        return Some(ToString(*prefLock));\n"
            "      }\n"
            "      return GetString(LOCAL_GL_RENDERER);\n"
            "    };\n",
            "    const auto GetUnmaskedRenderer = [&]() {\n"
            "      nsAutoCString frxRenderer;\n"
            "      if (dom::FrxFingerprintConfig::GetWebGLUnmaskedRenderer(\n"
            "              frxRenderer)) {\n"
            "        return Some(std::string(frxRenderer.get(), frxRenderer.Length()));\n"
            "      }\n"
            "      const auto prefLock = StaticPrefs::webgl_override_unmasked_renderer();\n"
            "      if (!prefLock->IsEmpty()) {\n"
            "        return Some(ToString(*prefLock));\n"
            "      }\n"
            "      return GetString(LOCAL_GL_RENDERER);\n"
            "    };\n",
        ),
        (
            "override WebGL unmasked vendor from fingerprint config",
            "    const auto GetUnmaskedVendor = [&]() {\n"
            "      const auto prefLock = StaticPrefs::webgl_override_unmasked_vendor();\n"
            "      if (!prefLock->IsEmpty()) {\n"
            "        return Some(ToString(*prefLock));\n"
            "      }\n"
            "      return GetString(LOCAL_GL_VENDOR);\n"
            "    };\n",
            "    const auto GetUnmaskedVendor = [&]() {\n"
            "      nsAutoCString frxVendor;\n"
            "      if (dom::FrxFingerprintConfig::GetWebGLUnmaskedVendor(\n"
            "              frxVendor)) {\n"
            "        return Some(std::string(frxVendor.get(), frxVendor.Length()));\n"
            "      }\n"
            "      const auto prefLock = StaticPrefs::webgl_override_unmasked_vendor();\n"
            "      if (!prefLock->IsEmpty()) {\n"
            "        return Some(ToString(*prefLock));\n"
            "      }\n"
            "      return GetString(LOCAL_GL_VENDOR);\n"
            "    };\n",
        ),
    ],
)


print("==> netwerk/protocol/http/nsHttpHandler.cpp")
patch_file(
    os.path.join(ROOT, "netwerk/protocol/http/nsHttpHandler.cpp"),
    [
        (
            "include FrxFingerprintConfig.h in nsHttpHandler.cpp",
            '#include "mozilla/ClearOnShutdown.h"\n',
            '#include "mozilla/ClearOnShutdown.h"\n#include "mozilla/dom/FrxFingerprintConfig.h"\n',
        ),
        (
            "override User-Agent request header",
            '  // Add the "User-Agent" header\n'
            "  rv = request->SetHeader(nsHttp::User_Agent,\n"
            "                          UserAgent(aShouldResistFingerprinting), false,\n"
            "                          nsHttpHeaderArray::eVarietyRequestDefault);\n"
            "  if (NS_FAILED(rv)) return rv;\n",
            '  // Add the "User-Agent" header\n'
            "  nsAutoCString frxUserAgent;\n"
            "  const nsACString* userAgent = &UserAgent(aShouldResistFingerprinting);\n"
            "  if (mozilla::dom::FrxFingerprintConfig::GetHttpUserAgent(\n"
            "          frxUserAgent)) {\n"
            "    userAgent = &frxUserAgent;\n"
            "  }\n"
            "  rv = request->SetHeader(nsHttp::User_Agent, *userAgent, false,\n"
            "                          nsHttpHeaderArray::eVarietyRequestDefault);\n"
            "  if (NS_FAILED(rv)) return rv;\n",
        ),
        (
            "use override variety for FRX User-Agent header",
            '  // Add the "User-Agent" header\n'
            "  nsAutoCString frxUserAgent;\n"
            "  const nsACString* userAgent = &UserAgent(aShouldResistFingerprinting);\n"
            "  if (mozilla::dom::FrxFingerprintConfig::GetHttpUserAgent(\n"
            "          frxUserAgent)) {\n"
            "    userAgent = &frxUserAgent;\n"
            "  }\n"
            "  rv = request->SetHeader(nsHttp::User_Agent, *userAgent, false,\n"
            "                          nsHttpHeaderArray::eVarietyRequestDefault);\n"
            "  if (NS_FAILED(rv)) return rv;\n",
            '  // Add the "User-Agent" header\n'
            "  nsAutoCString frxUserAgent;\n"
            "  const nsACString* userAgent = &UserAgent(aShouldResistFingerprinting);\n"
            "  nsHttpHeaderArray::HeaderVariety userAgentVariety =\n"
            "      nsHttpHeaderArray::eVarietyRequestDefault;\n"
            "  if (mozilla::dom::FrxFingerprintConfig::GetHttpUserAgent(\n"
            "          frxUserAgent)) {\n"
            "    userAgent = &frxUserAgent;\n"
            "    userAgentVariety = nsHttpHeaderArray::eVarietyRequestOverride;\n"
            "  }\n"
            "  rv = request->SetHeader(nsHttp::User_Agent, *userAgent, false,\n"
            "                          userAgentVariety);\n"
            "  if (NS_FAILED(rv)) return rv;\n",
        ),
        (
            "override nsHttpHandler UserAgent source",
            "const nsCString& nsHttpHandler::UserAgent(bool aShouldResistFingerprinting) {\n"
            "  if (aShouldResistFingerprinting && !mSpoofedUserAgent.IsEmpty()) {\n",
            "const nsCString& nsHttpHandler::UserAgent(bool aShouldResistFingerprinting) {\n"
            "  static nsCString sFrxUserAgent;\n"
            "  nsAutoCString frxUserAgent;\n"
            "  if (mozilla::dom::FrxFingerprintConfig::GetHttpUserAgent(\n"
            "          frxUserAgent)) {\n"
            "    sFrxUserAgent = frxUserAgent;\n"
            "    return sFrxUserAgent;\n"
            "  }\n\n"
            "  if (aShouldResistFingerprinting && !mSpoofedUserAgent.IsEmpty()) {\n",
        ),
        (
            "override Accept-Language request header",
            "  if (!aLanguageOverride.IsEmpty()) {\n"
            "    nsAutoCString acceptLanguage;\n"
            "    acceptLanguage.Assign(aLanguageOverride.get());\n"
            "    rv = request->SetHeader(nsHttp::Accept_Language, acceptLanguage, false,\n"
            "                            nsHttpHeaderArray::eVarietyRequestOverride);\n"
            "    if (NS_FAILED(rv)) return rv;\n"
            "  } else {\n",
            "  nsAutoCString frxAcceptLanguage;\n"
            "  if (mozilla::dom::FrxFingerprintConfig::GetHttpAcceptLanguage(\n"
            "          frxAcceptLanguage)) {\n"
            "    rv = request->SetHeader(nsHttp::Accept_Language, frxAcceptLanguage,\n"
            "                            false,\n"
            "                            nsHttpHeaderArray::eVarietyRequestOverride);\n"
            "    if (NS_FAILED(rv)) return rv;\n"
            "  } else if (!aLanguageOverride.IsEmpty()) {\n"
            "    nsAutoCString acceptLanguage;\n"
            "    acceptLanguage.Assign(aLanguageOverride.get());\n"
            "    rv = request->SetHeader(nsHttp::Accept_Language, acceptLanguage, false,\n"
            "                            nsHttpHeaderArray::eVarietyRequestOverride);\n"
            "    if (NS_FAILED(rv)) return rv;\n"
            "  } else {\n",
        ),
        (
            "add FRX Client Hints request headers",
            '  // add the "Send Hint" header\n'
            "  if (mSafeHintEnabled || sParentalControlsEnabled) {\n",
            "  auto setFrxClientHintHeader = [&](const nsACString& aName,\n"
            "                                    auto aGetter) -> nsresult {\n"
            "    nsAutoCString value;\n"
            "    if (!aGetter(value) || value.IsEmpty()) {\n"
            "      return NS_OK;\n"
            "    }\n"
            "    return request->SetHeader(nsHttp::ResolveAtom(aName), value, false,\n"
            "                              nsHttpHeaderArray::eVarietyRequestOverride);\n"
            "  };\n\n"
            "  rv = setFrxClientHintHeader(\n"
            '      "Sec-CH-UA"_ns, mozilla::dom::FrxFingerprintConfig::GetHttpSecChUa);\n'
            "  if (NS_FAILED(rv)) return rv;\n"
            "  rv = setFrxClientHintHeader(\n"
            '      "Sec-CH-UA-Mobile"_ns,\n'
            "      mozilla::dom::FrxFingerprintConfig::GetHttpSecChUaMobile);\n"
            "  if (NS_FAILED(rv)) return rv;\n"
            "  rv = setFrxClientHintHeader(\n"
            '      "Sec-CH-UA-Platform"_ns,\n'
            "      mozilla::dom::FrxFingerprintConfig::GetHttpSecChUaPlatform);\n"
            "  if (NS_FAILED(rv)) return rv;\n"
            "  rv = setFrxClientHintHeader(\n"
            '      "Sec-CH-UA-Full-Version-List"_ns,\n'
            "      mozilla::dom::FrxFingerprintConfig::GetHttpSecChUaFullVersionList);\n"
            "  if (NS_FAILED(rv)) return rv;\n"
            "  rv = setFrxClientHintHeader(\n"
            '      "Sec-CH-UA-Arch"_ns,\n'
            "      mozilla::dom::FrxFingerprintConfig::GetHttpSecChUaArch);\n"
            "  if (NS_FAILED(rv)) return rv;\n"
            "  rv = setFrxClientHintHeader(\n"
            '      "Sec-CH-UA-Bitness"_ns,\n'
            "      mozilla::dom::FrxFingerprintConfig::GetHttpSecChUaBitness);\n"
            "  if (NS_FAILED(rv)) return rv;\n"
            "  rv = setFrxClientHintHeader(\n"
            '      "Sec-CH-UA-Model"_ns,\n'
            "      mozilla::dom::FrxFingerprintConfig::GetHttpSecChUaModel);\n"
            "  if (NS_FAILED(rv)) return rv;\n"
            "  rv = setFrxClientHintHeader(\n"
            '      "Sec-CH-UA-Platform-Version"_ns,\n'
            "      mozilla::dom::FrxFingerprintConfig::GetHttpSecChUaPlatformVersion);\n"
            "  if (NS_FAILED(rv)) return rv;\n\n"
            '  // add the "Send Hint" header\n'
            "  if (mSafeHintEnabled || sParentalControlsEnabled) {\n",
        ),
    ],
)


print("==> js/xpconnect/src/nsXPConnect.cpp")
patch_file(
    os.path.join(ROOT, "js/xpconnect/src/nsXPConnect.cpp"),
    [
        (
            "include FrxFingerprintConfig.h in nsXPConnect.cpp",
            '#include "mozilla/Base64.h"\n',
            '#include "mozilla/Base64.h"\n#include "mozilla/dom/FrxFingerprintConfig.h"\n',
        ),
        (
            "feed Intl locale/timezone from fingerprint config",
            "  if (aForceUTC) {\n"
            "    nsCString timeZone = nsRFPService::GetSpoofedJSTimeZone();\n"
            "    aOptions.behaviors().setTimeZoneOverride(timeZone.get());\n"
            "  } else if (!aTimezoneOverride.IsEmpty()) {\n"
            "    aOptions.behaviors().setTimeZoneOverride(\n"
            "        NS_ConvertUTF16toUTF8(aTimezoneOverride).get());\n"
            "  }\n"
            "  aOptions.creationOptions().setAlwaysUseFdlibm(aAlwaysUseFdlibm);\n"
            "  if (aLocaleEnUS) {\n"
            "    nsCString locale = nsRFPService::GetSpoofedJSLocale();\n"
            "    aOptions.behaviors().setLocaleOverride(locale.get());\n"
            "  } else if (!aLanguageOverride.IsEmpty()) {\n"
            "    aOptions.behaviors().setLocaleOverride(\n"
            "        PromiseFlatCString(aLanguageOverride).get());\n"
            "  }\n",
            "  nsAutoString frxTimezoneOverride;\n"
            "  const nsAString* timezoneOverride = &aTimezoneOverride;\n"
            "  if (aTimezoneOverride.IsEmpty() &&\n"
            "      mozilla::dom::FrxFingerprintConfig::GetIntlTimezone(\n"
            "          frxTimezoneOverride)) {\n"
            "    timezoneOverride = &frxTimezoneOverride;\n"
            "  }\n"
            "  nsAutoCString frxLanguageOverride;\n"
            "  const nsACString* languageOverride = &aLanguageOverride;\n"
            "  if (aLanguageOverride.IsEmpty() &&\n"
            "      mozilla::dom::FrxFingerprintConfig::GetIntlLocale(\n"
            "          frxLanguageOverride)) {\n"
            "    languageOverride = &frxLanguageOverride;\n"
            "  }\n\n"
            "  if (aForceUTC) {\n"
            "    nsCString timeZone = nsRFPService::GetSpoofedJSTimeZone();\n"
            "    aOptions.behaviors().setTimeZoneOverride(timeZone.get());\n"
            "  } else if (!timezoneOverride->IsEmpty()) {\n"
            "    aOptions.behaviors().setTimeZoneOverride(\n"
            "        NS_ConvertUTF16toUTF8(*timezoneOverride).get());\n"
            "  }\n"
            "  aOptions.creationOptions().setAlwaysUseFdlibm(aAlwaysUseFdlibm);\n"
            "  if (aLocaleEnUS) {\n"
            "    nsCString locale = nsRFPService::GetSpoofedJSLocale();\n"
            "    aOptions.behaviors().setLocaleOverride(locale.get());\n"
            "  } else if (!languageOverride->IsEmpty()) {\n"
            "    aOptions.behaviors().setLocaleOverride(\n"
            "        PromiseFlatCString(*languageOverride).get());\n"
            "  }\n",
        ),
    ],
)

print("\nFingerprint config patches applied successfully.")

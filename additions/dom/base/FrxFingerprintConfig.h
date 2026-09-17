/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_dom_FrxFingerprintConfig_h
#define mozilla_dom_FrxFingerprintConfig_h

#include <stdint.h>

#include "nsString.h"
#include "nsTArray.h"

namespace mozilla::dom {

class FrxFingerprintConfig final {
 public:
  enum class Status : uint8_t { Absent, Loaded, Invalid };

  static bool Enabled();
  static Status GetStatus();
  // Stable diagnostic codes only; never configuration bytes or private paths.
  static void GetStatusReason(nsACString& aValue);
  static void GetConfigSource(nsACString& aValue);
  // Parent-only: publish an immutable, non-persistent preference snapshot
  // before SharedPreferenceSerializer captures content-process preferences.
  // The returned per-parent token must be supplied only to that child launch.
  static bool PrepareContentSnapshot(nsACString& aLaunchToken);
  // Read once on the main thread before rendering. Zero is a valid seed.
  static bool GetSurfaceSeed(const char* aSurface, uint64_t* aValue);

  static bool GetNavigatorUserAgent(nsAString& aValue);
  static bool GetNavigatorPlatform(nsAString& aValue);
  static bool GetNavigatorLanguage(nsAString& aValue);
  static bool GetNavigatorLanguages(nsTArray<nsString>& aValue);
  static bool GetNavigatorWebdriver(bool* aValue);
  static bool GetHardwareConcurrency(uint64_t* aValue);
  static bool GetNavigatorAppCodeName(nsAString& aValue);
  static bool GetNavigatorAppName(nsAString& aValue);
  static bool GetNavigatorAppVersion(nsAString& aValue);
  static bool GetNavigatorProduct(nsAString& aValue);
  static bool GetNavigatorProductSub(nsAString& aValue);
  static bool GetNavigatorVendor(nsAString& aValue);
  static bool GetNavigatorVendorSub(nsAString& aValue);
  static bool GetNavigatorOscpu(nsAString& aValue);
  static bool GetNavigatorBuildID(nsAString& aValue);
  static bool GetNavigatorDoNotTrack(nsAString& aValue);
  static bool GetNavigatorCookieEnabled(bool* aValue);
  static bool GetNavigatorPdfViewerEnabled(bool* aValue);
  static bool GetNavigatorMaxTouchPoints(uint32_t* aValue);

  static bool GetScreenWidth(int32_t* aValue);
  static bool GetScreenHeight(int32_t* aValue);
  static bool GetScreenAvailWidth(int32_t* aValue);
  static bool GetScreenAvailHeight(int32_t* aValue);
  static bool GetScreenColorDepth(int32_t* aValue);
  static bool GetScreenPixelDepth(int32_t* aValue);
  static bool GetDevicePixelRatio(double* aValue);

  static bool GetIntlLocale(nsACString& aValue);
  static bool GetIntlTimezone(nsAString& aValue);
  static bool GetHttpUserAgent(nsACString& aValue);
  static bool GetHttpAcceptLanguage(nsACString& aValue);
  static bool GetHttpSecChUa(nsACString& aValue);
  static bool GetHttpSecChUaMobile(nsACString& aValue);
  static bool GetHttpSecChUaPlatform(nsACString& aValue);
  static bool GetHttpSecChUaFullVersionList(nsACString& aValue);
  static bool GetHttpSecChUaArch(nsACString& aValue);
  static bool GetHttpSecChUaBitness(nsACString& aValue);
  static bool GetHttpSecChUaModel(nsACString& aValue);
  static bool GetHttpSecChUaPlatformVersion(nsACString& aValue);

  static bool GetWebGLUnmaskedVendor(nsACString& aValue);
  static bool GetWebGLUnmaskedRenderer(nsACString& aValue);
};

}  // namespace mozilla::dom

#endif  // mozilla_dom_FrxFingerprintConfig_h

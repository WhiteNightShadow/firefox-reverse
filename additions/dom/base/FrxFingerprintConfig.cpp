/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "FrxFingerprintConfig.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef XP_WIN
#  include <process.h>
#  define getpid _getpid
#else
#  include <unistd.h>
#endif

#include <memory>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

#include "json/json.h"
#include "mozilla/Maybe.h"
#include "mozilla/Preferences.h"
#include "mozilla/StaticPrefs_frx.h"
#include "nsError.h"
#include "nsString.h"

namespace mozilla::dom {
namespace {

using mozilla::Maybe;
using mozilla::Nothing;
using mozilla::Some;

bool DebugEnabled() {
  const char* debug = getenv("MOZ_FRX_DEBUG_FINGERPRINT");
  return debug && debug[0] && strcmp(debug, "0") != 0;
}

void DebugLog(const char* aFormat, ...) {
  if (!DebugEnabled()) {
    return;
  }

  fprintf(stderr, "[frx-fingerprint:%d] ", int(getpid()));
  va_list args;
  va_start(args, aFormat);
  vfprintf(stderr, aFormat, args);
  va_end(args);
  fprintf(stderr, "\n");
}

struct Config {
  bool enabled = false;
  Maybe<std::string> navigatorUserAgent;
  Maybe<std::string> navigatorPlatform;
  Maybe<std::string> navigatorLanguage;
  std::vector<std::string> navigatorLanguages;
  Maybe<bool> navigatorWebdriver;
  Maybe<uint64_t> hardwareConcurrency;
  Maybe<std::string> navigatorAppCodeName;
  Maybe<std::string> navigatorAppName;
  Maybe<std::string> navigatorAppVersion;
  Maybe<std::string> navigatorProduct;
  Maybe<std::string> navigatorProductSub;
  Maybe<std::string> navigatorVendor;
  Maybe<std::string> navigatorVendorSub;
  Maybe<std::string> navigatorOscpu;
  Maybe<std::string> navigatorBuildID;
  Maybe<std::string> navigatorDoNotTrack;
  Maybe<bool> navigatorCookieEnabled;
  Maybe<bool> navigatorPdfViewerEnabled;
  Maybe<uint64_t> navigatorMaxTouchPoints;
  Maybe<int32_t> screenWidth;
  Maybe<int32_t> screenHeight;
  Maybe<int32_t> screenAvailWidth;
  Maybe<int32_t> screenAvailHeight;
  Maybe<int32_t> screenColorDepth;
  Maybe<int32_t> screenPixelDepth;
  Maybe<double> devicePixelRatio;
  Maybe<std::string> intlLocale;
  Maybe<std::string> intlTimezone;
  Maybe<std::string> httpUserAgent;
  Maybe<std::string> httpAcceptLanguage;
  Maybe<std::string> httpSecChUa;
  Maybe<std::string> httpSecChUaMobile;
  Maybe<std::string> httpSecChUaPlatform;
  Maybe<std::string> httpSecChUaFullVersionList;
  Maybe<std::string> httpSecChUaArch;
  Maybe<std::string> httpSecChUaBitness;
  Maybe<std::string> httpSecChUaModel;
  Maybe<std::string> httpSecChUaPlatformVersion;
  Maybe<std::string> webglUnmaskedVendor;
  Maybe<std::string> webglUnmaskedRenderer;
};

bool ReadFile(const char* aPath, std::string& aOut) {
  FILE* f = fopen(aPath, "rb");
  if (!f) {
    return false;
  }
  char buf[4096];
  while (!feof(f)) {
    size_t n = fread(buf, 1, sizeof(buf), f);
    if (n) {
      aOut.append(buf, n);
      if (aOut.size() > (1024 * 1024)) {
        fclose(f);
        return false;
      }
    }
    if (ferror(f)) {
      fclose(f);
      return false;
    }
  }
  fclose(f);
  return true;
}

bool FieldEnabled(const Json::Value& aField) {
  if (!aField.isObject()) {
    return true;
  }
  const Json::Value& enabled = aField["enabled"];
  return !enabled.isBool() || enabled.asBool();
}

const Json::Value& FieldValue(const Json::Value& aField) {
  if (aField.isObject() && aField.isMember("value")) {
    return aField["value"];
  }
  return aField;
}

Maybe<std::string> ReadStringField(const Json::Value& aParent,
                                   const char* aName) {
  if (!aParent.isObject() || !aParent.isMember(aName)) {
    return Nothing();
  }
  const Json::Value& field = aParent[aName];
  if (!FieldEnabled(field)) {
    return Nothing();
  }
  const Json::Value& value = FieldValue(field);
  if (!value.isString()) {
    return Nothing();
  }
  std::string out = value.asString();
  if (out.empty()) {
    return Nothing();
  }
  return Some(out);
}

Maybe<bool> ReadBoolField(const Json::Value& aParent, const char* aName) {
  if (!aParent.isObject() || !aParent.isMember(aName)) {
    return Nothing();
  }
  const Json::Value& field = aParent[aName];
  if (!FieldEnabled(field)) {
    return Nothing();
  }
  const Json::Value& value = FieldValue(field);
  if (!value.isBool()) {
    return Nothing();
  }
  return Some(value.asBool());
}

Maybe<uint64_t> ReadUIntField(const Json::Value& aParent, const char* aName,
                              uint64_t aMin, uint64_t aMax) {
  if (!aParent.isObject() || !aParent.isMember(aName)) {
    return Nothing();
  }
  const Json::Value& field = aParent[aName];
  if (!FieldEnabled(field)) {
    return Nothing();
  }
  const Json::Value& value = FieldValue(field);
  if (!value.isUInt64() && !value.isInt()) {
    return Nothing();
  }
  uint64_t out = value.isUInt64() ? value.asUInt64() : uint64_t(value.asInt());
  if (out < aMin || out > aMax) {
    return Nothing();
  }
  return Some(out);
}

Maybe<int32_t> ReadIntField(const Json::Value& aParent, const char* aName,
                            int32_t aMin, int32_t aMax) {
  Maybe<uint64_t> v = ReadUIntField(aParent, aName, uint64_t(aMin),
                                    uint64_t(aMax));
  if (v.isNothing()) {
    return Nothing();
  }
  return Some(int32_t(v.value()));
}

Maybe<double> ReadDoubleField(const Json::Value& aParent, const char* aName,
                              double aMin, double aMax) {
  if (!aParent.isObject() || !aParent.isMember(aName)) {
    return Nothing();
  }
  const Json::Value& field = aParent[aName];
  if (!FieldEnabled(field)) {
    return Nothing();
  }
  const Json::Value& value = FieldValue(field);
  if (!value.isDouble() && !value.isInt() && !value.isUInt()) {
    return Nothing();
  }
  double out = value.asDouble();
  if (out < aMin || out > aMax) {
    return Nothing();
  }
  return Some(out);
}

void ReadStringArrayField(const Json::Value& aParent, const char* aName,
                          std::vector<std::string>& aOut) {
  if (!aParent.isObject() || !aParent.isMember(aName)) {
    return;
  }
  const Json::Value& field = aParent[aName];
  if (!FieldEnabled(field)) {
    return;
  }
  const Json::Value& value = FieldValue(field);
  if (!value.isArray()) {
    return;
  }
  for (const Json::Value& item : value) {
    if (item.isString() && !item.asString().empty()) {
      aOut.push_back(item.asString());
    }
  }
}

std::string BuildAcceptLanguage(const std::vector<std::string>& aLanguages) {
  std::string out;
  for (size_t i = 0; i < aLanguages.size(); ++i) {
    if (i) {
      out += ",";
    }
    out += aLanguages[i];
    if (i) {
      int q = 10 - int(i);
      if (q < 1) {
        q = 1;
      }
      out += ";q=0.";
      out += char('0' + q);
    }
  }
  return out;
}

std::string DefaultCurrentProcessConfigPath() {
  const char* home = getenv("HOME");
  if (!home || !home[0]) {
    return {};
  }

  std::string path(home);
  while (!path.empty() && path.back() == '/') {
    path.pop_back();
  }
  path += "/.firefox-reverse/environments/.current-process/fingerprint.json";
  return path;
}

Config LoadConfig() {
  Config cfg;
  std::string text;
  const char* inlineJson = getenv("MOZ_FRX_FINGERPRINT_JSON");
  if (inlineJson && inlineJson[0]) {
    text = inlineJson;
    DebugLog("using inline fingerprint config json bytes=%zu", text.size());
  }

  if (text.empty()) {
    auto staticPrefJson = mozilla::StaticPrefs::frx_fingerprint_config_json();
    if (!staticPrefJson->IsEmpty()) {
      text.assign(staticPrefJson->get(), staticPrefJson->Length());
      DebugLog("using static pref fingerprint config json bytes=%zu",
               text.size());
    }
  }

  if (text.empty()) {
    nsAutoCString prefJson;
    if (NS_SUCCEEDED(mozilla::Preferences::GetCString(
            "frx.fingerprint.config.json", prefJson)) &&
        !prefJson.IsEmpty()) {
      text.assign(prefJson.get(), prefJson.Length());
      DebugLog("using preferences fingerprint config json bytes=%zu",
               text.size());
    }
  }

  std::string configPath;
  if (text.empty()) {
    const char* envPath = getenv("MOZ_FRX_FINGERPRINT_CONFIG");
    if (envPath && envPath[0]) {
      configPath = envPath;
      DebugLog("using env config path: %s", configPath.c_str());
    } else {
      auto staticPrefPath = mozilla::StaticPrefs::frx_fingerprint_config_path();
      if (!staticPrefPath->IsEmpty()) {
        configPath.assign(staticPrefPath->get(), staticPrefPath->Length());
        DebugLog("using static pref config path: %s", configPath.c_str());
      } else {
        DebugLog("static pref config path is empty");
      }
    }
    if (configPath.empty()) {
      nsAutoCString prefPath;
      if (NS_SUCCEEDED(mozilla::Preferences::GetCString(
              "frx.fingerprint.config.path", prefPath)) &&
          !prefPath.IsEmpty()) {
        configPath.assign(prefPath.get(), prefPath.Length());
        DebugLog("using preferences config path: %s", configPath.c_str());
      } else {
        DebugLog("preferences config path is empty");
      }
    }
    if (configPath.empty()) {
      configPath = DefaultCurrentProcessConfigPath();
      if (!configPath.empty()) {
        DebugLog("using default current process config path: %s",
                 configPath.c_str());
      }
    }
    if (configPath.empty()) {
      DebugLog("no fingerprint config path available");
      return cfg;
    }

    if (!ReadFile(configPath.c_str(), text) || text.empty()) {
      DebugLog("failed to read fingerprint config: %s", configPath.c_str());
      return cfg;
    }
  }

  Json::Value root;
  Json::CharReaderBuilder builder;
  builder["collectComments"] = false;
  std::string errors;
  std::unique_ptr<Json::CharReader> reader(builder.newCharReader());
  if (!reader ||
      !reader->parse(text.data(), text.data() + text.size(), &root, &errors) ||
      !root.isObject()) {
    DebugLog("failed to parse fingerprint config: %s", errors.c_str());
    return cfg;
  }

  const Json::Value& enabled = root["enabled"];
  if (!enabled.isBool() || !enabled.asBool()) {
    DebugLog("fingerprint config disabled or missing enabled:true");
    return cfg;
  }
  cfg.enabled = true;

  const Json::Value& nav = root["navigator"];
  const Json::Value& screen = root["screen"];
  const Json::Value& window = root["window"];
  const Json::Value& intl = root["intl"];
  const Json::Value& http = root["http"];
  const Json::Value& webgl = root["webgl"];

  cfg.navigatorUserAgent = ReadStringField(nav, "userAgent");
  cfg.navigatorPlatform = ReadStringField(nav, "platform");
  cfg.navigatorLanguage = ReadStringField(nav, "language");
  ReadStringArrayField(nav, "languages", cfg.navigatorLanguages);
  cfg.navigatorWebdriver = ReadBoolField(nav, "webdriver");
  cfg.hardwareConcurrency = ReadUIntField(nav, "hardwareConcurrency", 1, 128);
  cfg.navigatorAppCodeName = ReadStringField(nav, "appCodeName");
  cfg.navigatorAppName = ReadStringField(nav, "appName");
  cfg.navigatorAppVersion = ReadStringField(nav, "appVersion");
  cfg.navigatorProduct = ReadStringField(nav, "product");
  cfg.navigatorProductSub = ReadStringField(nav, "productSub");
  cfg.navigatorVendor = ReadStringField(nav, "vendor");
  cfg.navigatorVendorSub = ReadStringField(nav, "vendorSub");
  cfg.navigatorOscpu = ReadStringField(nav, "oscpu");
  cfg.navigatorBuildID = ReadStringField(nav, "buildID");
  cfg.navigatorDoNotTrack = ReadStringField(nav, "doNotTrack");
  cfg.navigatorCookieEnabled = ReadBoolField(nav, "cookieEnabled");
  cfg.navigatorPdfViewerEnabled = ReadBoolField(nav, "pdfViewerEnabled");
  cfg.navigatorMaxTouchPoints = ReadUIntField(nav, "maxTouchPoints", 0, 32);

  cfg.screenWidth = ReadIntField(screen, "width", 1, 10000);
  cfg.screenHeight = ReadIntField(screen, "height", 1, 10000);
  cfg.screenAvailWidth = ReadIntField(screen, "availWidth", 1, 10000);
  cfg.screenAvailHeight = ReadIntField(screen, "availHeight", 1, 10000);
  cfg.screenColorDepth = ReadIntField(screen, "colorDepth", 1, 64);
  cfg.screenPixelDepth = ReadIntField(screen, "pixelDepth", 1, 64);
  cfg.devicePixelRatio = ReadDoubleField(window, "devicePixelRatio", 0.1, 10.0);
  if (cfg.devicePixelRatio.isNothing()) {
    cfg.devicePixelRatio =
        ReadDoubleField(root, "devicePixelRatio", 0.1, 10.0);
  }

  cfg.intlLocale = ReadStringField(intl, "locale");
  if (cfg.intlLocale.isNothing()) {
    cfg.intlLocale = ReadStringField(root["locale"], "value");
  }
  cfg.intlTimezone = ReadStringField(intl, "timezone");
  if (cfg.intlTimezone.isNothing()) {
    cfg.intlTimezone = ReadStringField(root["timezone"], "value");
  }

  cfg.httpUserAgent = ReadStringField(http, "userAgent");
  cfg.httpAcceptLanguage = ReadStringField(http, "acceptLanguage");
  cfg.httpSecChUa = ReadStringField(http, "secChUa");
  cfg.httpSecChUaMobile = ReadStringField(http, "secChUaMobile");
  cfg.httpSecChUaPlatform = ReadStringField(http, "secChUaPlatform");
  cfg.httpSecChUaFullVersionList =
      ReadStringField(http, "secChUaFullVersionList");
  cfg.httpSecChUaArch = ReadStringField(http, "secChUaArch");
  cfg.httpSecChUaBitness = ReadStringField(http, "secChUaBitness");
  cfg.httpSecChUaModel = ReadStringField(http, "secChUaModel");
  cfg.httpSecChUaPlatformVersion =
      ReadStringField(http, "secChUaPlatformVersion");
  cfg.webglUnmaskedVendor = ReadStringField(webgl, "unmaskedVendor");
  cfg.webglUnmaskedRenderer = ReadStringField(webgl, "unmaskedRenderer");

  if (cfg.navigatorLanguage.isNothing() && !cfg.navigatorLanguages.empty()) {
    cfg.navigatorLanguage = Some(cfg.navigatorLanguages[0]);
  }
  if (cfg.intlLocale.isNothing() && cfg.navigatorLanguage.isSome()) {
    cfg.intlLocale = Some(cfg.navigatorLanguage.value());
  }
  if (cfg.httpUserAgent.isNothing() && cfg.navigatorUserAgent.isSome()) {
    cfg.httpUserAgent = Some(cfg.navigatorUserAgent.value());
  }
  if (cfg.httpAcceptLanguage.isNothing() && !cfg.navigatorLanguages.empty()) {
    cfg.httpAcceptLanguage = Some(BuildAcceptLanguage(cfg.navigatorLanguages));
  }

  DebugLog(
      "loaded config navUA=%d platform=%d language=%d languages=%zu hc=%d "
      "screen=%d/%d/%d/%d dpr=%d intl=%d/%d http=%d/%d webgl=%d/%d",
      cfg.navigatorUserAgent.isSome(), cfg.navigatorPlatform.isSome(),
      cfg.navigatorLanguage.isSome(), cfg.navigatorLanguages.size(),
      cfg.hardwareConcurrency.isSome(), cfg.screenWidth.isSome(),
      cfg.screenHeight.isSome(), cfg.screenAvailWidth.isSome(),
      cfg.screenAvailHeight.isSome(), cfg.devicePixelRatio.isSome(),
      cfg.intlLocale.isSome(), cfg.intlTimezone.isSome(),
      cfg.httpUserAgent.isSome(), cfg.httpAcceptLanguage.isSome(),
      cfg.webglUnmaskedVendor.isSome(), cfg.webglUnmaskedRenderer.isSome());
  return cfg;
}

const Config& GetConfig() {
  static std::mutex configMutex;
  static std::unique_ptr<const Config> cachedConfig;
  static const Config emptyConfig;

  std::lock_guard<std::mutex> lock(configMutex);
  if (cachedConfig) {
    return *cachedConfig;
  }

  Config loadedConfig = LoadConfig();
  if (loadedConfig.enabled) {
    cachedConfig = std::make_unique<Config>(std::move(loadedConfig));
    return *cachedConfig;
  }

  return emptyConfig;
}

bool AssignString(const Maybe<std::string>& aValue, nsAString& aOut) {
  if (aValue.isNothing()) {
    return false;
  }
  const std::string& value = aValue.value();
  aOut.Assign(NS_ConvertUTF8toUTF16(value.data(), value.size()));
  return true;
}

bool AssignCString(const Maybe<std::string>& aValue, nsACString& aOut) {
  if (aValue.isNothing()) {
    return false;
  }
  const std::string& value = aValue.value();
  aOut.Assign(value.data(), value.size());
  return true;
}

template <typename T>
bool AssignNumber(const Maybe<T>& aValue, T* aOut) {
  if (!aOut || aValue.isNothing()) {
    return false;
  }
  *aOut = aValue.value();
  return true;
}

}  // namespace

bool FrxFingerprintConfig::Enabled() { return GetConfig().enabled; }

bool FrxFingerprintConfig::GetNavigatorUserAgent(nsAString& aValue) {
  const Config& cfg = GetConfig();
  DebugLog("GetNavigatorUserAgent enabled=%d field=%d", cfg.enabled,
           cfg.navigatorUserAgent.isSome());
  return cfg.enabled && AssignString(cfg.navigatorUserAgent, aValue);
}

bool FrxFingerprintConfig::GetNavigatorPlatform(nsAString& aValue) {
  const Config& cfg = GetConfig();
  DebugLog("GetNavigatorPlatform enabled=%d field=%d", cfg.enabled,
           cfg.navigatorPlatform.isSome());
  return cfg.enabled && AssignString(cfg.navigatorPlatform, aValue);
}

bool FrxFingerprintConfig::GetNavigatorLanguage(nsAString& aValue) {
  const Config& cfg = GetConfig();
  DebugLog("GetNavigatorLanguage enabled=%d field=%d", cfg.enabled,
           cfg.navigatorLanguage.isSome());
  return cfg.enabled && AssignString(cfg.navigatorLanguage, aValue);
}

bool FrxFingerprintConfig::GetNavigatorLanguages(nsTArray<nsString>& aValue) {
  const Config& cfg = GetConfig();
  DebugLog("GetNavigatorLanguages enabled=%d count=%zu", cfg.enabled,
           cfg.navigatorLanguages.size());
  if (!cfg.enabled || cfg.navigatorLanguages.empty()) {
    return false;
  }
  aValue.Clear();
  for (const std::string& lang : cfg.navigatorLanguages) {
    aValue.AppendElement(NS_ConvertUTF8toUTF16(lang.data(), lang.size()));
  }
  return true;
}

bool FrxFingerprintConfig::GetNavigatorWebdriver(bool* aValue) {
  const Config& cfg = GetConfig();
  DebugLog("GetNavigatorWebdriver enabled=%d field=%d", cfg.enabled,
           cfg.navigatorWebdriver.isSome());
  return cfg.enabled && AssignNumber(cfg.navigatorWebdriver, aValue);
}

bool FrxFingerprintConfig::GetHardwareConcurrency(uint64_t* aValue) {
  const Config& cfg = GetConfig();
  DebugLog("GetHardwareConcurrency enabled=%d field=%d", cfg.enabled,
           cfg.hardwareConcurrency.isSome());
  return cfg.enabled && AssignNumber(cfg.hardwareConcurrency, aValue);
}

bool FrxFingerprintConfig::GetNavigatorAppCodeName(nsAString& aValue) {
  const Config& cfg = GetConfig();
  return cfg.enabled && AssignString(cfg.navigatorAppCodeName, aValue);
}

bool FrxFingerprintConfig::GetNavigatorAppName(nsAString& aValue) {
  const Config& cfg = GetConfig();
  return cfg.enabled && AssignString(cfg.navigatorAppName, aValue);
}

bool FrxFingerprintConfig::GetNavigatorAppVersion(nsAString& aValue) {
  const Config& cfg = GetConfig();
  return cfg.enabled && AssignString(cfg.navigatorAppVersion, aValue);
}

bool FrxFingerprintConfig::GetNavigatorProduct(nsAString& aValue) {
  const Config& cfg = GetConfig();
  return cfg.enabled && AssignString(cfg.navigatorProduct, aValue);
}

bool FrxFingerprintConfig::GetNavigatorProductSub(nsAString& aValue) {
  const Config& cfg = GetConfig();
  return cfg.enabled && AssignString(cfg.navigatorProductSub, aValue);
}

bool FrxFingerprintConfig::GetNavigatorVendor(nsAString& aValue) {
  const Config& cfg = GetConfig();
  return cfg.enabled && AssignString(cfg.navigatorVendor, aValue);
}

bool FrxFingerprintConfig::GetNavigatorVendorSub(nsAString& aValue) {
  const Config& cfg = GetConfig();
  return cfg.enabled && AssignString(cfg.navigatorVendorSub, aValue);
}

bool FrxFingerprintConfig::GetNavigatorOscpu(nsAString& aValue) {
  const Config& cfg = GetConfig();
  return cfg.enabled && AssignString(cfg.navigatorOscpu, aValue);
}

bool FrxFingerprintConfig::GetNavigatorBuildID(nsAString& aValue) {
  const Config& cfg = GetConfig();
  return cfg.enabled && AssignString(cfg.navigatorBuildID, aValue);
}

bool FrxFingerprintConfig::GetNavigatorDoNotTrack(nsAString& aValue) {
  const Config& cfg = GetConfig();
  return cfg.enabled && AssignString(cfg.navigatorDoNotTrack, aValue);
}

bool FrxFingerprintConfig::GetNavigatorCookieEnabled(bool* aValue) {
  const Config& cfg = GetConfig();
  return cfg.enabled && AssignNumber(cfg.navigatorCookieEnabled, aValue);
}

bool FrxFingerprintConfig::GetNavigatorPdfViewerEnabled(bool* aValue) {
  const Config& cfg = GetConfig();
  return cfg.enabled && AssignNumber(cfg.navigatorPdfViewerEnabled, aValue);
}

bool FrxFingerprintConfig::GetNavigatorMaxTouchPoints(uint32_t* aValue) {
  const Config& cfg = GetConfig();
  if (!cfg.enabled || cfg.navigatorMaxTouchPoints.isNothing() || !aValue) {
    return false;
  }
  *aValue = uint32_t(cfg.navigatorMaxTouchPoints.value());
  return true;
}

bool FrxFingerprintConfig::GetScreenWidth(int32_t* aValue) {
  const Config& cfg = GetConfig();
  return cfg.enabled && AssignNumber(cfg.screenWidth, aValue);
}

bool FrxFingerprintConfig::GetScreenHeight(int32_t* aValue) {
  const Config& cfg = GetConfig();
  return cfg.enabled && AssignNumber(cfg.screenHeight, aValue);
}

bool FrxFingerprintConfig::GetScreenAvailWidth(int32_t* aValue) {
  const Config& cfg = GetConfig();
  return cfg.enabled && AssignNumber(cfg.screenAvailWidth, aValue);
}

bool FrxFingerprintConfig::GetScreenAvailHeight(int32_t* aValue) {
  const Config& cfg = GetConfig();
  return cfg.enabled && AssignNumber(cfg.screenAvailHeight, aValue);
}

bool FrxFingerprintConfig::GetScreenColorDepth(int32_t* aValue) {
  const Config& cfg = GetConfig();
  return cfg.enabled && AssignNumber(cfg.screenColorDepth, aValue);
}

bool FrxFingerprintConfig::GetScreenPixelDepth(int32_t* aValue) {
  const Config& cfg = GetConfig();
  return cfg.enabled && AssignNumber(cfg.screenPixelDepth, aValue);
}

bool FrxFingerprintConfig::GetDevicePixelRatio(double* aValue) {
  const Config& cfg = GetConfig();
  return cfg.enabled && AssignNumber(cfg.devicePixelRatio, aValue);
}

bool FrxFingerprintConfig::GetIntlLocale(nsACString& aValue) {
  const Config& cfg = GetConfig();
  return cfg.enabled && AssignCString(cfg.intlLocale, aValue);
}

bool FrxFingerprintConfig::GetIntlTimezone(nsAString& aValue) {
  const Config& cfg = GetConfig();
  return cfg.enabled && AssignString(cfg.intlTimezone, aValue);
}

bool FrxFingerprintConfig::GetHttpUserAgent(nsACString& aValue) {
  const Config& cfg = GetConfig();
  DebugLog("GetHttpUserAgent enabled=%d field=%d", cfg.enabled,
           cfg.httpUserAgent.isSome());
  return cfg.enabled && AssignCString(cfg.httpUserAgent, aValue);
}

bool FrxFingerprintConfig::GetHttpAcceptLanguage(nsACString& aValue) {
  const Config& cfg = GetConfig();
  DebugLog("GetHttpAcceptLanguage enabled=%d field=%d", cfg.enabled,
           cfg.httpAcceptLanguage.isSome());
  return cfg.enabled && AssignCString(cfg.httpAcceptLanguage, aValue);
}

bool FrxFingerprintConfig::GetHttpSecChUa(nsACString& aValue) {
  const Config& cfg = GetConfig();
  return cfg.enabled && AssignCString(cfg.httpSecChUa, aValue);
}

bool FrxFingerprintConfig::GetHttpSecChUaMobile(nsACString& aValue) {
  const Config& cfg = GetConfig();
  return cfg.enabled && AssignCString(cfg.httpSecChUaMobile, aValue);
}

bool FrxFingerprintConfig::GetHttpSecChUaPlatform(nsACString& aValue) {
  const Config& cfg = GetConfig();
  return cfg.enabled && AssignCString(cfg.httpSecChUaPlatform, aValue);
}

bool FrxFingerprintConfig::GetHttpSecChUaFullVersionList(
    nsACString& aValue) {
  const Config& cfg = GetConfig();
  return cfg.enabled && AssignCString(cfg.httpSecChUaFullVersionList, aValue);
}

bool FrxFingerprintConfig::GetHttpSecChUaArch(nsACString& aValue) {
  const Config& cfg = GetConfig();
  return cfg.enabled && AssignCString(cfg.httpSecChUaArch, aValue);
}

bool FrxFingerprintConfig::GetHttpSecChUaBitness(nsACString& aValue) {
  const Config& cfg = GetConfig();
  return cfg.enabled && AssignCString(cfg.httpSecChUaBitness, aValue);
}

bool FrxFingerprintConfig::GetHttpSecChUaModel(nsACString& aValue) {
  const Config& cfg = GetConfig();
  return cfg.enabled && AssignCString(cfg.httpSecChUaModel, aValue);
}

bool FrxFingerprintConfig::GetHttpSecChUaPlatformVersion(
    nsACString& aValue) {
  const Config& cfg = GetConfig();
  return cfg.enabled && AssignCString(cfg.httpSecChUaPlatformVersion, aValue);
}

bool FrxFingerprintConfig::GetWebGLUnmaskedVendor(nsACString& aValue) {
  const Config& cfg = GetConfig();
  return cfg.enabled && AssignCString(cfg.webglUnmaskedVendor, aValue);
}

bool FrxFingerprintConfig::GetWebGLUnmaskedRenderer(nsACString& aValue) {
  const Config& cfg = GetConfig();
  return cfg.enabled && AssignCString(cfg.webglUnmaskedRenderer, aValue);
}

}  // namespace mozilla::dom

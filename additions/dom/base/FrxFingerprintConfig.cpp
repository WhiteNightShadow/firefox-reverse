/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "FrxFingerprintConfig.h"
#include "FrxFingerprintSeed.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef XP_WIN
#  include <process.h>
#  include <windows.h>
#  define getpid _getpid
#else
#  include <unistd.h>
#endif

#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "json/json.h"
#include "mozilla/Maybe.h"
#include "mozilla/Preferences.h"
#include "mozilla/RandomNum.h"
#include "mozilla/StaticPrefs_frx.h"
#include "mozilla/Utf8.h"
#include "nsError.h"
#include "nsString.h"
#include "nsThreadUtils.h"
#include "nsXULAppAPI.h"

namespace mozilla::dom {
namespace {

using mozilla::Maybe;
using mozilla::Nothing;
using mozilla::Some;

constexpr size_t kMaxConfigBytes = 1024 * 1024;
constexpr size_t kSnapshotPartBytes = 4000;
constexpr size_t kMaxSnapshotBytes = 4 * kMaxConfigBytes + 4096;
constexpr const char* kSnapshotMetadataPref = "frx.fingerprint.bootstrap.metadata";
constexpr const char* kSnapshotPartPrefix = "frx.fingerprint.bootstrap.part.";

struct EnvironmentValue {
  bool present = false;
  bool valid = true;
  std::string value;
};

EnvironmentValue ReadEnvironment(const char* aName) {
  EnvironmentValue result;
#ifdef XP_WIN
  const std::wstring name(aName, aName + strlen(aName));
  SetLastError(ERROR_SUCCESS);
  const DWORD required = GetEnvironmentVariableW(name.c_str(), nullptr, 0);
  if (!required) {
    const DWORD error = GetLastError();
    result.present = error != ERROR_ENVVAR_NOT_FOUND;
    result.valid = error == ERROR_ENVVAR_NOT_FOUND || error == ERROR_SUCCESS;
    return result;
  }
  result.present = true;
  if (required > kMaxConfigBytes) {
    result.valid = false;
    return result;
  }
  std::wstring wide(required, L'\0');
  const DWORD written = GetEnvironmentVariableW(name.c_str(), wide.data(), required);
  if (!written || written >= required) {
    result.valid = false;
    return result;
  }
  const int bytes = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS,
      wide.data(), int(written), nullptr, 0, nullptr, nullptr);
  if (bytes <= 0 || size_t(bytes) > kMaxConfigBytes) {
    result.valid = false;
    return result;
  }
  result.value.resize(size_t(bytes));
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide.data(), int(written),
          result.value.data(), bytes, nullptr, nullptr) != bytes) {
    result.valid = false;
  }
#else
  const char* value = getenv(aName);
  if (!value) return result;
  result.present = true;
  const size_t length = strlen(value);
  if (length > kMaxConfigBytes) {
    result.valid = false;
    return result;
  }
  result.value.assign(value, length);
#endif
  return result;
}

bool DebugEnabled() {
  static const bool enabled = [] {
    const auto debug = ReadEnvironment("MOZ_FRX_DEBUG_FINGERPRINT");
    return debug.valid && !debug.value.empty() && debug.value != "0";
  }();
  return enabled;
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
  FrxFingerprintConfig::Status status = FrxFingerprintConfig::Status::Absent;
  std::string reason = "not-configured";
  const char* source = "none";
  std::string rawJson;
  std::string configPath;
  Maybe<uint64_t> audioSeed;
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
#ifdef XP_WIN
  const size_t pathLength = strlen(aPath);
  if (!pathLength || pathLength > kMaxConfigBytes) return false;
  const int wideLength = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
      aPath, int(pathLength), nullptr, 0);
  if (wideLength <= 0) return false;
  std::wstring widePath(size_t(wideLength), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, aPath, int(pathLength),
          widePath.data(), wideLength) != wideLength) return false;
  FILE* f = _wfopen(widePath.c_str(), L"rb");
#else
  FILE* f = fopen(aPath, "rb");
#endif
  if (!f) {
    return false;
  }
  char buf[4096];
  while (!feof(f)) {
    size_t n = fread(buf, 1, sizeof(buf), f);
    if (n) {
      aOut.append(buf, n);
      if (aOut.size() > kMaxConfigBytes) {
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

Config InvalidConfig(const char* aReason, const char* aSource) {
  Config config;
  config.status = FrxFingerprintConfig::Status::Invalid;
  config.reason = aReason;
  config.source = aSource;
  return config;
}

bool ParseStrictObject(const std::string& aText, Json::Value& aResult) {
  Json::CharReaderBuilder builder;
  builder["collectComments"] = false;
  builder["allowComments"] = false;
  builder["allowTrailingCommas"] = false;
  builder["failIfExtra"] = true;
  builder["rejectDupKeys"] = true;
  std::string errors;
  std::unique_ptr<Json::CharReader> reader(builder.newCharReader());
  return reader && reader->parse(aText.data(), aText.data() + aText.size(),
                                 &aResult, &errors) && aResult.isObject();
}

std::string HexBytes(const std::string& aValue) {
  constexpr char hex[] = "0123456789abcdef";
  std::string result;
  result.reserve(aValue.size() * 2);
  for (unsigned char value : aValue) {
    result += hex[value >> 4];
    result += hex[value & 15];
  }
  return result;
}

bool UnhexBytes(const Json::Value& aValue, std::string& aResult) {
  if (!aValue.isString()) return false;
  const std::string hex = aValue.asString();
  if (hex.size() % 2 || hex.size() > 2 * kMaxConfigBytes) return false;
  const auto digit = [](char c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    return -1;
  };
  aResult.clear();
  aResult.reserve(hex.size() / 2);
  for (size_t i = 0; i < hex.size(); i += 2) {
    const int high = digit(hex[i]), low = digit(hex[i + 1]);
    if (high < 0 || low < 0) return false;
    aResult += char((high << 4) | low);
  }
  return true;
}

Config ReadParentSnapshot() {
  constexpr const char* source = "parent-snapshot";
  if (!NS_IsMainThread()) {
    return InvalidConfig("parent-snapshot-not-initialized", source);
  }
  const auto token = ReadEnvironment("MOZ_FRX_PARENT_CONFIG_TOKEN");
  if (!token.present || !token.valid || token.value.size() != 32) {
    return InvalidConfig("parent-snapshot-missing", source);
  }
  nsAutoCString metadata;
  if (NS_FAILED(Preferences::GetCString(kSnapshotMetadataPref, metadata,
                                        PrefValueKind::Default))) {
    return InvalidConfig("parent-snapshot-missing", source);
  }
  Json::Value header;
  if (metadata.Length() > kSnapshotPartBytes ||
      !ParseStrictObject(std::string(metadata.get(), metadata.Length()), header) ||
      !header["token"].isString() || header["token"].asString() != token.value ||
      !header["chunks"].isUInt()) {
    return InvalidConfig("parent-snapshot-mismatch", source);
  }
  const unsigned count = header["chunks"].asUInt();
  if (!count || count > (kMaxSnapshotBytes + kSnapshotPartBytes - 1) /
                           kSnapshotPartBytes) {
    return InvalidConfig("parent-snapshot-invalid", source);
  }
  std::string serialized;
  for (unsigned i = 0; i < count; ++i) {
    const std::string name = std::string(kSnapshotPartPrefix) + std::to_string(i);
    nsAutoCString part;
    if (NS_FAILED(Preferences::GetCString(name.c_str(), part,
                                          PrefValueKind::Default)) ||
        part.IsEmpty() || part.Length() > kSnapshotPartBytes ||
        serialized.size() + part.Length() > kMaxSnapshotBytes) {
      return InvalidConfig("parent-snapshot-invalid", source);
    }
    serialized.append(part.get(), part.Length());
  }
  Json::Value envelope;
  Config cfg;
  cfg.source = source;
  if (!ParseStrictObject(serialized, envelope) ||
      !envelope["token"].isString() || envelope["token"].asString() != token.value ||
      !envelope["status"].isUInt() || envelope["status"].asUInt() > 2 ||
      !envelope["reason"].isString() || envelope["reason"].asString().empty() ||
      envelope["reason"].asString().size() > 80 ||
      !envelope["source"].isString() ||
      !UnhexBytes(envelope["jsonHex"], cfg.rawJson) ||
      !UnhexBytes(envelope["pathHex"], cfg.configPath)) {
    return InvalidConfig("parent-snapshot-invalid", source);
  }
  // The launch token binds this snapshot to the parent. Children must not
  // reinterpret inherited environment variables or reopen configuration files.
  cfg.status = FrxFingerprintConfig::Status(envelope["status"].asUInt());
  cfg.reason = envelope["reason"].asString();
  return cfg;
}

enum class ActiveFieldState { Missing, Disabled, Value, Invalid };
struct ActiveField {
  ActiveFieldState state;
  const Json::Value* value = nullptr;
};

ActiveField ReadActiveField(const Json::Value& aObject, const char* aName) {
  if (!aObject.isMember(aName)) return {ActiveFieldState::Missing};
  const Json::Value& field = aObject[aName];
  if (field.isObject()) {
    if (field.isMember("enabled")) {
      if (!field["enabled"].isBool()) return {ActiveFieldState::Invalid};
      if (!field["enabled"].asBool()) return {ActiveFieldState::Disabled};
    }
    if (!field.isMember("value")) return {ActiveFieldState::Invalid};
  }
  return {ActiveFieldState::Value, &FieldValue(field)};
}

bool ReadSurfaceSeed(const Json::Value& aRoot, const char* aName,
                     Maybe<uint64_t>& aSeed, const char*& aReason) {
  if (!aRoot.isMember(aName) || aRoot[aName].isNull()) return true;
  const Json::Value& surface = aRoot[aName];
  if (!surface.isObject()) {
    aReason = "surface-group-invalid";
    return false;
  }
  if (surface.isMember("enabled")) {
    if (!surface["enabled"].isBool()) {
      aReason = "surface-enabled-invalid";
      return false;
    }
    if (!surface["enabled"].asBool()) return true;
  }
  const auto mode = ReadActiveField(surface, "mode");
  if (mode.state == ActiveFieldState::Missing ||
      mode.state == ActiveFieldState::Disabled) return true;
  if (mode.state != ActiveFieldState::Value || !mode.value->isString()) {
    aReason = "surface-mode-invalid";
    return false;
  }
  const std::string modeValue = mode.value->asString();
  if (modeValue == "native") return true;
  if (modeValue != "seeded") {
    aReason = "surface-mode-unsupported";
    return false;
  }
  const auto seed = ReadActiveField(surface, "seed");
  if (seed.state == ActiveFieldState::Disabled) return true;
  if (strcmp(aName, "canvas") == 0) {
    aReason = "canvas-seeded-unsupported";
    return false;
  }
  if (!aRoot["seed_mode"].isString() ||
      aRoot["seed_mode"].asString() != "persistent") {
    aReason = "surface-seed-mode-invalid";
    return false;
  }
  const auto scope = ReadActiveField(surface, "scope");
  if (scope.state == ActiveFieldState::Invalid ||
      (scope.state == ActiveFieldState::Value &&
       (!scope.value->isString() || scope.value->asString() != "profile"))) {
    aReason = "surface-scope-invalid";
    return false;
  }
  for (const char* name : {"sampleRate", "noise", "baseLatency", "outputLatency"}) {
    const auto extra = ReadActiveField(surface, name);
    if (extra.state == ActiveFieldState::Invalid ||
        (extra.state == ActiveFieldState::Value && !extra.value->isNull())) {
      aReason = "audio-seeded-options-conflict";
      return false;
    }
  }
  if (seed.state != ActiveFieldState::Value || !seed.value->isString()) {
    aReason = "surface-seed-invalid";
    return false;
  }
  // Wrapped active values must explicitly enable their seed. A plain 64-hex
  // key is retained for the documented native configuration form.
  if (surface["seed"].isObject() && !surface["seed"]["enabled"].isBool()) {
    aReason = "surface-seed-enabled-invalid";
    return false;
  }
  const std::string hex = seed.value->asString();
  uint64_t value = 0;
  if (!frx::ParseSurfaceSeed(hex.data(), hex.size(), &value)) {
    aReason = "surface-seed-invalid";
    return false;
  }
  aSeed = Some(value);
  return true;
}

Config LoadConfig() {
  Config cfg;
  std::string text;
  std::string configPath;
  const auto managedId = ReadEnvironment("MOZ_FRX_ENV_ID");
  const auto legacyManagedId = ReadEnvironment("FRX_ENV_ID");
  const bool managed = managedId.present || legacyManagedId.present;
  const auto inlineJson = ReadEnvironment("MOZ_FRX_FINGERPRINT_JSON");
  const auto environmentPath = ReadEnvironment("MOZ_FRX_FINGERPRINT_CONFIG");
  bool parentSnapshot = false;
  const auto invalid = [&](const char* aReason) {
    Config failed = InvalidConfig(aReason, cfg.source);
    // An oversized unreadable source still needs a bounded Invalid snapshot.
    failed.rawJson = text.substr(0, kMaxConfigBytes);
    failed.configPath = configPath.substr(0, kMaxConfigBytes);
    return failed;
  };

  // The launcher snapshot wins, even when a file or saved preference differs.
  // A malformed explicit source is never an invitation to try another source.
  if (XRE_IsContentProcess()) {
    cfg = ReadParentSnapshot();
    if (cfg.status != FrxFingerprintConfig::Status::Loaded) return cfg;
    text = cfg.rawJson;
    configPath = cfg.configPath;
    parentSnapshot = true;
  } else if (inlineJson.present) {
    cfg.source = "environment-json";
    text = inlineJson.value;
    if (!inlineJson.valid || inlineJson.value.empty()) {
      return invalid("explicit-json-invalid");
    }
  } else if (environmentPath.present) {
    cfg.source = "environment-file-once";
    configPath = environmentPath.value;
    if (!environmentPath.valid || environmentPath.value.empty()) {
      return invalid("explicit-path-invalid");
    }
  } else {
    // DataMutexString mirrors are safe for worker readers. Do not fall through
    // to main-thread Preferences access or a global .current-process file.
    auto prefJson = mozilla::StaticPrefs::frx_fingerprint_config_json();
    if (!prefJson->IsEmpty()) {
      cfg.source = "profile-preference-json";
      text.assign(prefJson->get(), prefJson->Length());
    } else {
      auto prefPath = mozilla::StaticPrefs::frx_fingerprint_config_path();
      if (!prefPath->IsEmpty()) {
        cfg.source = "profile-preference-file-once";
        configPath.assign(prefPath->get(), prefPath->Length());
      }
    }
  }

  if (!parentSnapshot && !configPath.empty()) {
#ifdef XP_WIN
    const bool absolute = (configPath.size() >= 3 &&
        ((configPath[0] >= 'A' && configPath[0] <= 'Z') ||
         (configPath[0] >= 'a' && configPath[0] <= 'z')) &&
        configPath[1] == ':' && (configPath[2] == '\\' || configPath[2] == '/')) ||
        (configPath.size() >= 2 && configPath[0] == '\\' && configPath[1] == '\\');
#else
    const bool absolute = configPath[0] == '/';
#endif
    if (!absolute) return invalid("configuration-path-not-absolute");
    if (!ReadFile(configPath.c_str(), text) || text.empty()) {
      return invalid("configuration-file-unreadable");
    }
  }
  if (text.empty()) {
    return managed ? invalid("managed-configuration-missing") : cfg;
  }
  cfg.rawJson = text;
  cfg.configPath = configPath;
  if (text.size() > kMaxConfigBytes ||
      !mozilla::IsUtf8(mozilla::Span<const char>(text.data(), text.size()))) {
    return invalid("configuration-encoding-invalid");
  }

  Json::Value root;
  if (!ParseStrictObject(text, root)) {
    return invalid("configuration-json-invalid");
  }

  const Json::Value& enabled = root["enabled"];
  if (!enabled.isBool()) return invalid("configuration-enabled-invalid");
  cfg.status = FrxFingerprintConfig::Status::Loaded;
  cfg.reason = enabled.asBool() ? "loaded" : "disabled";
  if (!enabled.asBool()) return cfg;
  const bool hasPolicy = root.isMember("consistency");
  const Json::Value& policy = root["consistency"];
  if (hasPolicy &&
      (!policy.isObject() || !policy["mode"].isString() ||
       (policy["mode"] != "native-consistent" && policy["mode"] != "legacy") ||
       !policy["version"].isInt() || policy["version"].asInt() != 1)) {
    return invalid("consistency-policy-invalid");
  }
  const bool nativeConsistent = root["consistency"].isObject() &&
      root["consistency"]["mode"] == "native-consistent";
  if (nativeConsistent) {
    for (const char* name : {"navigator", "screen", "window", "intl", "http",
                             "webgl", "canvas", "audio", "fonts"}) {
      if (!root.isMember(name)) continue;
      const Json::Value& group = root[name];
      if (!group.isObject() ||
          (group.isMember("enabled") && !group["enabled"].isBool())) {
        return invalid("native-group-invalid");
      }
    }
  }
  const char* seedReason = "surface-seed-invalid";
  Maybe<uint64_t> unusedCanvasSeed;
  // Legacy surface metadata had no consumer. Never activate it implicitly.
  if (nativeConsistent &&
      (!ReadSurfaceSeed(root, "canvas", unusedCanvasSeed, seedReason) ||
       !ReadSurfaceSeed(root, "audio", cfg.audioSeed, seedReason))) {
    return invalid(seedReason);
  }
  cfg.enabled = true;

  const Json::Value nativeDisplay;
  const Json::Value& constRoot = root;
  const auto configGroup = [&](const char* name) -> const Json::Value& {
    const Json::Value& group = constRoot[name];
    return nativeConsistent && !FieldEnabled(group) ? nativeDisplay : group;
  };
  const auto canFallback = [&](const char* name, const char* field) {
    return !nativeConsistent ||
           (FieldEnabled(constRoot[name]) && FieldEnabled(constRoot[name][field]));
  };
  const Json::Value& nav = configGroup("navigator");
  const Json::Value& screen = nativeConsistent ? nativeDisplay : root["screen"];
  const Json::Value& window = nativeConsistent ? nativeDisplay : root["window"];
  const Json::Value& intl = configGroup("intl");
  const Json::Value& http = configGroup("http");
  const Json::Value& webgl = nativeConsistent ? nativeDisplay : root["webgl"];

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
  if (!nativeConsistent && cfg.devicePixelRatio.isNothing()) {
    cfg.devicePixelRatio =
        ReadDoubleField(root, "devicePixelRatio", 0.1, 10.0);
  }

  cfg.intlLocale = ReadStringField(intl, "locale");
  if (cfg.intlLocale.isNothing() && canFallback("intl", "locale")) {
    cfg.intlLocale = ReadStringField(root["locale"], "value");
  }
  cfg.intlTimezone = ReadStringField(intl, "timezone");
  if (cfg.intlTimezone.isNothing() && canFallback("intl", "timezone")) {
    cfg.intlTimezone = ReadStringField(root["timezone"], "value");
  }

  cfg.httpUserAgent = ReadStringField(http, "userAgent");
  cfg.httpAcceptLanguage = ReadStringField(http, "acceptLanguage");
  if (!nativeConsistent) {
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
  }
  if (nativeConsistent) {
    for (const auto* userAgent : {&cfg.navigatorUserAgent, &cfg.httpUserAgent}) {
      if (userAgent->isSome() &&
          (userAgent->value().find("Firefox/") == std::string::npos ||
           userAgent->value().find("Chrome/") != std::string::npos)) {
        return invalid("native-firefox-identity-required");
      }
    }
  }
  cfg.webglUnmaskedVendor = ReadStringField(webgl, "unmaskedVendor");
  cfg.webglUnmaskedRenderer = ReadStringField(webgl, "unmaskedRenderer");

  if (cfg.navigatorLanguage.isNothing() && !cfg.navigatorLanguages.empty() &&
      canFallback("navigator", "language")) {
    cfg.navigatorLanguage = Some(cfg.navigatorLanguages[0]);
  }
  if (cfg.intlLocale.isNothing() && cfg.navigatorLanguage.isSome() &&
      canFallback("intl", "locale")) {
    cfg.intlLocale = Some(cfg.navigatorLanguage.value());
  }
  if (cfg.httpUserAgent.isNothing() && cfg.navigatorUserAgent.isSome() &&
      canFallback("http", "userAgent")) {
    cfg.httpUserAgent = Some(cfg.navigatorUserAgent.value());
  }
  if (cfg.httpAcceptLanguage.isNothing() && !cfg.navigatorLanguages.empty() &&
      canFallback("http", "acceptLanguage")) {
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
  // C++ static initialization publishes one immutable snapshot to every reader.
  // Invalid and absent states are cached too: no getter-time I/O or late switch
  // to a different environment after the first global has been created.
  static const Config config = [] {
    Config loaded = LoadConfig();
    DebugLog("status=%u reason=%s source=%s", unsigned(loaded.status),
             loaded.reason.c_str(), loaded.source);
    return loaded;
  }();
  return config;
}

struct SnapshotPublication {
  std::string token;
  std::string metadata;
  std::vector<std::string> parts;
};

const SnapshotPublication& ParentSnapshotPublication() {
  static const SnapshotPublication publication = [] {
    SnapshotPublication result;
    const Config& cfg = GetConfig();
    char random[16];
    if (!mozilla::GenerateRandomBytesFromOS(random, sizeof(random))) return result;
    result.token = HexBytes(std::string(random, sizeof(random)));
    Json::Value envelope;
    envelope["token"] = result.token;
    envelope["status"] = unsigned(cfg.status);
    envelope["reason"] = cfg.reason;
    envelope["source"] = cfg.source;
    // Hex makes every preference fragment ASCII, including split UTF-8 paths
    // and invalid input bytes; values remain below libpref's 4 KiB IPC limit.
    envelope["jsonHex"] = HexBytes(cfg.rawJson);
    envelope["pathHex"] = HexBytes(cfg.configPath);
    Json::StreamWriterBuilder writer;
    writer["indentation"] = "";
    const std::string serialized = Json::writeString(writer, envelope);
    if (serialized.size() > kMaxSnapshotBytes) return SnapshotPublication{};
    for (size_t i = 0; i < serialized.size(); i += kSnapshotPartBytes) {
      result.parts.push_back(serialized.substr(i, kSnapshotPartBytes));
    }
    Json::Value header;
    header["token"] = result.token;
    header["chunks"] = unsigned(result.parts.size());
    result.metadata = Json::writeString(writer, header);
    return result;
  }();
  return publication;
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

FrxFingerprintConfig::Status FrxFingerprintConfig::GetStatus() {
  return GetConfig().status;
}

void FrxFingerprintConfig::GetStatusReason(nsACString& aValue) {
  aValue.Assign(GetConfig().reason.c_str());
}

bool FrxFingerprintConfig::PrepareContentSnapshot(nsACString& aLaunchToken) {
  if (!XRE_IsParentProcess() || !NS_IsMainThread()) return false;
  const auto& snapshot = ParentSnapshotPublication();
  if (snapshot.token.empty() || snapshot.parts.empty()) return false;
  for (size_t i = 0; i < snapshot.parts.size(); ++i) {
    const std::string name = std::string(kSnapshotPartPrefix) + std::to_string(i);
    if (NS_FAILED(Preferences::ClearUser(name.c_str())) ||
        NS_FAILED(Preferences::SetCString(name.c_str(), snapshot.parts[i].c_str(),
                                          PrefValueKind::Default))) return false;
  }
  // Publish the header last. These default-branch values never enter prefs.js;
  // clear a stale user override in this reserved namespace before serialization.
  if (NS_FAILED(Preferences::ClearUser(kSnapshotMetadataPref)) ||
      NS_FAILED(Preferences::SetCString(kSnapshotMetadataPref,
                                        snapshot.metadata.c_str(),
                                        PrefValueKind::Default))) return false;
  aLaunchToken.Assign(snapshot.token.c_str());
  return true;
}

void FrxFingerprintConfig::GetConfigSource(nsACString& aValue) {
  aValue.Assign(GetConfig().source);
}

bool FrxFingerprintConfig::GetSurfaceSeed(const char* aSurface, uint64_t* aValue) {
  if (!aSurface || !aValue || strcmp(aSurface, "audio") != 0) return false;
  const Config& cfg = GetConfig();
  return cfg.enabled && cfg.status == Status::Loaded &&
         AssignNumber(cfg.audioSeed, aValue);
}

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

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "NavigatorUAData.h"

#include <string>
#include <utility>
#include <vector>

#include "mozilla/dom/FrxFingerprintConfig.h"
#include "mozilla/dom/NavigatorUADataBinding.h"
#include "mozilla/dom/Promise.h"
#include "nsIGlobalObject.h"

namespace mozilla::dom {

namespace {

std::string ToStdString(const nsACString& aValue) {
  return std::string(aValue.BeginReading(), aValue.Length());
}

std::string Trim(std::string aValue) {
  while (!aValue.empty() &&
         (aValue.front() == ' ' || aValue.front() == '\t')) {
    aValue.erase(aValue.begin());
  }
  while (!aValue.empty() &&
         (aValue.back() == ' ' || aValue.back() == '\t')) {
    aValue.pop_back();
  }
  return aValue;
}

std::string Unquote(std::string aValue) {
  aValue = Trim(std::move(aValue));
  if (aValue.size() >= 2 && aValue.front() == '"' && aValue.back() == '"') {
    aValue = aValue.substr(1, aValue.size() - 2);
  }
  return aValue;
}

std::vector<std::pair<std::string, std::string>> ParseBrandHeader(
    const nsACString& aHeader) {
  std::vector<std::pair<std::string, std::string>> out;
  const std::string header = ToStdString(aHeader);
  size_t pos = 0;
  while (pos < header.size()) {
    const size_t brandStart = header.find('"', pos);
    if (brandStart == std::string::npos) {
      break;
    }
    const size_t brandEnd = header.find('"', brandStart + 1);
    if (brandEnd == std::string::npos) {
      break;
    }
    const size_t versionKey = header.find("v=\"", brandEnd + 1);
    if (versionKey == std::string::npos) {
      break;
    }
    const size_t versionStart = versionKey + 3;
    const size_t versionEnd = header.find('"', versionStart);
    if (versionEnd == std::string::npos) {
      break;
    }
    out.emplace_back(header.substr(brandStart + 1, brandEnd - brandStart - 1),
                     header.substr(versionStart, versionEnd - versionStart));
    pos = versionEnd + 1;
  }
  return out;
}

template <typename BrandArray>
void AppendBrands(const nsACString& aHeader, BrandArray& aBrands) {
  for (const auto& item : ParseBrandHeader(aHeader)) {
    NavigatorUABrandVersion* brand = aBrands.AppendElement(fallible);
    if (!brand) {
      continue;
    }
    brand->mBrand = NS_ConvertUTF8toUTF16(item.first);
    brand->mVersion = NS_ConvertUTF8toUTF16(item.second);
  }
}

void AssignUnquoted(nsAString& aTarget, const nsACString& aSource) {
  aTarget = NS_ConvertUTF8toUTF16(Unquote(ToStdString(aSource)));
}

nsString UnquotedString(const nsACString& aSource) {
  return NS_ConvertUTF8toUTF16(Unquote(ToStdString(aSource)));
}

bool GetLowEntropyBrandHeader(nsACString& aHeader) {
  return FrxFingerprintConfig::GetHttpSecChUa(aHeader) && !aHeader.IsEmpty();
}

bool GetFullVersionBrandHeader(nsACString& aHeader) {
  return FrxFingerprintConfig::GetHttpSecChUaFullVersionList(aHeader) &&
         !aHeader.IsEmpty();
}

nsString FirstFullVersion(const nsACString& aFullVersionHeader) {
  auto brands = ParseBrandHeader(aFullVersionHeader);
  for (const auto& item : brands) {
    if (item.first == "Google Chrome" || item.first == "Chromium") {
      return NS_ConvertUTF8toUTF16(item.second);
    }
  }
  if (!brands.empty()) {
    return NS_ConvertUTF8toUTF16(brands.front().second);
  }
  return u""_ns;
}

bool MobileValue() {
  nsAutoCString mobile;
  if (!FrxFingerprintConfig::GetHttpSecChUaMobile(mobile)) {
    return false;
  }
  return mobile.EqualsLiteral("?1") || mobile.EqualsLiteral("1") ||
         mobile.EqualsLiteral("true");
}

void FillValues(NavigatorUADataValues& aResult) {
  nsAutoCString brands;
  if (GetLowEntropyBrandHeader(brands)) {
    AppendBrands(brands, aResult.mBrands);
  }

  aResult.mMobile = MobileValue();

  nsAutoCString platform;
  if (FrxFingerprintConfig::GetHttpSecChUaPlatform(platform)) {
    aResult.mPlatform = UnquotedString(platform);
  }

  nsAutoCString arch;
  if (FrxFingerprintConfig::GetHttpSecChUaArch(arch)) {
    aResult.mArchitecture = UnquotedString(arch);
  }

  nsAutoCString bitness;
  if (FrxFingerprintConfig::GetHttpSecChUaBitness(bitness)) {
    aResult.mBitness = UnquotedString(bitness);
  }

  nsAutoCString fullVersionList;
  if (GetFullVersionBrandHeader(fullVersionList)) {
    AppendBrands(fullVersionList, aResult.mFullVersionList);
    aResult.mUaFullVersion = FirstFullVersion(fullVersionList);
  }

  nsAutoCString model;
  if (FrxFingerprintConfig::GetHttpSecChUaModel(model)) {
    aResult.mModel = UnquotedString(model);
  }

  nsAutoCString platformVersion;
  if (FrxFingerprintConfig::GetHttpSecChUaPlatformVersion(platformVersion)) {
    aResult.mPlatformVersion = UnquotedString(platformVersion);
  }

  aResult.mWow64 = false;
}

}  // namespace

NS_IMPL_CYCLE_COLLECTION_WRAPPERCACHE(NavigatorUAData, mGlobal)
NS_IMPL_CYCLE_COLLECTING_ADDREF(NavigatorUAData)
NS_IMPL_CYCLE_COLLECTING_RELEASE(NavigatorUAData)
NS_INTERFACE_MAP_BEGIN_CYCLE_COLLECTION(NavigatorUAData)
  NS_WRAPPERCACHE_INTERFACE_MAP_ENTRY
  NS_INTERFACE_MAP_ENTRY(nsISupports)
NS_INTERFACE_MAP_END

NavigatorUAData::NavigatorUAData(nsIGlobalObject* aGlobal) : mGlobal(aGlobal) {}

NavigatorUAData::~NavigatorUAData() = default;

JSObject* NavigatorUAData::WrapObject(JSContext* aCx,
                                      JS::Handle<JSObject*> aGivenProto) {
  return NavigatorUAData_Binding::Wrap(aCx, this, aGivenProto);
}

bool NavigatorUAData::IsEnabled(JSContext* aCx, JSObject* aGlobal) {
  nsAutoCString secChUa;
  if (GetLowEntropyBrandHeader(secChUa)) {
    return true;
  }

  nsAutoString userAgent;
  if (FrxFingerprintConfig::GetNavigatorUserAgent(userAgent) &&
      userAgent.Find(u"Chrome/"_ns) >= 0) {
    return true;
  }

  return false;
}

void NavigatorUAData::GetBrands(
    nsTArray<NavigatorUABrandVersion>& aBrands) const {
  nsAutoCString brands;
  if (GetLowEntropyBrandHeader(brands)) {
    AppendBrands(brands, aBrands);
  }
}

bool NavigatorUAData::Mobile() const { return MobileValue(); }

void NavigatorUAData::GetPlatform(nsAString& aPlatform) const {
  nsAutoCString platform;
  if (FrxFingerprintConfig::GetHttpSecChUaPlatform(platform)) {
    AssignUnquoted(aPlatform, platform);
    return;
  }
  aPlatform.Truncate();
}

already_AddRefed<Promise> NavigatorUAData::GetHighEntropyValues(
    const Sequence<nsString>& aHints, ErrorResult& aRv) const {
  if (!mGlobal) {
    aRv.Throw(NS_ERROR_UNEXPECTED);
    return nullptr;
  }

  RefPtr<Promise> promise = Promise::Create(mGlobal, aRv);
  if (NS_WARN_IF(aRv.Failed())) {
    return nullptr;
  }

  NavigatorUADataValues values;
  FillValues(values);
  promise->MaybeResolve(values);
  return promise.forget();
}

void NavigatorUAData::ToJSON(NavigatorUADataValues& aResult) const {
  FillValues(aResult);
}

}  // namespace mozilla::dom

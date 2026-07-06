/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_dom_NavigatorUAData_h
#define mozilla_dom_NavigatorUAData_h

#include "js/TypeDecls.h"
#include "mozilla/AlreadyAddRefed.h"
#include "mozilla/dom/BindingDeclarations.h"
#include "nsCOMPtr.h"
#include "nsISupports.h"
#include "nsString.h"
#include "nsWrapperCache.h"

class nsIGlobalObject;

namespace mozilla {
class ErrorResult;

namespace dom {

class Promise;
struct NavigatorUABrandVersion;
struct NavigatorUADataValues;

class NavigatorUAData final : public nsISupports, public nsWrapperCache {
 public:
  explicit NavigatorUAData(nsIGlobalObject* aGlobal);

  NS_DECL_CYCLE_COLLECTING_ISUPPORTS
  NS_DECL_CYCLE_COLLECTION_WRAPPERCACHE_CLASS(NavigatorUAData)

  nsIGlobalObject* GetParentObject() const { return mGlobal; }

  JSObject* WrapObject(JSContext* aCx,
                       JS::Handle<JSObject*> aGivenProto) override;

  static bool IsEnabled(JSContext* aCx, JSObject* aGlobal);

  void GetBrands(nsTArray<NavigatorUABrandVersion>& aBrands) const;
  bool Mobile() const;
  void GetPlatform(nsAString& aPlatform) const;
  already_AddRefed<Promise> GetHighEntropyValues(
      const Sequence<nsString>& aHints, ErrorResult& aRv) const;
  void ToJSON(NavigatorUADataValues& aResult) const;

 private:
  ~NavigatorUAData();

  nsCOMPtr<nsIGlobalObject> mGlobal;
};

}  // namespace dom
}  // namespace mozilla

#endif  // mozilla_dom_NavigatorUAData_h

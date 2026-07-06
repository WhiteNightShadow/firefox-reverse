/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

dictionary NavigatorUABrandVersion {
  required DOMString brand;
  required DOMString version;
};

dictionary NavigatorUADataValues {
  required sequence<NavigatorUABrandVersion> brands;
  required boolean mobile;
  required DOMString platform;
  required DOMString architecture;
  required DOMString bitness;
  required sequence<NavigatorUABrandVersion> fullVersionList;
  required DOMString model;
  required DOMString platformVersion;
  required DOMString uaFullVersion;
  required boolean wow64;
};

[Func="NavigatorUAData::IsEnabled", Exposed=(Window,Worker)]
interface NavigatorUAData {
  [Pure, Cached, Frozen]
  readonly attribute sequence<NavigatorUABrandVersion> brands;
  readonly attribute boolean mobile;
  readonly attribute DOMString platform;
  [NewObject]
  Promise<NavigatorUADataValues> getHighEntropyValues(sequence<DOMString> hints);
  NavigatorUADataValues toJSON();
};

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef FrxMacAppDataPolicy_h
#define FrxMacAppDataPolicy_h

namespace mozilla::frx {

enum class AppDataFailure { None, AccessDenied, Other };

// A denied stat is not evidence that a user's old data does not exist.
constexpr bool CanUsePrivateAppData(AppDataFailure failure,
                                    bool legacyKnownAbsent,
                                    bool existingPrivateProfile) {
  return failure == AppDataFailure::AccessDenied &&
         (legacyKnownAbsent || existingPrivateProfile);
}

}  // namespace mozilla::frx
#endif

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef FrxMacAppDataPolicy_h
#define FrxMacAppDataPolicy_h

namespace mozilla::frx {

enum class AppDataFailure { None, AccessDenied, Other };

// macOS 27 denies non-Mozilla apps the Firefox data root by name. Only that
// access denial switches roots; disk, I/O and file-type failures never do.
constexpr bool CanUsePrivateAppData(AppDataFailure failure) {
  return failure == AppDataFailure::AccessDenied;
}

// A denied stat is not evidence that a user's old data does not exist: when a
// new private profile starts while the old root may hold data, say so once.
constexpr bool NeedsLegacyDataNotice(bool legacyKnownAbsent,
                                     bool existingPrivateProfile) {
  return !legacyKnownAbsent && !existingPrivateProfile;
}

}  // namespace mozilla::frx
#endif

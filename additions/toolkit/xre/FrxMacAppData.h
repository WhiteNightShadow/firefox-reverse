/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef FrxMacAppData_h
#define FrxMacAppData_h

#include "FrxMacAppDataPolicy.h"
#include "nsINIParser.h"
#include "prio.h"

namespace mozilla::frx {

inline nsresult CheckAppDataDirectory(nsIFile* file) {
  bool directory = false;
  nsresult rv = file->IsDirectory(&directory);
  return NS_SUCCEEDED(rv) && !directory ? NS_ERROR_FILE_NOT_DIRECTORY : rv;
}

inline nsresult CreateAppDataDirectory(nsIFile* file) {
  nsresult rv = file->Create(nsIFile::DIRECTORY_TYPE, 0700);
  if (rv != NS_ERROR_FILE_ALREADY_EXISTS) {
    return rv;
  }
  return CheckAppDataDirectory(file);
}

inline nsresult AppDataChild(nsIFile* root, const nsACString& leaf,
                             nsIFile** result) {
  nsCOMPtr<nsIFile> child;
  MOZ_TRY(root->Clone(getter_AddRefs(child)));
  MOZ_TRY(child->AppendNative(leaf));
  child.forget(result);
  return NS_OK;
}

inline nsresult PrivateProfileState(nsIFile* root, bool* found) {
  *found = false;
  nsCOMPtr<nsIFile> ini;
  nsresult rv = CheckAppDataDirectory(root);
  if (rv == NS_ERROR_FILE_NOT_FOUND) {
    return NS_OK;
  }
  MOZ_TRY(rv);
  MOZ_TRY(AppDataChild(root, "profiles.ini"_ns, getter_AddRefs(ini)));
  bool file = false;
  rv = ini->IsFile(&file);
  if (rv == NS_ERROR_FILE_NOT_FOUND) {
    return NS_OK;
  }
  MOZ_TRY(rv);
  NS_ENSURE_TRUE(file, NS_ERROR_FILE_NOT_DIRECTORY);
  nsINIParser parser;
  bool errors = false;
  MOZ_TRY(parser.Init(ini, &errors));
  NS_ENSURE_TRUE(!errors, NS_ERROR_FILE_CORRUPTED);
  MOZ_TRY(parser.GetSections([&](const char* section) {
    nsAutoCString path;
    if (StringBeginsWith(nsDependentCString(section), "Profile"_ns) &&
        NS_SUCCEEDED(parser.GetString(section, "Path", path)) &&
        !path.IsEmpty()) {
      *found = true;
    }
    return !*found;
  }));
  return *found ? NS_OK : NS_ERROR_FILE_CORRUPTED;
}

// Explicit MOZ_APP_DATA and application Profile overrides bypass this helper.
// The marker stores a selection, not a migration: no profiles are copied/deleted.
inline nsresult ResolveMacAppData(nsIFile* legacy,
                                  nsCOMPtr<nsIFile>& selected) {
  nsCOMPtr<nsIFile> alternate;
  MOZ_TRY(legacy->GetParent(getter_AddRefs(alternate)));
  MOZ_TRY(alternate->AppendNative("FirefoxReverse"_ns));
  nsCOMPtr<nsIFile> marker;
  MOZ_TRY(AppDataChild(alternate, ".frx-appdata-v1"_ns,
                      getter_AddRefs(marker)));
  bool markerFile = false;
  nsresult markerRv = marker->IsFile(&markerFile);
  if (NS_SUCCEEDED(markerRv)) {
    bool symlink = false;
    int64_t size = -1;
    MOZ_TRY(marker->IsSymlink(&symlink));
    MOZ_TRY(marker->GetFileSize(&size));
    NS_ENSURE_TRUE(markerFile && !symlink && size == 0,
                   NS_ERROR_FILE_CORRUPTED);
    MOZ_TRY(CheckAppDataDirectory(alternate));
    selected = alternate;
    return NS_OK;
  }
  // An unreadable selection must not be mistaken for an absent selection.
  NS_ENSURE_TRUE(markerRv == NS_ERROR_FILE_NOT_FOUND, markerRv);

  nsresult before = CheckAppDataDirectory(legacy);
  nsresult rv = before;
  if (before == NS_ERROR_FILE_NOT_FOUND || NS_SUCCEEDED(before)) {
    rv = CreateAppDataDirectory(legacy);
  }
  if (NS_SUCCEEDED(rv)) {
    nsCOMPtr<nsIFile> ini;
    MOZ_TRY(AppDataChild(legacy, "profiles.ini"_ns, getter_AddRefs(ini)));
    // OpenANSIFileDesc collapses ENOENT and EPERM to NS_ERROR_FAILURE.
    // NSPR preserves both, which is essential for first-run compatibility.
    PRFileDesc* stream = nullptr;
    rv = ini->OpenNSPRFileDesc(PR_RDONLY, 0, &stream);
    if (NS_SUCCEEDED(rv)) {
      PR_Close(stream);
    } else if (rv == NS_ERROR_FILE_NOT_FOUND) {
      rv = NS_OK;
    }
  }
  if (NS_SUCCEEDED(rv)) {
    selected = legacy;
    return NS_OK;
  }

  const auto failure = rv == NS_ERROR_FILE_ACCESS_DENIED
                           ? AppDataFailure::AccessDenied
                           : AppDataFailure::Other;
  bool existingPrivateProfile = false;
  if (failure == AppDataFailure::AccessDenied) {
    MOZ_TRY(PrivateProfileState(alternate, &existingPrivateProfile));
  }
  if (!CanUsePrivateAppData(failure, before == NS_ERROR_FILE_NOT_FOUND,
                           existingPrivateProfile)) {
    PR_fprintf(PR_STDERR,
               "Firefox Reverse: default macOS app-data directory unavailable "
               "(0x%08x); no automatic empty-profile fallback. Preserve your "
               "data; use the read-only startup diagnostic.\n",
               static_cast<unsigned>(rv));
    return rv;
  }
  // PrivateProfileState rejected unreadable/malformed registries above.
  MOZ_TRY(CreateAppDataDirectory(alternate));
  rv = marker->Create(nsIFile::NORMAL_FILE_TYPE, 0600);
  NS_ENSURE_TRUE(NS_SUCCEEDED(rv) || rv == NS_ERROR_FILE_ALREADY_EXISTS, rv);
  selected = alternate;
  PR_fprintf(PR_STDERR,
             "Firefox Reverse: using independent macOS app-data directory "
             "FirefoxReverse; existing profiles are retained in place.\n");
  return NS_OK;
}

}  // namespace mozilla::frx
#endif

/* Test-only dyld interposition; never copied into the application or package. */
#include <CoreServices/CoreServices.h>
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static OSStatus fixture_folder(SInt16 domain, OSType kind, Boolean create,
                               FSRef* output) {
  const char* base = getenv("FRX_TEST_APPDATA_BASE");
  if (base && domain == kUserDomain &&
      (kind == kApplicationSupportFolderType || kind == kCachedDataFolderType)) {
    char path[PATH_MAX];
    int count = snprintf(path, sizeof(path), "%s/%s", base,
                         kind == kApplicationSupportFolderType ? "support" : "cache");
    if (count < 0 || (size_t)count >= sizeof(path)) _exit(95);
    fprintf(stderr, "FRX_TEST_APPDATA: redirected %s\n",
            kind == kApplicationSupportFolderType ? "support" : "cache");
    return FSPathMakeRef((const UInt8*)path, output, NULL);
  }
  return FSFindFolder(domain, kind, create, output);
}

static int fixture_mkdir(const char* path, mode_t mode) {
  const char* base = getenv("FRX_TEST_APPDATA_BASE");
  const char* fault = getenv("FRX_TEST_MKDIR_ERRNO");
  if (base) {
    char target[PATH_MAX];
    snprintf(target, sizeof(target), "%s/support/Firefox", base);
    int number = fault ? atoi(fault) : 0;
    if (strcmp(path, target) == 0 &&
        (number == ENOSPC || number == EIO || number == EROFS)) {
      fprintf(stderr, "FRX_TEST_APPDATA: mkdir errno=%d\n", number);
      errno = number;
      return -1;
    }
    if (strcmp(path, target) == 0) {
      int result = mkdir(path, mode);
      int saved = errno;
      if (result < 0 && (saved == EPERM || saved == EACCES)) {
        fprintf(stderr, "FRX_TEST_APPDATA: legacy mkdir denied=%d\n", saved);
      }
      errno = saved;
      return result;
    }
  }
  return mkdir(path, mode);
}

__attribute__((used, section("__DATA,__interpose")))
static const struct { const void* replacement; const void* original; } bindings[] = {
  {(const void*)fixture_folder, (const void*)FSFindFolder},
  {(const void*)fixture_mkdir, (const void*)mkdir},
};

#include "FrxMacAppDataPolicy.h"
#include <cassert>
#include <cstdio>
#include <initializer_list>

int main() {
  using namespace mozilla::frx;
  unsigned checked = 0;
  // Only an access denial switches to the private root; other failures stop.
  for (auto failure : {AppDataFailure::None, AppDataFailure::Other}) {
    assert(!CanUsePrivateAppData(failure));
    ++checked;
  }
  assert(CanUsePrivateAppData(AppDataFailure::AccessDenied));
  ++checked;
  // Order: neither proof, existing private profile, known absent, both proofs.
  // Notice only when a new private profile starts while old data may exist.
  assert(NeedsLegacyDataNotice(false, false));
  assert(!NeedsLegacyDataNotice(false, true));
  assert(!NeedsLegacyDataNotice(true, false));
  assert(!NeedsLegacyDataNotice(true, true));
  checked += 4;
  std::printf("macOS app-data policy: %u decision cases passed\n", checked);
}

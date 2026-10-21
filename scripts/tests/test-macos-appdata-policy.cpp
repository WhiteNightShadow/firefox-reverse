#include "FrxMacAppDataPolicy.h"
#include <cassert>
#include <cstdio>
#include <initializer_list>

int main() {
  using namespace mozilla::frx;
  unsigned checked = 0;
  // Order: neither proof, existing private profile, known absent, both proofs.
  for (auto failure : {AppDataFailure::None, AppDataFailure::Other}) {
    for (bool absent : {false, true}) {
      for (bool existing : {false, true}) {
        assert(!CanUsePrivateAppData(failure, absent, existing));
        ++checked;
      }
    }
  }
  assert(!CanUsePrivateAppData(AppDataFailure::AccessDenied, false, false));
  assert(CanUsePrivateAppData(AppDataFailure::AccessDenied, false, true));
  assert(CanUsePrivateAppData(AppDataFailure::AccessDenied, true, false));
  assert(CanUsePrivateAppData(AppDataFailure::AccessDenied, true, true));
  checked += 4;
  std::printf("macOS app-data policy: %u decision cases passed\n", checked);
}

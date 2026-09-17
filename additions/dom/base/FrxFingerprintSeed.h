/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

#ifndef mozilla_dom_FrxFingerprintSeed_h
#define mozilla_dom_FrxFingerprintSeed_h

#include <stddef.h>
#include <stdint.h>

namespace mozilla::dom::frx {

// The trusted launcher already derives SHA-256(environment, root, surface).
// Validate the complete key, then consume its first 64 bits in network order.
// No PID, wall clock, process-global RNG state, allocation or locale parsing.
inline bool ParseSurfaceSeed(const char* aHex, size_t aLength, uint64_t* aOut) {
  if (!aHex || !aOut || aLength != 64) {
    return false;
  }
  uint64_t result = 0;
  for (size_t i = 0; i < aLength; ++i) {
    const unsigned char character = static_cast<unsigned char>(aHex[i]);
    uint8_t digit;
    if (character >= '0' && character <= '9') {
      digit = character - '0';
    } else if (character >= 'a' && character <= 'f') {
      digit = character - 'a' + 10;
    } else if (character >= 'A' && character <= 'F') {
      digit = character - 'A' + 10;
    } else {
      return false;
    }
    if (i < 16) {
      result = (result << 4) | digit;
    }
  }
  *aOut = result;
  return true;
}

}  // namespace mozilla::dom::frx

#endif  // mozilla_dom_FrxFingerprintSeed_h

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_dom_FrxOfflineAudioTransform_h
#define mozilla_dom_FrxOfflineAudioTransform_h

#include <cstdint>
#include <cstring>
#include <limits>

namespace mozilla::dom {

// Integer-only, stable mixing. Zero is a valid profile seed. This function has
// no global state, allocation, locking, clock, origin or process identifier.
inline uint64_t FrxOfflineAudioSampleMask(uint64_t aSeed, uint32_t aChannel,
                                          uint64_t aFrame) {
  uint64_t value = aSeed + 0x9e3779b97f4a7c15ULL * (aFrame + 1) +
                   0xd1b54a32d192ed03ULL * (uint64_t(aChannel) + 1);
  value = (value ^ (value >> 30)) * 0xbf58476d1ce4e5b9ULL;
  value = (value ^ (value >> 27)) * 0x94d049bb133111ebULL;
  return value ^ (value >> 31);
}

// Call exactly once for completed, engine-owned OfflineAudioContext PCM before
// publishing its AudioBuffer. A changed normal sample moves by at most one ULP.
// Set, do not XOR, the selected bit: unity replay at the same channel/frame is
// idempotent and cannot undo or accumulate the profile's transformation.
// Never call this from getters or when restoring/detaching JS channel arrays:
// those paths must expose the same underlying data and preserve authored writes.
inline void FrxTransformOfflineAudioChannel(float* aData, uint32_t aLength,
                                           uint32_t aChannel, uint64_t aSeed,
                                           uint64_t aFirstFrame = 0) {
  static_assert(sizeof(float) == sizeof(uint32_t));
  static_assert(std::numeric_limits<float>::is_iec559);
  if (!aData) {
    return;
  }
  for (uint32_t index = 0; index < aLength; ++index) {
    uint32_t bits;
    std::memcpy(&bits, &aData[index], sizeof(bits));
    const uint32_t exponent = (bits >> 23) & 0xff;
    // Preserve positive/negative zero, subnormals, infinity and NaN payloads.
    if (exponent == 0 || exponent == 0xff) {
      continue;
    }
    bits = (bits & ~1u) |
           uint32_t(FrxOfflineAudioSampleMask(aSeed, aChannel,
                                             aFirstFrame + index) & 1);
    std::memcpy(&aData[index], &bits, sizeof(bits));
  }
}

}  // namespace mozilla::dom

#endif  // mozilla_dom_FrxOfflineAudioTransform_h

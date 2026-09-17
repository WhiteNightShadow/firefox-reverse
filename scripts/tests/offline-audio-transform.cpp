#include "FrxOfflineAudioTransform.h"

#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <vector>

using mozilla::dom::FrxTransformOfflineAudioChannel;

static float FloatFromBits(uint32_t bits) {
  float value;
  std::memcpy(&value, &bits, sizeof(value));
  return value;
}
static uint32_t Bits(float value) {
  uint32_t bits;
  std::memcpy(&bits, &value, sizeof(bits));
  return bits;
}
static bool Equal(const std::vector<float>& left, const std::vector<float>& right) {
  return left.size() == right.size() &&
         std::memcmp(left.data(), right.data(), left.size() * sizeof(float)) == 0;
}

int main() {
  const std::array<uint32_t, 8> special = {0u, 0x80000000u, 1u, 0x80000001u,
                                        0x7f800000u, 0xff800000u,
                                        0x7fc00001u, 0xffc12345u};
  std::vector<float> untouched;
  for (auto bits : special) untouched.push_back(FloatFromBits(bits));
  FrxTransformOfflineAudioChannel(untouched.data(), untouched.size(), 0, 0);
  for (size_t i = 0; i < special.size(); ++i) assert(Bits(untouched[i]) == special[i]);

  std::vector<float> original(4096);
  for (size_t i = 0; i < original.size(); ++i) original[i] = float(int(i % 1001) - 500) / 501.0f;
  auto first = original;
  auto repeated = original;
  auto differentSeed = original;
  auto chunked = original;
  FrxTransformOfflineAudioChannel(first.data(), first.size(), 1, 0);
  FrxTransformOfflineAudioChannel(repeated.data(), repeated.size(), 1, 0);
  FrxTransformOfflineAudioChannel(differentSeed.data(), differentSeed.size(), 1, 12345);
  FrxTransformOfflineAudioChannel(chunked.data(), 513, 1, 0, 0);
  FrxTransformOfflineAudioChannel(chunked.data() + 513, chunked.size() - 513, 1, 0, 513);
  assert(Equal(first, repeated));
  assert(Equal(first, chunked));
  assert(!Equal(first, original));
  assert(!Equal(first, differentSeed));
  auto replayed = first;
  FrxTransformOfflineAudioChannel(replayed.data(), replayed.size(), 1, 0);
  assert(Equal(first, replayed));
  double maximumError = 0;
  for (size_t i = 0; i < original.size(); ++i) {
    const uint32_t delta = Bits(first[i]) ^ Bits(original[i]);
    assert(delta == 0 || delta == 1);
    assert(std::isfinite(first[i]));
    maximumError = std::max(maximumError, std::abs(double(first[i]) - original[i]));
  }
  assert(maximumError <= std::numeric_limits<float>::epsilon());
  FrxTransformOfflineAudioChannel(nullptr, 10, 0, 0);
  std::cout << "Offline audio scalar tests passed: deterministic, idempotent unity replay, zero seed, special values, one ULP, absolute offsets\n";
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

#include "mozilla/dom/FrxDeterministicRandom.h"

#include "Crypto.h"
#include "js/Realm.h"              // JS::ResetRealmMathRandomSeed
#include "js/friend/MathRandom.h"  // js::SetRealmMathRandomState
#include "mozilla/Attributes.h"
#include "mozilla/ErrorResult.h"
#include "mozilla/Maybe.h"
#include "mozilla/RefPtr.h"
#include "mozilla/dom/ScriptSettings.h"
#include "nsGlobalWindowInner.h"
#include "nsID.h"
#include "nsString.h"

namespace mozilla::dom::frx {

namespace {

class SeedSequence {
 public:
  MOZ_NO_SANITIZE_UNSIGNED_OVERFLOW
  explicit SeedSequence(const nsACString& aSeed) {
    uint64_t hash = 0xcbf29ce484222325;
    for (const char* c = aSeed.BeginReading(); c != aSeed.EndReading(); ++c) {
      hash ^= static_cast<uint8_t>(*c);
      hash *= 0x100000001b3;
    }
    mState = hash;
  }

  // SplitMix64, the seeding mfbt/XorShift128PlusRNG.h recommends.
  MOZ_NO_SANITIZE_UNSIGNED_OVERFLOW
  uint64_t Next() {
    uint64_t z = (mState += 0x9e3779b97f4a7c15);
    z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9;
    z = (z ^ (z >> 27)) * 0x94d049bb133111eb;
    return z ^ (z >> 31);
  }

  // xorshift128+ must not start from an all-zero state.
  void NextState(uint64_t* aState0, uint64_t* aState1) {
    *aState0 = Next();
    *aState1 = Next();
    if (!*aState0 && !*aState1) {
      *aState1 = 1;
    }
  }

 private:
  uint64_t mState;
};

}  // namespace

void SetDeterministicRandom(nsGlobalWindowInner& aWindow,
                            const nsACString& aSeed, ErrorResult& aRv) {
  RefPtr<Crypto> crypto = aWindow.GetCrypto(aRv);
  if (aRv.Failed()) {
    return;
  }
  AutoJSAPI jsapi;
  if (!jsapi.Init(&aWindow)) {
    aRv.Throw(NS_ERROR_NOT_AVAILABLE);
    return;
  }
  if (aSeed.IsEmpty()) {
    JS::ResetRealmMathRandomSeed(jsapi.cx());
    crypto->SetDeterministicStream(Nothing());
    return;
  }
  SeedSequence sequence(aSeed);
  uint64_t state0;
  uint64_t state1;
  sequence.NextState(&state0, &state1);
  js::SetRealmMathRandomState(jsapi.cx(), state0, state1);
  sequence.NextState(&state0, &state1);
  crypto->SetDeterministicStream(
      Some(non_crypto::XorShift128PlusRNG(state0, state1)));
}

void FillDeterministic(non_crypto::XorShift128PlusRNG& aStream,
                       Span<uint8_t> aData) {
  for (size_t offset = 0; offset < aData.Length(); offset += 8) {
    uint64_t value = aStream.next();
    for (size_t i = 0; i < 8 && offset + i < aData.Length(); ++i) {
      aData[offset + i] = static_cast<uint8_t>(value >> (8 * i));
    }
  }
}

nsID DeterministicUUID(non_crypto::XorShift128PlusRNG& aStream) {
  uint64_t high = aStream.next();
  uint64_t low = aStream.next();
  nsID id;
  id.m0 = static_cast<uint32_t>(high >> 32);
  id.m1 = static_cast<uint16_t>(high >> 16);
  id.m2 = static_cast<uint16_t>((high & 0x0fff) | 0x4000);
  for (size_t i = 0; i < 8; ++i) {
    id.m3[i] = static_cast<uint8_t>(low >> (56 - 8 * i));
  }
  id.m3[0] = static_cast<uint8_t>((id.m3[0] & 0x3f) | 0x80);
  return id;
}

}  // namespace mozilla::dom::frx

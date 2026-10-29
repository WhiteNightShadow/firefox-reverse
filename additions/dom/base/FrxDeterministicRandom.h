/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

#ifndef mozilla_dom_FrxDeterministicRandom_h
#define mozilla_dom_FrxDeterministicRandom_h

#include <stdint.h>

#include "mozilla/Span.h"
#include "mozilla/XorShift128PlusRNG.h"
#include "nsStringFwd.h"

class nsGlobalWindowInner;
struct nsID;

namespace mozilla {
class ErrorResult;
}  // namespace mozilla

namespace mozilla::dom::frx {

// page_determinism: one seed gives every armed document the same Math.random
// sequence and the same crypto.getRandomValues / crypto.randomUUID stream.
// The agent tool replays all of this in Node, so change both together:
// FNV-1a 64 over the seed's UTF-8 bytes seeds SplitMix64, whose first two
// outputs are the Math.random state and the next two the crypto state (a zero
// pair gets 1 as its second word). An empty seed restores real randomness.
void SetDeterministicRandom(nsGlobalWindowInner& aWindow,
                            const nsACString& aSeed, ErrorResult& aRv);

// Each call starts on a fresh next(): bytes come from whole 64-bit outputs,
// least significant byte first, and a call's leftover bytes are dropped.
void FillDeterministic(non_crypto::XorShift128PlusRNG& aStream,
                       Span<uint8_t> aData);

// A version 4 UUID whose 32 hex digits are next() twice, most significant
// first, with the version and variant bits set as nsID::GenerateUUID does.
nsID DeterministicUUID(non_crypto::XorShift128PlusRNG& aStream);

}  // namespace mozilla::dom::frx

#endif  // mozilla_dom_FrxDeterministicRandom_h

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef js_friend_MathRandom_h
#define js_friend_MathRandom_h

#include <stdint.h>  // uint64_t

#include "jstypes.h"       // JS_PUBLIC_API
#include "js/TypeDecls.h"  // JSContext

namespace js {

// firefox-reverse: lets the DOM make a page's Math.random repeatable.
//
// Sets the xorshift128+ state behind Math.random in the current realm, so the
// same state gives the same sequence. The state must not be all zero.
// JS::ResetRealmMathRandomSeed (js/Realm.h) goes back to a random state.

extern JS_PUBLIC_API void SetRealmMathRandomState(JSContext* cx,
                                                  uint64_t state0,
                                                  uint64_t state1);

} /* namespace js */

#endif  // js_friend_MathRandom_h

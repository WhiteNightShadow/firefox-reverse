/* Phase A.0 PoC: JSVMP trace via JS_AddInterruptCallback
 *
 * Hook 在 XPCJSContext::Initialize() 末尾注册，每次 loop backedge / GC safepoint
 * 触发，用 JS::DescribeScriptedCaller 拿当前 JS script filename + line。
 *
 * 不动 JS 一字节，对 JSVMP 自校验完全透明。
 */

#ifndef mozilla_jsvmp_TraceHook_h
#define mozilla_jsvmp_TraceHook_h

#include "js/TypeDecls.h"

namespace mozilla {
namespace jsvmp {

// 在 XPCJSContext::Initialize() 末尾调用一次。
// 内部读取环境变量 MOZ_JSVMP_TRACE / MOZ_JSVMP_TRACE_FILE / MOZ_JSVMP_TRACE_SCRIPT。
// 未启用时（MOZ_JSVMP_TRACE != "1"）零开销。
void RegisterTraceCallback(JSContext* cx);

}  // namespace jsvmp
}  // namespace mozilla

#endif  // mozilla_jsvmp_TraceHook_h

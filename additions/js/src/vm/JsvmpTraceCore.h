/* Phase B: JSVMP per-opcode trace via patching Interpreter.cpp
 *
 * Hook 插入位置：js/src/vm/Interpreter.cpp 的 ADVANCE_AND_DISPATCH(N) 宏，
 * 在 `REGS.pc += (N)` 之后、`DISPATCH_TO(...)` 之前调 JSVMP_TRACE_OPCODE()。
 *
 * 设计原则：
 * 1. hot path 单分支跳过：gTraceEnabled = false 时只有一条 branch，
 *    JIT 友好，对 vanilla 用户接近零开销。
 * 2. cold path（trace 开启）在 .cpp 里独立实现，复杂逻辑都放 outline。
 * 3. 不动 JS 一字节，JSVMP 完全无法感知。
 *
 * 配置（环境变量，启动时一次性读取）：
 *   MOZ_JSVMP_TRACE=1                    总开关
 *   MOZ_JSVMP_TRACE_FILE=<path>          NDJSON 输出（自动追加 .<pid>）
 *                                        默认 /tmp/firefox-reverse-jsvmp-b.ndjson
 *   MOZ_JSVMP_TRACE_SCRIPT=<substring>   filename 过滤（substring，非正则）
 *                                        强烈建议设上，否则全量 trace 量爆炸
 *   MOZ_JSVMP_TRACE_LIMIT=<n>            单进程最大记录行数（防爆盘），默认 1000000
 *
 *   --- dump_args (Phase B.3): function entry dump 实参 ---
 *   MOZ_JSVMP_DUMP_ARGS=1               开启
 *   MOZ_JSVMP_DUMP_ARGS_COL=<col>       只 dump 指定列的函数入口（0=任意）
 *   MOZ_JSVMP_DUMP_ARGS_LIMIT=<n>       最多 dump 次数，默认 100
 *
 *   --- dump_locals (Phase B.4): 指定 (col,pc) dump 局部变量 + 闭包/环境链 ---
 *   MOZ_JSVMP_DUMP_LOCALS=1             开启
 *   MOZ_JSVMP_DUMP_LOCALS_COL=<col>     只在指定列的脚本触发（0=任意）
 *   MOZ_JSVMP_DUMP_LOCALS_PC=<off>      触发 pc 偏移，默认 0（函数入口）
 *   MOZ_JSVMP_DUMP_LOCALS_LIMIT=<n>     最多 dump 次数，默认 50
 *   MOZ_JSVMP_DUMP_ENV=1               同时 walk 环境链（拿闭包常量，如 xor key）
 *   MOZ_JSVMP_DUMP_DEPTH=<d>           对象/数组序列化深度，默认 2（0..5）
 *
 * 输出行类型（NDJSON）：
 *   {"sid","pc","op","n","ln","col"}          每 opcode
 *   {"_script":{"sid","file"}}                首见脚本
 *   {"_args":{"sid","n","args":[...]}}         dump_args
 *   {"_locals":{"sid","pc","nloc","narg","locals":[...],"args":[...],"env":[...]}}  dump_locals
 */

#ifndef vm_JsvmpTraceCore_h
#define vm_JsvmpTraceCore_h

#include "mozilla/Attributes.h"
#include "jstypes.h"
#include "js/TypeDecls.h"

namespace mozilla {
namespace jsvmp {

// 全局开关。hot path 只 check 这个标志。
// 初始 false；EnsureInit() 读 env 后可能设为 true。
extern bool gTraceEnabled;

// 在 Interpret() 顶部调用一次（CAS-protected，多次调用安全）。
// 第一次调用时读环境变量决定是否启用 trace、打开输出文件。
void EnsureInit();

// cold path（gTraceEnabled = true 时走）。outline 在 .cpp 里实现。
// spTop = 操作数栈指针(REGS.sp, 指向栈顶之上一格)。仅 dump_ret 在 RETURN 处读 spTop[-1]
// = 即将被返回的值；其它路径不读。用 void* 避免在头文件引入 JS::Value 完整定义。
void RecordOpcodeImpl(JSContext* cx, JSScript* script, uint8_t* pc,
                      uint8_t opcode, const void* spTop);

// hot path（inline，编译进 Interpreter.cpp）
MOZ_ALWAYS_INLINE void RecordOpcode(JSContext* cx, JSScript* script,
                                     uint8_t* pc, const void* spTop) {
  if (MOZ_UNLIKELY(gTraceEnabled)) {
    RecordOpcodeImpl(cx, script, pc, *pc, spTop);
  }
}

}  // namespace jsvmp
}  // namespace mozilla

/* 给 Interpreter.cpp 用的宏。展开在 ADVANCE_AND_DISPATCH(N) 内部。
 * 依赖 cx / script / REGS.pc / REGS.sp 在当前 scope 内（都是 Interpret() 的局部变量）。
 */
#define JSVMP_TRACE_OPCODE() \
  ::mozilla::jsvmp::RecordOpcode(cx, script, REGS.pc, (const void*)REGS.sp)

#endif  // vm_JsvmpTraceCore_h

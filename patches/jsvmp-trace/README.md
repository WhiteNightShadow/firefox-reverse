# patches/jsvmp-trace/

在 SpiderMonkey **C++ native 层**捕获/拦截字节码 dispatch，输出 NDJSON。**核心约束**：不修改任何 JS 源码，对 JSVMP 完全透明（JSVMP 普遍内置自校验：`func.toString()` hash、length、`performance.now()` op 时序检测，改 JS 必触发反爬）。

## 与 camoufox PropertyTracer 的差异

| 维度 | camoufox PropertyTracer | 本模块 jsvmp-trace |
|------|------------------------|-------------------|
| 追踪对象 | DOM API getter | SpiderMonkey 字节码 + 栈 + locals + args |
| 颗粒度 | 属性访问（稀疏） | 每条 opcode（密集） |
| 主动性 | 改 getter 返回值 | trace + dump + 可选 modify（return value / pc / opcode） |
| 用途 | 反检测 / 环境伪装 | 反混淆 / JSVMP 逆向 |
| 隐蔽性 | 在 binding 层（JS prototype 可能可检测） | 在 SpiderMonkey 解释器内核（JS 层不可见） |

## ⚠️ 已排除的方案

**不要用 `Debugger API`（`onStep`）。** 看似 per-bytecode 颗粒度完美，但挂上 Debugger 会导致：

- JIT 代码全部丢弃，Baseline 全部重编译加 instrumentation
- 性能下降 10-100×
- 目标站点的 `performance.now()` op 时序检测**必然命中**（中文逆向圈公认的反爬手段）

详见 [Rhoamer / mozilla 的 Debugger 性能分析](https://rfrn.org/~shu/2014/11/20/speeding-up-debugger.html)。

**其他试过/排除的方案**：

| 方案 | 排除原因 |
|------|---------|
| `TraceLogger` | 已 deprecated，颗粒度只到 function/IC 级 |
| `GeckoProfiler` 采样 | 1ms 采样频率，JSVMP 每秒数十万 op，丢绝大多数事件 |
| `JS::SetExecuteHook` / `SetCallHook` | SM 35 时已删除 |
| Frida hook | Frida 没有 SpiderMonkey backend（只 V8 + QuickJS） |
| QBDI DBI | 不理解 JS 语义，hook 拿到的是 x86 指令 |
| WebExtension API | 无 bytecode-level API |

## 两阶段实施方案

### Phase A — PoC: `JS_SetInterruptCallback`

**思路**：mozilla 自己用 `JS_SetInterruptCallback` 实现长脚本中断 + GC safepoint。callback 在 `js/src/vm/Interpreter.cpp` 的 `CHECK_BRANCH()` 宏（约 line 2446）触发，**每个 loop backedge 一次**。

**关键洞察**：JSVMP dispatcher 是大 while loop，每跑一个虚拟 op = 一次 loop backedge → **InterruptCallback 自然成了 per-virtual-op 触发**。

```cpp
// additions/js/src/reverse/JsvmpInterruptHook.h
bool JsvmpInterruptCallback(JSContext* cx) {
  // walk activation 拿 current script + pc
  for (js::ActivationIterator it(cx); !it.done(); ++it) {
    JSScript* script = it->asInterpreter()->script();
    jsbytecode* pc = it->asInterpreter()->regs().pc;
    // 过滤 script URL（只 trace 目标SDK.js 等）
    if (matches_filter(script->filename())) {
      write_ndjson({ts_ns(), script->id(), pc - script->code(),
                    *pc, JSOp_name(*pc), ...});
    }
  }
  return true;
}
```

注册：
```cpp
// 在 JSContext 初始化时
JS_AddInterruptCallback(cx, JsvmpInterruptCallback);
// 持续触发：每 N 个 op 调一次 JS_RequestInterruptCallback
```

**优点**：
- 隐蔽性顶级（mozilla 自己用，不改 JIT、不挂 Debugger、不改 toString）
- 实现简单（3-5 天）
- 理论上甚至不需要重编 firefox（如果走 embedder API）

**缺点**：
- 颗粒度受限于 loop backedge（直线代码段会漏）—— 但对 JSVMP dispatcher 不是问题

### Phase B — 生产版: patch `Interpreter.cpp` + Baseline generator

**思路**：在三个 tier 都加 hook 点（Interpreter / Baseline / Ion 可选），达到真正的 per-opcode 颗粒度。

**关键 patch 点**：

| 文件 | 修改 |
|------|------|
| `js/src/vm/Interpreter.cpp` | `ADVANCE_AND_DISPATCH(n)` 宏体里加 `JSVMP_HOOK_BEFORE` 调用，flag = 0 时编译期消除 |
| `js/src/jit/BaselineCodeGen.cpp` | 每个 op emit 时插入一段 ABI-compatible native call（trace enabled 时） |
| `js/src/jit/CodeGenerator.cpp` | Ion 可选，多数 JSVMP dispatcher 因 megamorphic IC 不会被 Ion 编译，跑 Baseline 就够 |

**hook 体**：
```cpp
inline void JSVMP_HOOK_BEFORE(JSContext* cx, JSScript* s, jsbytecode* pc, JSOp op) {
  if (MOZ_LIKELY(!gJsvmpTraceEnabled)) return;  // 单分支 cold path，零开销
  // cold path: 写 lock-free SPSC ring buffer
  TraceEvent ev{ ts_ns(), s->id(), uint32_t(pc - s->code()), uint8_t(op), ... };
  gRingBuffer.push(ev);
}
```

**数据流**：
```
Interpreter / Baseline dispatch
   ↓ (JSVMP_HOOK_BEFORE，flag off 时单分支跳过)
TraceWriter (per-thread lock-free SPSC ring buffer, 16-24 bytes/record)
   ↓ (后台 dedicated writer thread)
NDJSON file (mmap, settings.trace.jsvmp_dir/jsvmp-<pid>-<ts>.ndjson)
```

**Hook framework**：除了被动 trace，hook callback 可执行：
- `dump_args(frame)` — 当前 function 参数
- `dump_stack(N)` — 栈顶 N 个值
- `dump_locals(frame)` — 当前 frame locals
- `dump_return(frame)` — 返回值（function exit hook）
- `set_return(value)` — 替换返回值
- `goto(new_pc)` — 跳到新 PC
- `skip()` — 跳过本条 opcode
- `log(fmt, ...)` — 写日志

由用户提供 TOML 配置（见下）。

## 配置（用户侧）

```toml
# ~/.firefox-reverse/jsvmp-hooks.toml

[trace]
output_dir = "~/.firefox-reverse/traces/jsvmp"
ring_buffer_size = "64MiB"
script_filter = '目标SDK.*\.js$'   # 默认只 trace 匹配此正则的 script URL

[[hook]]
name = "目标站点-dispatcher-entry"
script_url = '目标SDK'
function_name = '^v_a$|^_v$'         # 目标站点 dispatcher 候选名（实际靠 Phase A trace 输出后人工锁定）
on = "function_enter"
actions = ["dump_args", "log"]

[[hook]]
name = "目标站点-bytecode-dump"
script_url = '目标SDK'
function_name = '^v_a$'
on = "function_enter"
actions = ["dump_arg(0)"]            # 第一个参数往往是 JSVMP 字节码数组
output_file = "目标站点-bytecode.ndjson"

[[hook]]
name = "目标站点-signature-extract"
script_url = '目标SDK'
function_name = 'sign|_signature|x_bogus|签名参数'
on = "function_exit"
actions = ["dump_return"]
```

环境变量切换（不重编）：
```bash
export MOZ_JSVMP_HOOK_CONFIG=$HOME/.firefox-reverse/jsvmp-hooks.toml
export MOZ_JSVMP_TRACE=1
open /Applications/Nightly.app --args https://目标站点/video/xxx
```

## 反检测策略

| JSVMP 检测手段 | 我们的应对 |
|---------------|-----------|
| `func.toString()` hash | 不改 JS 一字节，hash 不变 |
| `performance.now()` op 时序 | hook 体写 lock-free ring buffer，每 op ~5-20 ns，可控；不挂 Debugger 不重编 JIT，时序不塌方 |
| `Error.stack` 字符串检测 | 不在 JS 栈出现 |
| `Debugger` global 存在性 | 不挂 Debugger |
| `navigator.webdriver` / CDP 痕迹 | 走 `patches/fingerprint/` 模块覆盖 |
| DevTools 端口检测 | firefox 默认无开放端口；trace 走文件不走网络 |

## 目标站点 目标SDK / 签名参数 攻克路线

参考：[K哥爬虫 - JS 逆向百例 签名参数 还原](https://cloud.tencent.com/developer/article/2208864)、[nullpt.rs - 目标站点 VM RE Part 1](https://nullpt.rs/reverse-engineering-目标站点-vm-1)、[xugj520 - 目标SDK RE](https://www.xugj520.cn/en/archives/目标站点-vm-reverse-engineering-目标SDK.html)

```
W1: Phase A PoC → 跑 目标站点.com → 拿 dispatcher SM bytecode 流
W2-3: Phase B 全量 patch（Interpreter + Baseline）
W4: 写后处理器 → 启发式识别 dispatcher
    （连续重复的 case-block 模式 = JSVMP handler 表）
    → 把 SM bytecode 流反推回 JSVMP 178 个 virtual op 流
W5+: Python 算法复现（参考 K哥的 MD5 + RC4-like + 位运算线）
```

**JSVMP dispatcher 识别启发式**：
- 同一 BaseScript* 在短时间内被进入 >N 次
- 函数体内含大 switch（`JSOp::TableSwitch` / 大量 `JSOp::StrictEq` 紧邻）
- 一个 while loop + index 累加 + 字节码数组读取
→ 标记为 dispatcher candidate，导出该 script bytecode + 它每次跑的真实 op 序列

## 关键 Firefox 源文件

- **`js/src/vm/Interpreter.cpp`** — 解释器主 dispatch loop（`Interpret()` 函数 + `INTERPRETER_LOOP()` / `ADVANCE_AND_DISPATCH` 宏）
- **`js/src/jit/BaselineCodeGen.cpp`** — Baseline interpreter generator（emit 每个 op 的 native code）
- **`js/src/jit/BaselineIC.cpp`** — Baseline IC
- **`js/src/jit/CodeGenerator.cpp`** — IonMonkey codegen（多数 JSVMP dispatcher 跑 Baseline，Ion 可选）
- **`js/src/vm/JSScript.cpp`** — Script 元信息（id / filename / sourceURL）
- **`js/public/Context.h`** — `JS_SetInterruptCallback` / `JS_RequestInterruptCallback`（Phase A 用）

## 参考文献

- [Debugger.Frame onStep](https://firefox-source-docs.mozilla.org/devtools-user/debugger-api/debugger.frame/) — onStep 语义
- [Speeding up the Debugger (rfrn)](https://rfrn.org/~shu/2014/11/20/speeding-up-debugger.html) — Debugger 性能模型（为何排除）
- [Baseline Interpreter (Mozilla Hacks)](https://hacks.mozilla.org/2019/08/the-baseline-interpreter-a-faster-js-interpreter-in-firefox-70/) — Baseline generator 工作机制
- [searchfox: Interpreter.cpp](https://searchfox.org/mozilla-central/source/js/src/vm/Interpreter.cpp)
- [V8 `--trace-ignition`](https://chromium.googlesource.com/v8/v8/+/master/src/interpreter/bytecode-generator.cc) — V8 的官方等价物（参考思路）
- [JSVMP 原理（blog.jsvmp.com）](https://blog.jsvmp.com/js-virtualization/) — Dispatcher + Handler 经典 VM 结构
- [目标站点 目标SDK 178 opcodes 静态分析](https://www.xugj520.cn/en/archives/目标站点-vm-reverse-engineering-目标SDK.html) — 双层加密 Base64+AES-256-CBC+Leb128

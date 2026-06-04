# JSVMP 逆向工作流（实战 + 踩坑记录）

> 本文记录 firefox-reverse 第一个真实项目（目标站点 目标SDK 签名参数）的完整工作流、关键决策、和**踩过的坑**。
> 后续做新 JSVMP 站点（淘宝 某接口 ua / 京东 _aladdin / 网易云 encSecKey / 美团 mtgsig 等）直接照这个走，**不要重蹈覆辙**。

## TL;DR

**不要把 firefox-reverse 当 reverse engineering 的 IDE**。它的真实定位是**一次性 dump 关键数据**，然后**离线 Babel AST + LLM 分析**。

错路（我走过）：
- ❌ Per-op SpiderMonkey trace 反推 op 语义（天花板低，给不了语义）
- ❌ Fuzz dispatcher 256 个 byte（慢 + 信息密度低，且 byte → trace 不是 byte → 语义）
- ❌ 在 firefox 里反复改 hook code → 编译 → 装 dmg → 测（一轮 5-10 分钟）

正路（社区主流，我走通后）：
- ✅ Dump 一次：bytecode + dispatcher source + closure consts，**关闭 firefox**
- ✅ Babel AST 静态拆 dispatcher → handler 函数 → pattern matcher 命名 70% op
- ✅ LLM 命名剩余 30% 高层语义结构
- ✅ Bytecode + op 表 → 伪汇编 → LLM 还原算法

## 完整 4 步工作流

```
┌──────────────────────────────────────────────────────────┐
│ Step 1: Dump 关键数据（firefox-reverse 在这里登场）      │
│   - bytecode hex string / dispatcher source              │
│   - 实参 (Phase B.3 MOZ_JSVMP_DUMP_ARGS=1)               │
│   - 局部变量+闭包链 (Phase B.4 MOZ_JSVMP_DUMP_LOCALS=1    │
│       DUMP_ENV=1 → 拿运行时 xor key 等闭包常量)          │
│   - 目标 .js (curl 公网即可)                              │
└──────────────────────┬───────────────────────────────────┘
                       │  关闭 firefox，所有后续在离线 Node 跑
                       ▼
┌──────────────────────────────────────────────────────────┐
│ Step 2: AST 拆 dispatcher（全自动，通用，不写死站点）    │
│   node tools/dispatcher_split.js <in.js> <out.json>      │
│   - findDispatcherAuto 打分法定位 dispatcher（免 --col） │
│   - autoDetectRegisters 启发式识别 stack/sp/pc/bytecode/  │
│       consts/thisArg（无 REGISTER_MAP 写死）             │
│   - while+switch 与 嵌套 if/三元 决策树都支持            │
│   - extractDecodeFormula+foldConstants 提 byte→op 公式   │
│   - buildDecodeTable 跑导航器得 byte→op_key 表           │
│   → handlers.json（含 decode_table/base_advance/         │
│     bytecode_style/每 op operand_units）                 │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│ Step 3: 自动 + AI 命名 op                                 │
│   - 24+ AST pattern matcher → ~65-67% 自动命名           │
│   - node tools/ai_name_unknown.js handlers.json --apply  │
│     已命名作 few-shot，LLM(DeepSeek 默认) 命名剩余        │
│   → handlers.json（趋近 100% 命名）                       │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│ Step 4: 反汇编 + 算法还原                                 │
│   node tools/disassemble.js --handlers=h.json            │
│        --bytecode=bc.hex [--scan]                         │
│   - 查 decode_table + 推进 pc → 伪汇编（hex/array 双风格）│
│   - 跳转 op 标 ⚠；--scan 自动找代码起点                  │
│   - LLM + 加密点识别（MD5/RC4/XOR/Base64）→ Python 复现  │
└──────────────────────────────────────────────────────────┘
```

> 双验证用例（结构不同，确保通用不 hardcode）：
> - `示例VMP`（while+switch / array 字节码）
> - `目标SDK`（目标站点 签名参数，嵌套三元决策树 / hex-string 字节码）
> 任何工具改动后两者都要跑通。

## 已踩的坑（务必避免）

### 坑 1: per-op trace 路线天花板低
- **症状**：花了 3 天写 SpiderMonkey opcode trace（Phase B / B.1 / B.2），抓到 5M 行 354MB 数据
- **问题**：拿到的是 `byte → SpiderMonkey op trace`，不是 `byte → 语义`。AI 看 trace 也猜不出 `op 23` 是什么
- **解法**：转 Babel AST 静态分析。70% pattern match，30% 喂 LLM
- **教训**：trace 工具是**辅助验证**，不是 reverse 主力

### 坑 2: content sandbox 拦写 /tmp 和 $HOME
- **症状**：trace 文件只有父进程的（meta 行），content process 全部 0 字节
- **原因**：mac/Linux firefox content process sandbox 默认禁止写 `/tmp`、`$HOME`（防恶意 JS 落盘）
- **解法**：启动时加 `MOZ_DISABLE_CONTENT_SANDBOX=1`（debug 用，生产版要 patch sandbox profile）
- **教训**：firefox sandbox 是 reverse 工作流的隐形拦路虎，文档必须显眼标注

### 坑 3: JIT 让 hook 大量 miss
- **症状**：dispatcher 跑了好几遍，trace 只抓到几 KB
- **原因**：dispatcher 跑热被 Baseline JIT 编译，hook 只 patch 了 Interpreter，JIT 代码 hook 不到
- **解法**：在 profile 的 `user.js` 关 JIT
  ```
  user_pref("javascript.options.ion", false);
  user_pref("javascript.options.baselinejit", false);
  user_pref("javascript.options.warp", false);
  user_pref("javascript.options.blinterp", false);
  ```
- **代价**：firefox 整体慢 5-10×，但 trace 完整。reverse 阶段值得
- **教训**：JIT 关掉是必须，写到启动脚本里别忘

### 坑 4: filter 不命中也消耗 limit count
- **症状**：MOZ_JSVMP_TRACE_LIMIT=5000000 几秒就打满，但实际 目标SDK trace 一条没记
- **原因**：bug — `gRecordCount.fetch_add(1)` 在 filter check **之前**，每个 op 都涨 count
- **解法**：把 count 移到 filter check **之后**，filter no-match 不消耗 count
- **附加优化**：thread_local script→filter 结果 cache，避免每个 op 都 strstr
- **教训**：counter 加在哪是 cold path 性能 vs 数据正确性的 trade-off，先正确再优化

### 坑 5: 多 firefox 实例同 profile 互锁
- **症状**：`-no-remote -P phaseB` 启动后弹 "Choose User Profile" 对话框
- **原因**：之前的 firefox 进程没杀干净，profile 加锁
- **解法**：启动前 `pkill -9 -x firefox`（**注意 mac 进程名是 `firefox` 不是 `firefox-bin`**）
- **教训**：**不要用 `pkill -f`**，会匹配到 ssh 命令行 self-kill 自杀

### 坑 6: 反复 scp .dmg 来回慢
- **症状**：每次改 hook + 远程 mac arm64 build + scp 107MB 来回 + 装 dmg + 启动 firefox = **5-10 分钟/轮**
- **解法**：改 Linux x64 远程 build + Xvfb 跑 + trace 文件在远程读取
- **代价**：少了 mac UI 调试体验，但 reverse 阶段不需要 UI
- **教训**：能远程跑就远程跑，**user 端只看最终结果**

### 坑 7: mozilla style checker 严格 + include order
- **症状**：build 7 分钟后 fail：`"vm/JsvmpTraceCore.h" should be included after "js/EnvironmentChain.h"`
- **原因**：mozilla 强制 `js/src/` 下 include 按 path 字母序分组
- **解法**：跑 `python3 config/check_spidermonkey_style.py --fixup` 自动修
- **教训**：每次改 include 顺序后必须先跑 style checker 再 build

### 坑 8: UNIFIED_SOURCES 按字母排序硬性要求
- **症状**：`mozbuild.util.UnsortedError: We expected "JsvmpTraceHook.cpp" but got "nsXPConnect.cpp"`
- **原因**：moz.build 的 `UNIFIED_SOURCES += [...]` 是 `StrictOrderingOnAppendList`
- **解法**：插入新文件时严格按 ASCII case-sensitive 字母序
- **教训**：写 sed/python 脚本插入时校验顺序

### 坑 9: mac xattr `-r` 不支持
- **症状**：`xattr -dr com.apple.quarantine` 报 `option -r not recognized`
- **解法**：mac 上用 `xattr -cr` 清所有 xattr 递归
- **教训**：mac BSD coreutils vs Linux GNU coreutils 不一致

### 坑 10: pkill self-kill
- **症状**：ssh 命令突然 exit 255
- **原因**：`pkill -f "/firefox/obj"` 匹配到 ssh 命令行（含这字符串），把自己杀了
- **解法**：用 `pkill -x <name>` 精确匹配进程名，不要用 `-f` 匹配命令行
- **教训**：永远 prefer `-x` over `-f`

### 坑 11: firefox 子进程 stderr 不进 terminal
- **症状**：只看到一次 `[jsvmp-trace] enabled`，其他 content process 没 banner
- **原因**：mac firefox 子进程 stderr 不重定向到父 terminal，走 system log
- **解法**：trace 文件按 `<path>.<pid>` 命名（每个进程一个文件），不依赖 stderr
- **教训**：**多进程程序的可观测性靠落盘，不靠 stderr**

### 坑 12: dispatcher 不是简单 switch（目标SDK 用嵌套三元）
- **症状**：dispatcher_split.js 找不到 目标SDK 的 case 结构（示例VMP 跑通了）
- **原因**：目标SDK 用 `cond ? body1 : cond2 ? body2 : body3` + `cond && body`，不是 `switch(op){ case N: ... }`
- **解法**：扩展 dispatcher_split 支持 nested if/ternary AST traversal，每条 path 生成 op-key
- **教训**：不要假设 dispatcher 长一个样，**先 grep AST 结构再写 matcher**

## 流程优化关键 insights

### Insight 1: firefox-reverse 只 dump 一次性数据
**不要把 firefox 当 IDE**。完成 dump 后立刻关 firefox，所有分析在离线 Node 跑。
- firefox-reverse 只做 4 件事：dump bytecode / dump dispatcher source col / dump closure consts / 提供 dispatcher PID
- 离线 Babel + LLM 是分析主战场

### Insight 2: 远程编 Linux + Xvfb，比本地 mac 快 10×
- mac arm64 build 25-29 秒 + scp 107MB 30-60 秒 + 装 dmg + xattr + 启动 firefox = **5 分钟/轮**
- Linux x64 + trace 文件远程读取 + python 远程分析 = **30-60 秒/轮**
- 只在最后 user 真要 mac 浏览器时编 mac dmg，平时 Linux 跑

### Insight 3: 配置 env vars 整合到 启动脚本
启动 firefox 要传 6+ 个 env vars，命令行容易写错。整合到 `scripts/run-trace-on-linux.sh` 一个脚本。

### Insight 4: trace 格式 AI-first
- 每行结构化 JSON（不只是 number）
- 字段：`ev`（事件类型）、`sid`、`pc`、`op`、`n`（opname）、`ln`、`col`
- 按 `ev` filter（jq 一行）
- 默认稀疏（function-level），按需开 dense（op-level）

### Insight 5: AST pattern matcher 比 fuzz 快 10000×
- Fuzz 1 个 op：跑 dispatcher 一遍（数百 ms）+ 看 trace（几秒分析）= ~10 秒
- AST matcher：直接看 case body AST shape = ~1 ms
- 73 个 op 全 match：**几十 ms**

## 工程量真实估算

| 阶段 | 没工具 | 有 firefox-reverse + 工具链 |
|------|--------|----------------------------|
| dispatcher 定位 | 1-3 天（人工读 minified） | **5 分钟**（trace hot sid） |
| bytecode 提取 | 1-2 天（修改 目标SDK inject console.log，触发自校验风险） | **30 秒**（dump_args，对 JSVMP 透明） |
| Op 表反推 | 2-4 天（人工读 dispatcher.js） | **30 分钟**（AST + LLM） |
| Bytecode 反汇编 | 1-2 天（手工对照） | **5 分钟**（disassemble.js） |
| 算法识别（找 MD5/RC4） | 几天（grep + 人工） | **半天**（伪汇编 + LLM） |
| Python 复现 + 验证 | 1-2 天 | 1 天 |
| **总计** | **2-4 周** | **3-5 天** |

## 进度（2026-05-22：静态链全部通用化完成）

- [x] dispatcher_split 支持嵌套三元/if-else 决策树 → 解锁 目标SDK
- [x] **寄存器识别完全通用化**（删 REGISTER_MAP，autoDetectRegisters 启发式）
- [x] **dispatcher 自动检测**（findDispatcherAuto 打分法，免 --col）
- [x] **decode 公式自动提取 + 常量折叠**（byte→op，不写死 13*byte%241）
- [x] **byte→op_key 解码表自动生成**（决策树编译成导航器跑 0..255）
- [x] **disassemble.js**（hex-string/array 双风格，--scan 找起点）
- [x] **ai_name_unknown.js**（LLM 命名 UNKNOWN，复用 agent.json）
- [x] dump_locals + envChain C++（深度序列化对象/数组 + 环境链 walk）—— **远程 Linux 编译+实测通过**：
  目标站点 目标SDK 19 个 _locals，env 链 2-4 层，捕获闭包常量表（字节提取掩码 [128,32768,…] + 偏移 [0,8,16,24]）
- [x] **控制流恢复**：dispatcher_split 加 jump_kind/cond/target_expr；disassemble.js `--cfg`（基本块+跳转目标+回边=循环），合成 cy 程序验证正确
- [x] **Phase B.5 vpc_trace + 轨迹驱动反汇编**：C++ `MOZ_JSVMP_VPC_TRACE` 每条虚拟指令快照寄存器 →
  `vpc_resolve.js` 数据驱动认出虚拟 pc 槽 + 解析跳转目标(含循环) → `disassemble.js --vpc --cfg` 轨迹驱动 CFG。
  变长 opcode 站点(目标SDK)静态解不出的相对跳转，靠动态观测全部补全。**通用、不写死槽号/站点**。
- [x] **签名参数 本质还原**：自定义 Base64 + webdriver/selenium/phantom 全套反爬探测 + 指纹采集（见 分析目录/签名参数_analysis.md）

### 下一步 ROI

1. **控制流恢复**（JMP/JIF/JNF → if/while 伪 JS）→ disassemble.js 进阶
2. **第三个 JSVMP 验证**（淘宝 某接口 / 京东）→ 进一步证明通用性
3. **dump_locals 接入分析流水线**：把闭包常量喂给 disassemble/LLM 还原算法
4. **AI agent integration**（见 agent-sidebar.md）

> 远程编译：源码树 `~/firefox-vanilla/firefox`，增量编译 `export MOZCONFIG= && ./mach build binaries`
> （改 1 个 .cpp 约 14s 含 libxul 重链）；实测 `scripts/run-dumplocals-on-linux.sh`。
> 编译机 SSH 连接信息见私有配置（不入库）。

## 参考资料

- github.com/2833844911/示例VMP（同构 dispatcher）
- github.com/baishuijianjia/jsvmp（53 干净 handler 参考）
- resourch.com (2) 字节栈式虚拟机反编译（目标SDK decode 公式 `(13*byte)%241` 同款）
- 1997.pro 腾讯 VMP 系列
- 美团 jsvmp 反编译（CSDN）

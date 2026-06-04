# 实现路线

## Phase 0 — 脚手架 ✅

- [x] 仓库初始化（commit 6d012d2 + 76612b2）
- [x] 目录结构（docs / patches / additions / scripts / settings / tests）
- [x] 设计文档（architecture / features / roadmap / upstream-sync / distribution）

## Phase 1 — 能编译跑起来（vanilla） ✅

- [x] `scripts/bootstrap.sh` 浅克隆 mozilla-firefox/firefox main → upstream/
- [x] 远程 Linux x86_64 编译跑通（11 分 36 秒）→ `firefox-153.0a1.en-US.linux-x86_64.tar.xz` 98 MB
- [x] 远程 cross-compile macOS arm64 跑通（25 分 46 秒）→ `firefox-153.0a1.en-US.mac.dmg` 106 MB
- [x] mac 本地安装验证 OK（用户 2026-05-21 确认能打开）
- [x] `mozconfig.mac` cross-compile 配置可复用
- [ ] `scripts/apply-patches.sh` 实际跑通（等第一个真实 patch 出现）

**基线选定**：mozilla-firefox/firefox `main` 分支，commit `cebc55aab4d` (HEAD on 2026-05-21)，对应 Firefox 153.0a1 nightly。后续可考虑锁定到 ESR。

## Phase 2 — JSVMP Trace（**当前优先级最高**）

详细方案见 [`../patches/jsvmp-trace/README.md`](../patches/jsvmp-trace/README.md)。

### Phase 2.A — PoC: `JS_SetInterruptCallback` 路径

- [ ] 写 `additions/js/src/reverse/JsvmpInterruptHook.{h,cpp}`：注册 callback + 栈回溯拿 script + pc
- [ ] 写 `patches/jsvmp-trace/0001-register-interrupt-callback.patch`：在 `JSContext` 初始化时挂钩
- [ ] 写 NDJSON ring buffer writer
- [ ] 远程 rebuild macOS arm64 → scp .dmg 回本地
- [ ] 跑 https://目标站点/video/7141213450390359310，验证能拿到 目标SDK.js 的 SM bytecode 流
- **里程碑**：拿到一份 `~/.firefox-reverse/traces/jsvmp/目标站点-<ts>.ndjson` 看里面是不是 JSVMP dispatcher 的字节码流

时间预算：**3-5 天**

### Phase 2.B — 生产版: patch Interpreter + Baseline generator

- [ ] `patches/jsvmp-trace/0002-interpreter-dispatch-hook.patch` — 修改 `js/src/vm/Interpreter.cpp` 的 `ADVANCE_AND_DISPATCH(n)` 宏，加 `JSVMP_HOOK_BEFORE` 调用
- [ ] `patches/jsvmp-trace/0003-baseline-generator-hook.patch` — 修改 `js/src/jit/BaselineCodeGen.cpp` 每个 op emit 时插入 native call
- [ ] Lock-free SPSC ring buffer + 后台 dedicated writer thread（mmap NDJSON）
- [ ] `JSVMP_HOOK_BEFORE` 在 trace flag = 0 时单分支跳过（零开销验证：跑 SunSpider/Octane benchmark 对比 vanilla）

时间预算：**1-2 周**

### Phase 2.C — Hook framework（main path → modify）

- [ ] TOML 配置加载（`MOZ_JSVMP_HOOK_CONFIG=path.toml`）
- [ ] Hook actions: `dump_args` / `dump_stack` / `dump_locals` / `dump_return` / `log`
- [ ] Modify actions: `set_return` / `goto` / `skip`
- [ ] 配置示例（目标站点用）放 `settings/jsvmp-hooks.example.toml`

时间预算：**+5 天**

### Phase 2.D — 目标站点端到端：签名参数 / 签名参数 还原

- [ ] 写后处理器（Python，独立工具）：SM bytecode trace → JSVMP virtual op 序列反推
- [ ] 启发式 dispatcher 识别（连续重复 case-block + while loop + 字节码数组读取）
- [ ] dump JSVMP 178 个 opcode 的执行流
- [ ] Python 复现 签名参数 算法（参考 K哥那条线：MD5 + RC4-like + 位运算）
- [ ] 端到端验证：拿 Python 算出的 签名参数 调目标站点 API，跟浏览器算的对比一致

时间预算：**1-2 周**

## Phase 3 — 其他追踪模块（按需）

按优先级：
- [ ] **property-trace** — 从 camoufox-reverse 已有 PropertyTracer 迁移并扩展
- [ ] **network-analysis** — Necko hook（HTTP/HTTPS 请求/响应 + JS 调用栈关联）
- [ ] **cookie-js-analysis** — Cookie 监控 + Script Loader hook（JS 文件落盘）

## Phase 4 — 反检测能力

- [ ] **fingerprint** — 各模块按字段逐项实现，每个字段独立开关，按 `settings/fingerprint.json` 配置
- [ ] **proxy** — Necko 代理层，按规则路由

## Phase 5 — 多端编译

- [x] Linux x64（远程 Ubuntu 已跑通）
- [x] macOS arm64（远程 cross-compile 已跑通）
- [ ] macOS x64
- [ ] Windows x64
- [ ] 产物上传到本仓库 GitHub Releases（私有，详见 [distribution.md](distribution.md)）

## Phase 6 — 独立 MCP 仓库 `firefox-reverse-mcp/`

**与 `camoufox-reverse-mcp` 解耦**，新建独立 MCP Server，提供：

- `trace_query` — 按条件过滤 jsvmp/network/cookie/js/property trace
- `hook_install` / `hook_uninstall` — 运行时挂钩
- `find_jsvmp_dispatcher` — 按调用频率找 dispatcher 候选
- 配置热更新（指纹/代理/hook 配置 JSON 推送）
- 断点控制 / 单步
- 与 camoufox-reverse-mcp 共享部分 utils（NDJSON parser 等），但运行时进程独立

## Phase 7 — 公开发布

- [ ] 满足 [distribution.md](distribution.md) 的"公开门槛清单"
- [ ] 仓库 private → public
- [ ] Releases prerelease → 正式版

## Phase 8 — CI

- [ ] 上游同步机器人（参考 [upstream-sync.md](upstream-sync.md)）
- [ ] 多平台构建矩阵
- [ ] 补丁可应用性测试
- [ ] Tag 触发自动 release 草稿

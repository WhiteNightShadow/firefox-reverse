# firefox-reverse Agent 原生能力设计（ToolRouter + 六大基础能力）

> 配套：[agent-sidebar.md](./agent-sidebar.md)（Agent UI / Track A 设计）、[../patches/agent-ui/HANDOFF.md](../patches/agent-ui/HANDOFF.md)（A1 交接清单）、[jsvmp-reverse-workflow.md](./jsvmp-reverse-workflow.md)（离线分析流水线）。
> 本文聚焦：让**浏览器自身**具备 6 项 JS 逆向基础能力，并通过统一的 **ToolRouter** 暴露给内置 sidebar Agent（以及未来的 `firefox-reverse-mcp`）。
> **本文 = Track A3/A4 的落地细化**（HANDOFF.md §5：A3 = ToolRouter + 页面 tools + 用户确认机制；A4 = jsvmp.* tools）。A1（聊天侧栏）已交接、剩 T6 编译。

## 0. 目标 / 定位 / 红线

- **目标**：firefox-reverse 内置 Agent 能「直接控制浏览器做逆向」，需要浏览器原生提供：①网络捕获控制 ②保存 JS 文件 ③定位加密参数入口 ④JSVMP trace ⑤JS 执行 ⑥代码搜索。
- **定位差异**：camoufox-reverse-mcp 是**外部** MCP（Python + Playwright/CDP 从外面驱动 Camoufox）；firefox-reverse 的 Agent **跑在浏览器内**，可直接 import Firefox 在树的引擎/DevTools 模块 →「原生」。
- **红线（继承 jsvmp 线）**：能力对**任意站点**通用，绝不把任何具体站点案例写死进源码。所有目标 script、列、参数名都来自运行时配置，不硬编码。
- **既有决策（不再讨论，见 [[firefox-reverse-agent-sidebar]] memory）**：路径 B 内置 sidebar；不追上游（锁 153.0a1 baseline）；Key 用户自填、前端直连；不嵌本地模型；ToolRouter 是 Agent 与 MCP 的**共享抽象**。

## 1. 现状盘点（2026-05-25 实测）

| 能力 | firefox-reverse 现状 | 证据 |
|---|---|---|
| ④ JSVMP trace | ✅ **原生 C++ 可用** | `additions/js/src/vm/JsvmpTraceCore.cpp/.h`（631 行，NDJSON，env 驱动）；`dist/*.phase-b*.dmg` 已编译实测 |
| ① 网络捕获控制 | ❌ doc-only | `patches/network-analysis/README.md` 只列目标文件，无 patch/代码 |
| ② 保存 JS 文件 | ❌ doc-only | `patches/cookie-js-analysis/README.md` 同上 |
| ⑤ JS 执行 | ❌ 未建 | 无 chrome→content 桥 |
| ⑥ 代码搜索 | ❌ 未建 | 仅离线 `tools/inspect_ast.js` 对手动取的文件 |
| ③ 定位加密入口 | 🟡 离线 CLI | `tools/*.js` + `jsvmp-reverse-workflow.md`（已用真实案例验证） |
| **Agent 工具调用脊梁** | ❌ 只会聊天 | `LlmClient` 已支持 tools 协议字段，但无 `ToolRouter`、无 tool_use 循环 |

**结论**：除 ④ 外其余皆未落地；且无论建哪个能力，**脊梁（ToolRouter + tool_use 循环）必须先建**。

## 2. 架构总览：ToolRouter 脊梁 + 混合后端

```
┌─────────────────────────── sidebar Agent (React, content/) ──────────────────────────┐
│  AgentPanel  →  AgentLoop.sys.mjs  ←──tools schema / tool_use──→  LlmClient.sys.mjs    │
└───────────────────────────────────┬───────────────────────────────────────────────────┘
                                     │ dispatch(name,args)
                              ┌──────▼───────┐
                              │ ToolRouter   │  注册表 + 路由 + 结果信封 + 参数校验 + 截断
                              │ .sys.mjs     │  （后端无关；后端由 DI 注入）
                              └──────┬───────┘
        ┌───────────────┬───────────┼───────────────┬─────────────────────┐
   ┌────▼────┐    ┌─────▼─────┐ ┌───▼────┐    ┌──────▼──────┐       ┌───────▼────────┐
   │ Page    │    │ Network   │ │Scripts │    │ Jsvmp       │       │ Subprocess     │
   │ backend │    │ backend   │ │backend │    │ backend(C++)│       │ backend        │
   │ BiDi/   │    │ DevTools  │ │Debugger│    │ env+控制文件│       │ tools/*.js     │
   │ JSActor │    │ NetObsrv  │ │scriptP.│    │ + 读 NDJSON │       │ (node, 见§6)   │
   └─────────┘    └───────────┘ └────────┘    └─────────────┘       └────────────────┘
```

**混合策略（用户 2026-05-25 拍板）**：先用 Firefox 在树的 **DevTools + WebDriver BiDi** 模块把能力快速跑起来（JS 里迭代、无外部 server、无新 C++）；④ 用已有原生 C++；热点路径（网络/存 JS）以后**选择性下沉**到 C++（即把 `patches/network-analysis`、`patches/cookie-js-analysis` 真正落地）做到引擎级/不易被检测。

## 3. 六大能力 → 工具 → 机制 → 阶段

ToolRouter 工具命名用 `域_动作`（与 agent-sidebar.md §3.2(d)/§8 对齐）。

| 能力 | ToolRouter 工具 | Phase-1 机制（混合·快） | Phase-2 下沉（可选·C++） |
|---|---|---|---|
| ⑤ JS 执行 | `page_eval` | BiDi `script.evaluate` / JSActor `evalInSandbox` | — |
| 页面控制 | `page_navigate/reload/click/type/screenshot/snapshot` | BiDi `browsingContext`+`input` | — |
| ① 网络捕获 | `net_capture(start/stop)`、`net_list`、`net_get`、`net_intercept` | DevTools `NetworkObserver`（进程内）或 BiDi `network` 模块；含 initiator 调用栈 | `patches/network-analysis`：patch `nsHttpChannel/WebSocketChannel/Fetch/XHR`，native 栈 |
| ② 保存 JS | `scripts_list`、`scripts_get`、`scripts_save`、`scripts_capture_all` | DevTools `Debugger.scriptParsed`+`getScriptSource`（含 eval/Function/inline/worker）→ `IOUtils` 落盘 | `patches/cookie-js-analysis`：patch `ScriptLoader/Compilation/Eval`，`<sha256>.js` |
| ⑥ 代码搜索 | `code_search` | `Subprocess`→ripgrep 扫已存 JS 语料目录；或 JS 侧遍历 | — |
| ④ JSVMP trace | `jsvmp_trace(start/stop)`、`jsvmp_query`、`jsvmp_detect_dispatcher`、`jsvmp_dump_closure_consts`、`jsvmp_extract_handlers`、`jsvmp_name_unknown_ops`、`jsvmp_disassemble`、`jsvmp_reverse_algorithm` | 原生 C++ 控制（启动 env + 运行期控制文件）+ `IOUtils` 读 NDJSON + `Subprocess` 跑 `tools/*.js` | 已是 C++ |
| ③ 定位加密入口 | `find_param_entry(param,{url})` | **组合工具**：`net_get` 取 initiator 栈 + `code_search` 找参数字面量 + `page_eval`/`hook_function` 在嫌疑函数下钩子 +（可选）属性 trace → 排序候选入口（file:line + 栈） | 叠加 `patches/property-trace` 原生 getter 追踪 |
| ⑦ 工作目录/本地执行 | `fs_list`、`fs_read`、`fs_write`、`fs_mkdir`、`run_node`、`run_python` | 每会话绑定一个本地目录（侧边栏 `nsIFilePicker` 选）；文件读写**限定目录内**（拒 `..`/绝对越界）；`Subprocess` 在目录内跑宿主 node/python（cwd=目录，回传 stdout/stderr，PATH 兜底 homebrew/usr-local）；jsvmp trace 自动镜像到 `<目录>/jsvmp/`。让 Agent 把抓取脚本/还原实现落盘并实跑验证，形成闭环 | — |

**说明**：③ 是建立在 ①②⑤⑥ 之上的**编排型**工具——这也是 firefox-reverse 相对 Cursor 的差异化：Agent 能把「网络参数 ↔ 产出它的 JS ↔ JSVMP 内部」一条链打通。

## 4. ToolRouter / AgentLoop 设计

**ToolRouter.sys.mjs**（零 Firefox 依赖，后端 DI 注入，可 Node 自测）
- `register(spec)` / `registerAll(specs)`：`spec = { name, description, parameters(JSON-Schema), handler(args, ctx) }`。
- `listSpecs()` → OpenAI `tools` 数组 `[{type:"function", function:{name,description,parameters}}]`，直接喂 `LlmClient.chat(_, {tools})`。
- `dispatch(name, args, ctx)` → **结果信封** `{ ok, data?, error?, meta? }`；catch handler 抛错 → `{ok:false,error}`；未知工具 → `{ok:false,error:"unknown tool"}`；按 `maxChars` 截断超大结果（防爆 LLM 上下文）。
- 轻量参数校验：检查 `parameters.required` 是否齐全（不做完整 JSON-Schema 校验，保持零依赖）。

**AgentLoop.sys.mjs**（tool_use 循环；OpenAI 协议；DeepSeek V4 已支持 function calling）
```
runAgentTurn({ client, router, messages, systemPrompt?, maxRounds=6, signal, onEvent? }):
  msgs = [ {system}, ...messages ]
  for r in 1..maxRounds:
    res = await client.chat(msgs, { tools: router.listSpecs(), signal })
    if res.toolCalls.length == 0: return { content: res.content, rounds:r, messages: msgs }
    msgs.push({ role:"assistant", content: res.content ?? "", tool_calls: res.toolCalls })
    for tc in res.toolCalls:
      args = JSON.parse(tc.function.arguments || "{}")
      if router.needsConfirm(tc.name) and not (autoApprove or await confirm(tc)):   # A3 用户确认
        env = { ok:false, error:"user denied", denied:true }
      else:
        env = await router.dispatch(tc.function.name, args, ctx)
      msgs.push({ role:"tool", tool_call_id: tc.id, content: JSON.stringify(env) })
  return { content: "(达到 maxRounds)", rounds:maxRounds, messages: msgs }
```
- `onEvent` 把每步（round / tool_call / tool_result / confirm_request / confirm_result / final）推给 UI，便于侧栏展示「Agent 正在调用 X / 请批准」。
- **用户确认（A3 要求）**：改动型工具（`page_eval`/`page_navigate`/`net_capture`/`net_intercept`/`scripts_save`/`jsvmp_trace`）标 `needsConfirm`；执行前经 `confirm(call)→bool` 征求批准。**默认安全**：需确认但既无 `confirm` 回调也未 `autoApprove` → 拒绝（denied 信封）。只读工具（`*_list`/`*_get`/`code_search`/`jsvmp_query`）免确认。

## 5. 后端适配器（Phase-1 机制要点）

- **PageBackend**：优先 WebDriver BiDi（`resource:///modules/...` 在树模块，`script.evaluate`/`browsingContext`），回退 JSActor（chrome↔content）。返回值序列化 + 抛错带栈。
- **NetworkBackend**：DevTools `NetworkObserver`（`resource://devtools/server/...`）进程内订阅；或 BiDi `network`（支持 `addIntercept`/`continueRequest` 改包）。统一落到内存环形缓冲 + initiator 栈。
- **ScriptsBackend**：DevTools `Debugger` API（`scriptParsed` 拿全部已解析源，含 eval/Function/worker，比 `querySelectorAll('script')` 全），源码 `IOUtils.writeUTF8` 落盘到语料目录（= `code_search` 的语料）。
- **JsvmpBackend**：启动期 env（`MOZ_JSVMP_TRACE*`）+ 运行期控制文件；`IOUtils` 读 `/tmp/firefox-reverse-jsvmp-b.ndjson.<pid>`；分析步 `Subprocess` 调 `tools/*.js`。缓存键 **`(file,col)`**（`sid` 是 SpiderMonkey 指针，进程重启即变）。
- **SubprocessBackend**：`resource://gre/modules/Subprocess.sys.mjs`（chrome JS 无 `child_process`）。

## 6. 关键约束与风险

1. **Node 未随 Firefox 打包** → `tools/*.js`（dispatcher_split/disassemble 等）在分发版无法直接跑。策略：开发期用 `Subprocess` 调宿主机 `node`（可用）；分发期再决定 (a) 打包精简 node、(b) 把分析脚本移植到 chrome-JS/worker、(c) 作为 companion CLI。**不阻塞脊梁与 ①②⑤⑥**。
2. **依赖内部 DevTools/BiDi 模块 API** 跨版本脆弱 → 已决策锁 baseline 153.0a1、不追上游，适配成本用户自担；适配层集中在各 backend，便于升级时定点修。
3. **可检测性**：Phase-1 的 DevTools/BiDi/注入 JS 属半透明，**工作站自用可接受**；需要对抗目标站检测时走 Phase-2 C++ 下沉。
4. **system ESM 全局 fetch**：A1 已用 DeepSeek live 验证可用（说明特权环境 `globalThis.fetch` OK）。
5. **trace 路径/缓存键**：见 §5 JsvmpBackend。

## 7. 分阶段路线

- **N0｜脊梁（本次起步）**：`ToolRouter.sys.mjs` + `AgentLoop.sys.mjs` + `LlmClient` tool_use（已就绪）+ 2 个活工具（`page_eval`、`code_search`，后端可 mock）+ `dev/selftest-toolrouter.mjs` Node 跑通循环。**不依赖编译浏览器**。
- **N1｜网络 + 存 JS**：`NetworkBackend`（DevTools/BiDi）落地 `net_*`；`ScriptsBackend` 落地 `scripts_*`（含语料目录）。需浏览器集成 + 远程编译验证。
- **N2｜JSVMP 集成**：`JsvmpBackend` 把已有 C++ trace 接入 ToolRouter（控制 + query + `Subprocess` 分析），暴露 7 个 `jsvmp_*` 工具。
- **N3｜定位加密入口**：`find_param_entry` 组合工具（依赖 N1/N2）。
- **N4｜可选 C++ 下沉**：`patches/network-analysis`、`patches/cookie-js-analysis`、`patches/property-trace` 真正落地，做引擎级/不易检测版本。

## 8. 文件边界 & 与现有文档关系

- **新增全部位于** `additions/browser/components/agent-sidebar/`：`modules/{ToolRouter,AgentLoop}.sys.mjs`、`modules/tools/*.sys.mjs`（或 `modules/Tools.sys.mjs`）、`modules/backends/*.sys.mjs`（N1+）、`dev/selftest-toolrouter.mjs`。本设计文档 `docs/agent-native-capabilities.md`。
- **只读调用、绝不修改**：`additions/js/`（jsvmp C++）、`tools/*.js`、`patches/jsvmp-trace/`、`scripts/*.py`。
- **与 [agent-sidebar.md](./agent-sidebar.md) 关系**：本文是其 §3.2(d)/§6（ToolRouter）/§8（jsvmp 工具）的落地细化；§8 的 7 个 jsvmp.* 工具由 jsvmp 线维护，本文以 `jsvmp_*` 之名纳入 ToolRouter 统一暴露，不覆盖其语义。
- **与 MCP 关系**：未来 `firefox-reverse-mcp` 是 ToolRouter 之上的薄 RPC 包装（复用同一注册表），与 camoufox-reverse-mcp 解耦（独立仓、独立进程）。

# Agent 侧边栏方案

> firefox-reverse 浏览器内置 AI Agent 对话面板的可行性方案与实施规划。
>
> 类比产品：Brave Leo / Opera Aria / Edge Copilot / Arc Max / Cursor IDE。

## 1. 目标与定位

在 firefox-reverse 浏览器侧边栏内置一个 AI Agent 对话面板,用户可：

- 在面板内选择模型、填写 API Key,直接与 LLM 对话
- 让 Agent 调用浏览器底层 API,操作当前页面、读取 trace 数据、调整指纹/代理配置
- 把 firefox-reverse 的六大模块(fingerprint / proxy / jsvmp-trace / network-analysis / cookie-js-analysis / property-trace)的数据,作为 Agent 的"上下文",做 JS 逆向辅助决策

**差异化**:相比 Cursor 这类外挂工具,Agent 直接驻留在浏览器进程内,能拿到 C++ 层 trace、网络捕获、JS 落盘等普通扩展拿不到的数据。

## 2. 已拍板的决策

| 决策项 | 选择 | 理由 |
|---|---|---|
| **实现路径** | **B 方式:内置 sidebar UI** | 跳过 WebExtension PoC,直接做内置面板 |
| **上游同步** | **不追上游升级** | sidebar 相关补丁脆弱,统一锁定在当前可行版本即可。后续 Mozilla 升级带来的冲突由用户自行迭代,不作为常规维护项 |
| **UI 架构选型** | **接受 XUL + React 混杂** | Firefox 老组件 XUL、新组件 React (`browser/components/`),sidebar 改造踩坑成本接受 |
| **API Key** | **用户自行填写** | 不做代理服务器、不托管 Key,前端直连 LLM 厂商 API。隐私和成本责任在用户侧 |
| **本地模型** | **不嵌入** | 全部走现成云端 API,避免打包体积膨胀几个 G |
| **测试模型** | **DeepSeek V4** | 前期验证用,后续可扩展 OpenAI / Anthropic / Gemini / 国内其他模型 |
| **维护边界** | **短期混入 patches/,长期拆独立子仓** | 初期 `patches/agent-ui/` 与引擎层补丁并存;成熟后拆出 `firefox-reverse-agent-ui/` 独立 git 仓库,与引擎层关注点解耦 |

## 3. 实现路径 B 细化

### 3.1 模块位置

```
firefox-reverse/
├── patches/
│   └── agent-ui/                      ← 新增模块
│       ├── README.md                   功能说明与状态
│       ├── 0001-add-sidebar-entry.patch       浏览器 chrome 注册侧边栏入口
│       ├── 0002-agent-panel-xul.patch         XUL 容器(承载 React)
│       ├── 0003-llm-bridge.patch              chrome-privileged 的 LLM 调用桥
│       ├── 0004-tool-router.patch             Agent 工具调用路由(浏览器 API → MCP-style 调用)
│       └── 000N-*.patch
├── additions/
│   └── browser/
│       └── components/
│           └── agent-sidebar/         ← 新增源文件目录
│               ├── content/            React 面板源码
│               │   ├── AgentPanel.jsx
│               │   ├── ModelSelector.jsx
│               │   ├── ChatHistory.jsx
│               │   ├── ToolInvocationView.jsx
│               │   └── SettingsPane.jsx
│               ├── modules/            chrome-privileged JSM/ESM 模块
│               │   ├── LlmClient.sys.mjs       调用 LLM API(fetch + SSE 流式)
│               │   ├── ToolRouter.sys.mjs      把 Agent 的 tool_use 路由到浏览器 API
│               │   ├── ConfigStore.sys.mjs     读写用户 API Key、模型选择(偏好或加密存储)
│               │   └── TraceBridge.sys.mjs     桥接到 jsvmp-trace / network / property-trace
│               └── jar.mn / moz.build
└── settings/
    └── agent.example.json             示例配置:模型列表、endpoint、默认参数
```

### 3.2 关键技术点

#### (a) 侧边栏入口注册

Firefox 已有 `SidebarUI` 框架(`browser/components/sidebar/`),通过 patch 注册一个新的 sidebar broadcaster,即可在原生侧边栏菜单加入"Agent"项。无需新建独立窗口。

#### (b) UI 渲染

- 容器层:XUL `<browser>` 或 `<vbox>` 承载
- 内容层:React 18 + 现代构建(esbuild / Vite 单独打,产物注入 omni.ja)。**避开 XUL 内置控件**,所有可见 UI 用 HTML+React,只在最外层用 XUL 容器
- 样式:CSS-in-JS 或 plain CSS,跟随 Firefox 主题色变量(`--toolbar-bgcolor` 等)

#### (c) LLM 调用通道

- 走 `chrome://` 特权环境的 `fetch`,绕过 CSP 限制
- 支持 SSE 流式输出(`ReadableStream` + 手动解析 `data: ...`)
- 模型路由:`LlmClient` 内部按 provider(deepseek / openai / anthropic / gemini)分流,统一抽象 `messages` / `tools` / `stream` 接口
- 工具调用走 OpenAI tool_use 兼容协议,所有 provider 适配到同一抽象

#### (d) 浏览器 API 控制通道(Agent → Browser)

**这是核心**。Agent 的 `tool_use` 不只是"操作 DOM",而是能调用 firefox-reverse 的能力:

| Tool 类别 | 调用 | 实现 |
|---|---|---|
| 页面操作 | `navigate / click / type / scroll / screenshot` | 已有 Firefox Remote Agent (CDP/BiDi) 内部 API |
| Trace 查询 | `query_jsvmp_trace / query_network / query_property_access` | TraceBridge → 读 `~/.firefox-reverse/traces/` 落盘文件 |
| 配置热更新 | `set_fingerprint / set_proxy / toggle_hook` | 调用 fingerprint / proxy 模块的运行时配置接口 |
| JS 执行 | `eval_in_page / hook_function` | content-script bridge,复用 camoufox-reverse-mcp 的 hook 模板思路 |

#### (e) API Key 存储

- 默认:用户偏好(`about:config` / `prefs.js`)明文存储,文档说明风险
- 进阶选项:用 Firefox 的 `LoginManager`(钥匙串/Credentials Vault),引导用户首次设置主密码
- **不上传任何遥测、不内置代理**

### 3.3 默认模型清单

`settings/agent.example.json` 提供以下 provider 模板,用户填 Key 即可用:

| Provider | Endpoint | 备注 |
|---|---|---|
| **DeepSeek V4** | `https://api.deepseek.com/v1/chat/completions` | 前期主力测试模型 |
| OpenAI | `https://api.openai.com/v1/chat/completions` | GPT-4o / o1 等 |
| Anthropic | `https://api.anthropic.com/v1/messages` | Claude 4.x 系列 |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/...` | Google 模型 |
| 自定义 OpenAI 兼容端点 | 用户填 | 适配 vLLM / Ollama / 各类国内厂商 |

## 4. 阶段拆分

> 注意:不进 features.md / roadmap.md 的主线 Phase 编号,作为独立 Track 推进。主线 Phase 2 (JSVMP Trace) 不受影响。

### Track A1 — 最小可用侧边栏(MVU)

- [ ] `patches/agent-ui/0001-add-sidebar-entry.patch`:在 sidebar 注册"Agent"入口
- [ ] `additions/.../AgentPanel.jsx`:一个能输入 prompt、显示回复的简单 React 面板
- [ ] `LlmClient.sys.mjs`:DeepSeek V4 non-streaming 调用
- [ ] `SettingsPane.jsx`:API Key 输入框 + 模型下拉
- [ ] 编译 + 远程构建一份 macOS arm64 .dmg 本地验证

**里程碑**:能在侧边栏问 DeepSeek "你好"并拿到回复。

时间预算:**1-2 周**。

### Track A2 — 流式输出 + 多 provider

- [ ] SSE 流式渲染(打字机效果)
- [ ] OpenAI / Anthropic / Gemini provider 适配
- [ ] Chat 历史本地持久化(IndexedDB,scoped 到 chrome-privileged origin)
- [ ] Markdown / 代码块渲染

时间预算:**1 周**。

### Track A3 — Tool Use:页面操作

- [ ] `ToolRouter.sys.mjs` 框架:接收 Agent 的 tool_use 调用,路由到具体实现
- [ ] 内置 tools:`navigate` / `click_selector` / `read_dom` / `eval_js` / `screenshot`
- [ ] UI 上展示 tool_use 调用过程(展开/折叠卡片)
- [ ] 用户确认机制:高风险 tool 默认弹确认框,可在设置里关闭

时间预算:**2-3 周**。

### Track A4 — Trace 接入(差异化核心)

- [ ] `TraceBridge.sys.mjs`:读取 `~/.firefox-reverse/traces/jsvmp/`、`network/`、`property/` 落盘文件
- [ ] tools:`query_jsvmp_trace(filter)` / `query_network(filter)` / `query_property_access(filter)`
- [ ] 等主线 Phase 2 (jsvmp-trace) 至少完成 Phase 2.A 后启动

时间预算:**+2 周**,依赖主线进度。

### Track A5 — 配置热更新

- [ ] tools:`set_fingerprint(field, value)` / `set_proxy(config)` / `toggle_hook(name, enable)`
- [ ] 依赖主线 fingerprint / proxy / jsvmp-hook 模块的运行时配置接口

时间预算:**+1 周**。

### Track A6 — 拆独立子仓

- [ ] 评估时机:当 `patches/agent-ui/` 补丁数 > 15 且 `additions/.../agent-sidebar/` 源文件 > 30 个时
- [ ] 新建 `firefox-reverse-agent-ui/` 私有仓
- [ ] firefox-reverse 主仓只保留一个"安装入口" patch,UI 源码作为 git submodule 或独立分发
- [ ] 长期目标:UI 仓的迭代节奏与引擎层解耦,UI 可单独发版

## 5. 风险与边界

| 风险 | 说明 | 应对 |
|---|---|---|
| **上游升级冲突** | sidebar 补丁脆弱,Mozilla 任何 UI 重构都可能冲突 | **不追上游**。锁定到当前 baseline,冲突由用户自行迭代解决 |
| **omni.ja 重打包** | React 产物注入 omni.ja 流程繁琐 | 编译脚本里加一步 `pack-omni.sh`,放到 `firefox-reverse-build/scripts/` |
| **API Key 泄漏** | 用户填的 Key 落地到 prefs.js 明文 | 文档明示风险,推荐 LoginManager 加主密码 |
| **网络代理冲突** | LLM 调用走 fetch,会被 proxy 模块影响 | LlmClient 走 `nsIChannel` 时显式 bypass proxy(可配置) |
| **隐私问题** | 用户可能误把页面内容 / cookie 发给 LLM | 默认 Agent 上下文不包含敏感字段,需用户显式授权 "把当前页 cookie 加入对话" |
| **CSP / Mixed Content** | sidebar 内 fetch 跨域 / HTTPS 检查 | chrome-privileged 上下文豁免,但要避免漏给 content script |
| **OS 鉴权弹窗** | macOS / Windows 首次访问钥匙串触发系统弹窗 | 文档说明,首次使用提示一次 |

## 6. 与现有六大模块的关系

```
┌────────────────────────────────────────────────────────────┐
│                    Agent Sidebar (新增)                       │
│   React 面板 + LlmClient + ToolRouter + TraceBridge          │
└──────────────┬─────────────────────────────────────────────┘
               │ 消费数据 / 调用配置 API
               ▼
┌────────────────────────────────────────────────────────────┐
│              firefox-reverse 引擎层(六大模块)               │
│  fingerprint │ proxy │ jsvmp-trace │ network │ cookie │ prop │
└────────────────────────────────────────────────────────────┘
```

- **Agent Sidebar 不替代 firefox-reverse-mcp**:MCP 仍然是给外部 Cursor / Claude 用的工具暴露层。两者可共存——同一个 ToolRouter 抽象,在内可被 sidebar Agent 直接调,在外可被 MCP server 包装暴露
- **数据流向**:引擎层 → 落盘 → TraceBridge 读取 → Agent 上下文。不直接走内存共享,保持隔离

## 7. 待补充事项

- [ ] Firefox sidebar API 的具体 patch 点位调研(`browser/components/sidebar/SidebarController.sys.mjs` 在 153 的位置)
- [ ] omni.ja 重打包的工程细节
- [ ] React 产物的 CSP 兼容(`unsafe-eval` 在 chrome 上下文是否需要)
- [ ] DeepSeek V4 API 的 tool_use 协议确认(是否完全兼容 OpenAI function calling)
- [ ] 国产 LLM provider 列表扩展

## 8. JSVMP Reverse 集成（基于实战 目标SDK 经验补强）

> **背景**：2026-05-21 跑通了完整 JSVMP 反汇编工作流（详见 [jsvmp-reverse-workflow.md](jsvmp-reverse-workflow.md)），示例VMP 70% / 目标SDK 69% 自动识别 + LLM 命名 100%。这套工作流当前是 user 手动在 mac terminal 跑命令行，Agent sidebar 应该把它**端到端集成进浏览器**，让 reverse 从"工程师工作"变成"浏览器一键操作"。

### 8.1 新增 Tool 类别：JSVMP Reverse

在 `ToolRouter.sys.mjs` 加这一组 tool：

| Tool 名 | 输入 | 输出 | 实现路径 |
|---------|------|------|---------|
| `jsvmp.detect_dispatcher` | URL（默认当前页）| `{sid, file, col, hits}` 列表 | 调 firefox-reverse hook → trace → 按 hits 排序最热 script |
| `jsvmp.dump_bytecode` | dispatcher sid | bytecode hex string | 调 firefox-reverse Phase B.3 dump_args，PC=0 触发 |
| `jsvmp.dump_closure_consts` | dispatcher sid | `{q[], p[], xor_key}` | 调 firefox-reverse Phase B.4 dump_locals + envChain（待实现） |
| `jsvmp.extract_handlers` | dispatcher source | `handlers.json`（含 pattern 自动命名）| `child_process` 调 `tools/dispatcher_split.js` |
| `jsvmp.name_unknown_ops` | `handlers.json` 含 UNKNOWN | `handlers.json` 全命名 | 用 `LlmClient` 喂 UNKNOWN handler source 给 LLM，回写 inferred_name |
| `jsvmp.disassemble` | handlers + bytecode + consts | 伪汇编文本 | 调 `tools/disassemble.js`（待补） |
| `jsvmp.reverse_algorithm` | URL + 期望签名 API | Python 复现代码草稿 | **完整 pipeline 串联**：以上 tool 链 + LLM 综合分析 |

### 8.2 UI 增强

在 React `AgentPanel.jsx` 旁加几个**专用面板**：

- **"分析当前页 JSVMP"按钮**（toolbar）
  - 点击 → 自动跑 `jsvmp.detect_dispatcher`，在面板里展示 top 5 候选 dispatcher（sid + hits + script URL + 跳转 source 链接）

- **Handlers 表格视图**（`HandlersTable.jsx`）
  - 二维表格：op_key | inferred_name | source preview | status (auto / llm-named / unknown)
  - 每行可点 "Re-name with LLM" / "Edit name manually"
  - 高亮 UNKNOWN 行（红色），引导用户点 "Name all unknown with LLM" 批量处理

- **反汇编 Viewer**（`DisasmView.jsx`）
  - 显示伪汇编（每行 `pc=N op=NAME operands=[...]`）
  - 高亮 control flow（JMP/JIF/JNF 跳转可视化）
  - 高亮加密点（MD5/RC4/XOR 模式自动检测）
  - 跟 source code viewer 联动（点 PC 跳到对应 目标SDK col）

- **NDJSON Trace Browser**（`TraceBrowser.jsx`）
  - 浏览 `~/.firefox-reverse/traces/*.ndjson`
  - 按 `ev` 字段过滤（`enter`/`op`/`call`/`prop_access`）
  - 按 sid / pc 范围 / opname filter
  - 折叠/展开嵌套调用栈

### 8.3 实施阶段（合并到主 Track 编号）

| Track | 内容 | 时间预算 |
|-------|------|--------|
| **A4-JSVMP**（替代/扩展原 A4） | `jsvmp.detect_dispatcher` + `jsvmp.dump_bytecode` + `jsvmp.extract_handlers` 3 个核心 tool；HandlersTable.jsx 基础 UI | 3-5 天 |
| **A4-LLM** | `jsvmp.name_unknown_ops`（用 LlmClient 批量喂 LLM）；UI 显示命名 confidence | 1-2 天 |
| **A4-Disasm** | `jsvmp.disassemble`（先补 `tools/disassemble.js`）；DisasmView.jsx | 1 周（含 byte → path 映射的 abstract interpreter） |
| **A4-E2E** | `jsvmp.reverse_algorithm` 端到端 pipeline + Python codegen | 1 周 |
| **A4-Trace** | TraceBrowser.jsx + jq-style filter | 2-3 天 |

依赖 Track A3（ToolRouter 框架）先就绪。

### 8.4 工具间通信

```
┌─────────────────────────────────────────────────────────┐
│  Agent Sidebar (React)                                   │
│    AgentPanel + HandlersTable + DisasmView + TraceBrowser│
└──────────────┬──────────────────────────────────────────┘
               │ tool_use call
               ▼
┌─────────────────────────────────────────────────────────┐
│  ToolRouter.sys.mjs (chrome-privileged JSM)             │
│    jsvmp.* tool 注册 + 调度                              │
└──────────────┬──────────────────────────────────────────┘
               │ child_process / IPC
               ▼
┌─────────────────────────────────────────────────────────┐
│  firefox-reverse 引擎层 + tools/                         │
│    - jsvmp-trace hook (Phase B.3)                       │
│    - dispatcher_split.js (Babel AST 拆解)                │
│    - disassemble.js (TBD)                                │
│    - ai_name_unknown.js (TBD，用 LlmClient)              │
└─────────────────────────────────────────────────────────┘
```

**关键技术决策**：

- **tool 调用走 `child_process.exec`** —— 跑离线 Node 工具最快，跨进程不需要 binding glue
- **trace 文件用 chrome-privileged fetch** 读 `file:///`（profile dir 内）
- **LLM 调用复用 `LlmClient.sys.mjs`**（user 在 SettingsPane 填的 API Key）
- **结果落 IndexedDB**（chrome scope）+ 可导出 JSON 给离线分析

### 8.5 价值定位

- **现在**：reverse 工作流 4 步，user 在 mac terminal 跑命令行 → 看 trace → 跑 Node 工具 → 喂 LLM → 写 Python。**全程工程师手工，门槛高**
- **Agent sidebar 集成后**：user 在 firefox 里访问目标 URL → 点 "分析 JSVMP" 按钮 → Agent 自动跑完整 pipeline → 在 chat 里跟 user 讨论算法细节 → 输出 Python 代码
- **门槛降到**：会用 firefox + 会复制粘贴 → 能做 JSVMP reverse（**reverse 即服务**）

### 8.6 相对 LoseNine Ruyi Trace 的差异

LoseNine 的 Ruyi Trace 做 DOM API binding trace（指纹分析）；我们的 JSVMP Reverse 做**字节码反汇编 + 算法还原**。两个不冲突，可以同 sidebar 共存：

- 选 tab "Fingerprint" → DOM API trace 模式（类似 Ruyi Trace）
- 选 tab "JSVMP" → 反汇编模式（本节方案）

---

**更新日志**

- 2026-05-21 初版：选定路径 B、不追上游、用户自填 Key、不嵌本地模型、DeepSeek V4 主测、长期拆独立子仓
- 2026-05-21 补强：加入第 8 节 JSVMP Reverse 集成，基于 目标SDK 实战经验把 4 步工作流端到端搬进 sidebar

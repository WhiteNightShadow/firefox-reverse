# Agent Sidebar 交接清单

> 交接给 jsvmp 线程接手。**现状：A1（最小可用侧栏）代码已全部完成并验证，剩 T6 编译。**
> 方案见 [`docs/agent-sidebar.md`](../../docs/agent-sidebar.md)，模块说明见 [`additions/browser/components/agent-sidebar/README.md`](../../additions/browser/components/agent-sidebar/README.md)。

## 1. TL;DR

- Agent 侧栏的全部代码（LLM 调用、配置、React UI、sidebar 注册 patch、构建）已写完。
- LLM 链路 + 配置 + 端到端已用 **DeepSeek 真实 API live 验证通过**。
- `upstream/` 当前已是「应用了 patch + 组件就位」的**可编译状态**。
- **唯一剩余 = 编译**（T6）：在服务器编译出带 Agent 侧栏的 Firefox，验证「侧栏问 DeepSeek 拿到回复」。

## 2. 已完成文件清单

### 内容层 `additions/browser/components/agent-sidebar/`

| 文件 | 作用 | 验证 |
|---|---|---|
| `modules/LlmClient.sys.mjs` | OpenAI 兼容 LLM 调用，零 Firefox 依赖（只用 globalThis.fetch）。non-streaming | ✅ DeepSeek live |
| `modules/ConfigStore.sys.mjs` | API Key/模型/active provider 持久化。Firefox 用 Services.prefs，Node 退化内存 backend | ✅ Node 单测 |
| `modules/providers.sys.mjs` | 内置 provider 元数据 + `buildClientFromStore()` | ✅ e2e live |
| `content/AgentPanel.jsx` | 对话面板。props 注入 `buildClient`（纯 UI） | ✅ esbuild 打包 |
| `content/SettingsPane.jsx` | 设置面板。props 注入 `store`/`providers` | ✅ esbuild 打包 |
| `content/index.jsx` | 挂载入口。运行时 `ChromeUtils.importESModule` 加载 modules | ✅ esbuild 打包 |
| `content/panel.html` | sidebar 容器（CSP 允许 https LLM 调用） | — |
| `content/agent-panel.css` | 跟随 Firefox 主题变量的样式 | — |
| `content/agent-sidebar.bundle.js` | esbuild 产物 143.5kb（**gitignore，编译前需 `npm run build` 生成**） | ✅ 已生成 |
| `moz.build` | `EXTRA_JS_MODULES.agentsidebar`（→ resource:///modules/agentsidebar/）+ JAR_MANIFESTS | — |
| `jar.mn` | content 资源 → chrome://browser/content/agent-sidebar/ | — |
| `package.json` | esbuild + react devDeps + `npm run build`（含 --minify） | — |
| `dev/selftest-{llm,config,e2e}.mjs` | Node 自测脚本（**不打包**，jar.mn/moz.build 不引用） | ✅ 可跑 |
| `README.md` / `.gitignore` | 模块说明 / 忽略 node_modules+bundle | — |

### Patch `patches/agent-ui/0001-register-agent-sidebar.patch`

改 3 个 upstream 文件（14 行新增，照内置 genai chat sidebar 模式）：
- `browser/components/sidebar/browser-sidebar.js`：`SidebarController.generateSidebarsMap()` 的 Map 加 `viewAgentSidebar`，url=`chrome://browser/content/agent-sidebar/panel.html`
- `browser/components/moz.build`：DIRS 加 `"agent-sidebar"`
- `browser/locales/en-US/browser/sidebar.ftl`：加 `sidebar-menu-agent-label = .label = Agent`

### 脚本改动 `scripts/`

- `apply-patches.sh`：① MODULES 加 `agent-ui`；② **修了 rsync 的 `find|read`+pipefail bug**（原 bug 导致 additions/ 从未被 rsync，对 jsvmp 的 `additions/js/` 同样是修复）+ 加 `--exclude node_modules/dev/*.jsx/package*.json/.gitignore`
- `scripts/remote.sh`：**临时**远程连接封装（`<remote-build-host>` + `<build-ssh-key>`）。**已 gitignore，发布前删**

## 3. 怎么继续（T6 编译）

服务器 `<remote-build-host>`（用 `bash scripts/remote.sh "<命令>"` 连）现状（2026-05-22 探测）：
- 32 核 / 61G 内存 / 76G 可用磁盘（偏紧）
- **rust 1.95 已装**（`~/.cargo`，jsvmp 编 firefox-vanilla 时装的，**够编 Firefox 153，不用动**）、clang14/python3.10/node22/git 齐全、`bootstrap.done` 在
- **同机有 jsvmp 的 `~/firefox-vanilla`（已编译）+ `~/camoufox-reverse`** → 别和它们同时 `mach build`，会抢 CPU/内存/磁盘
- 服务器上**还没有 `~/firefox-reverse`** → 需 git clone 或从本地 rsync

编译步骤：
1. 同步 firefox-reverse 到服务器（git clone 私有仓 或 `rsync` 本地）
2. `cd additions/browser/components/agent-sidebar && npm install && npm run build` 生成 bundle（**bundle 是 gitignore 的，服务器上必须重新 build**）
3. `./scripts/bootstrap.sh`（clone upstream，几个 G）
4. `./scripts/apply-patches.sh`（apply 0001 patch + rsync 组件，已验证可跑通）
5. `cd upstream && source ~/.cargo/env && ./mach build`（依赖齐，**可跳过 `./mach bootstrap`**）
6. 产物在 `upstream/obj-*/dist/`，拉回本地装，验证里程碑：**侧栏出现 Agent 图标 → 填 DeepSeek Key → 对话拿到回复**

建议：照顶层 `scripts/deploy-and-test.sh`（camoufox 专用）的模式，为 firefox-reverse 写一个 `scripts/deploy-build.sh` 封装上述流程。

## 4. 接手必读的坑

1. **`child_process` 不存在于 chrome JS**：A3/A4 要调 `tools/*.js` 等子进程时，用 `Subprocess.sys.mjs`（`resource://gre/modules/Subprocess.sys.mjs`），不是 Node 的 child_process。文档 8.4 写错了。
2. **Firefox 153 sidebar 架构**：是 `SidebarController` 对象（在 `browser-sidebar.js` 里），**不是**独立的 SidebarController.sys.mjs；面板注册照 `generateSidebarsMap()` 里内置的 `viewGenaiChatSidebar` 模式。
3. **`sys.mjs` 全局 `fetch` 可用性未实测**：`LlmClient` 假设 chrome 特权 ESM 有 `globalThis.fetch`，编译跑起来后需确认；若不可用，由宿主（panel document）注入。
4. **资源 URL**：模块 = `resource:///modules/agentsidebar/<name>.sys.mjs`，content = `chrome://browser/content/agent-sidebar/<file>`。bundle 里已硬编码这些，改了要重新 `npm run build`。
5. **A4 接 jsvmp trace 时**：真实落盘路径是 `/tmp/firefox-reverse-jsvmp-b.ndjson.<pid>`（可被 `MOZ_JSVMP_TRACE_FILE` 覆盖），**不是**方案文档写的 `~/.firefox-reverse/traces/jsvmp/`；`sid` 是指针地址、进程重启即变，缓存键用 `(file,col)`。

## 5. 后续 Track（A1 之后，见 docs/agent-sidebar.md 第 4 / 8 节）

- A2：SSE 流式 + anthropic/gemini provider 适配（LlmClient 已留 protocol 分支 TODO）
- A3：`ToolRouter.sys.mjs` + 页面操作 tools（用户确认机制）
- A4：`TraceBridge.sys.mjs` + jsvmp.* tools（第 8 节已设计 7 个 tool，用 Subprocess 调 tools/dispatcher_split.js 等）
- A5：配置热更新 tools
- A6：拆独立子仓 `firefox-reverse-agent-ui/`

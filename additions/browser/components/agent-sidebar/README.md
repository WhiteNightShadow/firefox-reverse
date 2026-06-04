# agent-sidebar/ — Agent 侧边栏内容层

Agent 侧边栏的 **UI + LLM 调用源码层**。配合 [`patches/agent-ui/`](../../../../patches/agent-ui/README.md) 把它挂载进 Firefox chrome。方案见 [`docs/agent-sidebar.md`](../../../../docs/agent-sidebar.md)。

## 目录

| 目录 | 内容 | 打包 |
|---|---|---|
| `content/` | React 面板（`.jsx`）：AgentPanel / SettingsPane / ...（A1 待写） | 经 esbuild 打包注入 omni.ja |
| `modules/` | chrome-privileged ESM（`.sys.mjs`）：LlmClient ✅ / ConfigStore(A1) / ToolRouter(A3) / TraceBridge(A4) | 进 omni.ja |
| `dev/` | Node 自测脚本，**不随浏览器打包**（jar.mn 排除） | 否 |

## 与 jsvmp 线的文件边界（重要）

本目录属于 **Agent sidebar 线**。为与并行的 jsvmp 线零冲突，**本线不修改**：

- `additions/js/`（jsvmp C++ trace 实现）
- `patches/jsvmp-trace/`
- `tools/`（dispatcher_split.js 等 Node 工具）
- `scripts/*.py`（trace 分析器）
- `docs/agent-sidebar.md` 第 8 节、`docs/jsvmp-reverse-workflow.md`、`docs/roadmap.md`（jsvmp 线在维护）

trace 数据通过**只读契约**对接（A4 阶段），契约规格记录在 `patches/agent-ui/README.md`。

## A1 状态

| 部件 | 状态 |
|---|---|
| `modules/LlmClient.sys.mjs` | ✅ DeepSeek live 验证通过（OpenAI 兼容，deepseek/openai/custom） |
| `modules/ConfigStore.sys.mjs` | ✅ Node 单测通过（prefs/内存双 backend） |
| `modules/providers.sys.mjs` | ✅ 端到端 live 通过（ConfigStore→providers→LlmClient→DeepSeek） |
| `content/AgentPanel.jsx` + `SettingsPane.jsx` | ✅ esbuild 打包通过（jsx 语法已验证） |
| `content/index.jsx` + `panel.html` + `agent-panel.css` | ✅ 挂载入口 + 容器 + 主题样式 |
| `package.json` → `content/agent-sidebar.bundle.js` | ✅ 143.5kb minified |
| `settings/agent.example.json` | ✅ provider 配置示例 |
| sidebar 注册 patch `patches/agent-ui/0001` | ⬜ bootstrap 中，待调研 153 的 SidebarController |
| `moz.build` / `jar.mn`（注册 chrome/resource 资源） | ⬜ 待 bootstrap 后照真实格式写 |
| `apply-patches.sh` 加 `agent-ui` 模块 | ⬜ |
| 编译 macOS arm64 验证里程碑 | ⬜ |

## Node 自测 LlmClient

```bash
# dry-run：构造并打印请求，不发送、不需要 Key
node additions/browser/components/agent-sidebar/dev/selftest-llm.mjs

# 真实调用：需自备 Key
DEEPSEEK_API_KEY=sk-xxx \
  node additions/browser/components/agent-sidebar/dev/selftest-llm.mjs --live "你好"
```

## 设计原则

- **LlmClient 零 Firefox 依赖**：只用 `globalThis.fetch` / `AbortController`，不 import Services/ChromeUtils，因此能在 Node 下独立验证。
- **Key 不在 LlmClient 持久化**：由 ConfigStore 负责存取，LlmClient 只接收 `apiKey` 入参。
- **A1 只做 non-streaming + openai 协议**；SSE 流式与 anthropic/gemini 协议留 A2。

# patches/agent-ui/

把 Agent 侧边栏**挂载进 Firefox chrome** 的补丁集。源文件在 [`additions/browser/components/agent-sidebar/`](../../additions/browser/components/agent-sidebar/README.md)，本目录的 patch 负责让 Firefox 加载并显示它。方案见 [`docs/agent-sidebar.md`](../../docs/agent-sidebar.md)。

## 关系

```
patches/agent-ui/         ← 改 upstream，注册 sidebar 入口 + 把 additions 挂进 omni.ja
additions/.../agent-sidebar/  ← 提供 React/ESM 源文件（不改 upstream）
```

## 计划补丁清单（均 ⬜ 待写，依赖 upstream bootstrap）

| 补丁 | 作用 | 状态 |
|---|---|---|
| `0001-add-sidebar-entry.patch` | 注册 "Agent" 侧栏入口 | ⬜ 待调研 153 真实点位 |
| `0002-agent-panel-host.patch` | sidebar 容器承载 React 面板 | ⬜ |
| `0003-package-into-omni.patch` | 把 agent-sidebar 资源打进 omni.ja | ⬜ |

## 风险与技术备注（侦察阶段留痕，落地前必读）

1. **`child_process` 不存在于 chrome JS** — `docs/agent-sidebar.md` 第 8.4 节写"tool 调用走 `child_process.exec`"是 **Node 思维的错误**。Firefox 的 `.sys.mjs` 是 Gecko 环境，跑子进程必须用 `Subprocess.sys.mjs`（`resource://gre/modules/Subprocess.sys.mjs`）。A4 包装 `tools/*.js` 时按此实现。

2. **`SidebarUI` 很可能已过时** — 方案文档 3.2(a) 写的 `SidebarUI` 框架是旧架构。Firefox 近两年把 sidebar 重构为 `SidebarController` + web component（`browser/components/sidebar/`）。**0001 补丁的真实点位需 bootstrap upstream 后实地确认**，不可照文档假设直接写。

3. **jsvmp trace 落盘真实路径** — A4 的 TraceBridge 对接时注意：引擎层（`additions/js/src/vm/JsvmpTraceCore.cpp`）真实默认写到 **`/tmp/firefox-reverse-jsvmp-b.ndjson.<pid>`**（可被环境变量 `MOZ_JSVMP_TRACE_FILE` 覆盖），**不是**方案文档/`settings` 写的 `~/.firefox-reverse/traces/jsvmp/`。NDJSON 行格式：
   ```
   {"_meta":{"version":"phase-b.0","pid":N,"filter":"...","limit":N}}
   {"_script":{"sid":"0x...","file":"..."}}
   {"sid":"0x...","pc":N,"op":N,"n":"OpName","ln":N,"col":N}
   {"_args":{"sid":"0x...","n":N,"args":[...]}}
   ```
   `sid` 是 SpiderMonkey 指针地址，**进程重启即变**，缓存键须用 `(file, col)` 复合键而非 `sid`。

4. **system ESM 全局 `fetch` 可用性待验证** — `LlmClient` 假设 `globalThis.fetch` 在 chrome 特权 ESM 可用；bootstrap 后需实测，若不可用则由宿主注入。

5. **Node runtime 分发依赖** — A4 用 `Subprocess` 调 `tools/*.js` 要求目标机装了 Node；Firefox 不自带。打包/分发策略待定（见 docs/agent-sidebar.md 风险表）。

6. **上游同步**：已决策**不追上游**，锁定当前 baseline（Firefox 153.0a1 / `cebc55aab4d`）。sidebar 补丁脆弱，升级冲突由用户自行迭代。

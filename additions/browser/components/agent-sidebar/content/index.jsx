import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import AgentPanel from "./AgentPanel.jsx";
import SettingsPane from "./SettingsPane.jsx";

/* Agent 侧边栏入口：在 chrome-privileged document 里挂载 React。
 *
 * system modules 在运行时用 ChromeUtils.importESModule 加载（不打包进 bundle），
 * resource:// alias 由 jar.mn 注册——真实 URL 在 bootstrap upstream 后核对，
 * 见 patches/agent-ui/README.md。 */
function loadModules() {
  if (typeof ChromeUtils === "undefined") {
    throw new Error("ChromeUtils 不可用：agent-sidebar 须在 firefox-reverse 浏览器内运行");
  }
  const { configStore } = ChromeUtils.importESModule(
    "resource:///modules/agentsidebar/ConfigStore.sys.mjs"
  );
  const { buildClientFromStore, listProviders, isVisionModel, fetchModels } = ChromeUtils.importESModule(
    "resource:///modules/agentsidebar/providers.sys.mjs"
  );
  const { conversationStore } = ChromeUtils.importESModule(
    "resource:///modules/agentsidebar/ConversationStore.sys.mjs"
  );
  // 能力后端 + 工具路由 + Agent 循环
  const { getBackends } = ChromeUtils.importESModule(
    "resource:///modules/agentsidebar/Backends.sys.mjs"
  );
  const { ToolRouter } = ChromeUtils.importESModule(
    "resource:///modules/agentsidebar/ToolRouter.sys.mjs"
  );
  const { createBuiltinTools } = ChromeUtils.importESModule(
    "resource:///modules/agentsidebar/Tools.sys.mjs"
  );
  const { runAgentTurn } = ChromeUtils.importESModule(
    "resource:///modules/agentsidebar/AgentLoop.sys.mjs"
  );
  // 常驻后台对话引擎（跨侧栏面板重载存活）——UI 订阅它，切栏回来续看不丢。
  const { agentSession } = ChromeUtils.importESModule(
    "resource:///modules/agentsidebar/AgentSession.sys.mjs"
  );
  const backends = getBackends();
  const router = new ToolRouter();
  router.registerAll(createBuiltinTools(backends));
  return {
    store: configStore,
    providers: listProviders(),
    conversations: conversationStore,
    buildClient: () => buildClientFromStore(configStore),
    router,
    runAgentTurn,
    session: agentSession,
    isVisionModel,
    fetchModels,
    workspace: backends.workspace, // 工作目录后端（侧边栏据此 setRoot/列文件）
    notes: backends.notes, // 逆向进展笔记后端（每轮把当前站点笔记摘要注入系统提示）
    toolNames: router.names(),
  };
}

function App({ mods }) {
  const [view, setView] = useState("chat");
  // 关键：AgentPanel **始终挂载**（打开设置时仅隐藏），否则切到设置会卸载它、
  // 丢掉进行中回合的状态（busy/思考流/AbortController/正在跑的 send），返回后变回
  // 待发态、模型回复被吞。设置面板作为覆盖层渲染在其上。
  return (
    <>
      <AgentPanel
        buildClient={mods.buildClient}
        conversations={mods.conversations}
        store={mods.store}
        router={mods.router}
        runAgentTurn={mods.runAgentTurn}
        session={mods.session}
        isVisionModel={mods.isVisionModel}
        workspace={mods.workspace}
        notes={mods.notes}
        toolNames={mods.toolNames}
        onOpenSettings={() => setView("settings")}
        hidden={view === "settings"}
      />
      {view === "settings" && (
        <SettingsPane
          store={mods.store}
          providers={mods.providers}
          fetchModels={mods.fetchModels}
          onClose={() => setView("chat")}
        />
      )}
    </>
  );
}

function main() {
  const rootEl = document.getElementById("root");
  let mods;
  try {
    mods = loadModules();
  } catch (e) {
    rootEl.textContent = e.message;
    return;
  }
  createRoot(rootEl).render(<App mods={mods} />);
}

main();

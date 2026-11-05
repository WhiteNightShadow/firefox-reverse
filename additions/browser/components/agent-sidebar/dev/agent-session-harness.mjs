/* dev/agent-session-harness.mjs — 在 Node 里加载真实的 AgentSession.sys.mjs，它依赖的模块由调用方给替身。
 * 给各个自测共用（不启动浏览器、不调用真实模型）。 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { emptyUsage, mergeUsage, normalizeUsage } from "../modules/Usage.sys.mjs";

/**
 * @param {object} deps
 * @param {{ createRunState: Function, runAgentTurn: Function }} deps.agentLoop  AgentLoop.sys.mjs 的替身
 * @param {object} deps.configStore                 ConfigStore 实例或替身
 * @param {object} [deps.conversationStore]         覆盖默认的空实现
 * @param {object} [deps.backends]                  getBackends() 的返回值
 * @returns {Promise<object>} agentSession 单例
 */
export async function loadAgentSession({ agentLoop, configStore, conversationStore = {}, backends = {} }) {
  const imports = {
    "./AgentLoop.sys.mjs": agentLoop,
    "./ConfigStore.sys.mjs": { configStore },
    "./ConversationStore.sys.mjs": {
      conversationStore: {
        consumeCancellationBoundary: async () => false,
        setThreadTurnStatus: async () => {},
        getThread: async () => null,
        appendMessage: async () => {},
        ...conversationStore,
      },
    },
    "./ToolRouter.sys.mjs": { ToolRouter: class { registerAll() {} } },
    "./Tools.sys.mjs": { createBuiltinTools: () => [] },
    "./Backends.sys.mjs": { getBackends: () => backends },
    "./providers.sys.mjs": { buildClientFromStore: () => ({}), isVisionModel: () => false },
    "./ContextProjection.sys.mjs": {},
    "./Usage.sys.mjs": { emptyUsage, mergeUsage, normalizeUsage },
  };
  const source = await readFile(new URL("../modules/AgentSession.sys.mjs", import.meta.url), "utf8");
  const { code } = transformSync(source, { format: "cjs", target: "es2022" });
  const module = { exports: {} };
  runInNewContext(code, {
    module,
    exports: module.exports,
    require(name) {
      assert.ok(Object.hasOwn(imports, name), `Unexpected import: ${name}`);
      return imports[name];
    },
    ChromeUtils: { importESModule: () => ({ setTimeout, clearTimeout }) },
    Services: { obs: { addObserver() {} } },
    AbortController,
    console,
  });
  return module.exports.agentSession;
}

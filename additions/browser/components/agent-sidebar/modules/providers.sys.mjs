/* providers.sys.mjs — 内置 LLM provider 元数据 + 从 ConfigStore 构造 LlmClient。
 *
 * 与 settings/agent.example.json 对应；A1 只列 openai 协议族的可用 provider，
 * anthropic / gemini 留 A2。React 面板用 listProviders() 渲染下拉，用
 * buildClientFromStore() 在发送时构造 LlmClient。
 */
import { LlmClient } from "./LlmClient.sys.mjs";

/** 内置 Claude 模型（Anthropic 协议自定义端点用；中转站 /v1/models 往往列不出 Claude）。
 *  首项为默认。如需别的版本，设置里仍可「手动输入」。 */
export const ANTHROPIC_MODELS = [
  "claude-opus-4-7",
  "claude-opus-4-5",
  "claude-opus-4-1-20250805",
  "claude-opus-4-20250514",
  "claude-sonnet-4-20250514",
];

export const BUILTIN_PROVIDERS = Object.freeze({
  // 目前只支持 DeepSeek（用户 2026-05-25 决定）。其它 provider 待后续按需再加。
  // 2026 模型：deepseek-v4-flash(标准) / deepseek-v4-pro(推理/思考档)。旧名 chat/reasoner 兼容。
  // Agent 默认 deepseek-v4-flash：支持 function calling(工具调用)，是工具驱动 Agent 的必需。
  // deepseek-v4-pro 是推理/思考档：**支持工具调用**（实测能连跑上百次工具——之前"不支持 tools 会 400"的判断错了）。
  //   但思考链长，在**超长上下文 + 高频工具调用**下，到「思考完→发起调用」边界容易退化成纯文字 → drift 中断；
  //   长工具循环（逆向常上百轮）不如 flash 稳。→ pro 适合"难点单步深度分析"；**驱动这种工具重的 Agent 用 flash**（难站直接上 Claude）。
  // ★1M 上下文：V4 全线原生支持 1M，且**官方 API 默认就是 1M**（无需任何标记）→ Agent 已把
  //   deepseek-v4-* 直接识别为 1M 档。（Claude Code 那种 [1m] 标记是它中间层的约定，直连 API 不需要、还会 400。）
  deepseek: {
    label: "DeepSeek",
    protocol: "openai",
    baseUrl: "https://api.deepseek.com",
    chatPath: "/v1/chat/completions",
    defaultModel: "deepseek-v4-flash",
    models: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"],
  },
  // 智谱 GLM（z.ai / bigmodel，OpenAI 协议；端点是 /api/paas/v4，**不是** /v1）。
  // glm-5.1 = 推理 + 工具调用（已验证 function calling 可用，能驱动 Agent）；带 reasoning_content。
  // -turbo 更快、-air 更省。API key 直接作 Bearer（无需 JWT）。
  zhipu: {
    label: "智谱 GLM",
    protocol: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    chatPath: "/chat/completions",
    defaultModel: "glm-5.1",
    models: ["glm-5.1", "glm-5", "glm-5-turbo", "glm-4.7", "glm-4.6", "glm-4.5-air"],
  },
  // Kimi（Moonshot AI，OpenAI 协议）。kimi-k2.6 = 最新旗舰：1T MoE 多模态 agentic 模型、256k 上下文、
  // 强工具调用 + 长程代码（适合驱动本 Agent）。★旧 kimi-k2-*(0711/turbo) 系列 2026-05-25 已下线 → 用 kimi-k2.6。
  // China 直连用 api.moonshot.cn；国际版改 baseUrl 为 https://api.moonshot.ai。API key 直接作 Bearer。
  kimi: {
    label: "Kimi (Moonshot)",
    protocol: "openai",
    baseUrl: "https://api.moonshot.cn",
    chatPath: "/v1/chat/completions",
    defaultModel: "kimi-k2.6",
    models: ["kimi-k2.6", "kimi-k2.5", "moonshot-v1-128k", "moonshot-v1-32k", "moonshot-v1-8k"],
  },
  // MiniMax（OpenAI 兼容）。MiniMax-M3 = 最新 M 系：1M 上下文、agentic 推理 + 工具调用 + 代码（支持 stream/tools）。
  // ★端点按账号地区：国际版 https://api.minimax.io（已文档确认）；China 直连用 https://api.minimaxi.com。
  // 若用中转站，改用 custom provider 填中转 baseUrl/模型名。
  minimax: {
    label: "MiniMax",
    protocol: "openai",
    baseUrl: "https://api.minimaxi.com",
    chatPath: "/v1/chat/completions",
    defaultModel: "MiniMax-M3",
    models: ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.5", "MiniMax-M2.1", "MiniMax-M2"],
  },
  // 通义千问（阿里 DashScope，OpenAI 兼容；端点是 /compatible-mode/v1，不是 /v1）。qwen3-max = 最新旗舰
  // （强工具调用，适合驱动 Agent）；qwen-plus 均衡、qwen-turbo / qwen3.5-flash 更快更省。API key 直接作 Bearer。
  // China 直连用 dashscope.aliyuncs.com；国际版改 baseUrl 为 https://dashscope-intl.aliyuncs.com/compatible-mode/v1。
  qwen: {
    label: "通义千问 (Qwen)",
    protocol: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    chatPath: "/chat/completions",
    defaultModel: "qwen3-max",
    models: ["qwen3-max", "qwen-max-latest", "qwen-plus", "qwen-turbo", "qwen3.5-flash"],
  },
  // 自定义端点：URL/token/协议/模型全部在设置里填；协议支持 OpenAI(/v1/chat/completions) 与 Anthropic(/v1/messages)。
  // 视觉模型(gpt-4o 等)也通过自定义端点配置（OpenAI 协议 + 视觉模型名）。
  custom: {
    label: "自定义（OpenAI / Anthropic 兼容）",
    protocol: "openai", // 实际协议由 store.getCustomProtocol() 决定
    baseUrl: "", // 用户在设置里填
    chatPath: "/v1/chat/completions",
    defaultModel: "",
    models: [], // OpenAI 协议：空 → 设置里「获取模型列表」拉取
    // Anthropic 协议：网关 /v1/models 往往只列 GPT(且未必可用)、列不出 Claude，
    // 所以内置一份 Claude 模型供选（不用拉取/不用手填）。
    anthropicModels: ANTHROPIC_MODELS,
  },
});

/**
 * 从配置的端点拉取可用模型列表（OpenAI 风格 GET /v1/models；多数网关都支持，含 Anthropic 网关）。
 * @param {string} baseUrl
 * @param {string} [token]
 * @returns {Promise<string[]>}
 */
export async function fetchModels(baseUrl, token) {
  if (!baseUrl) {
    throw new Error("请先填写 Base URL");
  }
  const url = baseUrl.replace(/\/+$/, "") + "/v1/models";
  const resp = await fetch(url, { headers: token ? { Authorization: "Bearer " + token } : {} });
  if (!resp.ok) {
    throw new Error("获取模型失败：HTTP " + resp.status);
  }
  const j = await resp.json();
  const arr = Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : [];
  return arr.map(m => (typeof m === "string" ? m : m.id || m.name)).filter(Boolean);
}

/** 已知支持看图（多模态）的模型集合。 */
const VISION_MODELS = new Set(["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini"]);

/**
 * 该模型是否支持「看图」（决定 AgentLoop 要不要把截图回喂给模型）。
 * DeepSeek 系列均为纯文本 → false（截图自动操作只能走 DOM 路线）。
 * @param {string} model
 * @returns {boolean}
 */
export function isVisionModel(model) {
  if (!model) {
    return false;
  }
  const m = String(model).toLowerCase();
  if (VISION_MODELS.has(m)) {
    return true;
  }
  return /(^|[-_/])(vl|vision)([-_/]|$)|gpt-4o|gpt-4\.1|qwen.*vl|claude-3|gemini-(1\.5|2)|kimi-k2/.test(m);
}

/** 给 SettingsPane 下拉用。 */
export function listProviders() {
  return Object.entries(BUILTIN_PROVIDERS).map(([id, p]) => ({
    id,
    label: p.label,
    models: p.models,
    defaultModel: p.defaultModel,
    anthropicModels: p.anthropicModels || [],
  }));
}

/**
 * 从 ConfigStore（+ 可选 overrides）构造 LlmClient。
 * @param {object} store  ConfigStore 实例
 * @param {object} [overrides] { provider, apiKey, model, baseUrl }
 * @returns {LlmClient}
 */
export function buildClientFromStore(store, overrides = {}) {
  const id = overrides.provider || store.getActiveProvider();
  const p = BUILTIN_PROVIDERS[id];
  if (!p) {
    throw new Error(`unknown provider: ${id}`);
  }
  let protocol = p.protocol;
  let baseUrl = overrides.baseUrl || p.baseUrl;
  let chatPath = p.chatPath;
  if (id === "custom") {
    protocol = (store.getCustomProtocol && store.getCustomProtocol()) || "openai";
    baseUrl = overrides.baseUrl || (store.getCustomBaseUrl && store.getCustomBaseUrl()) || "";
    chatPath = protocol === "anthropic" ? "/v1/messages" : "/v1/chat/completions";
  }
  if (!baseUrl) {
    throw new Error(`provider "${id}" 未配置 Base URL（请在设置里填写自定义端点地址）`);
  }
  return new LlmClient({
    protocol,
    baseUrl,
    chatPath,
    apiKey: overrides.apiKey || store.getApiKey(id),
    model: overrides.model || store.getModel(id) || p.defaultModel,
  });
}

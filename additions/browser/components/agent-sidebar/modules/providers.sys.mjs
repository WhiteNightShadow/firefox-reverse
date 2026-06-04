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
  // deepseek-v4-pro 是推理档，多半不支持 tools（带工具会 400）→ 适合纯分析问答，不适合驱动工具。
  deepseek: {
    label: "DeepSeek",
    protocol: "openai",
    baseUrl: "https://api.deepseek.com",
    chatPath: "/v1/chat/completions",
    defaultModel: "deepseek-v4-flash",
    models: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"],
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
  return /(^|[-_/])(vl|vision)([-_/]|$)|gpt-4o|gpt-4\.1|qwen.*vl|claude-3|gemini-(1\.5|2)/.test(m);
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

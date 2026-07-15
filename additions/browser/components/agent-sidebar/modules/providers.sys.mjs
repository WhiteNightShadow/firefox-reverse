/* providers.sys.mjs — 内置 LLM provider 元数据 + 从 ConfigStore 构造 LlmClient。
 *
 * 与 settings/agent.example.json 对应；A1 只列 openai 协议族的可用 provider，
 * anthropic / gemini 留 A2。React 面板用 listProviders() 渲染下拉，用
 * buildClientFromStore() 在发送时构造 LlmClient。
 */
import { LlmClient } from "./LlmClient.sys.mjs";
import { normalizeReasoningEffort } from "./ReasoningEffort.sys.mjs";

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
 * 规范化用户填写的 Base URL：去空白与末尾斜杠；误贴完整 chat/models 端点时剥掉尾段，
 * 只留 API 根地址（如 …/v1/chat/completions → …/v1）。
 * @param {string} raw
 * @returns {string}
 */
export function normalizeBaseUrl(raw) {
  let u = String(raw || "").trim().replace(/\/+$/, "");
  u = u.replace(/\/(chat\/completions|completions|messages|models)$/i, "");
  return u.replace(/\/+$/, "");
}

/** baseUrl 路径里是否已含版本段（/v1、/v4、/v1beta、/v1beta/openai …）。只看 path 不看 host，
 *  且不限结尾——Gemini 兼容根 …/v1beta/openai 这种版本段后还有后缀的也算（再叠 /v1 必 404）。 */
function hasVersionSegment(base) {
  const path = String(base).replace(/^https?:\/\/[^/]*/i, "");
  return /\/v\d+[a-z]*(?:\.\d+)?(?:\/|$)/i.test(path);
}

/**
 * 自定义端点的 chat 路径：baseUrl 已带版本段就不再叠 /v1（否则 …/v1/v1/chat/completions 必 404）。
 * @param {"openai"|"anthropic"} protocol
 * @param {string} baseUrl
 * @returns {string}
 */
export function resolveChatPath(protocol, baseUrl) {
  const versioned = hasVersionSegment(normalizeBaseUrl(baseUrl));
  if (protocol === "anthropic") {
    return versioned ? "/messages" : "/v1/messages";
  }
  return versioned ? "/chat/completions" : "/v1/chat/completions";
}

/**
 * 从配置的端点动态拉取可用模型列表。不再死拼 /v1/models：按 baseUrl 形态生成候选路径逐个探测
 * （带版本段 → 先 {base}/models 再 {base}/v1/models；否则反序），兼容 OpenAI(/v1/models)、
 * 智谱(/api/paas/v4/models)、DashScope(/compatible-mode/v1/models) 等。
 * 401/403 视为「路径已对、Key 不对」直接报 Key 问题；全部失败时列出每个尝试的 URL 与状态。
 * @param {string} baseUrl
 * @param {string} [token]
 * @returns {Promise<string[]>}
 */
export async function fetchModels(baseUrl, token) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) {
    throw new Error("请先填写 Base URL");
  }
  if (!/^https?:\/\//i.test(base)) {
    throw new Error("Base URL 需以 http:// 或 https:// 开头");
  }
  const candidates = hasVersionSegment(base)
    ? [base + "/models", base + "/v1/models"]
    : [base + "/v1/models", base + "/models"];
  // 同时带 OpenAI(Bearer) 与 Anthropic(x-api-key+version) 两套鉴权头：OpenAI 网关忽略多余头，
  // Anthropic 官方/同款网关只认 x-api-key——只发 Bearer 会把有效 key 误报成 401。
  const headers = {};
  if (token) {
    headers.Authorization = "Bearer " + token;
    headers["x-api-key"] = token;
    headers["anthropic-version"] = "2023-06-01";
  }
  const attempts = [];
  for (const url of candidates) {
    let resp;
    try {
      resp = await fetch(url, { headers });
    } catch (e) {
      attempts.push(`${url} → 网络错误：${(e && e.message) || e}`);
      continue;
    }
    const isHtml = /html/i.test(resp.headers.get("content-type") || "");
    if (resp.ok) {
      let j = null;
      try {
        j = await resp.json();
      } catch (_) {}
      const arr =
        j && (Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : Array.isArray(j) ? j : null);
      if (arr) {
        const names = arr
          .map(m => (typeof m === "string" ? m : m && (m.id || m.name || m.model)))
          .filter(Boolean);
        if (names.length) {
          return names;
        }
        attempts.push(`${url} → 200 但模型列表为空`);
      } else {
        attempts.push(`${url} → 200 但${isHtml ? "返回的是网页(HTML)，不是 API 地址" : "响应不是模型列表 JSON"}`);
      }
      continue;
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new Error(
        `API Key 无效或未填写（模型端点已找到：${url}，HTTP ${resp.status}）。` +
          `若确认 Key 无误，可能是该端点鉴权方式特殊——可直接手动输入模型名使用。`
      );
    }
    attempts.push(`${url} → HTTP ${resp.status}${isHtml ? "（返回网页，疑似不是 API 地址）" : ""}`);
  }
  throw new Error(
    "获取模型失败，已尝试：\n" +
      attempts.join("\n") +
      "\nBase URL 应为 API 服务根地址（如 https://api.deepseek.com 或 " +
      "https://dashscope.aliyuncs.com/compatible-mode/v1），而非文档/控制台页面。"
  );
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

/** 给 SettingsPane 下拉用。baseUrl 供「获取模型列表」对内置 provider 动态拉取。 */
export function listProviders() {
  return Object.entries(BUILTIN_PROVIDERS).map(([id, p]) => ({
    id,
    label: p.label,
    baseUrl: p.baseUrl,
    models: p.models,
    defaultModel: p.defaultModel,
    anthropicModels: p.anthropicModels || [],
  }));
}

/**
 * 从 ConfigStore（+ 可选 overrides）构造 LlmClient。
 * @param {object} store  ConfigStore 实例
 * @param {object} [overrides] { provider, apiKey, model, baseUrl, reasoningEffort }
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
  let reasoningEffort = "auto";
  if (id === "custom") {
    protocol = (store.getCustomProtocol && store.getCustomProtocol()) || "openai";
    baseUrl = normalizeBaseUrl(overrides.baseUrl || (store.getCustomBaseUrl && store.getCustomBaseUrl()) || "");
    chatPath = resolveChatPath(protocol, baseUrl);
    reasoningEffort = normalizeReasoningEffort(
      overrides.reasoningEffort ??
        (store.getCustomReasoningEffort && store.getCustomReasoningEffort()) ??
        "auto"
    );
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
    request: {
      // Anthropic extended thinking uses a different object shape and token
      // budget contract; do not translate an OpenAI-compatible level into it.
      reasoning_effort: protocol === "openai" ? reasoningEffort : "auto",
    },
  });
}

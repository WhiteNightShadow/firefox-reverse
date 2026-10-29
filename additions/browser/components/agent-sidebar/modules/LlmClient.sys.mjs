/* LlmClient.sys.mjs — Agent 侧边栏的 LLM 调用核心。
 *
 * 设计约束（A1）：
 * 1. 近零 Firefox 依赖：fetch / AbortController 用 globalThis（Firefox chrome 与 Node 18+ 都有）。
 *    唯一例外：system ESM(.sys.mjs) 全局没有 setTimeout/clearTimeout，缺失时才从
 *    Timer.sys.mjs 取（见下方 _setTimeout 解析器）。Node 路径完全不碰 ChromeUtils，
 *    dev/selftest-llm.mjs 仍可直接 import 验证。
 * 2. API Key 由调用方传入，本类不持久化。持久化是 ConfigStore.sys.mjs 的职责。
 * 3. 支持 OpenAI Chat Completions/Responses、Anthropic Messages 和 Gemini GenerateContent；未实现的协议显式抛错。
 *
 * 注：Firefox system ESM 的全局 fetch 可用性需在 upstream bootstrap 后验证；
 * 若系统全局无 fetch，集成时由宿主注入。详见 patches/agent-ui/README.md 风险表。
 */

import { normalizeReasoningEffort } from "./ReasoningEffort.sys.mjs";

/** 协议族标识（与 settings/agent.example.json 的 provider.protocol 对应）。 */
export const PROTOCOLS = Object.freeze({
  OPENAI: "openai",
  OPENAI_RESPONSES: "openai-responses",
  ANTHROPIC: "anthropic",
  GEMINI: "gemini",
});

// Compatibility decisions live for the parent-process lifetime so an
// OpenAI/Anthropic-compatible gateway that rejects optional fields is probed
// only once per browser run, not once per user turn.
const _cacheFieldRejectedEndpoints = new Set();
const _streamUsageRejectedEndpoints = new Set();
let _geminiCallSequence = 0;

/* setTimeout/clearTimeout 解析：
 * - Node / chrome document：globalThis 上就有，直接用。
 * - Firefox system ESM(.sys.mjs)：globalThis 上没有 → 从 Timer.sys.mjs 取（仅此处、仅在缺失时碰
 *   ChromeUtils，故 Node 自测路径零 Firefox 依赖）。这是 “⚠ setTimeout is not defined” 的修复点。 */
const { setTimeout: _setTimeout, clearTimeout: _clearTimeout } = (() => {
  if (typeof globalThis.setTimeout === "function") {
    return {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: (globalThis.clearTimeout || (() => {})).bind(globalThis),
    };
  }
  if (typeof ChromeUtils !== "undefined") {
    const T = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
    return { setTimeout: T.setTimeout, clearTimeout: T.clearTimeout };
  }
  return { setTimeout: () => 0, clearTimeout: () => {} }; // 兜底：无定时器 → 不超时
})();

/** 带 HTTP 状态与响应体的错误类型，便于 UI 区分网络错误 / 鉴权错误 / 解析错误。 */
export class LlmError extends Error {
  constructor(message, { status, body, cause } = {}) {
    super(message);
    this.name = "LlmError";
    this.status = status ?? null;
    this.body = body ?? null;
    if (cause) {
      this.cause = cause;
    }
  }
}

// OpenCode uses conversation affinity for routing and prompt caching. Scope
// these headers to its official API so other providers keep their wire format.
export function openCodeRequestHeaders(endpoint, { sessionId = "", requireSession = false } = {}) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return {};
  }
  if (
    url.origin !== "https://opencode.ai" ||
    !/^\/zen\/(?:go\/)?v1(?:\/|$)/.test(url.pathname)
  ) {
    return {};
  }
  if (requireSession && !sessionId) {
    throw new LlmError("OpenCode 请求缺少会话标识：请从 Agent 会话发送请求（sessionId）。");
  }
  if (sessionId && !/^[a-zA-Z0-9._:-]{1,256}$/.test(sessionId)) {
    throw new LlmError("OpenCode sessionId 必须为 1-256 位字母、数字或 . _ : -。");
  }
  let version = "dev";
  try {
    version = Services.prefs.getStringPref("extensions.firefox-reverse.version", "dev");
  } catch {
    // Node tests and standalone callers have no Firefox version preference.
  }
  const headers = {
    "User-Agent": `Firefox-Reverse/${/^[a-zA-Z0-9.+-]+$/.test(version) ? version : "dev"}`,
  };
  if (sessionId) headers["x-opencode-session"] = sessionId;
  return headers;
}

/**
 * @typedef {{ role: "system"|"user"|"assistant"|"tool", content: string }} ChatMessage
 * @typedef {{ content: string, toolCalls: Array, finishReason: string,
 *             usage: object|null, raw: object }} ChatResult
 */

export class LlmClient {
  /**
   * @param {object} cfg
   * @param {string} cfg.protocol  "openai" | "openai-responses" | "anthropic" | "gemini"
   * @param {string} cfg.baseUrl   e.g. "https://api.deepseek.com"
   * @param {string} cfg.chatPath  e.g. "/v1/chat/completions"
   * @param {string} cfg.apiKey
   * @param {string} cfg.model
   * @param {string} [cfg.providerId]
   * @param {string} [cfg.sessionId] Persistent conversation id, shared by main/auxiliary requests.
   * @param {string} [cfg.promptCacheMode] "auto" | "off"
   * @param {string} [cfg.promptCacheTtl]  "default" | "5m" | "1h"
   * @param {object} [cfg.request]  { timeout_ms, max_tokens, temperature, stream, reasoning_effort }
   */
  constructor(cfg) {
    if (!cfg || typeof cfg !== "object") {
      throw new LlmError("LlmClient: config object required");
    }
    this.protocol = cfg.protocol || PROTOCOLS.OPENAI;
    this.baseUrl = (cfg.baseUrl || "").replace(/\/+$/, "");
    this.chatPath =
      cfg.chatPath ||
      (this.protocol === PROTOCOLS.OPENAI_RESPONSES
        ? "/v1/responses"
        : this.protocol === PROTOCOLS.GEMINI
          ? "/v1beta/models"
          : "/v1/chat/completions");
    this.apiKey = cfg.apiKey || "";
    this.model = cfg.model || "";
    this.providerId = cfg.providerId || "custom";
    this.sessionId = cfg.sessionId || "";
    this.promptCacheMode = cfg.promptCacheMode === "off" ? "off" : "auto";
    this.promptCacheTtl =
      cfg.promptCacheTtl === "5m" || cfg.promptCacheTtl === "1h"
        ? cfg.promptCacheTtl
        : "default";
    this._compatKey = `${this.protocol}|${this.baseUrl}|${this.chatPath}`;
    this._cacheFieldsRejected = _cacheFieldRejectedEndpoints.has(this._compatKey);
    this._streamUsageRejected = _streamUsageRejectedEndpoints.has(this._compatKey);
    this._configuredMaxTokens = Number.isFinite(cfg.request?.max_tokens) ? cfg.request.max_tokens : null;
    this._configuredTemperature = Number.isFinite(cfg.request?.temperature) ? cfg.request.temperature : null;
    this.request = Object.assign(
      // max_tokens 默认 32768：思考型模型(DeepSeek reasoning_content) 做多步逆向时，reasoning 常吃满
      // 8192 → 还没产出工具调用就 finish_reason=length 截断（用户见过"最后只回一个 <"然后停）→ 过早结束。
      // 提到 32768 给"长思考 + 工具调用/较大文件"留够空间；只是上限、按实际用量计费，代价很小。
      { timeout_ms: 300000, max_tokens: 32768, temperature: 0.7, stream: false },
      cfg.request || {}
    );
  }

  get endpoint() {
    return this.baseUrl + this.chatPath;
  }

  /**
   * 构造请求（url + fetch init），不发送。抽出来便于 dry-run 自测与单元测试。
   * @param {ChatMessage[]} messages
   * @param {object} [opts]  { tools, model, stream, reasoningEffort, maxTokens, cacheKey, sessionId }
   * @returns {{ url: string, init: object, cacheApplied: boolean }}
   */
  buildRequest(messages, opts = {}) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new LlmError("buildRequest: messages must be a non-empty array");
    }
    // 剥掉模型名里的上下文标记（如 [1m]）——那是 harness 内部用来判上下文档/缩放的标记，DeepSeek 等
    // API 不认会 400（"supported API model names are deepseek-v4-pro or deepseek-v4-flash"）。
    // 完整名（含 [1m]）仍由 modelBudget(client.model) 读取判档；发给 API 的是剥净的名字。
    const model = String(opts.model || this.model || "").replace(/\s*\[\d+[a-z]?\]\s*$/i, "");
    if (!model) {
      throw new LlmError("buildRequest: model is required");
    }
    const cacheKey = String(opts.cacheKey || "").trim().slice(0, 64);
    const cacheEnabled =
      this.promptCacheMode === "auto" &&
      !this._cacheFieldsRejected &&
      !opts.disablePromptCache &&
      !!cacheKey;

    if (this.protocol === PROTOCOLS.OPENAI) {
      const reasoningEffort = normalizeReasoningEffort(
        opts.reasoningEffort ?? this.request.reasoning_effort
      );
      const body = {
        model,
        messages,
        stream: opts.stream ?? this.request.stream ?? false,
        max_tokens: opts.maxTokens ?? this.request.max_tokens,
      };
      if (reasoningEffort === "auto") {
        body.temperature = this.request.temperature;
      } else {
        body.reasoning_effort = reasoningEffort;
      }
      if (opts.tools) {
        body.tools = opts.tools;
      }
      const streamUsageApplied =
        body.stream === true &&
        !this._streamUsageRejected &&
        !opts.disableStreamUsage;
      if (streamUsageApplied) {
        body.stream_options = { include_usage: true };
      }
      // DeepSeek and Qwen cache matching prefixes automatically and reject
      // unknown OpenAI fields on some deployments. Only custom OpenAI-style
      // endpoints receive prompt_cache_key; incompatible gateways are retried
      // once without it by chat().
      const cacheApplied = cacheEnabled && this.providerId === "custom";
      if (cacheApplied) {
        body.prompt_cache_key = cacheKey;
      }
      return {
        url: this.endpoint,
        cacheApplied,
        streamUsageApplied,
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
            ...openCodeRequestHeaders(this.endpoint, {
              sessionId: opts.sessionId ?? this.sessionId,
              requireSession: true,
            }),
          },
          body: JSON.stringify(body),
        },
      };
    }

    if (this.protocol === PROTOCOLS.OPENAI_RESPONSES) {
      const { instructions, input } = toResponsesInput(messages);
      const body = {
        model,
        input,
        stream: opts.stream ?? this.request.stream ?? false,
        max_output_tokens: opts.maxTokens ?? this.request.max_tokens,
        store: false,
        include: ["reasoning.encrypted_content"],
      };
      if (instructions) {
        body.instructions = instructions;
      }
      const reasoningEffort = normalizeReasoningEffort(
        opts.reasoningEffort ?? this.request.reasoning_effort
      );
      if (reasoningEffort !== "auto") {
        body.reasoning = { effort: reasoningEffort };
      }
      if (opts.tools) {
        body.tools = opts.tools.map(t => {
          const f = t.function || t;
          return {
            type: "function",
            name: f.name,
            description: f.description || "",
            parameters: f.parameters || { type: "object", properties: {} },
            ...(f.strict === undefined ? {} : { strict: f.strict }),
          };
        });
      }
      const cacheApplied = cacheEnabled && this.providerId === "custom";
      if (cacheApplied) {
        body.prompt_cache_key = cacheKey;
      }
      return {
        url: this.endpoint,
        cacheApplied,
        streamUsageApplied: false,
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
            ...openCodeRequestHeaders(this.endpoint, {
              sessionId: opts.sessionId ?? this.sessionId,
              requireSession: true,
            }),
          },
          body: JSON.stringify(body),
        },
      };
    }

    if (this.protocol === PROTOCOLS.GEMINI) {
      const streaming = opts.stream ?? this.request.stream ?? false;
      const modelId = model.replace(/^models\//, "");
      const method = streaming ? "streamGenerateContent" : "generateContent";
      const path = this.chatPath.includes("{model}")
        ? this.chatPath
            .replace("{model}", encodeURIComponent(modelId))
            .replace(/:(?:streamGenerateContent|generateContent)\/?$/i, ":" + method)
        : /\/models\/[^/]+:(?:streamGenerateContent|generateContent)\/?$/i.test(this.chatPath)
          ? this.chatPath.replace(/:(?:streamGenerateContent|generateContent)\/?$/i, ":" + method)
          : `${this.chatPath.replace(/\/+$/, "")}/${encodeURIComponent(modelId)}:${method}`;
      const { systemInstruction, contents } = toGeminiRequest(messages);
      const generationConfig = {};
      const maxOutputTokens = opts.maxTokens ?? this._configuredMaxTokens;
      if (Number.isFinite(maxOutputTokens)) generationConfig.maxOutputTokens = maxOutputTokens;
      if (Number.isFinite(this._configuredTemperature)) {
        generationConfig.temperature = this._configuredTemperature;
      }
      const body = {
        contents,
        generationConfig,
      };
      if (systemInstruction) body.systemInstruction = systemInstruction;
      if (opts.tools?.length) {
        body.tools = [
          {
            functionDeclarations: opts.tools.map(tool => {
              const fn = tool.function || tool;
              return {
                name: fn.name,
                description: fn.description || "",
                parameters: toGeminiSchema(fn.parameters),
              };
            }),
          },
        ];
      }
      return {
        url: this.baseUrl + path + (streaming ? "?alt=sse" : ""),
        cacheApplied: false,
        streamUsageApplied: false,
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": this.apiKey,
          },
          body: JSON.stringify(body),
        },
      };
    }

    if (this.protocol === PROTOCOLS.ANTHROPIC) {
      // 把 OpenAI 形态消息翻成 Anthropic /v1/messages（LlmClient 作协议适配器，AgentLoop 不感知）。
      const { system, messages: amsgs } = toAnthropicMessages(messages);
      const body = {
        model,
        max_tokens: opts.maxTokens ?? this.request.max_tokens ?? 32768,
        messages: amsgs,
        stream: opts.stream ?? this.request.stream ?? false,
      };
      if (system) {
        body.system = system;
      }
      // 注意：不发 temperature——较新的 Claude 模型(opus-4.x 等)已弃用该参数，
      // 带上会报 400 "temperature is deprecated for this model"。用模型默认即可。
      if (opts.tools) {
        body.tools = opts.tools.map(t => {
          const f = t.function || t;
          return { name: f.name, description: f.description || "", input_schema: f.parameters || { type: "object", properties: {} } };
        });
      }
      const cacheApplied = cacheEnabled;
      if (cacheApplied) {
        body.cache_control = {
          type: "ephemeral",
          // Automatic caching defaults to 5m. Only 1h needs an explicit TTL.
          ...(this.promptCacheTtl === "1h" ? { ttl: "1h" } : {}),
        };
      }
      // anthropic 用 /v1/messages；既兼容官方(x-api-key)也兼容网关(Authorization: Bearer)。
      const path = /messages\/?$/.test(this.chatPath || "") ? this.chatPath : "/v1/messages";
      return {
        url: this.baseUrl + path,
        cacheApplied,
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": this.apiKey,
            Authorization: `Bearer ${this.apiKey}`,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true",
            ...openCodeRequestHeaders(this.baseUrl + path, {
              sessionId: opts.sessionId ?? this.sessionId,
              requireSession: true,
            }),
          },
          body: JSON.stringify(body),
        },
      };
    }

    throw new LlmError(
      `protocol "${this.protocol}" not implemented (supported: "openai", "openai-responses", "anthropic", "gemini")`
    );
  }

  /**
   * 解析 OpenAI 兼容响应为统一结构。
   * @param {object} json
   * @returns {ChatResult}
   */
  parseResponse(json) {
    if (this.protocol === PROTOCOLS.OPENAI_RESPONSES) {
      return parseResponsesResponse(json);
    }
    if (this.protocol === PROTOCOLS.GEMINI) {
      return parseGeminiResponse(json);
    }
    if (this.protocol === PROTOCOLS.ANTHROPIC) {
      const blocks = Array.isArray(json?.content) ? json.content : [];
      let content = "";
      const toolCalls = [];
      for (const b of blocks) {
        if (b.type === "text") {
          content += b.text || "";
        } else if (b.type === "tool_use") {
          toolCalls.push({
            id: b.id,
            type: "function",
            function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
          });
        }
      }
      return {
        content,
        reasoningContent: "",
        toolCalls,
        finishReason: json?.stop_reason || "",
        usage: json?.usage || null,
        raw: json,
      };
    }
    if (this.protocol !== PROTOCOLS.OPENAI) {
      throw new LlmError(
        `parseResponse: protocol "${this.protocol}" not implemented`
      );
    }
    const choice = json?.choices?.[0];
    const msg = choice?.message || {};
    let content = msg.content ?? "";
    let toolCalls = msg.tool_calls ?? [];
    // 结构化 tool_calls 缺失但 content 里泄漏了工具调用文本标记 → 还原成结构化调用。
    if ((!toolCalls || toolCalls.length === 0) && content) {
      const rec = recoverInlineToolCalls(content);
      if (rec) {
        toolCalls = rec.toolCalls;
        content = rec.content;
      }
    }
    return {
      content,
      // 思考型模型（deepseek-v4-pro / reasoner 等）会返回 reasoning_content；
      // 多轮工具调用时必须原样回灌，否则 API 报 "reasoning_content must be passed back"。
      reasoningContent: msg.reasoning_content ?? "",
      toolCalls,
      finishReason: choice?.finish_reason ?? "",
      usage: json?.usage ?? null,
      raw: json,
    };
  }

  /**
   * 发起一次对话补全（non-streaming）。
   * @param {ChatMessage[]} messages
   * @param {object} [opts]  { tools, model, signal }
   * @returns {Promise<ChatResult>}
   */
  async chat(messages, opts = {}) {
    if (!this.apiKey) {
      throw new LlmError(
        "chat: apiKey is empty — 在 SettingsPane 填写或在 agent.json 配置"
      );
    }
    const streaming = typeof opts.onDelta === "function";
    const requestOpts = { ...opts, stream: streaming };
    let built = this.buildRequest(messages, requestOpts);
    let optionalFieldFallbackUsed = false;

    // 瞬时错误（网关 5xx / 上游抖动 / 网络）自动重试，避免中转站后端偶发失败直接断掉整轮。
    const maxAttempts = 3;
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // 空闲看门狗（idle watchdog）：只要还在进展就不超时——建连→响应头→每段流式数据都会 bump() 重置，
      // 仅当连续 idleMs 一个字节都不来（真·卡死/断流）才中止。于是慢/长响应（大上下文、推理模型边想边出）
      // 都不会再误报超时；正常出 token 时永不触发。stalled 标记区分"看门狗中止"与"用户停止/网络断"。
      const ac = new AbortController();
      let stalled = false;
      const idleMs = this.request.timeout_ms; // 语义=最大"无数据间隔"，不是总时长
      let watchdog = null;
      const bump = () => {
        if (watchdog) {
          _clearTimeout(watchdog);
        }
        watchdog = _setTimeout(() => {
          stalled = true;
          ac.abort();
        }, idleMs);
      };
      const stopWatch = () => {
        if (watchdog) {
          _clearTimeout(watchdog);
          watchdog = null;
        }
      };
      bump(); // 覆盖建连 + 首字节
      if (opts.signal) {
        opts.signal.addEventListener("abort", () => ac.abort(), { once: true });
      }
      let resp;
      try {
        resp = await fetch(built.url, { ...built.init, signal: ac.signal });
        bump(); // 收到响应头 → 重置看门狗
      } catch (e) {
        stopWatch();
        if (opts.signal && opts.signal.aborted) {
          throw new LlmError("request aborted", { cause: e }); // 用户「停止」→ 不重试
        }
        if (stalled) {
          // 连续 idleMs 服务端一字未回（建连/首字节彻底卡死，罕见）→ 报清楚、不空转重试
          throw new LlmError(
            `连接超时：${Math.round(idleMs / 1000)}s 内服务端无任何响应，可直接重发。`,
            { cause: e }
          );
        }
        // 真·网络错误（连接重置/DNS 等）→ 退避重试
        lastErr = new LlmError(`network error calling ${built.url}: ${e.message}`, { cause: e });
        if (attempt < maxAttempts) {
          await this._delay(500 * attempt);
          continue;
        }
        throw lastErr;
      }

      if (!resp.ok) {
        stopWatch();
        const errText = await resp.text().catch(() => "");
        if (
          (built.cacheApplied || built.streamUsageApplied) &&
          !optionalFieldFallbackUsed &&
          [400, 404, 422].includes(resp.status)
        ) {
          // OpenAI/Anthropic-compatible gateways frequently reject fields they
          // do not proxy. Disable native cache fields for this client and retry
          // the exact request once; user-visible behavior remains unchanged.
          if (built.cacheApplied) {
            this._cacheFieldsRejected = true;
            _cacheFieldRejectedEndpoints.add(this._compatKey);
          }
          if (built.streamUsageApplied) {
            this._streamUsageRejected = true;
            _streamUsageRejectedEndpoints.add(this._compatKey);
          }
          optionalFieldFallbackUsed = true;
          built = this.buildRequest(messages, {
            ...requestOpts,
            disablePromptCache: true,
            disableStreamUsage: true,
          });
          attempt--;
          continue;
        }
        // 5xx / 网关·上游错误属瞬时（中转站后端抖动）→ 可重试；4xx 是请求/鉴权问题 → 不重试。
        const transient =
          [429, 500, 502, 503, 504].includes(resp.status) ||
          /upstream|gateway|timeout|temporar|overload/i.test(errText);
        if (transient && attempt < maxAttempts) {
          lastErr = new LlmError(`LLM API ${resp.status} ${resp.statusText}`, { status: resp.status, body: errText.slice(0, 2000) });
          await this._delay(700 * attempt);
          continue;
        }
        const suffix = transient ? `（网关/上游暂时不可用，已自动重试 ${maxAttempts} 次；可稍后再试或换模型）` : "";
        throw new LlmError(`LLM API ${resp.status} ${resp.statusText}${suffix}`, {
          status: resp.status,
          body: errText.slice(0, 2000),
        });
      }

      if (streaming) {
        // 流式读取期间，每段数据都 bump() 重置看门狗（见 _readStream 的 onActivity）。
        try {
          if (this.protocol === PROTOCOLS.ANTHROPIC) {
            return await this._readStreamAnthropic(resp, opts.onDelta, bump);
          }
          if (this.protocol === PROTOCOLS.OPENAI_RESPONSES) {
            return await this._readStreamResponses(resp, opts.onDelta, opts.onReasoning, bump);
          }
          if (this.protocol === PROTOCOLS.GEMINI) {
            return await this._readStreamGemini(resp, opts.onDelta, opts.onReasoning, bump);
          }
          return await this._readStream(resp, opts.onDelta, opts.onReasoning, bump);
        } catch (e) {
          if (opts.signal && opts.signal.aborted) {
            throw new LlmError("request aborted", { cause: e }); // 用户「停止」
          }
          if (stalled) {
            throw new LlmError(
              `流式响应中断：连续 ${Math.round(idleMs / 1000)}s 无数据（服务端疑似断流），可直接重发。`,
              { cause: e }
            );
          }
          throw e;
        } finally {
          stopWatch();
        }
      }
      const text = await resp.text();
      stopWatch();
      let json;
      try {
        json = JSON.parse(text);
      } catch (e) {
        throw new LlmError(`invalid JSON from ${built.url}`, { body: text.slice(0, 500), cause: e });
      }
      return this.parseResponse(json);
    }
    throw lastErr;
  }

  /** 重试退避用的小延时（用 Timer 解析器，system ESM 也能用）。 */
  _delay(ms) {
    return new Promise(r => _setTimeout(r, ms));
  }

  /**
   * 读取 OpenAI/DeepSeek SSE 流：累积 content + tool_calls；每段 content 增量回调 onDelta。
   * 返回结构与 parseResponse 一致（content/toolCalls/finishReason/usage）。
   * @param {Response} resp
   * @param {(chunk:string)=>void} onDelta
   * @returns {Promise<ChatResult>}
   */
  async _readStream(resp, onDelta, onReasoning, onActivity) {
    if (!resp.body || typeof resp.body.getReader !== "function") {
      // 环境不支持流式读取 → 退化为整体解析
      const text = await resp.text();
      return this.parseResponse(JSON.parse(text));
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let reasoningContent = "";
    const toolCalls = [];
    let finishReason = "";
    let usage = null;
    let leakSuppressed = false; // 检测到工具调用泄漏标记后，停止把 content 打到 UI
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (onActivity) {
        onActivity(); // 收到数据 → 重置空闲看门狗（流式期间永不误超时）
      }
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) {
          continue;
        }
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          continue;
        }
        let chunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        const choice = chunk.choices && chunk.choices[0];
        const delta = (choice && choice.delta) || {};
        if (delta.content) {
          content += delta.content;
          // 一旦累积内容里出现工具调用泄漏标记，停止把后续 content 打到 UI（避免畸形标记刷屏）；
          // 真实工具调用在流末由 recoverInlineToolCalls 还原。
          if (!leakSuppressed && looksLikeToolCallLeak(content)) {
            leakSuppressed = true;
          }
          if (!leakSuppressed) {
            try {
              onDelta(delta.content);
            } catch {}
          }
        }
        if (delta.reasoning_content) {
          reasoningContent += delta.reasoning_content;
          if (onReasoning) {
            try {
              onReasoning(delta.reasoning_content);
            } catch {}
          }
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const i = tc.index || 0;
            if (!toolCalls[i]) {
              toolCalls[i] = { id: tc.id || "", type: "function", function: { name: "", arguments: "" } };
            }
            if (tc.id) {
              toolCalls[i].id = tc.id;
            }
            if (tc.function) {
              if (tc.function.name) {
                toolCalls[i].function.name = tc.function.name;
              }
              if (tc.function.arguments) {
                toolCalls[i].function.arguments += tc.function.arguments;
              }
            }
          }
        }
        if (choice && choice.finish_reason) {
          finishReason = choice.finish_reason;
        }
        if (chunk.usage) {
          usage = chunk.usage;
        }
      }
    }
    let outContent = content;
    let outToolCalls = toolCalls.filter(Boolean);
    // 结构化 tool_calls 缺失但 content 里泄漏了工具调用文本标记 → 还原成结构化调用，避免 Agent 空转。
    if (outToolCalls.length === 0) {
      const rec = recoverInlineToolCalls(outContent);
      if (rec) {
        outToolCalls = rec.toolCalls;
        outContent = rec.content;
      }
    }
    return { content: outContent, reasoningContent, toolCalls: outToolCalls, finishReason, usage, raw: null };
  }

  /** 读取 OpenAI Responses SSE，保留完整 output items 供无状态工具循环回灌。 */
  async _readStreamResponses(resp, onDelta, onReasoning, onActivity) {
    if (!resp.body || typeof resp.body.getReader !== "function") {
      return this.parseResponse(JSON.parse(await resp.text()));
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let reasoningContent = "";
    let usage = null;
    let finalResponse = null;
    let failure = null;
    const outputItems = new Map();

    const consumeEvent = data => {
      if (!data || data === "[DONE]") return;
      let event;
      try {
        event = JSON.parse(data);
      } catch {
        return;
      }
      const index = Number.isInteger(event.output_index) ? event.output_index : null;
      if (event.type === "response.output_item.added" || event.type === "response.output_item.done") {
        if (index !== null && event.item) outputItems.set(index, event.item);
      } else if (event.type === "response.function_call_arguments.delta" && index !== null) {
        const item = outputItems.get(index) || {
          id: event.item_id || "",
          type: "function_call",
          call_id: event.call_id || "",
          name: "",
          arguments: "",
        };
        item.arguments = String(item.arguments || "") + String(event.delta || "");
        if (event.call_id) item.call_id = event.call_id;
        outputItems.set(index, item);
      } else if (event.type === "response.output_text.delta" && event.delta) {
        content += event.delta;
        try {
          onDelta && onDelta(event.delta);
        } catch {}
      } else if (event.type === "response.reasoning_summary_text.delta" && event.delta) {
        reasoningContent += event.delta;
        try {
          onReasoning && onReasoning(event.delta);
        } catch {}
      } else if (event.type === "response.completed" || event.type === "response.incomplete") {
        finalResponse = event.response || null;
        usage = finalResponse?.usage || usage;
      } else if (event.type === "response.failed" || event.type === "error") {
        const error = event.response?.error || event.error || {};
        failure = error.message || event.message || "OpenAI Responses stream failed";
      }
    };

    const consumeLine = line => {
      const trimmed = line.trim();
      if (trimmed.startsWith("data:")) consumeEvent(trimmed.slice(5).trim());
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (onActivity) onActivity();
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        consumeLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) consumeLine(buffer);
    if (failure) throw new LlmError(failure);
    if (finalResponse) return this.parseResponse(finalResponse);

    const output = [...outputItems.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, item]) => item);
    if (content && !output.some(item => item.type === "message")) {
      output.push({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: content }],
      });
    }
    const result = parseResponsesResponse({ output, status: "completed", usage });
    if (!result.content && content) result.content = content;
    if (!result.reasoningContent && reasoningContent) result.reasoningContent = reasoningContent;
    return result;
  }

  /** 读取 Gemini SSE，同时保留原始 model parts（包括 functionCall thoughtSignature）。 */
  async _readStreamGemini(resp, onDelta, onReasoning, onActivity) {
    if (!resp.body || typeof resp.body.getReader !== "function") {
      return this.parseResponse(JSON.parse(await resp.text()));
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finishReason = "";
    let usageMetadata = null;
    let promptFeedback = null;
    let failure = null;
    const rawParts = new Map();
    let partOrder = 0;

    const consumeEvent = data => {
      if (!data || data === "[DONE]") return;
      let event;
      try {
        event = JSON.parse(data);
      } catch {
        return;
      }
      if (event.error) {
        failure = event.error.message || "Gemini stream failed";
        return;
      }
      usageMetadata = event.usageMetadata || usageMetadata;
      promptFeedback = event.promptFeedback || promptFeedback;
      const candidate = event.candidates?.[0];
      if (!candidate) return;
      if (candidate.finishReason) finishReason = candidate.finishReason;
      const occurrences = new Map();
      for (const part of candidate.content?.parts || []) {
        const baseKey = part?.functionCall?.name
          ? `function:${part.functionCall.name}`
          : typeof part?.text === "string"
            ? `text:${!!part.thought}`
            : `other:${part?.type || "part"}`;
        const occurrence = occurrences.get(baseKey) || 0;
        occurrences.set(baseKey, occurrence + 1);
        const key = `${baseKey}:${occurrence}`;
        const entry = rawParts.get(key) || { order: partOrder++, part: {} };
        const previous = entry.part;
        const merged = { ...previous, ...part };
        if (typeof previous.text === "string" && typeof part.text === "string") {
          merged.text = previous.text + part.text;
        }
        if (previous.functionCall && part.functionCall) {
          merged.functionCall = {
            ...previous.functionCall,
            ...part.functionCall,
            args: { ...(previous.functionCall.args || {}), ...(part.functionCall.args || {}) },
          };
        }
        rawParts.set(key, { ...entry, part: merged });
        if (typeof part.text === "string") {
          try {
            if (part.thought) onReasoning && onReasoning(part.text);
            else onDelta && onDelta(part.text);
          } catch {}
        }
      }
    };

    const consumeLine = line => {
      const trimmed = line.trim();
      if (trimmed.startsWith("data:")) consumeEvent(trimmed.slice(5).trim());
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (onActivity) onActivity();
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        consumeLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) consumeLine(buffer);
    if (failure) throw new LlmError(failure);
    return parseGeminiResponse({
      candidates: [
        {
          content: {
            role: "model",
            parts: [...rawParts.values()].sort((a, b) => a.order - b.order).map(x => x.part),
          },
          finishReason,
        },
      ],
      usageMetadata,
      promptFeedback,
    });
  }

  /** 读取 Anthropic /v1/messages SSE：text_delta→content(+onDelta)，tool_use+input_json_delta→toolCalls。 */
  async _readStreamAnthropic(resp, onDelta, onActivity) {
    if (!resp.body || typeof resp.body.getReader !== "function") {
      return this.parseResponse(JSON.parse(await resp.text()));
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    const blocks = {}; // index → { tc? }
    const toolCalls = [];
    let finishReason = "";
    let usage = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (onActivity) {
        onActivity(); // 收到数据 → 重置空闲看门狗（流式期间永不误超时）
      }
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) {
          continue;
        }
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") {
          continue;
        }
        let ev;
        try {
          ev = JSON.parse(data);
        } catch {
          continue;
        }
        if (ev.type === "message_start") {
          if (ev.message && ev.message.usage) {
            usage = { ...(usage || {}), ...ev.message.usage };
          }
        } else if (ev.type === "content_block_start") {
          const cb = ev.content_block || {};
          if (cb.type === "tool_use") {
            const tc = { id: cb.id, type: "function", function: { name: cb.name, arguments: "" } };
            blocks[ev.index] = { tc };
            toolCalls.push(tc);
          } else {
            blocks[ev.index] = {};
          }
        } else if (ev.type === "content_block_delta") {
          const d = ev.delta || {};
          if (d.type === "text_delta" && d.text) {
            content += d.text;
            try {
              onDelta && onDelta(d.text);
            } catch {}
          } else if (d.type === "input_json_delta" && d.partial_json != null) {
            const b = blocks[ev.index];
            if (b && b.tc) {
              b.tc.function.arguments += d.partial_json;
            }
          }
        } else if (ev.type === "message_delta") {
          if (ev.delta && ev.delta.stop_reason) {
            finishReason = ev.delta.stop_reason;
          }
          if (ev.usage) {
            usage = { ...(usage || {}), ...ev.usage };
          }
        }
      }
    }
    return { content, reasoningContent: "", toolCalls, finishReason, usage, raw: null };
  }
}

/* ── DeepSeek 等模型偶发把 tool_calls 以**文本标记**泄漏进 content（而非结构化 tool_calls 字段），
 * 形如 <｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="X"><｜｜DSML｜｜parameter name="P" string="true">V</…parameter></…invoke></…tool_calls>
 * （常见于上下文偏大/模型退化时）。若不处理：toolCalls 为空 → AgentLoop 当成最终答案 → 工具不执行、
 * Agent 空转、界面只剩这串畸形标记。这里在客户端把它**还原成结构化 toolCalls**并清理 content。
 * 通用：只认 invoke/parameter 标记，分隔符(｜｜DSML｜｜ / tool▁call / 裸 <invoke>)无关；仅在结构化
 * tool_calls 缺失时才尝试，避免误伤正常回复。 ── */
const INLINE_LEAK_MARKERS = ["DSML｜", "tool▁call", "<｜tool"]; // 流式期间据此抑制把畸形标记打到 UI
export function looksLikeToolCallLeak(s) {
  if (typeof s !== "string" || !s) {
    return false;
  }
  return INLINE_LEAK_MARKERS.some(mk => s.includes(mk));
}
export function recoverInlineToolCalls(content) {
  if (typeof content !== "string" || !content) {
    return null;
  }
  // 需同时出现 invoke 开/闭标记才认定是泄漏（避免把"讨论 invoke 的散文"误判）
  if (!/invoke\s+name\s*=\s*"/.test(content) || !/<\/[^>]*?invoke\s*>/.test(content)) {
    return null;
  }
  const calls = [];
  const invokeRe = /invoke\s+name\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/[^>]*?invoke\s*>/g;
  let m;
  while ((m = invokeRe.exec(content))) {
    const name = m[1];
    const inner = m[2] || "";
    const args = {};
    const paramRe = /parameter\s+name\s*=\s*"([^"]+)"([^>]*)>([\s\S]*?)<\/[^>]*?parameter\s*>/g;
    let p;
    while ((p = paramRe.exec(inner))) {
      const pname = p[1];
      const attrs = p[2] || "";
      const raw = String(p[3]).trim();
      let val = raw;
      // 非显式 string="true" 时尝试按 JSON 解析（数字/布尔/对象/数组），失败则当字符串
      if (!/string\s*=\s*"true"/.test(attrs)) {
        try {
          val = JSON.parse(raw);
        } catch {
          val = raw;
        }
      }
      args[pname] = val;
    }
    calls.push({
      id: "inline_" + (calls.length + 1) + "_" + Date.now().toString(36),
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    });
  }
  if (!calls.length) {
    return null;
  }
  // 清理 content：保留首个泄漏标记之前的正文（模型叙述），剥掉标记块。
  let cut = content.length;
  for (const mk of ["<｜｜DSML｜｜tool_calls", "DSML｜｜tool_calls", "<｜｜DSML｜｜invoke", "DSML｜｜invoke"]) {
    const idx = content.indexOf(mk);
    if (idx >= 0 && idx < cut) {
      cut = idx;
    }
  }
  if (cut === content.length) {
    const im = content.search(/<[^>]*invoke\s+name\s*=\s*"/);
    if (im >= 0) {
      cut = im;
    }
  }
  return { toolCalls: calls, content: content.slice(0, cut).trim() };
}

function parseResponsesResponse(json) {
  if (json?.status === "failed" || json?.error) {
    const error = json.error || {};
    throw new LlmError(error.message || "OpenAI Responses API failed", {
      body: JSON.stringify(error).slice(0, 2000),
    });
  }
  const output = Array.isArray(json?.output) ? json.output : [];
  const content = [];
  const reasoning = [];
  const toolCalls = [];
  for (const item of output) {
    if (item?.type === "message") {
      for (const part of item.content || []) {
        if (part?.type === "output_text" && part.text) content.push(part.text);
        else if (part?.type === "refusal" && part.refusal) content.push(part.refusal);
      }
    } else if (item?.type === "reasoning") {
      for (const part of item.summary || []) {
        if (part?.type === "summary_text" && part.text) reasoning.push(part.text);
      }
    } else if (item?.type === "function_call") {
      toolCalls.push({
        id: item.call_id || item.id || "",
        type: "function",
        function: {
          name: item.name || "",
          arguments:
            typeof item.arguments === "string"
              ? item.arguments
              : JSON.stringify(item.arguments ?? {}),
        },
      });
    }
  }
  const status = json?.status || "";
  const finishReason =
    status === "incomplete" && json?.incomplete_details?.reason === "max_output_tokens"
      ? "length"
      : toolCalls.length
        ? "tool_calls"
        : status === "completed"
          ? "stop"
          : status;
  return {
    content: content.join(""),
    reasoningContent: reasoning.join("\n"),
    toolCalls,
    finishReason,
    usage: json?.usage || null,
    raw: json,
    responseOutput: output,
  };
}

function nextGeminiCallId() {
  _geminiCallSequence = (_geminiCallSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `gemini_${Date.now().toString(36)}_${_geminiCallSequence.toString(36)}`;
}

function normalizeGeminiUsage(metadata) {
  if (!metadata || typeof metadata !== "object") return null;
  return {
    prompt_tokens: metadata.promptTokenCount,
    completion_tokens: metadata.candidatesTokenCount,
    reasoning_tokens: metadata.thoughtsTokenCount,
    prompt_cache_hit_tokens: metadata.cachedContentTokenCount,
  };
}

function geminiFinishReason(reason, hasToolCalls) {
  if (reason === "MAX_TOKENS") return "length";
  if (hasToolCalls) return "tool_calls";
  if (reason === "SAFETY" || reason === "RECITATION" || reason === "PROHIBITED_CONTENT") {
    return "content_filter";
  }
  if (reason === "STOP") return "stop";
  return reason || "";
}

function parseGeminiResponse(json) {
  if (json?.error) {
    const error = json.error;
    throw new LlmError(error.message || "Gemini GenerateContent failed", {
      status: error.code || null,
      body: JSON.stringify(error).slice(0, 2000),
    });
  }
  const blockReason = json?.promptFeedback?.blockReason;
  if (blockReason) {
    throw new LlmError(`Gemini request blocked: ${blockReason}`, {
      body: JSON.stringify(json.promptFeedback).slice(0, 2000),
    });
  }
  const candidate = json?.candidates?.[0] || {};
  const parts = Array.isArray(candidate.content?.parts) ? candidate.content.parts : [];
  const content = [];
  const reasoning = [];
  const toolCalls = [];
  for (const part of parts) {
    if (typeof part?.text === "string") {
      (part.thought ? reasoning : content).push(part.text);
    }
    if (part?.functionCall?.name) {
      toolCalls.push({
        id: part.functionCall.id || nextGeminiCallId(),
        type: "function",
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        },
      });
    }
  }
  const finishReason = geminiFinishReason(candidate.finishReason, toolCalls.length > 0);
  return {
    content: content.join(""),
    reasoningContent: reasoning.join(""),
    // A call returned at the output limit may contain only partial arguments.
    toolCalls: finishReason === "length" ? [] : toolCalls,
    finishReason,
    usage: normalizeGeminiUsage(json?.usageMetadata),
    raw: json,
    geminiContent: candidate.content || null,
  };
}

/** Translate the AgentLoop's OpenAI-shaped history into Gemini contents. */
export function toGeminiRequest(messages) {
  const systemParts = [];
  const contents = [];
  const callNames = new Map();
  for (const message of messages || []) {
    if (!message) continue;
    if (message.role === "system" || message.role === "developer") {
      const text = textOf(message.content);
      if (text) systemParts.push(text);
      continue;
    }
    if (message.role === "tool") {
      const call = callNames.get(String(message.tool_call_id || ""));
      const name = call?.name || message.name;
      if (!name) {
        const parts = toGeminiParts(message.content);
        if (parts.length) contents.push({ role: "user", parts });
        continue;
      }
      const part = {
        functionResponse: {
          ...(call?.id ? { id: call.id } : {}),
          name,
          response: geminiFunctionResult(message.content),
        },
      };
      const last = contents[contents.length - 1];
      if (last?.role === "user" && last.parts.every(p => p.functionResponse)) {
        last.parts.push(part);
      } else {
        contents.push({ role: "user", parts: [part] });
      }
      continue;
    }

    if (message.role === "assistant" && message.gemini_content?.parts) {
      const raw = { ...message.gemini_content, role: "model" };
      contents.push(raw);
      const rawCalls = raw.parts.filter(part => part?.functionCall);
      for (const [i, call] of (message.tool_calls || []).entries()) {
        const rawCall = rawCalls[i]?.functionCall;
        const name = rawCall?.name || call?.function?.name;
        if (call?.id && name) {
          callNames.set(String(call.id), { name, id: rawCall?.id || null });
        }
      }
      continue;
    }

    const role = message.role === "assistant" ? "model" : "user";
    const parts = toGeminiParts(message.content);
    for (const call of message.tool_calls || []) {
      const fn = call?.function || {};
      const name = String(fn.name || "");
      if (!name) continue;
      if (call?.id) callNames.set(String(call.id), { name, id: null });
      parts.push({ functionCall: { name, args: geminiFunctionArgs(fn.arguments) } });
    }
    if (parts.length) contents.push({ role, parts });
  }
  return {
    systemInstruction: systemParts.length ? { parts: [{ text: systemParts.join("\n\n") }] } : null,
    contents,
  };
}

function geminiFunctionArgs(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return {};
}

function geminiFunctionResult(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {}
    return { result: value };
  }
  return { result: value ?? "" };
}

function toGeminiParts(content) {
  if (typeof content === "string") return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) {
    return content == null ? [] : [{ text: String(content) }];
  }
  return content.flatMap(part => {
    if (typeof part === "string") return part ? [{ text: part }] : [];
    if (!part || typeof part !== "object") return [];
    if (["text", "input_text", "output_text"].includes(part.type)) {
      return [{ text: String(part.text || "") }];
    }
    if (part.type === "image_url" || part.type === "input_image") {
      const image = part.image_url;
      const url = typeof image === "string" ? image : image?.url;
      const match = typeof url === "string" && /^data:([^;,]+);base64,([\s\S]*)$/.exec(url);
      if (!match) {
        throw new LlmError("Gemini 图片输入需要 data:image/...;base64,... 格式");
      }
      return [{ inlineData: { mimeType: match[1], data: match[2] } }];
    }
    return [{ text: JSON.stringify(part) }];
  });
}

const GEMINI_SCHEMA_FIELDS = new Set([
  "description", "format", "nullable", "enum", "required", "minimum", "maximum",
  "minItems", "maxItems", "minLength", "maxLength", "pattern",
]);

function toGeminiSchema(schema = {}) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "OBJECT", properties: {} };
  }
  const out = {};
  if (schema.type) out.type = String(schema.type).toUpperCase();
  for (const key of GEMINI_SCHEMA_FIELDS) {
    if (schema[key] !== undefined) out[key] = schema[key];
  }
  if (schema.properties && typeof schema.properties === "object") {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [key, toGeminiSchema(value)])
    );
  }
  if (schema.items) out.items = toGeminiSchema(schema.items);
  if (!out.type) out.type = out.properties ? "OBJECT" : "STRING";
  return out;
}

/** 将 AgentLoop 的 OpenAI 形态上下文转成无状态 Responses API input。 */
export function toResponsesInput(messages) {
  const instructionParts = [];
  const input = [];
  for (const message of messages || []) {
    if (!message) continue;
    if (message.role === "system" || message.role === "developer") {
      const text = textOf(message.content);
      if (text) instructionParts.push(text);
      continue;
    }
    if (message.role === "assistant" && Array.isArray(message.responses_output)) {
      input.push(...message.responses_output);
      continue;
    }
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: String(message.tool_call_id || ""),
        output:
          typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content ?? ""),
      });
      continue;
    }

    const role = message.role === "assistant" ? "assistant" : "user";
    const content = responsesMessageContent(message.content);
    if (content !== "" || !message.tool_calls?.length) {
      input.push({ role, content });
    }
    for (const call of message.tool_calls || []) {
      const fn = call?.function || {};
      input.push({
        type: "function_call",
        call_id: String(call?.id || ""),
        name: String(fn.name || ""),
        arguments:
          typeof fn.arguments === "string"
            ? fn.arguments
            : JSON.stringify(fn.arguments ?? {}),
      });
    }
  }
  return { instructions: instructionParts.join("\n\n"), input };
}

function responsesMessageContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    return content == null ? "" : String(content);
  }
  return content.flatMap(part => {
    if (typeof part === "string") {
      return [{ type: "input_text", text: part }];
    }
    if (!part || typeof part !== "object") return [];
    if (part.type === "text" || part.type === "input_text" || part.type === "output_text") {
      return [{ type: "input_text", text: String(part.text || "") }];
    }
    if (part.type === "image_url" || part.type === "input_image") {
      const image = part.image_url;
      const imageUrl = typeof image === "string" ? image : image?.url;
      if (!imageUrl) return [];
      const detail = typeof image === "object" ? image.detail : part.detail;
      return [{ type: "input_image", image_url: imageUrl, detail: detail || "auto" }];
    }
    if (part.type === "input_file") return [part];
    return [{ type: "input_text", text: JSON.stringify(part) }];
  });
}

/* ── OpenAI 形态消息 → Anthropic /v1/messages 翻译（纯函数，便于自测） ── */
function textOf(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.filter(b => b && b.type === "text").map(b => b.text).join("");
  }
  return content == null ? "" : String(content);
}

function toAnthropicUserBlocks(content) {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (Array.isArray(content)) {
    return content.map(b => {
      if (b && b.type === "text") {
        return { type: "text", text: b.text };
      }
      if (b && b.type === "image_url" && b.image_url && b.image_url.url) {
        const url = b.image_url.url;
        const m = /^data:([^;]+);base64,(.*)$/.exec(url);
        return m
          ? { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } }
          : { type: "image", source: { type: "url", url } };
      }
      return { type: "text", text: typeof b === "string" ? b : JSON.stringify(b) };
    });
  }
  return [{ type: "text", text: content == null ? "" : String(content) }];
}

export function toAnthropicMessages(messages) {
  let system = "";
  const out = [];
  const pushMerged = (role, blocks) => {
    const last = out[out.length - 1];
    if (last && last.role === role) {
      last.content.push(...blocks);
    } else {
      out.push({ role, content: blocks });
    }
  };
  for (const m of messages || []) {
    if (m.role === "system") {
      system += (system ? "\n\n" : "") + textOf(m.content);
    } else if (m.role === "tool") {
      pushMerged("user", [
        {
          type: "tool_result",
          tool_use_id: m.tool_call_id,
          content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
        },
      ]);
    } else if (m.role === "assistant") {
      const blocks = [];
      const txt = textOf(m.content);
      if (txt) {
        blocks.push({ type: "text", text: txt });
      }
      for (const tc of m.tool_calls || []) {
        let input = {};
        try {
          input = tc.function && tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          input = {};
        }
        blocks.push({ type: "tool_use", id: tc.id, name: tc.function && tc.function.name, input });
      }
      pushMerged("assistant", blocks.length ? blocks : [{ type: "text", text: "" }]);
    } else {
      pushMerged("user", toAnthropicUserBlocks(m.content));
    }
  }
  return { system, messages: out };
}

/**
 * 从 agent.json 风格的 provider 配置构造 LlmClient。
 * @param {object} providerCfg  agent.json 中 providers[name] 的对象
 * @param {object} [requestCfg] agent.json 中的 request 对象
 * @param {object} [opts]       { apiKeyFallbackEnv?: string } Node 自测时回退读环境变量
 * @returns {LlmClient}
 */
export function clientFromProviderConfig(providerCfg, requestCfg, opts = {}) {
  let apiKey = providerCfg.api_key || "";
  if (!apiKey && opts.apiKeyFallbackEnv && globalThis.process?.env) {
    apiKey = globalThis.process.env[opts.apiKeyFallbackEnv] || "";
  }
  return new LlmClient({
    protocol: providerCfg.protocol,
    baseUrl: providerCfg.base_url,
    chatPath: providerCfg.chat_path,
    apiKey,
    model: providerCfg.default_model,
    request: requestCfg,
  });
}

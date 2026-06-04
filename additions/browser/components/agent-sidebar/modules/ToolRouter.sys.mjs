/* ToolRouter.sys.mjs — Agent 工具注册表 + 路由（脊梁，Phase N0）。
 *
 * 设计约束（沿用 A1）：
 * 1. 零 Firefox 依赖：纯逻辑，后端通过 DI 注入。绝不 import Services/ChromeUtils，
 *    以便 dev/selftest-toolrouter.mjs 在 Node 下直接 import 验证。
 * 2. Agent 与未来 firefox-reverse-mcp 共享同一注册表（见 docs/agent-native-capabilities.md §4）。
 * 3. 后端无关：ToolRouter 只管「注册 / 列规格 / 派发 / 结果信封 / 截断」；
 *    具体能力（page/net/scripts/jsvmp/code）由各 backend 适配器实现，注入到 tool.handler 闭包。
 *
 * 工具规格 spec = {
 *   name:        string                          // 域_动作，如 "page_eval"
 *   description: string                          // 给 LLM 看的说明
 *   parameters:  JSONSchema                      // OpenAI function.parameters
 *   handler:     async (args, ctx) => any        // 真正执行；抛错由 dispatch 兜成信封
 * }
 * 结果信封 envelope = { ok:boolean, data?:any, error?:string, meta?:object }
 */

const DEFAULT_MAX_CHARS = 20000; // 单次工具结果序列化上限，超出截断，防爆 LLM 上下文

export class ToolRouter {
  /** @param {object} [opts] { maxChars } */
  constructor(opts = {}) {
    this._tools = new Map();
    this.maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  }

  /** 注册单个工具。重复 name 抛错（防静默覆盖）。 */
  register(spec) {
    if (!spec || typeof spec !== "object") {
      throw new Error("ToolRouter.register: spec object required");
    }
    if (!spec.name || typeof spec.name !== "string") {
      throw new Error("ToolRouter.register: spec.name (string) required");
    }
    if (typeof spec.handler !== "function") {
      throw new Error(`ToolRouter.register: tool "${spec.name}" needs handler()`);
    }
    if (this._tools.has(spec.name)) {
      throw new Error(`ToolRouter.register: duplicate tool "${spec.name}"`);
    }
    this._tools.set(spec.name, {
      name: spec.name,
      description: spec.description || "",
      parameters: spec.parameters || { type: "object", properties: {} },
      handler: spec.handler,
      needsConfirm: !!spec.needsConfirm, // 改动型工具（执行 JS/导航/改包/落盘）需用户批准（A3 要求）
    });
    return this;
  }

  /** 批量注册。 */
  registerAll(specs) {
    for (const s of specs || []) {
      this.register(s);
    }
    return this;
  }

  has(name) {
    return this._tools.has(name);
  }

  /** 该工具是否为「改动型」需用户批准（AgentLoop 据此在 dispatch 前征求确认）。 */
  needsConfirm(name) {
    const t = this._tools.get(name);
    return !!(t && t.needsConfirm);
  }

  names() {
    return [...this._tools.keys()];
  }

  /** 导出为 OpenAI `tools` 数组，直接喂 LlmClient.chat(_, { tools })。 */
  listSpecs() {
    return [...this._tools.values()].map(t => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  /**
   * 派发一次工具调用，永远返回信封（不抛）。
   * @param {string} name
   * @param {object} args
   * @param {object} [ctx]  透传给 handler 的运行期上下文（如 tabId/signal）
   * @returns {Promise<{ok:boolean,data?:any,error?:string,meta?:object}>}
   */
  async dispatch(name, args, ctx = {}) {
    const tool = this._tools.get(name);
    if (!tool) {
      return { ok: false, error: `unknown tool "${name}"` };
    }
    const missing = this._missingRequired(tool.parameters, args);
    if (missing.length) {
      return { ok: false, error: `missing required param(s): ${missing.join(", ")}` };
    }
    try {
      const data = await tool.handler(args || {}, ctx);
      return this._envelope(data);
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  }

  /** 轻量必填校验（不做完整 JSON-Schema，保持零依赖）。 */
  _missingRequired(parameters, args) {
    const req = parameters && Array.isArray(parameters.required) ? parameters.required : [];
    const a = args || {};
    return req.filter(k => a[k] === undefined || a[k] === null);
  }

  /** 包装成功信封 + 按 maxChars 截断超大结果。
   * 例外：`data._media`（图像等二进制，如截图 dataURL）抽到信封顶层 `media`，
   * **不参与文本截断、也不进模型文本上下文**（由 AgentLoop 决定喂给视觉模型 / 显示给用户）。 */
  _envelope(data) {
    let media;
    if (data && typeof data === "object" && Array.isArray(data._media)) {
      media = data._media;
      const { _media, ...rest } = data; // eslint-disable-line no-unused-vars
      data = rest;
    }
    const attach = env => (media ? { ...env, media } : env);
    let str;
    try {
      str = JSON.stringify(data);
    } catch {
      // 含循环引用/不可序列化 → 退化为字符串
      return attach({ ok: true, data: String(data) });
    }
    if (str !== undefined && str.length > this.maxChars) {
      return attach({
        ok: true,
        data: { _truncated: true, total_chars: str.length, preview: str.slice(0, this.maxChars) },
        meta: { truncated: true },
      });
    }
    return attach({ ok: true, data });
  }
}

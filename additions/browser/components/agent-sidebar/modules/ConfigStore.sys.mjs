/* ConfigStore.sys.mjs — Agent 侧边栏配置持久化（active provider / API Key / 模型）。
 *
 * 设计：
 * - Firefox 内用 Services.prefs；无 Services 时（Node 自测）退化为内存 backend，
 *   因此本模块也能在 Node 下 import 验证（不静态依赖 Services）。
 * - 与 LlmClient 解耦：LlmClient 不读配置，只接收 apiKey 入参；本类只管存取。
 *
 * 安全提示：A1 用 prefs 明文存 API Key（已在 patches/agent-ui/README.md 标风险）。
 * LoginManager 加密存储留后续增强。
 */

const PREF_PREFIX = "extensions.firefox-reverse.agent.";

/** 选择 storage backend：有 Services.prefs 用之，否则内存（仅供 Node 自测）。 */
function makeBackend() {
  const S = globalThis.Services;
  if (S?.prefs) {
    return {
      persistent: true,
      getString(key, def = "") {
        try {
          return S.prefs.getStringPref(key, def);
        } catch {
          return def;
        }
      },
      setString(key, val) {
        S.prefs.setStringPref(key, val);
        // 立刻落盘，保证 API Key 等配置在非正常退出（崩溃/强杀）后仍在缓存里。
        try {
          S.prefs.savePrefFile(null);
        } catch {}
      },
      clear(key) {
        try {
          S.prefs.clearUserPref(key);
          S.prefs.savePrefFile(null);
        } catch {}
      },
    };
  }
  const mem = new Map();
  return {
    persistent: false,
    getString: (k, def = "") => (mem.has(k) ? mem.get(k) : def),
    setString: (k, v) => void mem.set(k, v),
    clear: (k) => void mem.delete(k),
  };
}

export class ConfigStore {
  constructor(backend = makeBackend()) {
    this.b = backend;
  }

  /** 真持久化（Firefox prefs）还是内存（Node 自测）。 */
  get isPersistent() {
    return !!this.b.persistent;
  }

  getActiveProvider(def = "deepseek") {
    return this.b.getString(PREF_PREFIX + "activeProvider", def);
  }
  setActiveProvider(name) {
    this.b.setString(PREF_PREFIX + "activeProvider", name);
  }

  getApiKey(provider) {
    return this.b.getString(PREF_PREFIX + "key." + provider, "");
  }
  setApiKey(provider, key) {
    this.b.setString(PREF_PREFIX + "key." + provider, key || "");
  }
  clearApiKey(provider) {
    this.b.clear(PREF_PREFIX + "key." + provider);
  }

  getModel(provider, def = "") {
    return this.b.getString(PREF_PREFIX + "model." + provider, def);
  }
  setModel(provider, model) {
    this.b.setString(PREF_PREFIX + "model." + provider, model || "");
  }

  /** 自定义端点（provider="custom"）的 Base URL，如 http://host:port。 */
  getCustomBaseUrl(def = "") {
    return this.b.getString(PREF_PREFIX + "custom.baseUrl", def);
  }
  setCustomBaseUrl(url) {
    this.b.setString(PREF_PREFIX + "custom.baseUrl", url || "");
  }

  /** 自定义端点协议："openai"（/v1/chat/completions）或 "anthropic"（/v1/messages）。 */
  getCustomProtocol(def = "openai") {
    return this.b.getString(PREF_PREFIX + "custom.protocol", def);
  }
  setCustomProtocol(p) {
    this.b.setString(PREF_PREFIX + "custom.protocol", p || "openai");
  }

  /** 改动型工具（page_eval/导航/网络/存JS/jsvmp）执行前是否需用户确认。
   *  默认 false = autoApprove（工作站自用、不打断）。开启则每次改动型调用弹确认。 */
  getConfirmTools() {
    return this.b.getString(PREF_PREFIX + "confirmTools", "0") === "1";
  }
  setConfirmTools(on) {
    this.b.setString(PREF_PREFIX + "confirmTools", on ? "1" : "0");
  }

  /** 默认工作目录（新会话继承上次用过的目录；可被每个会话各自覆盖）。 */
  getDefaultWorkspaceDir(def = "") {
    return this.b.getString(PREF_PREFIX + "workspace.default", def);
  }
  setDefaultWorkspaceDir(path) {
    this.b.setString(PREF_PREFIX + "workspace.default", path || "");
  }

  /** node/python 可执行文件路径覆盖（GUI 启动 PATH 精简、homebrew 等搜不到时手动指定）。 */
  getNodePath() {
    return this.b.getString(PREF_PREFIX + "exec.node", "");
  }
  setNodePath(p) {
    this.b.setString(PREF_PREFIX + "exec.node", p || "");
  }
  getPythonPath() {
    return this.b.getString(PREF_PREFIX + "exec.python", "");
  }
  setPythonPath(p) {
    this.b.setString(PREF_PREFIX + "exec.python", p || "");
  }
}

/** 默认单例（Firefox 用；测试可 new ConfigStore(自定义 backend)）。 */
export const configStore = new ConfigStore();

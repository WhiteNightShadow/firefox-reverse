/* ConversationStore.sys.mjs — Agent 多线程对话历史持久化。
 *
 * - Firefox：落盘到 profile 下 <profile>/firefox-reverse-agent/conversations.json
 *   （用 IOUtils/PathUtils，system ESM 全局可用）。比 prefs 更适合大体量历史。
 * - Node 自测：无 IOUtils → 退化为内存，仍可 import 验证。
 * 全部 API 异步。数据结构：{ schemaVersion, threads: [{ id, title, createdAt, updatedAt,
 * workspace, envId, modelStrategy, contextProjection, usage, messages:[{role,content}] }] }
 *   workspace = 该会话绑定的本地工作目录绝对路径（null=未设；**新会话默认为空/不绑定**，需用户手动打开目录）。
 *   envId = 该会话准备使用的 Firefox-Reverse 环境 id（null=未选）。
 *   modelStrategy = "balanced" | "premium"，先作为 Agent 调度上下文，后续可映射到具体 provider/model。
 */

import { normalizeContextProjection, projectMessages } from "./ContextProjection.sys.mjs";
import { emptyUsage, mergeUsage } from "./Usage.sys.mjs";

const DIR_NAME = "firefox-reverse-agent";
const FILE_NAME = "conversations.json";
const NEW_TITLE = "新对话";
const STORE_SCHEMA_VERSION = 3;
const EXPORT_FORMAT = "firefox-reverse-conversation";
const EXPORT_SCHEMA_VERSION = 1;
const MAX_IMPORT_CHARS = 10 * 1024 * 1024;
const MAX_IMPORT_MESSAGES = 5000;
const MAX_MESSAGE_CHARS = 1024 * 1024;
const TURN_STATUSES = new Set(["idle", "running", "completed", "cancelled", "failed"]);

function hasIO() {
  return typeof IOUtils !== "undefined" && typeof PathUtils !== "undefined";
}

// 单调递增时间戳：保证连续操作（同一毫秒内）也严格递增 → 列表排序确定。
let _clock = 0;
function nextTs() {
  _clock = Math.max(Date.now(), _clock + 1);
  return _clock;
}

function newThreadId() {
  const now = nextTs();
  return "t" + now.toString(36) + Math.random().toString(36).slice(2, 7);
}

function cleanTitle(value) {
  return String(value || NEW_TITLE).replace(/\s+/g, " ").trim().slice(0, 120) || NEW_TITLE;
}

function normalizeThread(t) {
  const messages = Array.isArray(t.messages) ? t.messages : [];
  return {
    ...t,
    workspace: t.workspace || null,
    mode: t.mode || null,
    envId: t.envId || null,
    modelStrategy: t.modelStrategy === "premium" ? "premium" : "balanced",
    lastTurnStatus: TURN_STATUSES.has(t.lastTurnStatus) ? t.lastTurnStatus : "idle",
    cancellationPending: t.cancellationPending === true,
    cancelledAt: Number.isFinite(t.cancelledAt) ? t.cancelledAt : null,
    contextProjection: normalizeContextProjection(t.contextProjection, messages.length),
    usage: mergeUsage(t.usage || emptyUsage()),
    messages,
  };
}

function cleanStep(step) {
  if (!step || typeof step !== "object" || !["text", "think", "tool"].includes(step.kind)) {
    return null;
  }
  if (step.kind === "text" || step.kind === "think") {
    return { kind: step.kind, text: String(step.text || "").slice(0, 200000) };
  }
  return {
    kind: "tool",
    ...(step.id ? { id: String(step.id).slice(0, 200) } : {}),
    ...(step.name ? { name: String(step.name).slice(0, 200) } : {}),
    ...(step.status ? { status: String(step.status).slice(0, 32) } : {}),
    ...(step.summary ? { summary: String(step.summary).slice(0, 2000) } : {}),
    ...(Number.isFinite(step.shot) ? { shot: Math.max(0, Math.floor(step.shot)) } : {}),
  };
}

function cleanMessage(msg, index) {
  if (!msg || typeof msg !== "object" || !["user", "assistant"].includes(msg.role)) {
    throw new Error(`导入失败：第 ${index + 1} 条消息角色无效`);
  }
  if (typeof msg.content !== "string") {
    throw new Error(`导入失败：第 ${index + 1} 条消息内容必须是文本`);
  }
  if (msg.content.length > MAX_MESSAGE_CHARS) {
    throw new Error(`导入失败：第 ${index + 1} 条消息超过 1MB`);
  }
  const steps = Array.isArray(msg.steps) ? msg.steps.map(cleanStep).filter(Boolean) : [];
  return {
    role: msg.role,
    content: msg.content,
    ...(steps.length ? { steps } : {}),
  };
}

export class ConversationStore {
  constructor(opts = {}) {
    this._mem = null; // { threads: [...] }
    this._path = opts.path || null;
    this._memoryOnly = opts.memoryOnly ?? !hasIO();
  }

  get isPersistent() {
    return !this._memoryOnly;
  }

  async _filePath() {
    if (this._path) {
      return this._path;
    }
    const dir = PathUtils.join(PathUtils.profileDir, DIR_NAME);
    await IOUtils.makeDirectory(dir, { ignoreExisting: true });
    this._path = PathUtils.join(dir, FILE_NAME);
    return this._path;
  }

  async _load() {
    if (this._mem) {
      return this._mem;
    }
    if (this._memoryOnly) {
      return (this._mem = { schemaVersion: STORE_SCHEMA_VERSION, threads: [] });
    }
    try {
      const data = await IOUtils.readJSON(await this._filePath());
      this._mem =
        data && Array.isArray(data.threads)
          ? { ...data, schemaVersion: STORE_SCHEMA_VERSION, threads: data.threads.map(normalizeThread) }
          : { schemaVersion: STORE_SCHEMA_VERSION, threads: [] };
    } catch {
      this._mem = { schemaVersion: STORE_SCHEMA_VERSION, threads: [] }; // 文件不存在/损坏 → 空
    }
    return this._mem;
  }

  async _save() {
    if (this._memoryOnly) {
      return;
    }
    const p = await this._filePath();
    await IOUtils.writeJSON(p, this._mem, { tmpPath: p + ".tmp" });
  }

  /** 线程摘要列表（按更新时间倒序），不含 messages。 */
  async listThreads() {
    const d = await this._load();
    return d.threads
      .map(t => ({
        id: t.id,
        title: t.title,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        workspace: t.workspace || null,
        mode: t.mode || null,
        envId: t.envId || null,
        modelStrategy: t.modelStrategy || "balanced",
        lastTurnStatus: t.lastTurnStatus || "idle",
        cancellationPending: t.cancellationPending === true,
        contextProjected: !!t.contextProjection,
        usage: mergeUsage(t.usage),
        count: t.messages.length,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getThread(id) {
    const d = await this._load();
    return d.threads.find(t => t.id === id) || null;
  }

  /** Full UI history remains untouched; only the model-facing view may use a projection. */
  async getModelMessages(id, { strategy = "projected" } = {}) {
    const t = await this.getThread(id);
    if (!t) {
      return [];
    }
    const messages = t.messages.map(message => ({
      role: message.role,
      content: message.content,
    }));
    return strategy === "legacy"
      ? messages
      : projectMessages(messages, t.contextProjection);
  }

  async createThread(title = NEW_TITLE, workspace = null, mode = null) {
    const d = await this._load();
    const now = nextTs();
    const t = {
      id: newThreadId(),
      title: cleanTitle(title),
      createdAt: now,
      updatedAt: now,
      workspace: workspace || null,
      mode: mode || null, // "auto"=全自动一条龙 / "assist"=AI辅助逐阶段 / null=未选（用时默认 auto）
      envId: null,
      modelStrategy: "balanced",
      lastTurnStatus: "idle",
      cancellationPending: false,
      cancelledAt: null,
      contextProjection: null,
      usage: emptyUsage(),
      messages: [],
    };
    d.threads.push(t);
    await this._save();
    return t;
  }

  /** 绑定/更新会话的工作目录。 */
  async setThreadWorkspace(id, workspace) {
    const d = await this._load();
    const t = d.threads.find(x => x.id === id);
    if (t) {
      t.workspace = workspace || null;
      t.updatedAt = nextTs();
      await this._save();
    }
    return t;
  }

  /** 设置/更新会话的执行模式（auto=全自动 / assist=AI辅助逐阶段）。按会话持久化，一选定整条会话沿用。 */
  async setThreadMode(id, mode) {
    const d = await this._load();
    const t = d.threads.find(x => x.id === id);
    if (t) {
      t.mode = mode || null;
      t.updatedAt = nextTs();
      await this._save();
    }
    return t;
  }

  /** 绑定/更新会话的浏览器环境。 */
  async setThreadEnvironment(id, envId) {
    const d = await this._load();
    const t = d.threads.find(x => x.id === id);
    if (t) {
      t.envId = envId || null;
      t.updatedAt = nextTs();
      await this._save();
    }
    return t;
  }

  /** 设置/更新会话的模型策略。 */
  async setThreadModelStrategy(id, strategy) {
    const d = await this._load();
    const t = d.threads.find(x => x.id === id);
    if (t) {
      t.modelStrategy = strategy === "premium" ? "premium" : "balanced";
      t.updatedAt = nextTs();
      await this._save();
    }
    return t;
  }

  /** 记录最近一轮状态。手动取消只标记边界，不会影响正常运行或自动续跑。 */
  async setThreadTurnStatus(id, status) {
    if (!TURN_STATUSES.has(status)) {
      throw new Error("invalid turn status: " + status);
    }
    const d = await this._load();
    const t = d.threads.find(x => x.id === id);
    if (!t) {
      return null;
    }
    const now = nextTs();
    t.lastTurnStatus = status;
    if (status === "cancelled") {
      t.cancellationPending = true;
      t.cancelledAt = now;
    } else if (status === "completed" || status === "failed") {
      t.cancellationPending = false;
    }
    t.updatedAt = now;
    await this._save();
    return t;
  }

  /** 下一条用户消息消费一次取消边界；返回 true 时调用方应注入“不自动恢复旧任务”的系统提示。 */
  async consumeCancellationBoundary(id) {
    const d = await this._load();
    const t = d.threads.find(x => x.id === id);
    if (!t || t.cancellationPending !== true) {
      return false;
    }
    t.cancellationPending = false;
    t.updatedAt = nextTs();
    await this._save();
    return true;
  }

  /** 追加一条消息；首条 user 消息自动作为标题。 */
  async appendMessage(id, msg) {
    const d = await this._load();
    const t = d.threads.find(x => x.id === id);
    if (!t) {
      throw new Error("conversation thread not found: " + id);
    }
    t.messages.push({ role: msg.role, content: msg.content, ...(msg.steps ? { steps: msg.steps } : {}) });
    t.updatedAt = nextTs();
    if (t.title === NEW_TITLE && msg.role === "user" && msg.content) {
      t.title = msg.content.replace(/\s+/g, " ").trim().slice(0, 30) || NEW_TITLE;
    }
    await this._save();
    return t;
  }

  /** Atomically replace the model-only continuation projection. */
  async setContextProjection(id, projection) {
    const d = await this._load();
    const t = d.threads.find(x => x.id === id);
    if (!t) {
      throw new Error("conversation thread not found: " + id);
    }
    const normalized = normalizeContextProjection(projection, t.messages.length);
    if (!normalized) {
      throw new Error("invalid context projection");
    }
    const previous = t.contextProjection;
    t.contextProjection = normalized;
    try {
      await this._save();
    } catch (error) {
      t.contextProjection = previous;
      throw error;
    }
    return normalized;
  }

  async clearContextProjection(id) {
    const d = await this._load();
    const t = d.threads.find(x => x.id === id);
    if (!t) {
      return false;
    }
    t.contextProjection = null;
    await this._save();
    return true;
  }

  /** Persist aggregate token counters without changing conversation ordering. */
  async addThreadUsage(id, usage) {
    const d = await this._load();
    const t = d.threads.find(x => x.id === id);
    if (!t) {
      return null;
    }
    t.usage = mergeUsage(t.usage, usage);
    await this._save();
    return t.usage;
  }

  async renameThread(id, title) {
    const d = await this._load();
    const t = d.threads.find(x => x.id === id);
    if (t) {
      t.title = cleanTitle(title);
      t.updatedAt = nextTs();
      await this._save();
    }
  }

  async deleteThread(id) {
    const d = await this._load();
    const before = d.threads.length;
    d.threads = d.threads.filter(t => t.id !== id);
    if (d.threads.length !== before) {
      await this._save();
    }
  }

  /** 生成可迁移的单会话包。不携带工作目录、环境绑定、进程状态或模型密钥。 */
  async exportThread(id) {
    const t = await this.getThread(id);
    if (!t) {
      throw new Error("conversation thread not found: " + id);
    }
    return {
      format: EXPORT_FORMAT,
      schemaVersion: EXPORT_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      source: { app: "Firefox Reverse" },
      conversation: {
        sourceThreadId: t.id,
        title: cleanTitle(t.title),
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        mode: t.mode || null,
        modelStrategy: t.modelStrategy === "premium" ? "premium" : "balanced",
        messages: t.messages.map((m, i) => cleanMessage(m, i)),
      },
    };
  }

  async exportThreadJSON(id) {
    return JSON.stringify(await this.exportThread(id), null, 2) + "\n";
  }

  async exportThreadToFile(id, path) {
    if (!hasIO()) {
      throw new Error("当前环境不支持写入会话文件");
    }
    const json = await this.exportThreadJSON(id);
    const byteLength = typeof TextEncoder !== "undefined" ? new TextEncoder().encode(json).byteLength : json.length;
    if (byteLength > MAX_IMPORT_CHARS) {
      throw new Error("导出失败：当前单会话超过 10MB，请先精简超长消息");
    }
    await IOUtils.writeUTF8(path, json, { tmpPath: path + ".tmp" });
    return { ok: true, path, bytes: byteLength };
  }

  /** 导入仅创建一条静止的新会话，不恢复 workspace/envId，也绝不自动执行历史内容。 */
  async importThread(payload) {
    let data = payload;
    if (typeof payload === "string") {
      if (payload.length > MAX_IMPORT_CHARS) {
        throw new Error("导入失败：文件超过 10MB");
      }
      try {
        data = JSON.parse(payload);
      } catch {
        throw new Error("导入失败：不是有效 JSON");
      }
    }
    if (!data || data.format !== EXPORT_FORMAT || data.schemaVersion !== EXPORT_SCHEMA_VERSION) {
      throw new Error("导入失败：不是受支持的 Firefox Reverse 会话文件");
    }
    const src = data.conversation;
    if (!src || !Array.isArray(src.messages)) {
      throw new Error("导入失败：缺少 conversation.messages");
    }
    if (src.messages.length > MAX_IMPORT_MESSAGES) {
      throw new Error(`导入失败：消息数超过 ${MAX_IMPORT_MESSAGES}`);
    }
    const messages = src.messages.map((m, i) => cleanMessage(m, i));
    const d = await this._load();
    const now = nextTs();
    const t = {
      id: newThreadId(),
      title: cleanTitle(src.title),
      createdAt: now,
      updatedAt: now,
      workspace: null,
      mode: src.mode === "assist" || src.mode === "auto" ? src.mode : null,
      envId: null,
      modelStrategy: src.modelStrategy === "premium" ? "premium" : "balanced",
      lastTurnStatus: "idle",
      cancellationPending: false,
      cancelledAt: null,
      contextProjection: null,
      usage: emptyUsage(),
      importedFrom: {
        sourceThreadId: String(src.sourceThreadId || "").slice(0, 200) || null,
        importedAt: now,
      },
      messages,
    };
    d.threads.push(t);
    await this._save();
    return t;
  }

  async importThreadFromFile(path) {
    if (!hasIO()) {
      throw new Error("当前环境不支持读取会话文件");
    }
    const st = await IOUtils.stat(path);
    if (st.size > MAX_IMPORT_CHARS) {
      throw new Error("导入失败：文件超过 10MB");
    }
    return this.importThread(await IOUtils.readUTF8(path));
  }
}

/** 默认单例（Firefox 用；测试可 new ConversationStore({memoryOnly:true})）。 */
export const conversationStore = new ConversationStore();

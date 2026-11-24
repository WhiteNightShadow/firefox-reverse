/* AgentSession.sys.mjs — 常驻后台对话引擎（解决"切侧栏面板重载→正在进行的回复丢失"）。
 *
 * 关键点：侧栏(revamp)切到别的工具再切回会**重载 panel.html**→content 文档销毁→
 * 跑在 content 里的 runAgentTurn 与流式 fetch 随之而亡。把引擎挪到**系统模块单例**(父进程，
 * 跨面板重载存活)：这里跑 runAgentTurn、把事件 reduce 成 canonical steps、广播给订阅者，
 * done/error 时**自己**把最终/中断消息落 ConversationStore。UI 变薄：mount 时若本线程仍在跑就
 * 恢复 steps+busy 并订阅续看；不在场也不影响——引擎照跑、结果照存。
 */
import { createRunState, runAgentTurn } from "./AgentLoop.sys.mjs";
import { ToolRouter } from "./ToolRouter.sys.mjs";
import { createBuiltinTools } from "./Tools.sys.mjs";
import { getBackends } from "./Backends.sys.mjs";
import { configStore } from "./ConfigStore.sys.mjs";
import {
  buildProjectionInput,
  CONTEXT_PROJECTION_PROMPT,
  CONTEXT_PROJECTION_VERSION,
  planContextProjection,
} from "./ContextProjection.sys.mjs";
import { buildClientFromStore, resolveImageInput } from "./providers.sys.mjs";
import { conversationStore } from "./ConversationStore.sys.mjs";
import { emptyUsage, mergeUsage, normalizeUsage } from "./Usage.sys.mjs";

// system ESM 无 window.setTimeout；从 Timer.sys.mjs 取（用于流式通知节流）。
const { setTimeout: _setTimeout, clearTimeout: _clearTimeout } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs"
);
const NOTIFY_THROTTLE_MS = 50; // 流式 delta/reasoning 最多 ~20 次/秒推给 UI——避免每 token 跨 realm 调用把内容进程压垮
const CANCELLED_TURN_BOUNDARY =
  "【手动取消边界】上一项任务已被用户明确手动取消。此前未完成事项只能作为历史背景，" +
  "不得自动恢复、补做或继续调用工具。请把最新一条用户消息视为新的独立请求；" +
  "只有当最新消息明确要求‘继续/恢复上一项任务’时，才可以接着执行被取消的任务。";

let _router = null;
function router() {
  if (!_router) {
    _router = new ToolRouter();
    _router.registerAll(createBuiltinTools(getBackends()));
  }
  return _router;
}

// 从 steps 里拼出本轮模型产出的正文文本。content 兜底用：
// 工具密集轮 / 被打断轮 res.content 可能为空，但 steps 里有 text 段 → 落盘的 assistant
// 消息仍须带文本，否则下一轮历史里这一轮是空白回复＝模型看不到自己上轮说过什么＝会话失忆。
function textFromSteps(steps) {
  return (steps || [])
    .filter(x => x && x.kind === "text" && typeof x.text === "string" && x.text.trim())
    .map(x => x.text)
    .join("\n")
    .trim();
}

function interruptedContentFromSteps(steps) {
  const text = textFromSteps(steps);
  if (text) {
    return text;
  }
  const tools = (steps || []).filter(x => x && x.kind === "tool" && x.name);
  if (tools.length) {
    const names = tools.map(t => `${t.name}(${t.status || "stopped"})`).join("、");
    return `（已执行工具：${names}；已按用户新补充转向）`;
  }
  return "";
}

/** 持久化前给 steps 瘦身（去截图大数据、截断长思考），与 UI 旧逻辑一致。 */
function slimifySteps(steps) {
  return steps.map(s => {
    if (s.images && s.images.length) {
      const { images, ...rest } = s; // eslint-disable-line no-unused-vars
      return { ...rest, shot: images.length };
    }
    if (s.kind === "think" && s.text && s.text.length > 800) {
      return { ...s, text: s.text.slice(0, 800) + "…（思考已截断）" };
    }
    return s;
  });
}

function summarizeEnv(env) {
  if (!env) return "";
  if (!env.ok) return (env.error ? String(env.error) : "失败").slice(0, 80);
  const d = env.data;
  if (d == null) return "ok";
  if (typeof d === "object") {
    for (const k of ["count", "savedCount", "total", "enabled", "requests", "hits", "records", "urls"]) {
      if (d[k] != null) {
        return k + "=" + (Array.isArray(d[k]) ? d[k].length : JSON.stringify(d[k]).slice(0, 40));
      }
    }
    return "ok";
  }
  return String(d).slice(0, 60);
}

const sessions = new Map(); // threadId -> state

if (typeof conversationStore.setExternalImageRefs === "function") {
  conversationStore.setExternalImageRefs(() => {
    const ids = new Set();
    for (const s of sessions.values()) {
      for (const entry of [...s.queue, ...s.guidance]) {
        for (const img of entry.message?.images || []) {
          if (img?.id) {
            ids.add(img.id);
          }
        }
      }
    }
    return ids;
  });
}

// 多窗口预留的心跳过期：持有窗口活着时每隔几秒续约 ts；超过此时长没续约 = 持有者已销毁
// （切栏/关窗时文档被异常拆除、releaseThread 没跑成）→ 预留视为可回收。比心跳间隔(3s)宽裕。
const RESERVE_TTL_MS = 8000;

// 关机时中止所有运行中的会话（停掉挂起的 LLM 流/工具 + 经 signal 让子进程被 kill），让 firefox
// 主进程干净快速退出。修「关闭浏览器后进程僵尸/慢退」：实测基座(无 agent)SIGTERM 1s 退，agent
// 激活后占资源则慢退；这里在关机早期主动中止。Node 自测无 Services.obs → try 兜底。
try {
  Services.obs.addObserver(
    {
      observe() {
        for (const s of sessions.values()) {
          try {
            s.queue.length = 0;
            s.guidance.length = 0;
            s.abort?.abort();
          } catch {
            /* ignore */
          }
        }
      },
    },
    "quit-application-granted"
  );
} catch {
  /* 非 Firefox 环境无 Services.obs */
}
const _runLog = []; // [DEBUG] 记录每次 run() 调用，确认 UI 是否真的路由到引擎
export function getRunLog() {
  return _runLog.slice(-20);
}

function newState() {
  return {
    running: false,
    settled: false, // 本轮已结束（done/error）——UI 据此从 store 重载已落盘消息
    steps: [],
    _curText: -1,
    _curThink: -1,
    content: "",
    error: null,
    aborted: false,
    abort: null,
    queue: [],
    guidance: [], // 已点「引导」的消息；当前请求收尾后一起交给模型。
    lastRunOpts: null,
    nextMessageId: 0,
    historyRev: 0, // 跨连续回复递增，侧栏据此重读新落盘的气泡。
    subs: new Set(),
    reservation: null, // 多窗口隔离：{ owner, ts } 或 null。owner=持有窗口 token；ts=最后心跳。
    //   只有「owner 不同 且 心跳新鲜(未过 TTL)」才算被别的活窗口占用；过期/同 owner/空 → 可认领。
    //   修「切到别的插件侧栏再切回→该会话已在另一个窗口打开」：旧 reserved 布尔无持有者无存活性，
    //   文档异常拆除时 releaseThread 没跑→reserved 永真泄漏→同窗口重挂载误判成"别的窗口占用"。
    pendingConfirm: null, // { id, name, args, resolve }
    _notifyTimer: null, // 节流定时器
    _lastNotify: 0, // 上次广播时刻
    rev: 0, // 状态每变一次 +1（只增不减）：UI 轮询时据此跳过没有变化的拍子
    checkpointSeq: 0, // 自增：每次上下文压缩落盘一条 checkpoint 回复就 +1，UI 据此重载并起新气泡
    usage: emptyUsage(), // current run only; aggregate is persisted on the thread
    lastUsage: null,
    contextStrategy: "projected",
    contextProjected: false,
  };
}
function getOrInit(threadId) {
  let s = sessions.get(threadId);
  if (!s) {
    s = newState();
    sessions.set(threadId, s);
  }
  return s;
}

// 状态变了之后调用 notify / notifyThrottled：版本号立即前进（UI 轮询看的是它），只有广播本身会被节流。
function notify(s) {
  // 立即广播（结构性事件：tool/round/confirm/done/error）。会清掉待发的节流定时器。
  s.rev++;
  broadcast(s);
}
function broadcast(s) {
  if (s._notifyTimer) {
    _clearTimeout(s._notifyTimer);
    s._notifyTimer = null;
  }
  s._lastNotify = Date.now();
  const snap = snapshot(s);
  for (const cb of s.subs) {
    try {
      cb(snap);
    } catch {
      /* 死订阅者(面板已重载)忽略 */
    }
  }
}
// 节流广播（高频流式 delta/reasoning）：把"每 token 一次跨 realm 调用"降到 ~20 次/秒，
// 否则内容进程被每 token 的快照+渲染压垮→看起来不流式、很慢。带 trailing：突发结束后补发一次。
function notifyThrottled(s) {
  s.rev++;
  const now = Date.now();
  const since = now - (s._lastNotify || 0);
  if (since >= NOTIFY_THROTTLE_MS) {
    broadcast(s);
  } else if (!s._notifyTimer) {
    s._notifyTimer = _setTimeout(() => {
      s._notifyTimer = null;
      broadcast(s);
    }, NOTIFY_THROTTLE_MS - since);
  }
}
function snapshot(s) {
  return {
    rev: s.rev,
    running: s.running,
    settled: s.settled,
    steps: s.steps.slice(),
    error: s.error,
    aborted: s.aborted,
    content: s.content,
    pendingMessages: [
      ...s.guidance.map(({ id, message }) => ({
        id,
        text: message.content,
        imageCount: message.images?.length || 0,
        steering: true,
      })),
      ...s.queue.map(({ id, message }) => ({
        id,
        text: message.content,
        imageCount: message.images?.length || 0,
        steering: false,
      })),
    ],
    historyRev: s.historyRev,
    checkpointSeq: s.checkpointSeq || 0,
    usage: { ...s.usage },
    lastUsage: s.lastUsage ? { ...s.lastUsage } : null,
    contextStrategy: s.contextStrategy || "projected",
    contextProjected: s.contextProjected === true,
    pendingConfirm: s.pendingConfirm ? { id: s.pendingConfirm.id, name: s.pendingConfirm.name, args: s.pendingConfirm.args } : null,
  };
}

function interruptReply(s) {
  s.abort.abort();
  // 等待工具确认时也要唤醒当前回合，才能收尾并交还输入。
  if (s.pendingConfirm) {
    const { resolve } = s.pendingConfirm;
    s.pendingConfirm = null;
    resolve(false);
  }
}

function startNextReply(threadId, s) {
  const guided = s.guidance.length > 0;
  const entries = guided ? s.guidance.splice(0) : s.queue.splice(0, 1);
  const saved = s.lastRunOpts || {};
  const fallbackPrompt = guided
    ? "请结合上面的对话和已经写出的回复，按用户刚补充的要求继续回答。"
    : "请结合上面的对话回答用户的新消息。";
  void agentSession.run(threadId, {
    ...saved,
    systemPrompt: saved.systemPrompt || fallbackPrompt,
    followUps: entries,
    guidedFollowUp: guided,
  });
}

// ── step reducer（从 UI 原样搬来：text / think 流式段 + tool 步骤）──
function pushDelta(s, chunk) {
  const arr = s.steps;
  const i = s._curText;
  if (i >= 0 && arr[i] && arr[i].kind === "text") {
    arr[i] = { ...arr[i], text: arr[i].text + chunk };
  } else {
    arr.push({ kind: "text", text: chunk });
    s._curText = arr.length - 1;
    s._curThink = -1;
  }
}
function pushReasoning(s, chunk) {
  const arr = s.steps;
  const i = s._curThink;
  if (i >= 0 && arr[i] && arr[i].kind === "think") {
    arr[i] = { ...arr[i], text: arr[i].text + chunk };
  } else {
    arr.push({ kind: "think", text: chunk });
    s._curThink = arr.length - 1;
    s._curText = -1;
  }
}
function applyEvent(s, ev) {
  if (ev.type === "round") {
    s._curText = -1;
    s._curThink = -1;
  } else if (ev.type === "tool_call") {
    s.steps.push({ kind: "tool", id: ev.id, name: ev.name, status: "running" });
    s._curText = -1;
    s._curThink = -1;
  } else if (ev.type === "tool_result") {
    const idx = s.steps.findIndex(x => x.kind === "tool" && x.id === ev.id && x.status === "running");
    if (idx >= 0) {
      const imgs =
        ev.env && Array.isArray(ev.env.media)
          ? ev.env.media.filter(m => m && m.type === "image" && m.dataUrl).map(m => m.dataUrl)
          : null;
      s.steps[idx] = {
        ...s.steps[idx],
        status: ev.env && ev.env.ok ? "ok" : "err",
        summary: summarizeEnv(ev.env),
        ...(imgs && imgs.length ? { images: imgs } : {}),
      };
    }
  }
}

export const agentSession = {
  isRunning(threadId) {
    const s = sessions.get(threadId);
    return !!(s && s.running);
  },
  /** 列出当前所有「正在跑」的线程（id + 进度），供面板发现被外部/MCP 驱动、但自己没在显示的会话 →
   *  空闲时自动跟随、忙时横幅提示。只读，开销极小（遍历进程内 sessions Map）。 */
  listRunning() {
    const out = [];
    for (const [id, s] of sessions) {
      if (s && s.running) {
        out.push({ id, nSteps: (s.steps || []).length, checkpointSeq: s.checkpointSeq || 0 });
      }
    }
    return out;
  },
  /** 列出全部已注册工具的规格（OpenAI tools 数组）。供 MCP 等外部 director 发现可直调的工具集。
   *  只读、零副作用；与 agent 用的是同一个全局 ToolRouter 单例（可用工具面 = 已接好的 backend）。 */
  listTools() {
    try {
      return { ok: true, tools: router().listSpecs() };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  },
  /** 直调一个内置工具并返回信封（dispatch 永不抛、已校验未知工具/缺参）。**不经 LLM、不走 confirm**
   *  —— 外部 director（Claude/Cursor 等）即审批者，等同现有 director 驱动的 confirmMode:false。
   *  用的是与 agent **同一个全局 ToolRouter + backends 单例**，状态一致；ctx 复刻 director 驱动路径
   *  （win:null → PageBackend 兜底到活动标签页，与 agentSession.run 第 410 行的 toolCtx 一致；
   *   signal:null 各 backend 均 `ctx && ctx.signal` 守护，安全）。
   *  ⚠ 安全闸：任一会话正在跑时拒绝——raw 调用与运行中的 agent 共享同一标签页/hook/trace 状态，
   *  并发会相互串味。先停掉 agent 再直调。 */
  async callTool(name, args, opts = {}) {
    if (!name || typeof name !== "string") {
      return { ok: false, error: "callTool: name (string) required" };
    }
    const running = this.listRunning();
    if (running.length) {
      return {
        ok: false,
        error:
          `agent 正在运行（${running.map(r => r.id).join(", ")}）——raw 工具直调已暂时禁用：` +
          `它与运行中的 agent 共享同一页面/hook/trace 状态，并发会相互串味。` +
          `先 agent_wait_for_stop 等它停、或 agent_stop 砍掉，再直调工具。`,
        running,
      };
    }
    const ctx = { workspaceRoot: (opts && opts.workspaceRoot) || null, win: null, signal: null };
    return await router().dispatch(name, args || {}, ctx);
  },
  /** 多窗口隔离：从候选线程里认领一条**没被别的活窗口占用**的，原子预留(记 owner+心跳)并返回其 id；
   *  都被别的活窗口占着返回 null（调用方应新建空线程给本窗口）。`owner`=本窗口稳定 token：
   *  同一 chrome 窗口切栏重挂载会传同一 token → 立即重认领自己那条（不受 TTL 影响）；
   *  传旧式无 owner 时退化为匿名(仍按 TTL 回收)。每个侧栏挂载/切线程时调。 */
  acquireThread(candidateIds, owner) {
    const token = owner || "anon";
    const now = Date.now();
    for (const id of (candidateIds || [])) {
      if (!id) {
        continue;
      }
      const s = getOrInit(id);
      const r = s.reservation;
      // 仅「别的 owner 且心跳仍新鲜」= 真有另一个活窗口占用；自己持有 / 无预留 / 预留过期(持有者已销毁) → 认领
      const liveOther = r && r.owner !== token && now - r.ts < RESERVE_TTL_MS;
      if (!liveOther) {
        s.reservation = { owner: token, ts: now };
        return id;
      }
    }
    return null;
  },
  /** 心跳续约：本窗口显示 currentId 期间定时调，刷新 ts 证明自己还活着→别的窗口在 TTL 内认领不到。
   *  本 owner 持有 / 预留为空 / 原持有窗口已失联(过 TTL) → 续上并返回 true；别的活窗口持有 → 返回 false，
   *  UI 据此把本窗口置为只读查看（可看进度、不能发送，需要时点「在此窗口接管」）。 */
  renewThread(threadId, owner) {
    const s = getOrInit(threadId);
    const token = owner || "anon";
    const now = Date.now();
    if (!s.reservation) {
      s.reservation = { owner: token, ts: now };
      return true;
    }
    if (s.reservation.owner !== token) {
      if (now - s.reservation.ts < RESERVE_TTL_MS) {
        return false;                           // 别的活窗口持有（或已被接管）→ 本窗口只读查看，不抢回
      }
      s.reservation = { owner: token, ts: now }; // 持有窗口已失联（过 TTL 没续约）→ 只读方接手
      return true;
    }
    s.reservation.ts = now;
    return true;
  },
  /** 用户在本窗口明确点了「在此窗口接管」：把预留直接转给本窗口。原持有窗口下次心跳续约失败 → 转为只读查看。 */
  takeOverThread(threadId, owner) {
    getOrInit(threadId).reservation = { owner: owner || "anon", ts: Date.now() };
    return threadId;
  },
  /** 释放本窗口对某线程的预留（侧栏切走该线程 / pagehide / 关闭窗口时调）。释放后该线程可被任意窗口重开续看。
   *  传了 owner 则只释放自己的预留(不抢释放别窗口的)；不传 owner=旧式无条件释放。引擎后台仍跑不受影响。 */
  releaseThread(threadId, owner) {
    const s = sessions.get(threadId);
    if (!s || !s.reservation) {
      return;
    }
    if (owner && s.reservation.owner !== owner) {
      return;                                   // 不是自己的预留，别动（避免误放别的活窗口）
    }
    s.reservation = null;
  },
  /** 取本线程当前快照（mount/remount 恢复用）；无则 null。 */
  getState(threadId) {
    const s = sessions.get(threadId);
    return s ? snapshot(s) : null;
  },
  /** 订阅本线程的状态更新；返回退订函数。订阅即立刻收到一次当前快照。 */
  subscribe(threadId, cb) {
    const s = getOrInit(threadId);
    s.subs.add(cb);
    try {
      cb(snapshot(s));
    } catch {
      /* ignore */
    }
    return () => {
      s.subs.delete(cb);
      if (s.subs.size === 0) {
        s.reservation = null; // 窗口关闭/退订 → 释放预留，本线程可被其它窗口再认领（关后台续跑不受影响）
      }
    };
  },
  /** 回应工具确认（confirm-mode）。all=true → 本轮后续工具自动批准（"总是允许"）。 */
  respondConfirm(threadId, id, approved, all) {
    const s = sessions.get(threadId);
    if (s && s.pendingConfirm && s.pendingConfirm.id === id) {
      if (all && approved) {
        s.approveAll = true;
      }
      const resolve = s.pendingConfirm.resolve;
      s.pendingConfirm = null;
      notify(s);
      resolve(!!approved);
    }
  },
  queueMessage(threadId, message, runOpts) {
    const s = getOrInit(threadId);
    if (runOpts && typeof runOpts === "object") {
      s.lastRunOpts = { ...(s.lastRunOpts || {}), ...runOpts };
    }
    // 面板文档能随时销毁，队列只保存后台自己的文本与图片引用。
    const queued = {
      role: "user", content: message.content,
      ...(message.images?.length ? { images: Array.from(message.images, image => ({ ...image })) } : {}),
    };
    s.queue.push({ id: ++s.nextMessageId, message: queued });
    if (s.running) {
      notify(s);
    } else {
      startNextReply(threadId, s);
    }
  },
  removeQueuedMessage(threadId, id) {
    const s = sessions.get(threadId);
    const index = s?.queue.findIndex(item => item.id === id) ?? -1;
    if (index < 0) return;
    s.queue.splice(index, 1);
    notify(s);
  },
  steerQueuedMessage(threadId, id) {
    const s = sessions.get(threadId);
    const index = s?.queue.findIndex(item => item.id === id) ?? -1;
    if (index < 0) return; // 刚好已发出，或用户重复点击同一条。
    const [entry] = s.queue.splice(index, 1);
    if (s.running) {
      s.guidance.push(entry);
      interruptReply(s);
      notify(s);
    } else {
      s.queue.unshift(entry);
      startNextReply(threadId, s);
    }
  },
  clearQueuedMessages(threadId) {
    const s = sessions.get(threadId);
    if (s) {
      s.queue.length = 0;
      s.guidance.length = 0;
      notify(s);
    }
  },
  /** 停止本回合（轮次边界 + 进行中的 LLM 请求都会停）。 */
  stop(threadId) {
    const s = sessions.get(threadId);
    if (s && s.abort) {
      if (s.guidance.length) {
        s.queue.push(...s.guidance.splice(0));
        s.queue.sort((a, b) => a.id - b.id);
      }
      interruptReply(s);
      s.aborted = true;
      void conversationStore.setThreadTurnStatus(threadId, "cancelled").catch(() => {});
      notify(s);
    }
  },
  /**
   * 启动一轮自主执行（异步、即发即跑，不阻塞 UI）。引擎在本模块跑、跨面板重载存活。
   * @param {string} threadId
   * @param {object} p { systemPrompt, dynamicContext, convo, confirmMode, maxRounds, maxPerTool, workspaceRoot, assist }
   *   workspaceRoot — 本轮绑定的工作目录绝对路径；注入到每条工具调用的 ctx，实现多窗口/多会话隔离。
   *   assist — true=AI辅助逐阶段模式：不跨回合自动续（每个 turn 结束即交回用户），且 AgentLoop 里
   *            无工具的纯文字回复当正常收尾（停下给方向）而非 drift 逼它继续。false=全自动一条龙（默认）。
   */
  async run(
    threadId,
    {
      systemPrompt,
      baseSystemPrompt,
      modePrompts,
      dynamicContext = "",
      convo,
      confirmMode = false,
      maxRounds = 120,
      maxPerTool = 40,
      workspaceRoot,
      win,
      assist = false,
      followUps,
      guidedFollowUp = false,
    } = {}
  ) {
    _runLog.push({ threadId, at: Date.now(), convoLen: Array.isArray(convo) ? convo.length : -1 });
    const s = getOrInit(threadId);
    if (s.running) {
      return; // 已在跑，避免重入
    }
    if (!followUps) {
      s.lastRunOpts = {
        systemPrompt,
        baseSystemPrompt,
        modePrompts,
        dynamicContext,
        confirmMode,
        maxRounds,
        maxPerTool,
        workspaceRoot,
        win,
        assist,
      };
    }
    // 重置本轮态
    s.running = true;
    s.settled = false;
    s.steps = [];
    s._curText = -1;
    s._curThink = -1;
    s.content = "";
    s.error = null;
    s.aborted = false;
    s.pendingConfirm = null;
    s.approveAll = false;
    s.checkpointSeq = 0; // 新一轮自主执行：checkpoint 计数清零
    s.usage = emptyUsage();
    s.lastUsage = null;
    s.contextStrategy =
      configStore.getContextStrategy && configStore.getContextStrategy() === "legacy"
        ? "legacy"
        : "projected";
    s.contextProjected = false;
    if (s._notifyTimer) {
      _clearTimeout(s._notifyTimer);
      s._notifyTimer = null;
    }
    s._lastNotify = 0;
    const ac = new AbortController();
    s.abort = ac;
    notify(s);

    let vision = false;
    let appendedFollowUps = 0;
    try {
      if (followUps) {
        let threadSnapshot = null;
        try {
          threadSnapshot = await conversationStore.getThread(threadId);
        } catch {
          threadSnapshot = null;
        }
        if (threadSnapshot && "workspace" in threadSnapshot) {
          workspaceRoot = threadSnapshot.workspace || null;
        }
        if (threadSnapshot && (threadSnapshot.mode === "assist" || threadSnapshot.mode === "auto")) {
          assist = threadSnapshot.mode === "assist";
        }
        if (typeof configStore.getConfirmTools === "function") {
          confirmMode = !!configStore.getConfirmTools();
        }
        if (baseSystemPrompt) {
          const effMode = assist ? "assist" : "auto";
          systemPrompt = baseSystemPrompt + ((effMode === "assist" ? modePrompts?.assist : modePrompts?.auto) || "");
          const dynamicParts = [
            workspaceRoot
              ? `【当前工作目录】${workspaceRoot}\n用 fs_list/fs_read/fs_write 读写其中文件、run_node/run_python 在此目录执行脚本验证；jsvmp trace 自动镜像到其 jsvmp/ 子目录。把抓取的脚本、还原出的实现、笔记都存到这里。`
              : "【当前工作目录】未设置。若任务需要读写文件或执行脚本，请提示用户点击侧边栏顶部「打开目录」选择一个本地目录。",
          ];
          try {
            const backends = getBackends() || {};
            const dg = backends.notes && backends.notes.digest
              ? await backends.notes.digest({}, { workspaceRoot: workspaceRoot || null })
              : "";
            if (dg) {
              dynamicParts.push(dg);
            }
          } catch {
            /* 笔记可选 */
          }
          try {
            const backends = getBackends() || {};
            const catalog = backends.skill && backends.skill.list
              ? await backends.skill.list({}, { workspaceRoot: workspaceRoot || null })
              : null;
            if (catalog && catalog.ok && Array.isArray(catalog.skills) && catalog.skills.length) {
              const lines = catalog.skills.slice(0, 30).map(sk => `- ${sk.name}: ${sk.description || "无描述"}`);
              dynamicParts.push(`【当前可用 Skills】\n${lines.join("\n")}\n用户指定 Skill 时先 skill_get 读取正文。`);
            }
          } catch {
            /* Skill 目录可选 */
          }
          dynamicContext = dynamicParts.join("\n\n");
        }
        if (guidedFollowUp) {
          const steerNote =
            "【用户引导补充】上一轮执行已在用户补充处转向收尾；请结合上方已完成的步骤与部分回复，按本条补充要求继续推进。";
          dynamicContext = dynamicContext ? dynamicContext + "\n\n" + steerNote : steerNote;
        }
      }
      // 每次用户发起一轮时取最新设置；自动续跑沿用同一份 system，避免重复追加。
      const globalSystemPrompt = configStore.getGlobalSystemPrompt().trim();
      if (globalSystemPrompt) {
        systemPrompt = (systemPrompt ? systemPrompt + "\n\n" : "") + globalSystemPrompt;
      }
      // 取消边界只消费一次，且仅影响手动停止后的下一轮。正常回合和同一回合内的自动续跑完全不变。
      let hadCancellationBoundary = false;
      try {
        hadCancellationBoundary = await conversationStore.consumeCancellationBoundary(threadId);
        await conversationStore.setThreadTurnStatus(threadId, "running");
      } catch {
        /* 状态元数据失败不阻断 Agent */
      }
      if (hadCancellationBoundary) {
        dynamicContext = String(dynamicContext || "") + "\n\n" + CANCELLED_TURN_BOUNDARY;
      }
      const client = buildClientFromStore(configStore, { sessionId: threadId });
      const activeProfile =
        (configStore.getActiveModelProfile && configStore.getActiveModelProfile()) || null;
      const cacheKey = [
        "frx-v1",
        threadId,
        activeProfile?.id || client.providerId || "provider",
        client.model || "model",
      ]
        .join(":")
        .replace(/[^a-zA-Z0-9._:-]+/g, "_")
        .slice(0, 160);
      const recordUsage = (raw, info = {}) => {
        const normalized = normalizeUsage(raw, {
          provider: client.providerId,
          protocol: client.protocol,
          model: client.model,
          phase: info.phase || "chat",
        });
        if (!normalized.providerReported) {
          return;
        }
        s.lastUsage = normalized;
        s.usage = mergeUsage(s.usage, normalized);
        notifyThrottled(s);
      };
      // 图片：模型配置里「图片输入」选了支持/不支持就按选的，自动时按模型名判断（providers.sys.mjs）。
      // 确定能看图才把工具截图回喂给模型；确定不能看图时，用户贴过的图片换成文字说明，免得请求被拒；
      // 认不出的模型照发用户贴的图（发不过去会报错，用户再到设置里改成「不支持」）。
      let imageSupport = null;
      try {
        const active = configStore.getActiveModelProfile && configStore.getActiveModelProfile();
        const pid = (active && active.provider) || (configStore.getActiveProvider && configStore.getActiveProvider());
        const model = (active && active.model) || (pid && configStore.getModel && configStore.getModel(pid));
        imageSupport =
          typeof resolveImageInput === "function"
            ? resolveImageInput(active && active.imageInput, model).supported
            : null;
        vision = imageSupport === true;
      } catch {
        /* 取不到当不支持视觉 */
      }
      if (followUps) {
        if (imageSupport === false && followUps.some(entry => entry.message.images?.length)) {
          throw new Error("待发消息含有图片，请切换到支持图片的模型后再发送。");
        }
        for (const entry of followUps) {
          await conversationStore.appendMessage(threadId, entry.message);
          appendedFollowUps++;
        }
        s.historyRev++;
        notify(s);
      }
      // 全自动续跑（用户选定）：turn 因 maxRounds/漂移结束但任务没完成 → 自动起下一轮
      // （per-turn 的 maxRounds/maxPerTool/重复熔断计数随之全部重置——这正是 80轮上限/40次工具上限
      // 这类"莫名其妙停了、要手按继续"的根治），直到给出可独立实跑产物、或真需要用户（stopReason=final/
      // aborted），或安全网触发。免去用户反复手按"继续"。
      const NON_TERMINAL = new Set(["max_rounds", "drift"]);
      const MAX_AUTO_RESTARTS = 24; // 8→24：长逆向任务的天花板别太低（24×120≈2880 轮）。只作防无限空转的最终兜底，
      // 真正的空转由 A2 同参同结果熔断 + 连续失败护栏 + drift 拦，从头重做已完成的分析由跨回合的循环检测拦
      // （提醒后仍在重复就停，stopReason=loop）；任务在做实事就让它一直跑。
      let turnMsgs = Array.isArray(convo) ? convo : [];
      try {
        const thread = await conversationStore.getThread(threadId);
        if (thread && Array.isArray(thread.messages) && thread.messages.length) {
          const fullMessages = thread.messages.map(message => ({
            role: message.role,
            content: message.content,
            ...(Array.isArray(message.images) && message.images.length ? { images: message.images } : {}),
          }));
          if (s.contextStrategy === "projected") {
            const plan = planContextProjection(fullMessages, thread.contextProjection);
            if (plan) {
              const source = buildProjectionInput(fullMessages, plan);
              const projected = await client.chat(
                [
                  { role: "system", content: CONTEXT_PROJECTION_PROMPT },
                  {
                    role: "user",
                    content:
                      "Update the continuation record from this bounded source:\n\n" +
                      source,
                  },
                ],
                {
                  signal: ac.signal,
                  maxTokens: 2048,
                  // 少思考、给输出留足余量：推理模型的思考 token 也算在 maxTokens 里。
                  auxiliary: true,
                  cacheKey: cacheKey + ":projection",
                }
              );
              recordUsage(projected.usage, { phase: "projection" });
              // 被长度截断的记录是半截的：不落盘，沿用上一份投影（早期消息不能因此永久退出上下文）。
              const truncated = projected.finishReason === "length" || projected.finishReason === "max_tokens";
              const summary = truncated ? "" : String(projected.content || "").trim();
              if (summary) {
                const now = Date.now();
                await conversationStore.setContextProjection(threadId, {
                  version: CONTEXT_PROJECTION_VERSION,
                  summary,
                  cutoff: plan.cutoff,
                  sourceCount: plan.cutoff,
                  createdAt: plan.previous?.createdAt || now,
                  updatedAt: now,
                  strategy: "projected",
                });
              }
            }
            turnMsgs = await conversationStore.getModelMessages(threadId, {
              strategy: "projected",
            });
            const latest = await conversationStore.getThread(threadId);
            s.contextProjected = !!latest?.contextProjection;
          } else {
            turnMsgs = fullMessages;
          }
        }
      } catch (e) {
        // Projection is an optimization. On summary/read/write failure, preserve
        // the prior projection and continue with it (or full history if none).
        try {
          turnMsgs = await conversationStore.getModelMessages(threadId, {
            strategy: s.contextStrategy,
          });
          const latest = await conversationStore.getThread(threadId);
          s.contextProjected = !!latest?.contextProjection;
        } catch {
          turnMsgs = Array.isArray(convo) ? convo : [];
        }
      }
      // 消息上的图片引用换成发给模型的图片内容块（读图片文件、按一次请求的图片预算取舍）。
      if (typeof conversationStore.materializeImages === "function") {
        turnMsgs = await conversationStore.materializeImages(turnMsgs, { allowImages: imageSupport !== false });
      }
      const onDelta = chunk => { pushDelta(s, chunk); notifyThrottled(s); };
      const onReasoning = chunk => { pushReasoning(s, chunk); notifyThrottled(s); };
      let autoRestarts = 0;
      let driftStreak = 0;
      let res;
      let sessionNotice = ""; // 本模块自己加在最终回复后面的说明（为什么不再自动续跑）
      // 本次执行的所有回合共用一份状态：自动续跑会重置每回合的计数，但「这一步之前做过、结果一样」、
      // 最近一份进展存档、用户发的那条任务（任务锚点）都要跨回合记着——否则续跑后一压缩，上一回合的工作
      // 和任务本身都会从上下文里消失，从头重做一遍分析也看不出来。
      const runState = createRunState();
      for (;;) {
      res = await runAgentTurn({
        client,
        router: router(),
        messages: turnMsgs,
        systemPrompt,
        dynamicContext,
        runState,
        autoApprove: !confirmMode,
        assist, // AI辅助模式：无工具纯文字回复=正常收尾（停下给方向），不 drift 逼它继续
        vision,
        maxRounds,
        maxPerTool,
        signal: ac.signal,
        // 每条工具调用透传会话绑定的工作目录，WorkspaceBackend 优先用它而非全局 setRoot()，
        // 实现多窗口/多会话并发使用不同工作目录时互不干扰。
        toolCtx: { workspaceRoot: workspaceRoot || null, win: win || null, signal: ac.signal },
        // 沉淀式记忆：每轮开头 + 每次压缩后，引擎取最新账本(已确认事实/已否决死路)整本注入系统提示，
        // 让确认过的事实不因压缩衰减、动手前先看账本（治"压缩后重新发现/重走死路"）。
        getLedger: async () => {
          try {
            return await getBackends().ledger.digest({}, { workspaceRoot: workspaceRoot || null });
          } catch {
            return "";
          }
        },
        contextStrategy: s.contextStrategy,
        cacheKey,
        onUsage: recordUsage,
        persistToolArtifact:
          workspaceRoot
            ? async ({ id, name, content }) => {
                const safeName = String(name || "tool").replace(/[^a-zA-Z0-9._-]+/g, "_");
                const safeId = String(id || Date.now()).replace(/[^a-zA-Z0-9._-]+/g, "_");
                const path = `.frx-context/tool-results/${Date.now()}_${safeName}_${safeId}.json`;
                const saved = await getBackends().workspace.write(
                  { path, content },
                  { workspaceRoot, win: win || null }
                );
                return { path: saved?.path || path };
              }
            : null,
        onDelta,
        onReasoning,
        // 上下文压缩点：把本段进展作为一条 checkpoint 回复落盘 + 重置实时步骤 + 自增 seq，
        // UI 据 checkpointSeq 变化重载历史(新气泡)、清空 live 区，于是"一个长任务"在界面上
        // 表现为"多条阶段回复"，且每条都已持久化(任意后续步骤失败也不丢已完成进展)。
        onCheckpoint: async (summary, info) => {
          await this._persist(threadId, summary, s.steps);
          // 同时把交接摘要落盘到工作目录 progress.md：① 用户能直接找到的"知识库"；
          // ② 接手段若需要也能 fs_read 回看；覆盖写=始终是最新累积状态。
          if (workspaceRoot) {
            try {
              await getBackends().workspace.write(
                { path: "progress.md", content: summary },
                { workspaceRoot }
              );
            } catch {
              /* 工作目录未设/写失败不影响续跑 */
            }
            // 自动捕获安全网：把交接摘要里的"已确认事实/已否决假设"沉淀进结构化账本（去重）——
            // 即便 Agent 没主动 remember，每次压缩也把确认结论累积进账本、不衰减。这是"把压缩能力沉淀下来"。
            // 只沉淀模型这一次写出来的账本（info.ledger）：存档里还可能有机械记录、带过来的旧账本、引用的对话原文，
            // 那些不是这一次确认的结论——对话里的列表会被记成事实，截过的旧账本会把库里完整的结论换成半句。
            const written = info && typeof info.ledger === "string" ? info.ledger : summary;
            if (written.trim()) {
              try {
                await getBackends().ledger.mergeHandoff(written, { workspaceRoot, win: win || null });
              } catch {
                /* 自动沉淀失败不影响续跑 */
              }
            }
          }
          s.steps = [];
          s._curText = -1;
          s._curThink = -1;
          s.content = "";
          s.checkpointSeq = (s.checkpointSeq || 0) + 1;
          s.historyRev++;
          notify(s);
        },
        onEvent: ev => {
          applyEvent(s, ev);
          notify(s); // 结构性事件→立即(snappy)
        },
        confirm: confirmMode
          ? call =>
              ac.signal.aborted || s.approveAll
                ? Promise.resolve(!ac.signal.aborted)
                : new Promise(resolve => {
                    s.pendingConfirm = { id: call.id, name: call.name, args: call.args, resolve };
                    notify(s);
                  })
          : undefined,
      });
      const _reason = (res && res.stopReason) || "stop";
      // 真结束（final/loop/aborted/error）或被手动停 → 跳出收尾，等用户。loop=循环检测提醒后仍在重复，不自动续跑。
      // AI辅助模式：每个 turn 结束都交回用户（不跨回合自动续）——阶段做完就停、等用户选方向。
      if (ac.signal.aborted || assist || !NON_TERMINAL.has(_reason)) {
        break;
      }
      // ── 任务未完成，进入自动续跑判定 ──
      // 安全网①：连续两轮"漂移"（只描述/分析、没产生实质工具动作）= 真卡住 → 停下报告，别"顺畅地"空转烧 token。
      driftStreak = _reason === "drift" ? driftStreak + 1 : 0;
      if (driftStreak >= 2) {
        sessionNotice =
          "（已停下）连续两轮只在描述/分析、没有产生实质工具动作——多半卡住了。进展已落盘（progress.md/工作目录）。" +
          "说一句你的判断、或补个我拿不到的输入（登录态/样本/方向），我再继续。";
        res.content = (res.content ? res.content + "\n\n" : "") + sessionNotice;
        break;
      }
      // 安全网②：自动续跑硬上限（防极端 runaway）。
      if (autoRestarts >= MAX_AUTO_RESTARTS) {
        sessionNotice =
          `（已停下）已自动续跑 ${autoRestarts} 轮仍未给出可独立实跑的最终产物。进展已落盘。` +
          "回看上面进展，告诉我聚焦哪条路、或补个输入，我再继续。";
        res.content = (res.content ? res.content + "\n\n" : "") + sessionNotice;
        break;
      }
      // 续跑：把本段进展落盘成一条独立气泡（复用 checkpoint 的 UI 分段法）+ 清空 live 区 + 自增 seq。
      autoRestarts++;
      try {
        await this._persist(threadId, res.content || "（继续推进）", s.steps);
      } catch {
        /* 持久化失败不影响续跑 */
      }
      s.steps = [];
      s._curText = -1;
      s._curThink = -1;
      s.content = "";
      s.checkpointSeq = (s.checkpointSeq || 0) + 1;
      s.historyRev++;
      notify(s);
      // 喂回累积对话（剥掉 res.messages 前置的 system——runAgentTurn 会按 systemPrompt 重新前置，否则双份）
      // + 一条续跑指令（保证角色交替合法 + 给模型明确"接着干、别重来"的指示）。
      turnMsgs = (res.messages || turnMsgs).filter(m => m && m.role !== "system");
      turnMsgs.push({
        role: "user",
        content:
          "（系统·自动续跑）上一段到达轮次/调用上限但任务还没完成。基于已落盘进展（progress.md/工作目录文件 + 上面对话）" +
          "继续推进到底。**绝不从头重来：上面已经做过的工具调用 / 已测过的项 / 已确认的发现一律不要重做，直接拿已有结果接着干或汇总。**" +
          "只有给出可独立实跑的产物、或真需要我提供你拿不到的东西（登录态/账号/验证码/纯业务决策）时才停。",
      });
      } // end for(;;) —— 全自动续跑
      await this._finishReply(threadId, s, res, sessionNotice);
    } catch (e) {
      if (followUps && appendedFollowUps < followUps.length) {
        s.queue.unshift(...followUps.slice(appendedFollowUps));
      }
      const guided = s.guidance.length > 0 && ac.signal.aborted;
      s.aborted = !guided && ac.signal.aborted;
      if (guided) {
        s.content = interruptedContentFromSteps(s.steps);
      } else if (s.aborted) {
        s.content = "（已手动停止）";
      } else {
        const message = e?.message || String(e);
        s.error = message + (e?.body ? "\n— " + String(e.body).slice(0, 600) : "");
        s.content = "（本轮出错中断：" + message.slice(0, 160) + "）";
      }
      if (s.content || (!guided && (s.steps.length || s.aborted))) {
        await this._persist(threadId, s.content, s.steps);
      }
      try {
        await conversationStore.setThreadTurnStatus(threadId, guided ? "completed" : s.aborted ? "cancelled" : "failed");
      } catch {
        /* 状态元数据失败不影响中断收尾 */
      }
    } finally {
      try {
        if (s.usage && s.usage.requests > 0) {
          await conversationStore.addThreadUsage(threadId, s.usage);
        }
      } catch {
        /* usage persistence never blocks final state */
      }
      s.running = false;
      s.settled = true;
      s.abort = null;
      s.pendingConfirm = null;
      s.historyRev++;
      if (s.guidance.length || (s.queue.length && !ac.signal.aborted && !s.error)) {
        startNextReply(threadId, s);
      } else {
        notify(s);
      }
    }
  },

  async _finishReply(threadId, s, result, sessionNotice = "") {
    const interrupted = s.abort.signal.aborted || result.stopReason === "aborted";
    const guided = interrupted && s.guidance.length > 0;
    s.aborted = interrupted && !guided;
    const notice = [result.notice, sessionNotice].filter(Boolean).join("\n\n");
    if (notice && !interrupted) {
      pushDelta(s, (s._curText >= 0 ? "\n\n---\n" : "") + notice);
    }
    // 引导只保留当前回复已经生成的正文和步骤，下一条是同一话题里的补充。
    s.content = guided && result.stopReason === "aborted"
      ? interruptedContentFromSteps(s.steps)
      : result.content || textFromSteps(s.steps);
    if (s.content || (!guided && (s.steps.length || !interrupted))) {
      await this._persist(threadId, s.content, s.steps);
    }
    try {
      await conversationStore.setThreadTurnStatus(threadId, s.aborted ? "cancelled" : "completed");
    } catch {
      /* 状态元数据失败不影响已完成结果 */
    }
  },

  async _persist(threadId, content, steps) {
    try {
      const slim = slimifySteps(steps);
      await conversationStore.appendMessage(threadId, {
        role: "assistant",
        content,
        ...(slim.length ? { steps: slim } : {}),
      });
    } catch {
      /* 持久化失败不影响内存中已展示的过程 */
    }
  },
};

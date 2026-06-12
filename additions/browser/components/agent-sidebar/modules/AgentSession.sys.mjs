/* AgentSession.sys.mjs — 常驻后台对话引擎（解决"切侧栏面板重载→正在进行的回复丢失"）。
 *
 * 关键点：侧栏(revamp)切到别的工具再切回会**重载 panel.html**→content 文档销毁→
 * 跑在 content 里的 runAgentTurn 与流式 fetch 随之而亡。把引擎挪到**系统模块单例**(父进程，
 * 跨面板重载存活)：这里跑 runAgentTurn、把事件 reduce 成 canonical steps、广播给订阅者，
 * done/error 时**自己**把最终/中断消息落 ConversationStore。UI 变薄：mount 时若本线程仍在跑就
 * 恢复 steps+busy 并订阅续看；不在场也不影响——引擎照跑、结果照存。
 */
import { runAgentTurn } from "./AgentLoop.sys.mjs";
import { ToolRouter } from "./ToolRouter.sys.mjs";
import { createBuiltinTools } from "./Tools.sys.mjs";
import { getBackends } from "./Backends.sys.mjs";
import { configStore } from "./ConfigStore.sys.mjs";
import { buildClientFromStore, isVisionModel } from "./providers.sys.mjs";
import { conversationStore } from "./ConversationStore.sys.mjs";

// system ESM 无 window.setTimeout；从 Timer.sys.mjs 取（用于流式通知节流）。
const { setTimeout: _setTimeout, clearTimeout: _clearTimeout } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs"
);
const NOTIFY_THROTTLE_MS = 50; // 流式 delta/reasoning 最多 ~20 次/秒推给 UI——避免每 token 跨 realm 调用把内容进程压垮

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
    subs: new Set(),
    reservation: null, // 多窗口隔离：{ owner, ts } 或 null。owner=持有窗口 token；ts=最后心跳。
    //   只有「owner 不同 且 心跳新鲜(未过 TTL)」才算被别的活窗口占用；过期/同 owner/空 → 可认领。
    //   修「切到别的插件侧栏再切回→该会话已在另一个窗口打开」：旧 reserved 布尔无持有者无存活性，
    //   文档异常拆除时 releaseThread 没跑→reserved 永真泄漏→同窗口重挂载误判成"别的窗口占用"。
    pendingConfirm: null, // { id, name, args, resolve }
    _notifyTimer: null, // 节流定时器
    _lastNotify: 0, // 上次广播时刻
    checkpointSeq: 0, // 自增：每次上下文压缩落盘一条 checkpoint 回复就 +1，UI 据此重载并起新气泡
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

function notify(s) {
  // 立即广播（结构性事件：tool/round/confirm/done/error）。会清掉待发的节流定时器。
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
  const now = Date.now();
  const since = now - (s._lastNotify || 0);
  if (since >= NOTIFY_THROTTLE_MS) {
    notify(s);
  } else if (!s._notifyTimer) {
    s._notifyTimer = _setTimeout(() => {
      s._notifyTimer = null;
      notify(s);
    }, NOTIFY_THROTTLE_MS - since);
  }
}
function snapshot(s) {
  return {
    running: s.running,
    settled: s.settled,
    steps: s.steps.slice(),
    error: s.error,
    aborted: s.aborted,
    content: s.content,
    checkpointSeq: s.checkpointSeq || 0,
    pendingConfirm: s.pendingConfirm ? { id: s.pendingConfirm.id, name: s.pendingConfirm.name, args: s.pendingConfirm.args } : null,
  };
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
  /** 心跳续约：本窗口持有 currentId 期间定时调，刷新 ts 证明自己还活着→别的窗口在 TTL 内认领不到。
   *  仅当本 owner 仍持有(或预留为空=已被回收则重新认领)时续；预留已被别的活窗口接管则返回 false(本窗口已失去)。 */
  renewThread(threadId, owner) {
    const s = sessions.get(threadId);
    if (!s) {
      return false;
    }
    const token = owner || "anon";
    if (!s.reservation) {
      s.reservation = { owner: token, ts: Date.now() };
      return true;
    }
    if (s.reservation.owner !== token) {
      return false;                             // 已被别的活窗口接管，不抢回
    }
    s.reservation.ts = Date.now();
    return true;
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
  /** 停止本回合（轮次边界 + 进行中的 LLM 请求都会停）。 */
  stop(threadId) {
    const s = sessions.get(threadId);
    if (s && s.abort) {
      try {
        s.abort.abort();
      } catch {
        /* ignore */
      }
    }
  },
  /**
   * 启动一轮自主执行（异步、即发即跑，不阻塞 UI）。引擎在本模块跑、跨面板重载存活。
   * @param {string} threadId
   * @param {object} p { systemPrompt, convo, confirmMode, maxRounds, maxPerTool, workspaceRoot, assist }
   *   workspaceRoot — 本轮绑定的工作目录绝对路径；注入到每条工具调用的 ctx，实现多窗口/多会话隔离。
   *   assist — true=AI辅助逐阶段模式：不跨回合自动续（每个 turn 结束即交回用户），且 AgentLoop 里
   *            无工具的纯文字回复当正常收尾（停下给方向）而非 drift 逼它继续。false=全自动一条龙（默认）。
   */
  async run(threadId, { systemPrompt, convo, confirmMode = false, maxRounds = 120, maxPerTool = 40, workspaceRoot, win, assist = false } = {}) {
    _runLog.push({ threadId, at: Date.now(), convoLen: Array.isArray(convo) ? convo.length : -1 });
    const s = getOrInit(threadId);
    if (s.running) {
      return; // 已在跑，避免重入
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
    if (s._notifyTimer) {
      _clearTimeout(s._notifyTimer);
      s._notifyTimer = null;
    }
    s._lastNotify = 0;
    const ac = new AbortController();
    s.abort = ac;
    notify(s);

    let vision = false;
    try {
      const client = buildClientFromStore(configStore);
      try {
        const pid = configStore.getActiveProvider && configStore.getActiveProvider();
        const model = pid && configStore.getModel && configStore.getModel(pid);
        vision = !!(isVisionModel && isVisionModel(model));
      } catch {
        /* 取不到当不支持视觉 */
      }
      // 全自动续跑（用户选定）：turn 因 maxRounds/漂移结束但任务没完成 → 自动起下一轮
      // （per-turn 的 maxRounds/maxPerTool/重复熔断计数随之全部重置——这正是 80轮上限/40次工具上限
      // 这类"莫名其妙停了、要手按继续"的根治），直到给出可独立实跑产物、或真需要用户（stopReason=final/
      // aborted），或安全网触发。免去用户反复手按"继续"。
      const NON_TERMINAL = new Set(["max_rounds", "drift"]);
      const MAX_AUTO_RESTARTS = 24; // 8→24：长逆向任务的天花板别太低（24×120≈2880 轮）。只作防无限空转的最终兜底，
      // 真正的空转由 A2 同参同结果熔断 + 连续失败护栏 + drift 拦；任务在做实事就让它一直跑。
      let turnMsgs = convo;
      let autoRestarts = 0;
      let driftStreak = 0;
      let res;
      for (;;) {
      res = await runAgentTurn({
        client,
        router: router(),
        messages: turnMsgs,
        systemPrompt,
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
        onDelta: c => {
          pushDelta(s, c);
          notifyThrottled(s); // 高频→节流(~20/s)
        },
        onReasoning: c => {
          pushReasoning(s, c);
          notifyThrottled(s); // 高频→节流
        },
        // 上下文压缩点：把本段进展作为一条 checkpoint 回复落盘 + 重置实时步骤 + 自增 seq，
        // UI 据 checkpointSeq 变化重载历史(新气泡)、清空 live 区，于是"一个长任务"在界面上
        // 表现为"多条阶段回复"，且每条都已持久化(任意后续步骤失败也不丢已完成进展)。
        onCheckpoint: async summary => {
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
            try {
              await getBackends().ledger.mergeHandoff(summary, { workspaceRoot, win: win || null });
            } catch {
              /* 自动沉淀失败不影响续跑 */
            }
          }
          s.steps = [];
          s._curText = -1;
          s._curThink = -1;
          s.content = "";
          s.checkpointSeq = (s.checkpointSeq || 0) + 1;
          notify(s);
        },
        onEvent: ev => {
          applyEvent(s, ev);
          notify(s); // 结构性事件→立即(snappy)
        },
        confirm: confirmMode
          ? call =>
              s.approveAll
                ? Promise.resolve(true) // 本轮已选"总是允许"→ 后续工具不再打断
                : new Promise(resolve => {
                    s.pendingConfirm = { id: call.id, name: call.name, args: call.args, resolve };
                    notify(s);
                  })
          : undefined,
      });
      const _reason = (res && res.stopReason) || "stop";
      // 真结束（final/aborted/error）或被手动停 → 跳出收尾，等用户。
      // AI辅助模式：每个 turn 结束都交回用户（不跨回合自动续）——阶段做完就停、等用户选方向。
      if (ac.signal.aborted || assist || !NON_TERMINAL.has(_reason)) {
        break;
      }
      // ── 任务未完成，进入自动续跑判定 ──
      // 安全网①：连续两轮"漂移"（只描述/分析、没产生实质工具动作）= 真卡住 → 停下报告，别"顺畅地"空转烧 token。
      driftStreak = _reason === "drift" ? driftStreak + 1 : 0;
      if (driftStreak >= 2) {
        res.content =
          (res.content ? res.content + "\n\n" : "") +
          "（已停下）连续两轮只在描述/分析、没有产生实质工具动作——多半卡住了。进展已落盘（progress.md/工作目录）。" +
          "说一句你的判断、或补个我拿不到的输入（登录态/样本/方向），我再继续。";
        break;
      }
      // 安全网②：自动续跑硬上限（防极端 runaway）。
      if (autoRestarts >= MAX_AUTO_RESTARTS) {
        res.content =
          (res.content ? res.content + "\n\n" : "") +
          `（已停下）已自动续跑 ${autoRestarts} 轮仍未给出可独立实跑的最终产物。进展已落盘。` +
          "回看上面进展，告诉我聚焦哪条路、或补个输入，我再继续。";
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
      // res.content 为空时（工具结尾轮/被截断轮）从 steps 的 text 段兜底，
      // 保证落盘的 assistant 消息一定带正文 → 下一轮历史里这轮不会是空白＝不失忆。
      s.content = res.content || textFromSteps(s.steps) || "";
      // 落盘最终消息（引擎自己存，UI 不在场也不丢）
      await this._persist(threadId, s.content, s.steps);
    } catch (e) {
      s.aborted = ac.signal.aborted;
      const note = s.aborted
        ? "（已手动停止）"
        : "（本轮出错中断：" + (e && (e.message || String(e)) || "").slice(0, 160) + "）";
      s.error = s.aborted ? null : (e && (e.message || String(e))) + (e && e.body ? "\n— " + String(e.body).slice(0, 600) : "");
      s.content = note;
      if (s.steps.length || s.aborted) {
        await this._persist(threadId, note, s.steps);
      }
    } finally {
      s.running = false;
      s.settled = true;
      s.abort = null;
      s.pendingConfirm = null;
      notify(s);
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

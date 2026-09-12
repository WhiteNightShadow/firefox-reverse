/* AgentSession.sys.mjs — 常驻后台对话引擎（解决"切侧栏面板重载→正在进行的回复丢失"）。
 *
 * 关键点：侧栏(revamp)切到别的工具再切回会**重载 panel.html**→content 文档销毁→
 * 跑在 content 里的 runAgentTurn 与流式 fetch 随之而亡。把引擎挪到**系统模块单例**(父进程，
 * 跨面板重载存活)：这里跑 runAgentTurn、把事件 reduce 成 canonical steps、广播给订阅者，
 * done/error 时**自己**把最终/中断消息落 ConversationStore。UI 变薄：mount 时若本线程仍在跑就
 * 恢复 steps+busy 并订阅续看；不在场也不影响——引擎照跑、结果照存。
 */
import { runAgentTurn } from "./AgentLoop.sys.mjs";
import {
  AgentRuntimeCore,
  slimifySteps,
  textFromSteps,
} from "./AgentRuntimeCore.sys.mjs";
import { configStore } from "./ConfigStore.sys.mjs";
import {
  buildProjectionInput,
  CONTEXT_PROJECTION_PROMPT,
  CONTEXT_PROJECTION_VERSION,
  planContextProjection,
} from "./ContextProjection.sys.mjs";
import { buildClientFromStore, isVisionModel } from "./providers.sys.mjs";
import { conversationStore } from "./ConversationStore.sys.mjs";
import { firefoxAgentRuntimeHost } from "./FirefoxAgentRuntimeHost.sys.mjs";
import { emptyUsage, mergeUsage, normalizeUsage } from "./Usage.sys.mjs";

const CANCELLED_TURN_BOUNDARY =
  "【手动取消边界】上一项任务已被用户明确手动取消。此前未完成事项只能作为历史背景，" +
  "不得自动恢复、补做或继续调用工具。请把最新一条用户消息视为新的独立请求；" +
  "只有当最新消息明确要求‘继续/恢复上一项任务’时，才可以接着执行被取消的任务。";
console.log("[AgentSession] zbb");
const _runLog = [];
export function getRunLog() {
  return _runLog.slice(-20);
}

const runtimeCore = new AgentRuntimeCore({
  ...firefoxAgentRuntimeHost.timers,
  createUsage: emptyUsage,
});
const router = () => firefoxAgentRuntimeHost.router();
const backends = () => firefoxAgentRuntimeHost.backends();
firefoxAgentRuntimeHost.onShutdown(() => runtimeCore.abortAll());

export const agentSession = {
  isRunning(threadId) {
    return runtimeCore.isRunning(threadId);
  },
  listRunning() {
    return runtimeCore.listRunning();
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
    return runtimeCore.acquireThread(candidateIds, owner);
  },
  renewThread(threadId, owner) {
    return runtimeCore.renewThread(threadId, owner);
  },
  releaseThread(threadId, owner) {
    runtimeCore.releaseThread(threadId, owner);
  },
  getState(threadId) {
    return runtimeCore.getState(threadId);
  },
  subscribe(threadId, callback) {
    return runtimeCore.subscribe(threadId, callback);
  },
  respondConfirm(threadId, id, approved, all) {
    return runtimeCore.respondConfirm(threadId, id, approved, all);
  },
  stop(threadId) {
    if (runtimeCore.abortThread(threadId)) {
      void conversationStore.setThreadTurnStatus(threadId, "cancelled").catch(() => {});
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
  async run(threadId, { systemPrompt, dynamicContext = "", convo, confirmMode = false, maxRounds = 120, maxPerTool = 40, workspaceRoot, win, assist = false } = {}) {
    _runLog.push({ threadId, at: Date.now(), convoLen: Array.isArray(convo) ? convo.length : -1 });
    const contextStrategy =
      configStore.getContextStrategy && configStore.getContextStrategy() === "legacy"
        ? "legacy"
        : "projected";
    const s = runtimeCore.beginRun(threadId, { usage: emptyUsage(), contextStrategy });
    if (!s) {
      return; // Already running; avoid re-entry.
    }
    const ac = firefoxAgentRuntimeHost.llmTransport.createAbortController();
    s.abort = ac;
    const runtimeBackends = backends();
    runtimeCore.notify(s);

    let vision = false;
    try {
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
      const client = buildClientFromStore(configStore, {
        transport: firefoxAgentRuntimeHost.llmTransport,
      });
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
        runtimeCore.notifyThrottled(s);
      };
      try {
        const active = configStore.getActiveModelProfile && configStore.getActiveModelProfile();
        const pid = (active && active.provider) || (configStore.getActiveProvider && configStore.getActiveProvider());
        const model = (active && active.model) || (pid && configStore.getModel && configStore.getModel(pid));
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
      let turnMsgs = Array.isArray(convo) ? convo : [];
      try {
        const thread = await conversationStore.getThread(threadId);
        if (thread && Array.isArray(thread.messages) && thread.messages.length) {
          const fullMessages = thread.messages.map(message => ({
            role: message.role,
            content: message.content,
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
                  cacheKey: cacheKey + ":projection",
                }
              );
              recordUsage(projected.usage, { phase: "projection" });
              const summary = String(projected.content || "").trim();
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
      let autoRestarts = 0;
      let driftStreak = 0;
      let res;
      for (;;) {
      res = await runAgentTurn({
        client,
        router: router(),
        messages: turnMsgs,
        systemPrompt,
        dynamicContext,
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
            return await runtimeBackends.ledger.digest({}, { workspaceRoot: workspaceRoot || null });
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
                const saved = await runtimeBackends.workspace.write(
                  { path, content },
                  { workspaceRoot, win: win || null }
                );
                return { path: saved?.path || path };
              }
            : null,
        onDelta: c => {
          runtimeCore.pushDelta(s, c);
          runtimeCore.notifyThrottled(s); // 高频→节流(~20/s)
        },
        onReasoning: c => {
          runtimeCore.pushReasoning(s, c);
          runtimeCore.notifyThrottled(s); // 高频→节流
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
              await runtimeBackends.workspace.write(
                { path: "progress.md", content: summary },
                { workspaceRoot }
              );
            } catch {
              /* 工作目录未设/写失败不影响续跑 */
            }
            // 自动捕获安全网：把交接摘要里的"已确认事实/已否决假设"沉淀进结构化账本（去重）——
            // 即便 Agent 没主动 remember，每次压缩也把确认结论累积进账本、不衰减。这是"把压缩能力沉淀下来"。
            try {
              await runtimeBackends.ledger.mergeHandoff(summary, { workspaceRoot, win: win || null });
            } catch {
              /* 自动沉淀失败不影响续跑 */
            }
          }
          s.steps = [];
          s._curText = -1;
          s._curThink = -1;
          s.content = "";
          s.checkpointSeq = (s.checkpointSeq || 0) + 1;
          runtimeCore.notify(s);
        },
        onEvent: ev => {
          runtimeCore.applyEvent(s, ev);
          runtimeCore.notify(s); // 结构性事件→立即(snappy)
        },
        confirm: confirmMode
          ? call =>
              s.approveAll
                ? Promise.resolve(true) // 本轮已选"总是允许"→ 后续工具不再打断
                : new Promise(resolve => {
                    s.pendingConfirm = { id: call.id, name: call.name, args: call.args, resolve };
                    runtimeCore.notify(s);
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
      runtimeCore.notify(s);
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
      s.aborted = ac.signal.aborted || (res && res.stopReason === "aborted");
      // res.content 为空时（工具结尾轮/被截断轮）从 steps 的 text 段兜底，
      // 保证落盘的 assistant 消息一定带正文 → 下一轮历史里这轮不会是空白＝不失忆。
      s.content = res.content || textFromSteps(s.steps) || "";
      // 落盘最终消息（引擎自己存，UI 不在场也不丢）
      await this._persist(threadId, s.content, s.steps);
      try {
        await conversationStore.setThreadTurnStatus(threadId, s.aborted ? "cancelled" : "completed");
      } catch {
        /* 状态元数据失败不影响已完成结果 */
      }
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
      try {
        await conversationStore.setThreadTurnStatus(threadId, s.aborted ? "cancelled" : "failed");
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
      runtimeCore.settle(s);
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

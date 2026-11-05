/* AgentLoop.sys.mjs — Agent 的 tool_use 循环（脊梁，Phase N0）。
 *
 * 把 LlmClient（聊天）与 ToolRouter（工具）编织起来：
 *   LLM 返回 tool_calls → 逐个 ToolRouter.dispatch → 结果回灌 → 再问 LLM，
 *   直到 LLM 不再要工具或达到 maxRounds。OpenAI 协议（DeepSeek V4 已支持 function calling）。
 *
 * 零 Firefox 依赖：client / router 注入，可 Node 自测。
 */

// 单条工具结果回灌进对话上下文的字符上限。超出只截头部+提示分段读，避免长会话上下文无界膨胀→TTFT 超时。
const TOOL_RESULT_CAP = 6000;

// 单轮 Agent 内对话上下文(msgs)总字符上限。长会话(几十轮)里 msgs 每轮都追加(assistant+reasoning_content+tool结果)
// 且每轮整份重发——上下文越大，上游推理模型生成越慢；中转站常**缓冲整段上游响应**才回响应头 →
// 大上下文(120K≈35K token)下生成可能 >300s → fetch 等不到响应头 → "300s 无响应"超时卡死(用户反复踩到)。
// 上限 140K(≈39K token)：对 64K 窗模型(DeepSeek 等)安全、留足系统/工具/回复余量；trim 仍保
// system + 首条 user 任务锚点 + 最近若干轮，老轮次细节让模型 fs_read 落盘文件回看。
// （原 80K 偏低：自检这类短任务因大工具结果中途触发压缩→模型重锚定原始任务→重跑，故上调。）
const MAX_CONTEXT_CHARS = 140000;

// 自主回合内**上下文压缩阈值**（< MAX_CONTEXT_CHARS，主动压缩先于被动 trim）。工作上下文一旦超过它，
// 就把本回合至今的进展机械总结成一条 checkpoint（可见回复+落盘），再用 [system+任务+checkpoint+继续提示]
// 这个小上下文续跑。这样：①每次请求都小而快(基本根治"大上下文→上游>300s→连响应头都等不到"的卡死)；
// ②进度拆成多条可见回复；③任意一步失败/超时，最近 checkpoint 已落盘，重发即从那里续。
const COMPACT_AT = 100000;
// 压缩后两次之间至少跑这么多轮，避免阈值附近抖动反复压缩。
const COMPACT_MIN_ROUNDS = 2;
// 模型连续返回"纯文字、不调工具"的最多自动续跑次数。超过就当它真的停了（防纯文字死循环空转）。
const MAX_AUTO_CONTINUE = 3;

// ★按模型上下文窗口缩放「压缩阈值 / trim 上限 / 单结果截断」——这是「同模型在 Claude Code 丝滑、
// 在本 Agent 毛病多」的主因：强模型(大窗口)被按小窗口(64k)的保守值过早压缩 + 狠截工具结果 →
// 反复丢状态、重读重搜 = 空转。仅靠模型名启发式分档（判不准就落默认档，绝不超窗）。
// 自定义端点跑 Opus 时模型名含 "opus" → XL 档。
function modelBudget(model) {
  const m = String(model || "").toLowerCase();
  // XL：百万级上下文 —— opus / gemini-1.5,2 / **deepseek-v4 全系（官方 API 默认即 1M）** / 任何带 1m 标记的模型。
  // （[1m] 这类标记仍兜底识别；LlmClient 发请求时会把标记剥掉，API 收到的是纯净模型名。）
  if (/opus|gemini-(1\.5|2|exp)|deepseek-v[4-9]|(\[|[-_/])1m(\]|[-_/]|$)|1000k|1000000/.test(m)) {
    return { compactAt: 800000, maxChars: 1000000, resultCap: 150000 };
  }
  // 默认 ~200k 上下文（claude / glm·智谱 / 不带标记的 deepseek / gpt / 未知）——比原 14万 大幅放开、
  // 但留足余量不超窗。若你只用 ≥200k 的模型、想更激进，把这里也调成 1M 档即可
  //（默认保守到 200k，是因为"未知模型"可能是小窗口、发太多会硬报错）。
  return { compactAt: 250000, maxChars: 320000, resultCap: 50000 };
}

// 【输出被长度限制截断】的专用重试上限——**与 autoContinue/drift 完全解耦**。
// 思考型模型(DeepSeek reasoner 等)的 reasoning_content 不受 prompt 约束、长度无界：难题轮里
// reasoning 可能吃满 max_tokens，还没产出 content/tool_call 就被切(finish_reason=length，只剩"<"之类零碎)。
// 这**不是**"模型漂走不动手"(drift)，而是"该少想多做"——若把它当 autoContinue 累计，3 次就误判 drift、
// 外层再两轮 drift 就"已停下"→ 用户看到的"DeepSeek 跑一会突然截断然后会话停了"。故截断走独立计数、不污染 drift。
const MAX_TRUNC_RETRIES = 6;
// 回灌给下一轮的 reasoning_content 上限：思考型模型每轮 reasoning 可达数千字，整段回灌会撑爆 80K 上下文
// → trimContext 把真正的工具结果挤掉 → 模型丢状态、反复重读重跑(兜圈子)。只留尾部(结论/"所以我要调用X"常在尾部)，
// 既满足"必须带 reasoning_content 字段"的中转，又不让它吃上下文。(Anthropic/Opus 不回灌这段，故无此问题。)
const REASONING_FEEDBACK_CAP = 1200;

// A2 重复熔断豁免由工具声明里的 repeatExempt 特性决定（Tools.sys.mjs）：这些工具"同参重复"是正当的——
// 每次都有真实副作用或推进世界状态，不是空转。page_scroll 滚动加载新内容、page_navigate 重载、
// trace start/stop/clear 开关、page_eval 触发请求/取不同时刻的值、page_click 交互。误把它们当空转拦掉，
// 会逼模型绕路（实测踩到）。真正该熔断的是**纯只读查询**（jsvmp_query/net_list/fs_list/code_search…）反复拿同一结果。

/** 32 位 FNV-1a，返回 8 位十六进制。用于工具结果摘要和「完全相同的参数」判定，不做安全用途。 */
function _hash(text) {
  const s = String(text);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** 键按字母序的 JSON：模型给参数时键的先后不固定，同样的参数要得到同一个串。 */
function _stableJson(value) {
  if (Array.isArray(value)) {
    return "[" + value.map(_stableJson).join(",") + "]";
  }
  if (value && typeof value === "object") {
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(k => JSON.stringify(k) + ":" + _stableJson(value[k]))
        .join(",") +
      "}"
    );
  }
  const s = JSON.stringify(value);
  return s === undefined ? "null" : s;
}

/** 超长文本留头和尾、中间标出省略了多少。headShare 是头部占比；最新进展通常在尾部，所以多数调用给尾部更多。
 *  asHeading：省略标记写成 markdown 标题。存档里按标题分节的内容被截开后，尾部不能再算进截断前的那一节。 */
function _clip(text, max, headShare = 0.3, asHeading = false) {
  const s = String(text || "");
  if (s.length <= max) {
    return s;
  }
  const marker = `\n${asHeading ? "## " : ""}…（中间省略约 ${s.length - max} 字）…\n`;
  const room = Math.max(0, max - marker.length);
  const head = Math.floor(room * headShare);
  return s.slice(0, head) + marker + s.slice(s.length - (room - head));
}

/** 给人看的一次调用：工具名 + 截短的参数，用在重复提示和循环提示里。 */
function _callLabel(name, args) {
  let a = "";
  try {
    a = JSON.stringify(args || {});
  } catch {
    a = String(args);
  }
  return `${name} ${a.length > 80 ? a.slice(0, 80) + "…" : a}`;
}

// 循环检测（跨压缩、跨自动续跑）：最近 LOOP_WINDOW 次计入的工具调用里，有 LOOP_REPEATS 次以上是
// 「之前用完全相同的参数做过、结果也完全相同」的调用，就当作在从头重做已完成的分析。第一次注入提醒；
// 提醒后的下一个窗口仍是这样就停下本轮，交给用户（不再自动续跑）。窗口里重复不超过 LOOP_RECOVERED 次算已恢复。
const LOOP_WINDOW = 12;
const LOOP_REPEATS = 8;
const LOOP_RECOVERED = 3;
// 记住的调用条数上限（按最近使用淘汰），只放摘要和计数，不放结果本身。
const LOOP_CALLS_CAP = 600;

/**
 * 一次自主执行（含自动续跑的多个回合）共用的状态。AgentSession 每次 run 建一个，传给每个 runAgentTurn；
 * 不传时 runAgentTurn 自己建一个，只在本回合内有效。
 */
export function createRunState() {
  return {
    calls: new Map(), // 工具名+参数摘要 → { fp, count, lastSeq, epoch }
    seq: 0, // 计入循环检测的工具调用序号（跨回合累加）
    epoch: 0, // 上下文压缩次数：用来告诉模型「这次调用在上次压缩之前就做过」
    window: [], // 最近计入的调用：{ name, label, repeat }
    level: 0, // 0=正常，1=已提醒过
    lastCheckpoint: "", // 最近一份进展存档，下次压缩时并进交接账本，交接账本没生成出来时也带上
    anchor: null, // 任务锚点（msgs 里的那个消息对象）：自动续跑的回合靠它认出用户发的任务，不把引擎加的续跑提示当任务
    userNotes: [], // 锚点之前的用户消息原文，压缩后附在续跑说明里
  };
}

function _isRunState(state) {
  return (
    !!state &&
    typeof state === "object" &&
    !!state.calls &&
    typeof state.calls.get === "function" &&
    Array.isArray(state.window) &&
    Array.isArray(state.userNotes)
  );
}

/** 记一次计入循环检测的调用。和之前参数完全相同、结果也完全相同时返回 { count, ago, beforeCompaction }，否则 null。
 *  blocked=被 A2 拒绝执行（没有结果），直接算一次重复。 */
function _trackCall(run, name, args, fp, blocked) {
  run.seq++;
  const label = _callLabel(name, args);
  let repeat = null;
  if (blocked) {
    run.window.push({ name, label, repeat: true });
  } else {
    let argsText;
    try {
      argsText = _stableJson(args || {});
    } catch {
      argsText = String(args);
    }
    const key = name + "|" + argsText.length + ":" + _hash(argsText);
    const seen = run.calls.get(key);
    run.calls.delete(key); // 删了再放回去 = 移到最近使用的一端
    if (seen && seen.fp === fp) {
      repeat = { count: seen.count, ago: run.seq - seen.lastSeq, beforeCompaction: seen.epoch < run.epoch };
      seen.count++;
      seen.lastSeq = run.seq;
      run.calls.set(key, seen);
    } else {
      run.calls.set(key, { fp, count: 1, lastSeq: run.seq, epoch: run.epoch });
      if (run.calls.size > LOOP_CALLS_CAP) {
        run.calls.delete(run.calls.keys().next().value);
      }
    }
    run.window.push({ name, label, repeat: !!repeat });
  }
  if (run.window.length > LOOP_WINDOW) {
    run.window.splice(0, run.window.length - LOOP_WINDOW);
  }
  return repeat;
}

/** 窗口满了才判断。返回 { action: "warn"|"stop", repeats, examples, tools } 或 null。
 *  examples 带参数，只给模型看；tools 只有工具名，写进给用户看的停止说明。 */
function _loopVerdict(run) {
  if (run.window.length < LOOP_WINDOW) {
    return null;
  }
  const repeated = run.window.filter(x => x.repeat);
  if (repeated.length >= LOOP_REPEATS) {
    const verdict = {
      action: run.level >= 1 ? "stop" : "warn",
      repeats: repeated.length,
      examples: [...new Set(repeated.map(x => x.label))].slice(0, 6),
      tools: [...new Set(repeated.map(x => x.name))].slice(0, 4),
    };
    run.level = verdict.action === "warn" ? 1 : 0;
    run.window = [];
    return verdict;
  }
  if (run.level >= 1 && repeated.length <= LOOP_RECOVERED) {
    run.level = 0; // 提醒之后恢复了正常推进
  }
  return null;
}

// 压缩后放在进展存档后面的续跑说明。也用它在对话里找上一次压缩的位置（自动续跑后的回合里是上一回合留下的），
// 所以正文固定，要附加的内容只往后接。
const COMPACT_NOTE =
  "（上面是你已完成的【进展存档】——已确认的事实 / 已做过的工具调用及结果 / 下一步都在里面，也已落盘 progress.md。" +
  "**铁律：存档里已经做过的事一律不要重做——别重新调用任何已调用过的工具、别重测已测过的项、别重新 list/搜索/抓包去发现已确认的信息。" +
  "若任务是清单且某些项已在存档里有结果，直接拿那些结果继续或汇总，绝不重跑。**" +
  "只在需要某个具体旧细节时才 fs_read 对应文件。现在只做存档里「下一步」指向的、尚未完成的动作。）";

// 压缩后保留的用户原话：每条和总量的上限（字符）。
const USER_NOTE_CHARS = 1500;
const USER_NOTES_CHARS = 6000;
const USER_NOTES_LABEL = "【用户此前的消息（原话，按时间先后；最新的一条是最上面的任务消息，有冲突以最新的为准）】";

function textOfContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter(b => b && b.type === "text" && typeof b.text === "string")
      .map(b => b.text)
      .join("\n");
  }
  return "";
}

/** 把锚点之前的用户消息原文记进 run.userNotes（去重、每条限长）。引擎自己加的提醒和续跑说明不算用户的话。
 *  锚点是「继续」这类短消息时，真正的任务和中途给的限制条件都在这些消息里，压缩后不能只剩一句「继续」。 */
function collectUserNotes(run, earlier) {
  for (const m of earlier || []) {
    if (!m || m.role !== "user") continue;
    const text = textOfContent(m.content).trim();
    if (!text || text.startsWith("（系统") || text.startsWith(COMPACT_NOTE)) continue;
    const note = _clip(text, USER_NOTE_CHARS, 0.7);
    if (!run.userNotes.includes(note)) {
      run.userNotes.push(note);
    }
  }
}

/** 编号列出用户消息；超出总量时留第一条和最新的几条，中间标出略了几条。 */
function formatUserNotes(notes, maxChars = USER_NOTES_CHARS) {
  if (!notes.length) {
    return "";
  }
  const picked = notes.map((_, i) => i === 0);
  let used = notes[0].length;
  for (let i = notes.length - 1; i > 0 && used + notes[i].length <= maxChars; i--) {
    picked[i] = true;
    used += notes[i].length;
  }
  const lines = [];
  let skipped = 0;
  notes.forEach((note, i) => {
    if (!picked[i]) {
      skipped++;
      return;
    }
    if (skipped) {
      lines.push(`…（中间 ${skipped} 条略）…`);
      skipped = 0;
    }
    lines.push(`${i + 1}. ${note}`);
  });
  return lines.join("\n");
}

/** 把一段消息拍平成纯文本（避免把 tool_calls/tool 消息原样喂给无 tools 的摘要调用引发协议问题）。 */
function transcriptOf(list) {
  const lines = [];
  for (const m of list || []) {
    if (!m) continue;
    if (m.role === "assistant") {
      if (m.content && String(m.content).trim()) lines.push("[助手] " + String(m.content).trim());
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const n = tc && tc.function && tc.function.name;
          const a = tc && tc.function && tc.function.arguments;
          if (n) lines.push("[调用] " + n + (a ? " " + String(a).slice(0, 160) : ""));
        }
      }
    } else if (m.role === "tool") {
      lines.push("[结果] " + String(m.content == null ? "" : m.content).slice(0, 700));
    } else if (m.role === "user") {
      lines.push("[用户] " + textOfContent(m.content));
    }
  }
  return lines.join("\n");
}

/** 去掉存档里「当前阶段 + 下一步」那一节（交接账本骨架的最后一节）：那是当时的下一步，原样带进新存档
 *  会让模型去重做之后已经做完的事。只认以「当前阶段」或「下一步」开头的标题，别的标题里提到这个词不算。 */
function _withoutNextStep(text) {
  const kept = [];
  let skipping = false;
  for (const line of String(text || "").split("\n")) {
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      skipping = /^(当前阶段|下一步)/.test(heading[1].trim());
    }
    if (!skipping) {
      kept.push(line);
    }
  }
  return kept.join("\n").trim();
}

/** 机械构建进展存档（零额外 LLM 调用、确定性、有界）：工具账本 + 最近的文字叙述 + 最近一步结果摘要。
 *  fromIdx 后扫描——把模型自己的"做了什么/下一步"叙述 + 工具调用清单折成一段，老的原始 trace/输出
 *  留在工作目录文件里（要细节 fs_read）。压缩后续跑只带这段，不带原始大堆历史。
 *  previous 是上一份存档，earlier 是任务锚点之前的对话：交接账本没生成出来时要带上，否则之前确认过的结论
 *  会在这次压缩里全部丢掉。各节用 markdown 标题分开——账本的自动沉淀（LedgerBackend.mergeHandoff）按标题
 *  认「已确认事实 / 已否决假设」两节，机械记录里的叙述不能被算进上一节。 */
function buildCheckpointSummary(msgs, fromIdx, { previous = "", earlier = [] } = {}) {
  const narration = [];
  const toolCounts = {};
  let lastToolResult = "";
  for (let i = Math.max(0, fromIdx); i < msgs.length; i++) {
    const m = msgs[i];
    if (!m) continue;
    if (m.role === "assistant") {
      if (m.content && String(m.content).trim()) narration.push(String(m.content).trim());
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const n = tc && tc.function && tc.function.name;
          if (n) toolCounts[n] = (toolCounts[n] || 0) + 1;
        }
      }
    } else if (m.role === "tool") {
      lastToolResult = typeof m.content === "string" ? m.content : "";
    }
  }
  const ledger = _clip(
    Object.entries(toolCounts)
      .map(([n, c]) => (c > 1 ? `${n}×${c}` : n))
      .join("、") || "（无）",
    800,
    1
  );
  // 最近的叙述在尾部，截断时保尾。
  const recent = _clip(narration.slice(-4).join("\n"), 2600, 0.2) || "（暂无文字记录）";
  const tail = lastToolResult ? `\n\n最近一步工具结果(截断)：${lastToolResult.slice(0, 500)}` : "";
  const sections = [];
  const carried = _withoutNextStep(previous);
  if (carried) {
    sections.push(
      "## 之前的存档（当时记下的结论仍然有效；接下来做什么，以下面的最近进展为准）\n" + _clip(carried, 6000, 0.7, true)
    );
  }
  const before = transcriptOf(earlier).trim();
  if (before) {
    sections.push("## 此前对话的结尾（节选）\n" + _clip(before, 3000, 0.1, true));
  }
  sections.push(`## 这一段的机械记录\n已调用工具：${ledger}\n\n进展记录：\n${recent}${tail}`);
  return (
    "【进展存档·自动压缩】\n" +
    sections.join("\n\n") +
    "\n\n（以上为已压缩的早前过程；完整 trace/脚本/产物都在工作目录文件里，需要细节用 fs_read 读对应文件。）"
  );
}

// LLM 交接摘要的系统提示：要的是"让全新无记忆的自己能直接接手"，所以必须写死**已确认事实**，
// 而不是流水账——这是压缩不失忆的关键（机械摘要做不到，会丢结论导致重新发现）。
const HANDOFF_PROMPT = `你在为"上下文压缩"写 **Findings Ledger（交接账本）**：把目前进展浓缩成结构化账本，交给一个**全新、无上文记忆**的你继续。
目标：接手者**无需重新探索**就能续上——别让它重新 list 目录/搜代码/试探已确认过的东西，更别重试已否决的死路。严格按以下骨架（有则写、无则省略该节）：
## 目标定义
- 站点/接口/目标参数；目标参数的**逐字节真实样本**（取自真实请求）+ 对应输入(url/method/body)；已识别的易变字段位置(时间戳/nonce)
## 已确认事实（最重要——逐条写死、带证据，避免接手者重复发现）
- 每条格式：<事实> | 证据:<工具+关键返回片段> | 置信:高/中/低
- 涵盖：已定位的入口/函数/参数/脚本(文件名+函数名+调用方式+参数格式)、已验证的算法/数据特征、关键运行时值(签名样本/参数结构/init 配置/cookie/token 等可复用具体值)
## 已否决假设（永不重试——关键！防止接手者重走死路）
- 每条：<错误假设/试过的方向> → 否决理由(证据)
## 工作目录文件
- 路径 — 是什么 + 已分析到什么程度
## 当前阶段 + 下一步
- 阶段(P0侦察/P1定位/P2验证锁定/P3判型/P4选策略/P5补环境/P6验证) + 该阶段退出标准
- 下一步：**单条、具体、直接指向当前退出标准**（具体到工具名+参数）
输入里可能有【上一份进展存档】和【本轮之前的对话】：其中的已确认事实、已否决假设只要仍然成立，就要原样并进新账本，别因为最新记录里没再提到就丢掉；目标定义要保留【用户的消息】里的要求和限制条件。「当前阶段 + 下一步」以执行记录**最后**的部分为准，那是最新进展。
只输出这份账本本身，不要调用工具、不要寒暄、不要复述本提示。`;

// 交接摘要输入的各段上限（字符）。执行记录保尾：最新进展和真正的「下一步」都在最后。
const HANDOFF_SEGMENT_CHARS = 60000;
const HANDOFF_EARLIER_CHARS = 24000;
const HANDOFF_PREVIOUS_CHARS = 16000;
const HANDOFF_MAX_TOKENS = 4096;
// 交接摘要被长度截断时，至少有这么长才拿来用（再补一段机械记录）；更短的当没生成出来。
const HANDOFF_PARTIAL_MIN = 400;

/**
 * 交接摘要的输入：用户的消息原文 + 任务锚点之前的对话（历史投影、前几轮的结论）+ 上一份存档 + 之后的执行记录。
 * 以前只取锚点之后执行记录的前 6 万字：记录一长，最新的那部分（真正的「下一步」）就没给摘要模型看；
 * 锚点之前的内容和上一份存档也不在输入里，压缩后接手的模型只好从头再来。
 */
function buildHandoffSource({ userNotes = [], task = "", earlier = [], previous = "", segment = [] }) {
  const parts = [];
  const said = userNotes.slice();
  const request = _clip(String(task || "").trim(), USER_NOTE_CHARS * 2, 0.7);
  if (request) {
    said.push(request);
  }
  if (said.length) {
    parts.push(
      "【用户的消息（原话，按时间先后；最后一条是当前任务）】\n" + formatUserNotes(said, USER_NOTES_CHARS + request.length)
    );
  }
  const before = transcriptOf(earlier);
  if (before.trim()) {
    parts.push("【本轮之前的对话（节选）】\n" + _clip(before, HANDOFF_EARLIER_CHARS, 0.5));
  }
  if (String(previous || "").trim()) {
    parts.push("【上一份进展存档】\n" + _clip(String(previous).trim(), HANDOFF_PREVIOUS_CHARS, 0.7));
  }
  const after = transcriptOf(segment);
  if (after.trim()) {
    parts.push("【之后的执行记录（最新的在最后）】\n" + _clip(after, HANDOFF_SEGMENT_CHARS, 0.25));
  }
  return parts.join("\n\n");
}

/** 让模型把执行记录浓缩成结构化交接摘要（单次 chat、无 tools、输出短）。返回 { text, truncated }。 */
async function summarizeForHandoff(client, source, signal, onUsage, cacheKey) {
  if (!source) {
    return { text: "", truncated: false };
  }
  const res = await client.chat(
    [
      { role: "system", content: HANDOFF_PROMPT },
      { role: "user", content: "以下是迄今的执行记录，据此输出交接账本：\n\n" + source },
    ],
    // auxiliary：少思考、给输出留足余量（推理模型的思考 token 也算在 maxTokens 里）。
    { signal, maxTokens: HANDOFF_MAX_TOKENS, auxiliary: true, cacheKey: cacheKey ? cacheKey + ":handoff" : "" }
  );
  try {
    onUsage && onUsage(res.usage, { phase: "handoff" });
  } catch {
    /* usage reporting never blocks the Agent */
  }
  return {
    text: (res && res.content ? String(res.content) : "").trim(),
    truncated: !!res && (res.finishReason === "length" || res.finishReason === "max_tokens"),
  };
}

// 反绕圈：同一(工具+错误签名)累计到这个次数 → 在结果里注入"换路线"提示。
const SAME_ERR_PIVOT_AT = 3;
// 连续失败(任意类型，不限同类)到这个次数 → 提示别再用同套方式空转重复（换思路/换工具/核对前提；
// 确有不同且有把握的下一步仍可继续用工具，不硬停）。抓"各种错连环出现=空转/退化"，
// 是 SAME_ERR_PIVOT_AT 抓不到的另一种空转：空参数调用/截断/超限轮番出现）。
const CONSEC_ERR_AT = 6;

// 取字符串里**第一个配平的顶层 {…}**（正确跳过字符串/转义）。模型偶尔在合法 JSON 后附加多余
// 文字/第二个对象 → JSON.parse 报 "unexpected non-whitespace character after JSON data"；
// 提取首个对象即可丢弃尾部噪声。
function _extractFirstJsonObject(s) {
  const start = s.indexOf("{");
  if (start < 0) {
    return null;
  }
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (c === "\\") {
      esc = true;
      continue;
    }
    if (c === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) {
      continue;
    }
    if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        return s.slice(start, i + 1);
      }
    }
  }
  return null;
}

// 容错解析工具参数 JSON：先直接 parse；失败则剥 ```json 围栏、再取首个配平对象。仍失败抛原错。
function parseToolArgs(raw) {
  if (raw == null || raw === "") {
    return {};
  }
  const s = String(raw);
  try {
    return JSON.parse(s);
  } catch (e) {
    const fenced = s.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
    if (fenced !== s) {
      try {
        return JSON.parse(fenced);
      } catch {
        /* 继续兜底 */
      }
    }
    const obj = _extractFirstJsonObject(fenced);
    if (obj !== null && obj !== fenced) {
      try {
        return JSON.parse(obj);
      } catch {
        /* 落到抛原错 */
      }
    }
    throw e;
  }
}
// A2 重复调用熔断用：给一次调用算"调用签名"= 工具名 + 归一化参数（数字/hex/引号内容/空白归一，
// 使"同一意图、参数无实质变化"的反复调用得同签名）。
function _callSig(name, args) {
  let s = "";
  try {
    s = JSON.stringify(args || {});
  } catch {
    s = String(args);
  }
  const norm = s
    .toLowerCase()
    .replace(/0x[0-9a-f]+/g, "#")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, "")
    .slice(0, 200);
  return name + "|" + norm;
}
/** 工具的返回值：ToolRouter 把它放在信封的 data 里（{ ok:true, data }）。只取对象形式的。 */
function _payload(env) {
  const data = env && env.data;
  return data && typeof data === "object" && !Array.isArray(data) ? data : null;
}

/** 这次工具调用是否失败：抛错（信封 ok:false），或工具没抛错但返回了 { ok:false, … }——脚本退出码非 0、
 *  要找的请求不存在、页面拿不到等，很多工具是这样报失败的。两种都要算，否则下面几道护栏对它们不起作用。 */
function _failed(env) {
  if (!env || env.ok === false) {
    return true;
  }
  const payload = _payload(env);
  return !!payload && payload.ok === false;
}

// A2 和循环检测共用的"结果指纹"，用于判断"重复调用是否带来了新信息"。
// 成功：结果正文（ToolRouter 信封里的 data）的长度+摘要，内容完全一样才算同一结果；
// 失败：归一化的错误文本，同一类错算同一结果。
// （旧版只看信封顶层的 count/requests 等字段，可工具返回值都在 data 里，成功调用的指纹全是 "ok"：
//   分页 fs_read 这种每次内容都不一样的调用也被当成"结果相同"，连续 10 次就被熔断。）
function _resultFp(env) {
  if (!env || typeof env !== "object") {
    return "v:" + _hash(String(env));
  }
  if (env.ok === false) {
    return "err:" + String(env.error || env.note || "").toLowerCase().replace(/\d+/g, "#").slice(0, 80);
  }
  let body = "";
  try {
    body = JSON.stringify(env.data !== undefined ? env.data : env) || "";
  } catch {
    body = String(env.data);
  }
  return "ok:" + body.length + ":" + _hash(body);
}

// A1 无进展预算用：判定一次工具调用是否构成"真实前进"（机械、不靠模型自述）。
// 真前进 = 产生了新的、有价值的状态变化：成功落盘脚本/文件、抓到带调用栈的请求、wasm_probe 出 calls、
// trace 有非空记录、写了产物文件等。纯查询(失败/count=0/列表没变)不算前进；"列表没变"由调用方按
// 重复调用判定（和之前完全相同的调用拿到完全相同的结果）。
function _isProgress(name, env, progressOnSuccess = false) {
  if (_failed(env)) {
    return false;
  }
  // 写盘/落盘类工具成功 = 前进（工具声明里标了 progress）
  if (progressOnSuccess) {
    return true;
  }
  // 工具返回值在 ToolRouter 信封的 data 里；自测里的简化信封直接放在顶层：两处都看。
  const data = env.data;
  const nested = _payload(env);
  const field = key => (env[key] !== undefined ? env[key] : nested ? nested[key] : undefined);
  // run_node/run_python：**只有脚本真的跑成功**才算前进。"进程跑起来了"(env.ok)≠"脚本逻辑成功"——
  // 很多脚本 catch 后照样 exit 0 却打印报错/"对不上"，那是在死胡同里换脚本兜圈子、不是前进。
  // 实测教训：WASM 复刻兔子洞里 100+ 次 run_node 每次跑个坏 loader 全被当"前进"→ A1 无进展预算永远清零、
  // 永不触发换路线提示。故要求 exitCode===0 且合并输出里**没有异常签名**。
  if (/^run_(node|python)$/.test(name)) {
    if (field("exitCode") !== 0 || field("timedOut")) {
      return false;
    }
    const out = String(field("output") || "");
    const looksFailed =
      /Error:|Exception\b|Traceback|is not defined|is not a function|Cannot (read|find)|\babort(ed)?\b|ReferenceError|TypeError|SyntaxError|RangeError|ERR_[A-Z]|MODULE_NOT_FOUND|ENOENT|Unhandled|panicked|❌|不匹配|对不上|复刻失败|验证失败/i.test(
        out
      );
    return !looksFailed;
  }
  // net_get 拿到带发起者栈的请求 = 关键前进
  const request = field("request");
  if (name === "net_get" && request && Array.isArray(request.initiatorStack) && request.initiatorStack.length) {
    return true;
  }
  // wasm_probe 抓到 wbg 调用 / webapi_query 有指纹 / 抓到非空列表 = 前进
  if (Array.isArray(data) && data.length) return true;
  const calls = field("calls");
  if (Array.isArray(calls) && calls.length) return true;
  const count = field("count");
  if (typeof count === "number" && count > 0) return true;
  for (const k of ["requests", "hits", "entries", "records", "exports", "functions"]) {
    const list = field(k);
    if (Array.isArray(list) && list.length > 0) return true;
  }
  return false;
}

// 给失败的工具结果算一个"错误类别签名"：归一掉数字/hex/引号内容/路径 → 同类错误得同签名。
// 失败判定见 _failed；错误文本取信封的 error，或工具返回值里的 error / 合并输出（run_node/python）/ log / note。
function _errSig(name, env) {
  if (!env || !_failed(env)) {
    return null;
  }
  const payload = _payload(env) || {};
  const raw = String(env.error || env.output || payload.error || payload.output || payload.log || payload.note || "");
  if (!raw) {
    return null;
  }
  // 取"错误消息行"作签名，**跳过栈帧(at ...:line:col)**——栈位置每次不同，会让同类错误得不同签名。
  const lines = raw.split("\n").map(s => s.trim()).filter(Boolean);
  let msg = "";
  for (const ln of lines) {
    if (/^at\s/i.test(ln)) {
      continue;
    }
    if (/(error|cannot|undefined|is not|not a function|not defined|failed|拒绝|失败|找不到|超过|不可用)/i.test(ln)) {
      msg = ln;
      break;
    }
  }
  if (!msg) {
    msg = lines.find(l => !/^at\s/i.test(l)) || lines[0] || "";
  }
  // 归一掉数字/hex/引号内容/路径 → 同类错误同签名（如不同 reading 'x'/'y' → 同签名）。
  const norm = msg
    .toLowerCase()
    .replace(/0x[0-9a-f]+/g, "")
    .replace(/['"`][^'"`]*['"`]/g, "")
    .replace(/[/\\][^\s)]+/g, "")
    .replace(/[0-9]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return norm ? name + "|" + norm : null;
}

function _msgSize(m) {
  let n = 0;
  if (m.content != null) {
    n += typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length;
  }
  if (m.reasoning_content) {
    n += String(m.reasoning_content).length;
  }
  if (m.tool_calls) {
    n += JSON.stringify(m.tool_calls).length;
  }
  if (m.responses_output) {
    n += JSON.stringify(m.responses_output).length;
  }
  if (m.gemini_content) {
    n += JSON.stringify(m.gemini_content).length;
  }
  if (m.tool_call_id) {
    n += 64;
  }
  return n;
}

const RUNTIME_CONTEXT_START = "⟪FRX_RUNTIME_CONTEXT_START⟫";
const RUNTIME_CONTEXT_END = "⟪FRX_RUNTIME_CONTEXT_END⟫";

function _stripRuntimeContext(content) {
  if (typeof content !== "string" || !content.includes(RUNTIME_CONTEXT_START)) {
    return content;
  }
  let out = content;
  for (;;) {
    const start = out.indexOf(RUNTIME_CONTEXT_START);
    if (start < 0) break;
    const end = out.indexOf(RUNTIME_CONTEXT_END, start);
    out = end < 0
      ? out.slice(0, start).trimEnd()
      : (out.slice(0, start) + out.slice(end + RUNTIME_CONTEXT_END.length)).trim();
  }
  return out;
}

function _runtimeContext(dynamicContext, ledgerText) {
  const parts = [];
  if (dynamicContext && String(dynamicContext).trim()) {
    parts.push(String(dynamicContext).trim());
  }
  if (ledgerText && String(ledgerText).trim()) {
    parts.push(String(ledgerText).trim());
  }
  return parts.length
    ? `${RUNTIME_CONTEXT_START}\n【本轮动态上下文】\n${parts.join("\n\n")}\n${RUNTIME_CONTEXT_END}`
    : "";
}

function _withRuntimeContext(message, block) {
  if (!message || !block) {
    return message;
  }
  if (Array.isArray(message.content)) {
    return {
      ...message,
      content: [...message.content, { type: "text", text: "\n\n" + block }],
    };
  }
  return {
    ...message,
    content: String(message.content || "") + "\n\n" + block,
  };
}

/**
 * 把要发给模型的消息数组裁到上下文预算内（只用于 LLM 请求；loop 自身仍保留完整 msgs 用于返回/落盘）。
 * 规则：固定保留 system(首条) + 第一条 user(原始任务)；从尾部往前尽量多保留最近轮次；
 * 切片不能以"孤儿 tool"(其 assistant 已被裁)开头——会让 OpenAI 协议报错，故往后挪过开头的 tool；
 * 中间被裁处插一条省略提示。未超预算则原样返回。
 */
function trimContext(msgs, maxChars = MAX_CONTEXT_CHARS) {
  let total = 0;
  for (const m of msgs) {
    total += _msgSize(m);
  }
  if (total <= maxChars) {
    return msgs;
  }
  let i = 0;
  const head = [];
  if (msgs[0] && msgs[0].role === "system") {
    head.push(msgs[0]);
    i = 1;
  }
  let firstUser = -1;
  for (let j = i; j < msgs.length; j++) {
    if (msgs[j].role === "user") {
      firstUser = j;
      break;
    }
  }
  if (firstUser >= 0) {
    head.push(msgs[firstUser]);
  }
  let used = 0;
  for (const m of head) {
    used += _msgSize(m);
  }
  const budget = maxChars - used;
  let keepFrom = msgs.length;
  let acc = 0;
  for (let j = msgs.length - 1; j > i; j--) {
    const s = _msgSize(msgs[j]);
    if (acc + s > budget && msgs.length - j >= 6) {
      break; // 至少保留最近 ~6 条
    }
    acc += s;
    keepFrom = j;
  }
  // 切片不能以孤儿 tool 开头（其 assistant 被裁）：往后挪过开头的 tool 消息
  while (keepFrom < msgs.length && msgs[keepFrom].role === "tool") {
    keepFrom++;
  }
  const tail = [];
  for (let j = keepFrom; j < msgs.length; j++) {
    if (head.includes(msgs[j])) {
      continue; // 别与 head 重复（firstUser 可能落在尾区）
    }
    tail.push(msgs[j]);
  }
  const elision = {
    role: "user",
    content: "（系统提示：为控制长度，已省略中间若干轮过程；早前的工具结果若需要，请 fs_read 工作目录里已落盘的文件。）",
  };
  return [...head, elision, ...tail];
}

/**
 * 运行一个 Agent 回合。
 * @param {object} p
 * @param {{ chat: Function }} p.client            LlmClient 实例（或同形 mock）
 * @param {{ listSpecs:Function, dispatch:Function }} p.router  ToolRouter 实例
 * @param {Array} p.messages                       既有对话（不含 system）
 * @param {string} [p.systemPrompt]                追加到首位的 system 消息
 * @param {number} [p.maxRounds=6]                 防工具死循环上限
 * @param {AbortSignal} [p.signal]
 * @param {object} [p.toolCtx]                     透传给工具 handler 的 ctx
 * @param {(ev:object)=>void} [p.onEvent]          每步事件回调（供 UI 展示）
 * @param {(call:object)=>Promise<boolean>} [p.confirm]  改动型工具执行前征求批准（A3）
 * @param {boolean} [p.autoApprove=false]          true 则跳过确认（headless/MCP 受信场景）
 * @returns {Promise<{content:string, rounds:number, toolCalls:Array, messages:Array, stopReason:string}>}
 */
export async function runAgentTurn(p) {
  const {
    client,
    router,
    messages,
    systemPrompt,
    dynamicContext,
    maxRounds = 6,
    maxPerTool = 8,
    signal,
    toolCtx = {},
    onEvent,
    onDelta,
    onReasoning, // 思考型模型的 reasoning_content 增量回调（供 UI 展示"思考过程"）
    onCheckpoint, // 上下文压缩时回调(summary)：引擎据此把进展落盘成一条可见回复 + 重置实时步骤
    onUsage, // (rawUsage, {phase})：统一统计由上层按 provider 规范化并持久化
    persistToolArtifact, // 大工具结果落工作目录；返回 {path}，上下文只保留头尾与引用
    getLedger, // 取任务账本注入块的回调(async→string)：每轮开头+每次压缩后拼进系统提示，确认事实永不衰减
    confirm,
    autoApprove = false,
    assist = false, // AI辅助逐阶段模式：无工具的纯文字回复=正常收尾（停下报告+给方向），不当 drift 逼它继续
    vision = false, // 模型是否支持看图：true 时把截图等图像作为 user 图片消息回喂
    contextStrategy = "legacy", // projected=小上下文+大结果折叠；legacy=旧行为，可随时回退
    cacheKey = "",
    runState, // createRunState()：一次自主执行的多个回合共用——循环检测、最近一份存档、任务锚点都跨压缩和自动续跑
  } = p || {};
  const run = _isRunState(runState) ? runState : createRunState();

  if (!client || typeof client.chat !== "function") {
    throw new Error("runAgentTurn: client.chat required");
  }
  if (!router || typeof router.dispatch !== "function") {
    throw new Error("runAgentTurn: router required");
  }
  if (!Array.isArray(messages)) {
    throw new Error("runAgentTurn: messages array required");
  }

  // ★按当前模型上下文窗口缩放预算（强模型少压缩/少截结果 → 少空转、少重读重搜）。从 client.model 解析，
  // 判不准落默认档（=现状，安全）。注意用局部变量、不改模块常量 → 多会话并发安全。
  const _bud = modelBudget(client.model || (client.config && client.config.model));
  const maxChars = _bud.maxChars;
  const compactAt = _bud.compactAt;
  // 单工具结果进上下文的截断上限：**随窗口缩放**（默认档 50k / 大模型 150k）。
  // ★修复旧 bug：以前这里写死 TOOL_RESULT_CAP=6000 又砍一刀，把 modelBudget 给大模型放大的 resultCap(150k) 架空了
  //   → 强模型实际只能看到每条结果 6KB。现在改用 _bud.resultCap，缩放真正生效。
  const legacyResultCap = (_bud && _bud.resultCap) || TOOL_RESULT_CAP;
  const resultCap =
    contextStrategy === "projected"
      ? Math.min(legacyResultCap, 12000)
      : legacyResultCap;
  try {
    if (router && _bud.resultCap) {
      // Projected mode needs the full envelope long enough to save an artifact,
      // then AgentLoop folds it before the next model request.
      router.maxChars =
        contextStrategy === "projected"
          ? Math.max(_bud.resultCap, 256 * 1024)
          : _bud.resultCap;
    }
  } catch {
    /* router 无此字段也不影响 */
  }

  const emit = ev => {
    try {
      onEvent && onEvent(ev);
    } catch {
      /* UI 回调不影响主流程 */
    }
  };

  // 只保留 LLM 协议认得的字段——历史消息带的 UI 元数据(steps 等)若发给模型会污染上下文、引起串话。
  const sanitize = m => {
    const o = { role: m.role };
    if (m.content !== undefined) {
      o.content = _stripRuntimeContext(m.content);
    }
    if (m.tool_calls) {
      o.tool_calls = m.tool_calls;
    }
    if (m.tool_call_id) {
      o.tool_call_id = m.tool_call_id;
    }
    if (m.name) {
      o.name = m.name;
    }
    if (m.reasoning_content) {
      o.reasoning_content = m.reasoning_content; // 思考型模型多轮需保留
    }
    if (Array.isArray(m.responses_output)) {
      o.responses_output = m.responses_output;
    }
    if (m.gemini_content && typeof m.gemini_content === "object") {
      o.gemini_content = m.gemini_content;
    }
    return o;
  };

  // Keep the system prompt byte-stable for provider prefix caching. Workspace,
  // notes, skills, cancellation boundaries, and ledger snapshots are appended
  // only to the current user task message.
  const baseSystem = systemPrompt || "";
  let ledgerText = "";
  try {
    ledgerText = getLedger ? (await getLedger()) || "" : "";
  } catch {
    /* 账本可选，取不到不影响 */
  }
  const history = messages.map(sanitize);
  // 任务锚点 = 用户发的那条任务。自动续跑的回合里，最后一条 user 消息是引擎加的续跑提示，上一回合的锚点
  // 还在消息里（同一个对象）：接着用它。否则压缩时锚点之前的内容——整个上一回合的工作——会被当成历史丢掉，
  // 压缩后的上下文里只剩一句「继续推进」。认不出来（调用方换了消息对象）就退回取最后一条 user 消息。
  let taskIndex = run.anchor ? messages.indexOf(run.anchor) : -1;
  for (let i = history.length - 1; taskIndex < 0 && i >= 0; i--) {
    if (history[i].role === "user") {
      taskIndex = i;
    }
  }
  const rawTaskAnchor = taskIndex >= 0 ? history[taskIndex] : null;
  let taskAnchor = _withRuntimeContext(
    rawTaskAnchor,
    _runtimeContext(dynamicContext, ledgerText)
  );
  if (taskIndex >= 0) {
    history[taskIndex] = taskAnchor;
  }
  run.anchor = taskAnchor;
  let msgs = [
    ...(baseSystem ? [{ role: "system", content: baseSystem }] : []),
    ...history,
  ];

  // Stable order is part of the provider cache prefix.
  const tools = router
    .listSpecs()
    .slice()
    .sort((a, b) =>
      String(a?.function?.name || "").localeCompare(String(b?.function?.name || ""))
    );
  const allToolCalls = [];
  const toolCounts = {}; // 每个工具本回合调用次数（防打转）
  const failSigs = {}; // (工具+错误签名) → 次数（反绕圈：同错反复出现就提示换路线）
  let consecErr = 0; // 连续失败计数（任意类型错；任一成功即清零）——抓"各种错连环=空转"
  let lastCompactRound = 0; // 上次压缩所在轮，避免阈值附近反复压缩
  let autoContinues = 0; // 连续"纯文字不调工具"的自动续跑计数（防过早结束 + 防死循环）
  let truncRetries = 0; // 【输出长度截断】专用重试计数——与 autoContinues 解耦，截断不算"漂移"，免误判停
  // A2 重复调用熔断：callSig → { fp:上次结果指纹, n:连续相同结果次数 }。同调用同结果≥阈值=空转，引擎拒执行。
  const repeatTracker = new Map();
  const REPEAT_BREAK_AT = 10; // 6→10：A2 是唯一还硬拒的护栏，但它只在**同参数+同结果**(确实零新信息)时触发——
  // 这种纯机械 runaway 才该拦。再给强模型更多空间（10 次同参同结果才兜底），其余空转交给软提示/连续失败护栏。
  // A1 无进展预算：自上次"真实前进"以来的工具调用数；连续 NO_PROGRESS_BUDGET 次零前进 → 强制决策回合。
  let noProgress = 0;
  const NO_PROGRESS_BUDGET = 12; // 配合 _isProgress 修正(失败的 run_node 不再误计为前进)：这下能真累计了，稍早一点提醒换路线
  let forcedDecisionPending = false; // 已注入强制决策提示、等模型给出"切换/继续(带证据)/阻塞报告"

  for (let round = 1; round <= maxRounds; round++) {
    // 手动停止（侧边栏「停止」按钮 abort）：在轮次边界干净退出，返回已有进展。
    if (signal && signal.aborted) {
      emit({ type: "aborted", round });
      return {
        content: "（已手动停止）",
        rounds: round - 1,
        toolCalls: allToolCalls,
        messages: msgs,
        stopReason: "aborted",
      };
    }

    // ── 主动上下文压缩（先于 chat 调用）──────────────────────────────────
    // 工作上下文超阈值 → 把本回合进展折成 checkpoint（可见回复+落盘）→ 用小上下文续跑。
    // 仅当有任务锚点、且距上次压缩 ≥ COMPACT_MIN_ROUNDS 轮时触发。
    if (taskAnchor && round - lastCompactRound >= COMPACT_MIN_ROUNDS) {
      let workSize = 0;
      for (const m of msgs) {
        workSize += _msgSize(m);
      }
      if (workSize > compactAt) {
        const anchorIdx = msgs.indexOf(taskAnchor);
        const firstIdx = baseSystem ? 1 : 0;
        // 要总结的执行记录：上一次压缩的续跑说明之后（自动续跑后的回合里，它是上一回合留下的）；
        // 还没压缩过就从任务锚点之后开始。
        let noteIdx = -1;
        for (let i = msgs.length - 1; noteIdx < 0 && i >= 0; i--) {
          const m = msgs[i];
          if (m && m.role === "user" && typeof m.content === "string" && m.content.startsWith(COMPACT_NOTE)) {
            noteIdx = i;
          }
        }
        const segStart = noteIdx >= 0 ? noteIdx + 1 : anchorIdx >= 0 ? anchorIdx + 1 : firstIdx;
        // 锚点之前的对话：最初的任务、历史投影、前几轮的结论。锚点是「继续」这类短消息时，任务本身也在这里。
        const earlierEnd = anchorIdx >= 0 ? Math.min(anchorIdx, segStart) : firstIdx;
        const earlier = earlierEnd > firstIdx ? msgs.slice(firstIdx, earlierEnd) : [];
        collectUserNotes(run, earlier);
        const previous = run.lastCheckpoint || "";
        // 关键：用 **LLM 生成结构化交接摘要**（保留"已确认事实/文件清单/下一步"），而不是机械截取——
        // 机械摘要会丢掉已发现的结论，导致压缩后重新探索=循环失忆（这是把压缩做对的核心）。
        // LLM 摘要失败/超时再退回机械摘要，至少不丢压缩本身。
        let handoff = null;
        try {
          handoff = await summarizeForHandoff(
            client,
            buildHandoffSource({
              userNotes: run.userNotes,
              task: textOfContent(rawTaskAnchor && rawTaskAnchor.content),
              earlier,
              previous,
              segment: msgs.slice(segStart),
            }),
            signal,
            onUsage,
            cacheKey
          );
        } catch {
          /* 摘要调用失败 → 机械兜底 */
        }
        let summary;
        if (handoff && handoff.text && !handoff.truncated) {
          summary = handoff.text;
        } else if (handoff && handoff.truncated && handoff.text.length >= HANDOFF_PARTIAL_MIN) {
          // 被长度截断：目标和已确认事实在前面，多半已经写出来了，比整份换成机械记录强；
          // 没写出来的部分（靠后的「已否决」「下一步」）用上一份存档和机械记录的最近进展补上。
          // 补充部分以标题开头：账本自动沉淀按标题分节，不能把后面的内容算进被截断的那一节。
          summary =
            handoff.text +
            "\n\n## 交接账本超出长度被截断，以下是补充\n" +
            buildCheckpointSummary(msgs, segStart, { previous, earlier });
        } else {
          summary = buildCheckpointSummary(msgs, segStart, { previous, earlier });
        }
        run.lastCheckpoint = summary;
        run.epoch++;
        emit({ type: "checkpoint", round, summary });
        if (typeof onCheckpoint === "function") {
          try {
            await onCheckpoint(summary);
          } catch {
            /* 落盘失败不阻断续跑 */
          }
        }
        // 压缩后重新取**最新账本**（含本回合 remember 的新事实）拼进 system → 确认事实永不因压缩衰减。
        let freshLedger = ledgerText;
        try {
          if (getLedger) {
            freshLedger = (await getLedger()) || "";
          }
        } catch {
          /* 取不到就沿用上次的账本快照 */
        }
        taskAnchor = _withRuntimeContext(
          rawTaskAnchor,
          _runtimeContext(dynamicContext, freshLedger)
        );
        run.anchor = taskAnchor;
        // 锚点之前的用户消息原文附在续跑说明后面：锚点是「继续」时，任务和中途给的限制条件都在那些消息里。
        const userNotes = formatUserNotes(run.userNotes);
        // Rebuild a small context with the same stable system prefix. Dynamic
        // runtime data remains attached to the task anchor.
        msgs = [
          ...(baseSystem ? [{ role: "system", content: baseSystem }] : []),
          taskAnchor,
          { role: "assistant", content: summary },
          { role: "user", content: COMPACT_NOTE + (userNotes ? `\n\n${USER_NOTES_LABEL}\n${userNotes}` : "") },
        ];
        lastCompactRound = round;
      }
    }

    emit({ type: "round", round });
    const res = await client.chat(trimContext(msgs, maxChars), {
      tools,
      signal,
      onDelta,
      onReasoning,
      cacheKey,
    });
    try {
      onUsage && onUsage(res.usage, { phase: "chat" });
    } catch {
      /* usage reporting never blocks the Agent */
    }

    const toolCalls = res.toolCalls || [];
    if (toolCalls.length === 0) {
      // 模型没调工具就回了。可能 ①真完成 ②真要用户输入 ③只是"复述计划/进展"漂走了没动手
      // （尤其压缩后 [任务+存档+继续提示] 很容易引出一段纯文字回复）。③ 会让自主执行**过早结束**
      // ——这正是用户看到的"自己停下不动了"。判断是否真结论：含结论/求助/已完成才真停，否则注入
      // "现在就执行下一步"逼它真的调工具继续。autoContinues 封顶防纯文字死循环；任一工具调用即清零。
      const txt = String(res.content || "");
      const reasoningLen = (res.reasoningContent || "").length;
      // 【截断判定】(Fix 2，对中转鲁棒)：标准是 finish_reason=length/max_tokens；但不少中转在流被切时
      // 不回标准 finish_reason，故再加"reasoning 吃满预算"特征签名——无工具调用 + content 只剩零碎(<8 字) +
      // reasoning 很长(>2000 字) → 几乎一定是思考型模型把 max_tokens 全耗在 reasoning 上、没产出调用就被切。
      const truncated =
        res.finishReason === "length" ||
        res.finishReason === "max_tokens" ||
        (txt.trim().length < 8 && reasoningLen > 2000);

      // 【工具调用本身没生成好】：Gemini 的 MALFORMED_FUNCTION_CALL（参数大、引号/换行没转义时常见）或
      // 截断正好落在工具调用上（参数不完整，没派发）。都不是"模型只说不做"，也不是"想太多"：把服务端给的
      // 原因告诉模型让它重发，并按截断那套计数，免得误判成 drift 或把预算耗在思考上。
      if (res.finishReason === "malformed_function_call" || res.truncatedToolCall) {
        truncRetries++;
        if (truncRetries > MAX_TRUNC_RETRIES) {
          emit({ type: "final", content: res.content, round });
          return {
            content:
              (res.content || "") +
              `\n\n（已停下）模型连续 ${truncRetries - 1} 次没能生成出完整有效的工具调用` +
              (res.finishMessage ? `（服务端原因：${String(res.finishMessage).slice(0, 300)}）` : "") +
              `。进展已落盘。建议换更稳的模型续跑，或把该模型 max_tokens 调大。`,
            rounds: round,
            toolCalls: allToolCalls,
            messages: msgs,
            stopReason: "final",
          };
        }
        msgs.push({ role: "assistant", content: txt || "（上轮的工具调用没有生成完整）" });
        msgs.push({
          role: "user",
          content: res.truncatedToolCall
            ? "（系统）你上一条的工具调用参数被输出长度限制截断了（finish_reason=length），本次调用未执行。" +
              "⚠ **别再重发同样的大内容**——重试还会被截断。改用其一：① 要复制/改**已落盘的文件**→ `fs_copy(src,dst)` 拷现成的、再只写小补丁；" +
              "② 确需新写大文件 → 分多段 `fs_write({path,content,append:true})` 每段 ≤2KB；③ 缩短本轮思考/少灌内容。"
            : "（系统）你上一条的工具调用没有生成成功，服务端判定为无效的函数调用" +
              (res.finishMessage ? `（原因：${String(res.finishMessage).slice(0, 300)}）` : "") +
              "，本次调用未执行。请**重新发出这个调用**：参数必须是一个合法 JSON 对象，字符串值里的引号、反斜杠、换行要正确转义；" +
              "内容很大就分多段 `fs_write({path,content,append:true})` 每段 ≤2KB。",
        });
        continue;
      }

      // 【截断专用处理】(Fix 1)：与 drift/autoContinue **完全解耦**。截断不是"漂移不动手"，是"想太多被切"——
      // 若按 autoContinue 累计，3 次就误判 drift、外层再两轮 drift 即"已停下"=用户实测的"DeepSeek 跑一会突然
      // 截断然后会话停了"。故：不碰 autoContinues、不把那半截废思考回灌（白占 80K 预算还会顺着想下去），
      // 只塞一条硬指令逼它这轮极简推理直奔工具调用，retry。仅当连续截断到上限才停（且给可行动报告，不走 drift）。
      if (truncated) {
        truncRetries++;
        if (truncRetries > MAX_TRUNC_RETRIES) {
          emit({ type: "final", content: res.content, round });
          return {
            content:
              (res.content || "") +
              `\n\n（已停下）模型连续把输出预算耗在"思考"上、始终没发出工具调用就被长度限制切断` +
              `（思考型模型的 reasoning 无法靠提示压住）。进展已落盘。建议换更稳的模型（如 Claude）续跑，或把该模型 max_tokens 调大。`,
            rounds: round,
            toolCalls: allToolCalls,
            messages: msgs,
            stopReason: "final", // 走 final 停下等用户决策；**不**走 drift（drift 两轮即停且文案误导成"只在描述分析"）
          };
        }
        msgs.push({ role: "assistant", content: txt || "（上轮思考超长被截断）" });
        msgs.push({
          role: "user",
          content:
            "（系统）你上一条把输出预算几乎全耗在思考上、**还没发出工具调用就被长度限制截断了**。" +
            "这一轮**严禁长篇推理**：基于已知信息用最多一两句话说清要做什么，**立刻发出一个工具调用**。" +
            "若同一处已反复试不通，别再钻——换路线（浏览器当 oracle：page_eval 调页面里的 signer 拿「输入→签名」真值对照；或 jsvmp_trace 看 VM 算法）。",
        });
        continue;
      }

      // ── 非截断的"无工具纯文字"：真结论 or 漂移 ──
      // 真结论才停：有结论小标题/明确求助/已完成（正则即可区分真结论与零碎字符）。
      const looksFinal =
        /##\s*结论|结论[:：]|已(全部)?完成|无法继续|搞不定|需要你|需要您|请你提供|请您提供|请提供|麻烦你|等你|等您|你来决定|由你决定/.test(
          txt
        );
      // AI辅助模式：任一无工具的纯文字回复都当作"阶段门停"——做完本阶段的工具动作后，模型发一条
      // 「汇报发现+给方向选项」的纯文字，本回合即收尾交回用户等其选方向（不 drift 逼它跳下一阶段）。
      if (assist || looksFinal || autoContinues >= MAX_AUTO_CONTINUE) {
        // 【drift 自诊断】非 assist/非真结论却停 = 模型连续只输出文字计划、不调工具（drift）。旧版只把模型那段
        // 计划文字原样抛给用户就停 → 用户看着像"莫名其妙中断"。这里补一句**为什么停 + 怎么办**，让中断不再神秘。
        const isDrift = !assist && !looksFinal;
        const driftDiag = isDrift
          ? "\n\n---\n（系统）⚠ 模型**连续多次只输出文字计划、不调用工具**就停了 —— 不是任务做完，是模型卡在「工具调用」这一步。" +
            "这通常是**模型侧**问题：① 推理档（`deepseek-reasoner` / R1）**不支持 function calling**，只会叙述下一步、不会真的发起工具调用；" +
            "② DeepSeek 在**超长上下文 + 高频工具调用**下，到「思考完→发起调用」的边界容易退化成纯文字。" +
            "**换 `deepseek-v4-flash`（支持工具、稳）或 Claude 续跑**即可；进展已落盘，开回原工作目录可接着干。"
          : "";
        emit({ type: "final", content: res.content + driftDiag, round });
        return {
          content: (res.content || "") + driftDiag,
          rounds: round,
          toolCalls: allToolCalls,
          messages: msgs,
          // assist/looksFinal=停下等用户 → "final"；否则全自动下连续纯文字攒满 → "drift"（上层自动续跑）。
          stopReason: assist || looksFinal ? "final" : "drift",
        };
      }
      // 漂走/只说计划 → 推进它真的动手，不结束本轮。
      autoContinues++;
      msgs.push({ role: "assistant", content: txt });
      msgs.push({
        role: "user",
        content:
          "（系统）别只描述计划/复述进展——**现在就调用工具执行你说的下一步**。" +
          "任务没完成就一直推进到底；只有真正需要我提供你拿不到的东西（登录态/账号/验证码/纯业务决策）、" +
          "或任务已全部完成（给出可独立实跑的产物）时才停。" +
          "**若你已反复搜索/静态分析同一处仍无进展，立刻换路线**：签名器能在浏览器调用就转 jsdom/node 补环境实跑、" +
          "用 XHR/fetch 拦截器把目标参数截出来对照，而不是继续静态找定义。",
      });
      continue;
    }
    autoContinues = 0; // 有真实工具调用 → 清零（只数"连续纯文字空转"）
    truncRetries = 0; // 成功产出工具调用 → 清零截断重试计数（只数**连续**截断，免长会话零星截断攒到上限误停）

    // 回灌：assistant 的 tool_calls 消息必须原样保留，再跟每个 tool 结果。
    // 思考型模型(deepseek-v4-pro 等)要求把本轮 reasoning_content 一并回灌，否则下一轮 400；
    // 但整段 reasoning 每轮可达数千字，全回灌会撑爆 80K 上下文、把真工具结果挤掉 → 模型丢状态、反复重读重跑(兜圈子)。
    // 故只回灌尾部 REASONING_FEEDBACK_CAP 字（结论/"所以我现在要调用 X"通常落在尾部）：既满足"字段在"、又不吃上下文。
    const asstMsg = { role: "assistant", content: res.content ?? "", tool_calls: toolCalls };
    if (Array.isArray(res.responseOutput)) {
      asstMsg.responses_output = res.responseOutput;
    }
    if (res.geminiContent && typeof res.geminiContent === "object") {
      asstMsg.gemini_content = res.geminiContent;
    }
    if (res.reasoningContent) {
      asstMsg.reasoning_content =
        res.reasoningContent.length > REASONING_FEEDBACK_CAP
          ? "…" + res.reasoningContent.slice(-REASONING_FEEDBACK_CAP)
          : res.reasoningContent;
    }
    msgs.push(asstMsg);

    // 工具返回的图先攒着，整批 tool 结果回灌完再作为一条 user 图片消息追加：OpenAI 要求 tool 消息紧跟
    // tool_calls，Gemini 要求一轮调用的 functionResponse 数量对得上且连在一起，中间插 user 消息都会 400。
    const mediaBlocks = [];
    for (const tc of toolCalls) {
      if (signal && signal.aborted) {
        break; // 手动停止：跳出，外层轮次边界会干净返回
      }
      const name = tc.function?.name;
      let args = {};
      let parseErr = null;
      try {
        args = tc.function?.arguments ? parseToolArgs(tc.function.arguments) : {};
      } catch (e) {
        // 最常见原因：输出被 max_tokens 截断(finish_reason=length) → arguments JSON 被切断
        // （多见于把整个大文件当 fs_write 的 content 一次性写出）。给可操作提示，
        // 避免模型对同一超大写入盲目重试同样会再截断。
        const truncated =
          res.finishReason === "length" ||
          res.finishReason === "max_tokens" ||
          /end of data|unterminated|unexpected end/i.test(e.message || "");
        parseErr = truncated
          ? `工具参数被输出长度限制截断（finish_reason=${res.finishReason || "length"}，本次调用未执行）。` +
            `⚠ **别再重发同样的大内容**——重试还会被截断、白白卡住会话。改用其一：` +
            `① 若是要复制/改一个**已落盘的文件**（如已 scripts_save 的 glue）→ 用 \`fs_copy(src,dst)\` 拷现成的、` +
            `再只写几十行小 loader/补丁，**绝不要 fs_write 把大文件全文重写**；` +
            `② 确需新写大文件 → 分多段 \`fs_write({path,content,append:true})\` 每段 ≤2KB；` +
            `③ 缩短本轮思考/少灌内容。（原始解析错误：${e.message}）`
          : `工具参数 JSON 非法（${e.message}）。请**只**发一个完整合法的 JSON 对象作为该工具参数，` +
            `别在它后面再附加说明文字/第二个对象/\`\`\` 代码块标记；复杂字符串值（如 callExpr）里的引号、反斜杠、换行要正确转义。`;
      }
      emit({ type: "tool_call", name, args, id: tc.id });
      toolCounts[name] = (toolCounts[name] || 0) + 1;

      // A2 重复调用熔断（纯机械、模型绕不过）：同一(工具+归一化参数)已连续 ≥REPEAT_BREAK_AT 次
      // 拿到**相同结果指纹**（无新信息）→ 引擎直接拒绝执行，逼它换动作/换工具。掐死
      // jsvmp_query(count=0) 反复、fs_list 连发、net_capture→scroll→net_list 空转这类死循环。
      // 豁免有副作用的工具（滚动/导航/trace 开关/触发请求等）——它们同参重复是正当的，不算空转。
      const callSig = parseErr || router.isRepeatExempt?.(name) ? null : _callSig(name, args);
      const rep = callSig ? repeatTracker.get(callSig) : null;
      const repeatBlocked = !!(rep && rep.n >= REPEAT_BREAK_AT);

      // 改动型工具（page_eval/navigate/intercept/save/trace…）执行前征求用户批准（A3）。
      // 默认安全：需确认但既无 confirm 回调也没 autoApprove → 拒绝。
      let env;
      if (parseErr) {
        env = { ok: false, error: parseErr };
      } else if (repeatBlocked) {
        env = {
          ok: false,
          error:
            `⛔ 已用**相同参数**调用 ${name} ${rep.n + 1} 次、每次结果都一样（无新信息）——这是空转。` +
            `引擎已拒绝再次执行。**别重发同样的调用**：要么改参数（换 filter/换脚本/换 offset）、` +
            `要么换工具、要么换策略。若该策略确实走不通，按账本登记"已否决假设(带证据)"再换路线，别原地磨。`,
        };
      } else if (router.needsConfirm(name)) {
        emit({ type: "confirm_request", name, args, id: tc.id });
        let approved = autoApprove;
        if (!approved && typeof confirm === "function") {
          approved = await confirm({ name, args, id: tc.id });
        }
        emit({ type: "confirm_result", name, id: tc.id, approved: !!approved });
        env = approved
          ? await router.dispatch(name, args, toolCtx)
          : { ok: false, error: "user denied tool execution", denied: true };
      } else {
        env = await router.dispatch(name, args, toolCtx);
      }

      allToolCalls.push({ name, args, env, id: tc.id });
      emit({ type: "tool_result", name, env, id: tc.id });

      // A2：更新重复跟踪。被熔断拒绝(repeatBlocked)的不计入；正常执行后比对结果指纹：
      // 与上次相同→n++（逼近阈值）；不同（有新信息）→重置为 0。换了参数=新 callSig=独立计数。
      const fp = callSig && !repeatBlocked ? _resultFp(env) : null;
      if (fp) {
        const prev = repeatTracker.get(callSig);
        if (prev && prev.fp === fp) {
          prev.n += 1;
        } else {
          repeatTracker.set(callSig, { fp, n: 1 });
        }
      }

      // 循环检测：参数完全相同、结果也完全相同的调用之前做过 = 重复调用。跨压缩、跨自动续跑都记着
      // （A2 只在本回合内、同一调用连续 10 次才拦，从头重做一遍分析时每个调用只重复一两次，A2 看不出来）。
      // 范围和 A2 一样：不豁免的工具；参数解析失败的、被用户拒绝的不记；被 A2 拒绝执行的算一次重复。
      const repeatOf = callSig && !env.denied ? _trackCall(run, name, args, fp, repeatBlocked) : null;

      // A1：真实前进则清零预算 + 清空强制决策态；否则累加。被熔断/被拒的、重复调用拿到相同结果的不算前进。
      if (!repeatBlocked && !repeatOf && _isProgress(name, env, !!router.countsAsProgress?.(name))) {
        noProgress = 0;
        forcedDecisionPending = false;
      } else {
        noProgress++;
      }

      // 图像（截图）走 env.media 旁路：不塞进工具文本结果（否则爆 token / 被截断）。
      const media = Array.isArray(env.media) ? env.media : null;
      const envText = media ? { ok: env.ok, data: env.data, error: env.error, meta: env.meta } : env;
      // 单条工具结果进上下文的硬上限：防长会话(逆向多步、page_eval/fs_read 大输出)上下文无界增长
      // → 请求体越来越大 → 模型 TTFT 超过空闲看门狗(默认300s)一字未回 → 误报「连接超时」/撞上下文窗。
      // 大结果只截给模型一个头部 + 可操作提示；完整内容仍在侧栏事件与落盘文件里，要细节让模型分段 fs_read。
      let contentStr = JSON.stringify(envText);
      if (contentStr.length > resultCap) {
        const originalChars = contentStr.length;
        let artifact = null;
        if (typeof persistToolArtifact === "function") {
          try {
            artifact = await persistToolArtifact({
              id: tc.id,
              name,
              content: contentStr,
              chars: originalChars,
            });
          } catch {
            /* artifact persistence is optional */
          }
        }
        const reference = artifact?.path
          ? `折叠前结果已保存到 ${artifact.path}；需要细节请用 fs_read 分段读取或 code_search 精确搜索。`
          : "未设置工作目录或保存失败；需要细节请缩小查询范围后重新获取。";
        const marker =
          `\n…⟪旧工具输出已折叠，原始 ${originalChars} 字符。${reference}⟫…\n`;
        const room = Math.max(1000, resultCap - marker.length);
        const headChars = Math.floor(room * 0.65);
        const tailChars = room - headChars;
        contentStr =
          contentStr.slice(0, headChars) +
          marker +
          contentStr.slice(-tailChars);
      }
      // 反绕圈护栏：同一(工具+错误签名)累计到阈值 → 在结果里注入"换路线"硬提示（依据 skill §6 决策树）。
      const sig = _errSig(name, env);
      if (sig) {
        failSigs[sig] = (failSigs[sig] || 0) + 1;
        if (failSigs[sig] >= SAME_ERR_PIVOT_AT) {
          contentStr +=
            `\n\n⟪⚠ 你已第 ${failSigs[sig]} 次用 ${name} 撞同一类错误。别再用同样方式重试——这多半不是再补一个 stub/参数能解决，是路线/初始化链不对。换路线(见 skill_get §6 决策树)：` +
            `①浏览器当 oracle：page_eval 调页面里的 signer 拿「输入→签名」真值对照(零补环境先验证可行)；` +
            `②转路径A：jsvmp_trace 直接看 VM 算法；③仍不行就把卡点+已知信息报告用户。⟫`;
        }
      }
      // 【maxPerTool 改软提示，不再硬熔断】旧版"同一工具本回合超 N 次就拒执行"是**一刀切**——长逆向任务里
      // run_node/code_search/page_eval 正当地要调几十上百次（每次不同脚本/不同搜索=都有进展），硬熔断会把活
      // 生生的任务掐断（用户实测痛点："很长的 Agent 任务不可能一刀切"）。现在**绝不拦执行**，只在跨过阈值时
      // **偶尔附一句温和提醒**。真正的空转交给 A2(同参同结果熔断，纯机械绕不过) + 下面的连续失败护栏 + maxRounds 兜——
      // 它们只在**确无新信息/连环失败**时才触发，不误伤"高频但每次有进展"的正当调用。
      if (toolCounts[name] > maxPerTool && (toolCounts[name] - maxPerTool - 1) % 20 === 0) {
        contentStr +=
          `\n\n⟪提示：${name} 本回合已调用 ${toolCounts[name]} 次——长任务这很正常、继续无妨，只要每次有新进展即可。` +
          `（同参同结果会被自动熔断、连环失败会另有提示；都没触发就说明你在正常推进，放心干。）⟫`;
      }
      // 重复调用提示：告诉模型这一步之前做过、结果一样，从第二次起就提示（A2 要到第 10 次才拦）。
      if (repeatOf) {
        contentStr +=
          `\n\n⟪重复调用：本次任务里已经用完全相同的参数调用过 ${name} ${repeatOf.count} 次，结果和这次完全一样` +
          `（上一次在 ${repeatOf.ago} 次工具调用之前${repeatOf.beforeCompaction ? "，第一次在上次上下文压缩之前" : ""}）。` +
          `想找回当时的结论就看【进展存档】和账本；需要原文细节才重读。别从头重做已经做完的分析。⟫`;
      }
      // 连续失败护栏（任意类型，不限同类）：连环失败=空转/退化 → 强提示停手。
      if (_failed(env)) {
        consecErr++;
        if (consecErr >= CONSEC_ERR_AT) {
          contentStr +=
            `\n\n⟪⚠ 连续 ${consecErr} 次工具调用都失败了——很可能在空转。**别再用同样的方式重试/猜参数/重发大内容**；换个思路、换个工具、或先核对前提（路径是否存在、参数格式对不对、前置步骤做了没）。若你确有**不同且有把握**的下一步，**照常继续用工具**（包括刚失败的这个）；若只是在重复同类尝试，就停下、基于已有信息给结论或说清卡在哪、需要什么（进展已落盘不丢）。⟫`;
        }
      } else if (env && env.ok === true) {
        consecErr = 0;
      }
      msgs.push({
        role: "tool",
        tool_call_id: tc.id,
        content: contentStr,
      });

      // 视觉回喂：模型支持看图时，把图像作为 user 图片消息追加，让模型"看见"页面。
      if (media && media.length && vision) {
        const blocks = [
          { type: "text", text: `（${name} 返回 ${media.length} 张图，请据此判断页面与下一步操作）` },
        ];
        for (const m of media) {
          if (m && m.type === "image" && m.dataUrl) {
            blocks.push({ type: "image_url", image_url: { url: m.dataUrl } });
          }
        }
        if (blocks.length > 1) {
          mediaBlocks.push(...blocks);
        }
      }
    }
    if (mediaBlocks.length) {
      msgs.push({ role: "user", content: mediaBlocks });
    }

    // 循环检测（只在一轮的工具结果全部回灌之后插消息，不能插在 tool 结果中间）：
    // 最近的调用大多是之前做过、结果相同的重复 → 第一次提醒；提醒之后还这样就停下本轮，不再自动续跑。
    const verdict = _loopVerdict(run);
    if (verdict && verdict.action === "warn") {
      forcedDecisionPending = true; // 这一轮不再叠一条 A1 提醒
      emit({ type: "loop_warning", round, repeats: verdict.repeats });
      msgs.push({
        role: "user",
        content:
          `（系统·循环检测）最近 ${LOOP_WINDOW} 次工具调用里有 ${verdict.repeats} 次和之前做过的调用完全相同、结果也一样，例如：\n` +
          verdict.examples.map(l => "- " + l).join("\n") +
          `\n你很可能在从头重做已经完成的分析。先看【进展存档】和账本（工作目录里的 progress.md、ledger.md），从记下的「下一步」接着做；` +
          `确实需要重新验证某一项，先用一句话说明为什么，再只做那一步。卡住了就停下汇报：已确认什么、卡在哪、还需要什么。` +
          `如果接下来还是这样重复，本轮会停下，交给用户决定方向。`,
      });
    } else if (verdict && verdict.action === "stop") {
      emit({ type: "loop_stop", round, repeats: verdict.repeats });
      msgs.push({
        role: "user",
        content:
          "（系统·循环检测）提醒之后你仍在重复之前做过、结果相同的调用，本轮到此停下。**不要再调用工具。**" +
          "用几句话汇报：已经确认的结论、卡在哪一步、要继续需要什么（换哪条路，或需要用户提供什么）。",
      });
      // 请求里照样带工具声明，和主请求一致：对话里有工具调用和结果，不带声明的请求不保证每个服务端都接受。
      // 模型要是仍然发了工具调用，不执行，只取文字。
      let report = "";
      try {
        const fin = await client.chat(trimContext(msgs, maxChars), {
          tools,
          signal,
          onDelta,
          onReasoning,
          cacheKey,
        });
        try {
          onUsage && onUsage(fin.usage, { phase: "final" });
        } catch {
          /* usage reporting never blocks the Agent */
        }
        report = fin.content || "";
      } catch {
        /* 汇报失败也照样停下 */
      }
      const note =
        `\n\n---\n（系统）⚠ 检测到循环：提醒之后，最近 ${LOOP_WINDOW} 次工具调用里仍有 ${verdict.repeats} 次是之前做过、结果完全相同的调用` +
        `（如 ${verdict.tools.join("、")}）。为免无限循环，本轮已停下，不再自动续跑。` +
        `进展已落盘；告诉我聚焦哪条路、或补一个我拿不到的输入，我再继续。`;
      emit({ type: "final", content: report + note, round });
      return {
        content: report + note,
        rounds: round,
        toolCalls: allToolCalls,
        messages: msgs,
        stopReason: "loop",
      };
    }

    // A1 无进展软提醒（轻量、不强制）：连续 NO_PROGRESS_BUDGET 次零真实前进 → 注入**一条温和提醒**，
    // 提示它"可能在绕，停下想想最有把握的一条路推到底，或如实报告卡点"。只提醒一次（fired 后不再重复打扰）。
    // 不再做"三选一强制裁决"——按精简法，方法论交给 skill、判断交给模型，引擎只做轻护栏不越俎代庖。
    if (noProgress >= NO_PROGRESS_BUDGET && !forcedDecisionPending) {
      forcedDecisionPending = true;
      emit({ type: "forced_decision", noProgress });
      msgs.push({
        role: "user",
        content:
          `（系统·提醒）你已连续约 ${noProgress} 次工具调用没明显推进（没新落盘/没抓到关键数据/结果在重复）。` +
          `不是逼你停——只是提个醒：若在反复试同类手段，**挑一条你最有把握的路推到判决**（要么跑出结果，要么确认此路不通再换）；` +
          `若确实卡住，如实说清卡在哪、还需要什么。然后继续。`,
      });
    }
  }

  emit({ type: "max_rounds", maxRounds });
  // 轮数用尽：不带工具再问一次，逼模型基于已有工具结果直接给结论，而不是空停。
  let summary = "";
  try {
    const fin = await client.chat(trimContext(msgs, maxChars), {
      signal,
      onDelta,
      onReasoning,
      cacheKey,
    });
    try {
      onUsage && onUsage(fin.usage, { phase: "final" });
    } catch {
      /* usage reporting never blocks the Agent */
    }
    summary = fin.content || "";
  } catch {
    /* 总结失败就退回提示 */
  }
  emit({ type: "final", content: summary, round: maxRounds });
  return {
    content:
      summary ||
      `（已达最大轮数 ${maxRounds}，仍未得出结论。可换个问法、缩小范围，或分步让我做。）`,
    rounds: maxRounds,
    toolCalls: allToolCalls,
    messages: msgs,
    stopReason: "max_rounds",
  };
}

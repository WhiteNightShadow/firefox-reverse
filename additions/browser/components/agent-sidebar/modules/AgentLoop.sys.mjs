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
// 压到 80K(≈22K token)：请求体更小、上游更快出首字节，且更易落进 32K/64K 窗模型；trim 仍保
// system + 首条 user 任务锚点 + 最近若干轮，老轮次细节让模型 fs_read 落盘文件回看。
const MAX_CONTEXT_CHARS = 80000;

// 自主回合内**上下文压缩阈值**（< MAX_CONTEXT_CHARS，主动压缩先于被动 trim）。工作上下文一旦超过它，
// 就把本回合至今的进展机械总结成一条 checkpoint（可见回复+落盘），再用 [system+任务+checkpoint+继续提示]
// 这个小上下文续跑。这样：①每次请求都小而快(基本根治"大上下文→上游>300s→连响应头都等不到"的卡死)；
// ②进度拆成多条可见回复；③任意一步失败/超时，最近 checkpoint 已落盘，重发即从那里续。
const COMPACT_AT = 55000;
// 压缩后两次之间至少跑这么多轮，避免阈值附近抖动反复压缩。
const COMPACT_MIN_ROUNDS = 2;
// 模型连续返回"纯文字、不调工具"的最多自动续跑次数。超过就当它真的停了（防纯文字死循环空转）。
const MAX_AUTO_CONTINUE = 3;

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

// A2 重复熔断**豁免名单**：这些工具"同参重复"是正当的——每次都有真实副作用或推进世界状态，
// 不是空转。page_scroll 滚动加载新内容、page_navigate 重载、trace start/stop/clear 开关、
// page_eval 触发请求/取不同时刻的值、page_click 交互。误把它们当空转拦掉，会逼模型绕路（实测踩到）。
// 真正该熔断的是**纯只读查询**（jsvmp_query/net_list/fs_list/code_search…）反复拿同一结果。
const REPEAT_EXEMPT = new Set([
  "page_scroll",
  "page_navigate",
  "page_click",
  "page_type",
  "page_eval",
  "page_screenshot",
  "jsvmp_trace",
  "webapi_trace",
  "net_capture",
  "run_node",
  "run_python",
  "fs_write",
  "npm_install",
]);

/** 机械构建进展存档（零额外 LLM 调用、确定性、有界）：工具账本 + 最近的文字叙述 + 最近一步结果摘要。
 *  fromIdx 后扫描——把模型自己的"做了什么/下一步"叙述 + 工具调用清单折成一段，老的原始 trace/输出
 *  留在工作目录文件里（要细节 fs_read）。压缩后续跑只带这段，不带原始大堆历史。 */
function buildCheckpointSummary(msgs, fromIdx) {
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
  const ledger =
    Object.entries(toolCounts)
      .map(([n, c]) => (c > 1 ? `${n}×${c}` : n))
      .join("、") || "（无）";
  const recent = narration.slice(-4).join("\n").slice(0, 2600) || "（暂无文字记录）";
  const tail = lastToolResult ? `\n\n最近一步工具结果(截断)：${lastToolResult.slice(0, 500)}` : "";
  const body =
    `【进展存档·自动压缩】\n已调用工具：${ledger}\n\n进展记录：\n${recent}${tail}\n\n` +
    `（以上为已压缩的早前过程；完整 trace/脚本/产物都在工作目录文件里，需要细节用 fs_read 读对应文件。）`;
  return body.slice(0, 4000);
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
只输出这份账本本身，不要调用工具、不要寒暄、不要复述本提示。`;

/** 把本回合的执行记录拍平成纯文本（避免把 tool_calls/tool 消息原样喂给无 tools 的摘要调用引发协议问题）。 */
function segmentTranscript(msgs, fromIdx) {
  const lines = [];
  for (let i = Math.max(0, fromIdx); i < msgs.length; i++) {
    const m = msgs[i];
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
      lines.push("[用户] " + (typeof m.content === "string" ? m.content : ""));
    }
  }
  return lines.join("\n").slice(0, 60000);
}

/** 让模型把本回合执行记录浓缩成结构化交接摘要（单次 chat、无 tools、输出短）。 */
async function summarizeForHandoff(client, msgs, fromIdx, signal) {
  const transcript = segmentTranscript(msgs, fromIdx);
  if (!transcript) return "";
  const res = await client.chat(
    [
      { role: "system", content: HANDOFF_PROMPT },
      { role: "user", content: "以下是迄今的执行记录，据此输出交接摘要：\n\n" + transcript },
    ],
    { signal }
  );
  return (res && res.content ? String(res.content) : "").trim();
}

// 反绕圈：同一(工具+错误签名)累计到这个次数 → 在结果里注入"换路线"提示。
const SAME_ERR_PIVOT_AT = 3;
// 连续失败(任意类型，不限同类)到这个次数 → 强提示模型停手（抓"各种错连环出现=空转/退化"，
// 是 SAME_ERR_PIVOT_AT 抓不到的另一种空转：空参数调用/截断/超限轮番出现）。
const CONSEC_ERR_AT = 4;

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
// A2：给一次工具结果算"结果指纹"——只取**信息量特征**（ok/错误签名/数量/大小/少量内容头），
// 用于判断"重复调用是否带来了新信息"。两次 callSig 相同且 resultFp 相同 = 纯空转。
function _resultFp(env) {
  if (!env || typeof env !== "object") {
    return String(env);
  }
  const parts = [];
  parts.push(env.ok === false ? "err" : "ok");
  // 常见"数量/状态"字段：count/length/size/bytes/exitCode/cleared/capturing…
  for (const k of ["count", "callCount", "watLines", "funcCount", "exitCode", "size", "bytes", "cleared", "capturing", "tracing", "hasTrace"]) {
    if (env[k] !== undefined) {
      parts.push(k + "=" + JSON.stringify(env[k]));
    }
  }
  // 列表类：长度即可（内容不进指纹，避免大对象）
  for (const k of ["requests", "entries", "hits", "records", "calls", "functions", "exports"]) {
    if (Array.isArray(env[k])) {
      parts.push(k + ".len=" + env[k].length);
    }
  }
  // 错误文本头（归一）
  if (env.ok === false) {
    const e = String(env.error || env.note || "").toLowerCase().replace(/\d+/g, "#").slice(0, 80);
    parts.push("e:" + e);
  }
  return parts.join(",");
}

// A1 无进展预算用：判定一次工具调用是否构成"真实前进"（机械、不靠模型自述）。
// 真前进 = 产生了新的、有价值的状态变化：成功落盘脚本/文件、抓到带调用栈的请求、wasm_probe 出 calls、
// trace 有非空记录、写了产物文件等。纯查询(失败/count=0/列表没变)不算前进。
function _isProgress(name, env) {
  if (!env || env.ok === false) {
    return false;
  }
  // 写盘/落盘类工具成功 = 前进
  if (/^(scripts_save|fs_write|fs_copy|fs_mkdir|wasm_disasm|jsvmp_split_dispatcher|jsvmp_disassemble|js_trace|notes_add)$/.test(name)) {
    return true;
  }
  // run_node/run_python：**只有脚本真的跑成功**才算前进。"进程跑起来了"(env.ok)≠"脚本逻辑成功"——
  // 很多脚本 catch 后照样 exit 0 却打印报错/"对不上"，那是在死胡同里换脚本兜圈子、不是前进。
  // 实测教训：WASM 复刻兔子洞里 100+ 次 run_node 每次跑个坏 loader 全被当"前进"→ A1 无进展预算永远清零、
  // 永不触发换路线提示。故要求 exitCode===0 且合并输出里**没有异常签名**。
  if (/^run_(node|python)$/.test(name) && env.exitCode === 0 && !env.timedOut) {
    const out = String(env.output || "");
    const looksFailed =
      /Error:|Exception\b|Traceback|is not defined|is not a function|Cannot (read|find)|\babort(ed)?\b|ReferenceError|TypeError|SyntaxError|RangeError|ERR_[A-Z]|MODULE_NOT_FOUND|ENOENT|Unhandled|panicked|❌|不匹配|对不上|复刻失败|验证失败/i.test(
        out
      );
    return !looksFailed;
  }
  // net_get 拿到带发起者栈的请求 = 关键前进
  if (name === "net_get" && env.request && Array.isArray(env.request.initiatorStack) && env.request.initiatorStack.length) {
    return true;
  }
  // wasm_probe 抓到 wbg 调用 / webapi_query 有指纹 / 抓到非空列表 = 前进
  if (Array.isArray(env.calls) && env.calls.length) return true;
  if (typeof env.count === "number" && env.count > 0) return true;
  for (const k of ["requests", "hits", "entries", "records", "exports", "functions"]) {
    if (Array.isArray(env[k]) && env[k].length > 0) return true;
  }
  return false;
}

// 给失败的工具结果算一个"错误类别签名"：归一掉数字/hex/引号内容/路径 → 同类错误得同签名。
// 失败判定：env.ok===false；错误文本取 env.error，或 run_node/python 失败时合并输出的尾部。
function _errSig(name, env) {
  if (!env || env.ok) {
    return null;
  }
  const raw = env.error ? String(env.error) : env.output ? String(env.output) : "";
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
  if (m.tool_call_id) {
    n += 64;
  }
  return n;
}

/**
 * 把要发给模型的消息数组裁到上下文预算内（只用于 LLM 请求；loop 自身仍保留完整 msgs 用于返回/落盘）。
 * 规则：固定保留 system(首条) + 第一条 user(原始任务)；从尾部往前尽量多保留最近轮次；
 * 切片不能以"孤儿 tool"(其 assistant 已被裁)开头——会让 OpenAI 协议报错，故往后挪过开头的 tool；
 * 中间被裁处插一条省略提示。未超预算则原样返回。
 */
function trimContext(msgs) {
  let total = 0;
  for (const m of msgs) {
    total += _msgSize(m);
  }
  if (total <= MAX_CONTEXT_CHARS) {
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
  const budget = MAX_CONTEXT_CHARS - used;
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
    maxRounds = 6,
    maxPerTool = 8,
    signal,
    toolCtx = {},
    onEvent,
    onDelta,
    onReasoning, // 思考型模型的 reasoning_content 增量回调（供 UI 展示"思考过程"）
    onCheckpoint, // 上下文压缩时回调(summary)：引擎据此把进展落盘成一条可见回复 + 重置实时步骤
    getLedger, // 取任务账本注入块的回调(async→string)：每轮开头+每次压缩后拼进系统提示，确认事实永不衰减
    confirm,
    autoApprove = false,
    assist = false, // AI辅助逐阶段模式：无工具的纯文字回复=正常收尾（停下报告+给方向），不当 drift 逼它继续
    vision = false, // 模型是否支持看图：true 时把截图等图像作为 user 图片消息回喂
  } = p || {};

  if (!client || typeof client.chat !== "function") {
    throw new Error("runAgentTurn: client.chat required");
  }
  if (!router || typeof router.dispatch !== "function") {
    throw new Error("runAgentTurn: router required");
  }
  if (!Array.isArray(messages)) {
    throw new Error("runAgentTurn: messages array required");
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
      o.content = m.content;
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
    return o;
  };

  // 「始终注入账本」：把任务账本（已确认事实/已否决死路）拼到系统提示——每轮都在模型眼前，压缩后也重新拼
  // （getLedger 取最新、含本回合 remember 的新事实）→ "动手前先看账本、确认过的别重新发现" 成为自然行为
  // （retrieve-before-derive），不靠强制约束。baseSystem 单独留着，压缩重建时配最新账本重拼。
  const baseSystem = systemPrompt || "";
  let ledgerText = "";
  try {
    ledgerText = getLedger ? (await getLedger()) || "" : "";
  } catch {
    /* 账本可选，取不到不影响 */
  }
  const sysWithLedger = baseSystem + (ledgerText ? "\n\n" + ledgerText : "");
  let msgs = [];
  if (sysWithLedger) {
    msgs.push({ role: "system", content: sysWithLedger });
  }
  msgs.push(...messages.map(sanitize));

  // 压缩用锚点：system（永远保留）+ 本回合任务（初始 msgs 里最后一条 user，即用户这次的请求）。
  const systemMsg = msgs[0] && msgs[0].role === "system" ? msgs[0] : null;
  let taskAnchor = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user") {
      taskAnchor = msgs[i];
      break;
    }
  }

  const tools = router.listSpecs();
  const allToolCalls = [];
  const toolCounts = {}; // 每个工具本回合调用次数（防打转）
  const failSigs = {}; // (工具+错误签名) → 次数（反绕圈：同错反复出现就提示换路线）
  let consecErr = 0; // 连续失败计数（任意类型错；任一成功即清零）——抓"各种错连环=空转"
  let lastCompactRound = 0; // 上次压缩所在轮，避免阈值附近反复压缩
  let autoContinues = 0; // 连续"纯文字不调工具"的自动续跑计数（防过早结束 + 防死循环）
  let truncRetries = 0; // 【输出长度截断】专用重试计数——与 autoContinues 解耦，截断不算"漂移"，免误判停
  // A2 重复调用熔断：callSig → { fp:上次结果指纹, n:连续相同结果次数 }。同调用同结果≥阈值=空转，引擎拒执行。
  const repeatTracker = new Map();
  const REPEAT_BREAK_AT = 3;
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
      if (workSize > COMPACT_AT) {
        const anchorIdx = msgs.indexOf(taskAnchor);
        const fromIdx = anchorIdx >= 0 ? anchorIdx + 1 : 0;
        // 关键：用 **LLM 生成结构化交接摘要**（保留"已确认事实/文件清单/下一步"），而不是机械截取——
        // 机械摘要会丢掉已发现的结论，导致压缩后重新探索=循环失忆（这是把压缩做对的核心）。
        // LLM 摘要失败/超时再退回机械摘要，至少不丢压缩本身。
        let summary = "";
        try {
          summary = await summarizeForHandoff(client, msgs, fromIdx, signal);
        } catch {
          /* 摘要调用失败 → 机械兜底 */
        }
        if (!summary) {
          summary = buildCheckpointSummary(msgs, fromIdx);
        }
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
        const freshSys = baseSystem + (freshLedger ? "\n\n" + freshLedger : "");
        // 重建小上下文：system(含最新账本) + 任务锚点 + checkpoint(assistant) + 继续提示(user，保角色交替合法)
        msgs = [
          ...(freshSys ? [{ role: "system", content: freshSys }] : []),
          taskAnchor,
          { role: "assistant", content: summary },
          {
            role: "user",
            content:
              "（上面是你已完成的【进展存档】——已确认的事实/文件/下一步都在里面，也已落盘到工作目录 progress.md。" +
              "**直接据此继续推进剩余任务，不要重新 fs_list / notes_get / code_search / page_eval 去重新发现已经确认过的信息**；" +
              "只在需要某个具体旧细节时才 fs_read 对应文件。现在做存档里「下一步」指向的动作。）",
          },
        ];
        lastCompactRound = round;
      }
    }

    emit({ type: "round", round });
    const res = await client.chat(trimContext(msgs), { tools, signal, onDelta, onReasoning });

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
        emit({ type: "final", content: res.content, round });
        return {
          content: res.content || "",
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
    if (res.reasoningContent) {
      asstMsg.reasoning_content =
        res.reasoningContent.length > REASONING_FEEDBACK_CAP
          ? "…" + res.reasoningContent.slice(-REASONING_FEEDBACK_CAP)
          : res.reasoningContent;
    }
    msgs.push(asstMsg);

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
      const callSig = parseErr || REPEAT_EXEMPT.has(name) ? null : _callSig(name, args);
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
      } else if (toolCounts[name] > maxPerTool) {
        // 防打转：同一工具本回合已调用过多 → 不再执行，逼模型基于已有结果作答
        env = {
          ok: false,
          error: `已调用 ${name} 超过 ${maxPerTool} 次，重复调用不会有新结果；请基于已有信息直接作答，或换工具/换思路。`,
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
      if (callSig && !repeatBlocked) {
        const fp = _resultFp(env);
        const prev = repeatTracker.get(callSig);
        if (prev && prev.fp === fp) {
          prev.n += 1;
        } else {
          repeatTracker.set(callSig, { fp, n: 1 });
        }
      }

      // A1：真实前进则清零预算 + 清空强制决策态；否则累加。被熔断/被拒的不算前进。
      if (!repeatBlocked && _isProgress(name, env)) {
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
      if (contentStr.length > TOOL_RESULT_CAP) {
        const dropped = contentStr.length - TOOL_RESULT_CAP;
        contentStr =
          contentStr.slice(0, TOOL_RESULT_CAP) +
          `…⟪结果过大已截断 ${dropped} 字符（仅此条进上下文的部分）。别把大结果全塞进来：` +
          `要看全量用 fs_read 的 offset/limit 分段读对应落盘文件，或用 code_search 精确搜，而不是重复整块读取。⟫`;
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
      // 连续失败护栏（任意类型，不限同类）：连环失败=空转/退化 → 强提示停手。
      if (env && env.ok === false) {
        consecErr++;
        if (consecErr >= CONSEC_ERR_AT) {
          contentStr +=
            `\n\n⟪⚠ 连续 ${consecErr} 次工具调用都失败了——你在空转。**停止再发工具调用**：直接基于已有信息给结论，或明确说清卡在哪、需要什么（必要时让用户开新会话延续，已落盘进展不丢）。别再重试/猜参数/重发大内容。⟫`;
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
          msgs.push({ role: "user", content: blocks });
        }
      }
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
    const fin = await client.chat(trimContext(msgs), { signal, onDelta, onReasoning });
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

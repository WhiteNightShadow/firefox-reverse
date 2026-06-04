/* AgentEvalChild.sys.mjs — JSWindowActorChild：在「页面内容上下文」执行 JS（page_eval），
 * 并提供「请求发起者调用栈」捕获（逆向黄金路径：谁发起了请求＝谁生成了签名参数）。
 *
 * eval 跑在内容进程，用 Sandbox 以页面 principal 求值，能读页面 window/函数/变量。
 *
 * 发起者栈：用 **Services.obs 观察 http-on-opening-request**（DevTools network-events-stacktraces 同款）——
 * 该通知在内容进程、且**同步处于发起 fetch/xhr.send 的 JS 栈中**触发，此刻 Components.stack 就含页面
 * 发起代码的调用链。父进程的 http-on-modify-request 看不到 JS 栈（JS 跑在内容进程），故必须内容侧抓。
 * 采用 **pull 模型**：观察者把 {channelId,stack} 暂存到进程级 Map，父进程经 actor 的 drain 消息取走，
 * 避免 child→parent push 时 relay actor 生命周期（页面导航 actor 销毁）带来的丢失。
 */

const Cu = Components.utils;
const Ci = Components.interfaces;

// ── 进程级（模块单例，跨 actor 实例/页面导航存活）发起者栈捕获 ──
let _armed = false;
const _stash = new Map(); // channelId(string) → stack[]（capped）
const _netObs = {
  observe(subject, topic) {
    if (topic !== "http-on-opening-request") {
      return;
    }
    let ch;
    try {
      ch = subject.QueryInterface(Ci.nsIHttpChannel);
    } catch {
      return;
    }
    // 仅抓承载签名的请求类型，过滤 image/css/font/script 噪声
    const P = Ci.nsIContentPolicy;
    let type = 0;
    try {
      type = ch.loadInfo && ch.loadInfo.externalContentPolicyType;
    } catch {
      /* 取不到类型就不过滤 */
    }
    if (
      type &&
      type !== P.TYPE_XMLHTTPREQUEST &&
      type !== P.TYPE_FETCH &&
      type !== P.TYPE_BEACON &&
      type !== P.TYPE_WEBSOCKET
    ) {
      return;
    }
    let channelId = "";
    try {
      channelId = String(ch.channelId);
    } catch {
      return;
    }
    // Components.stack.caller 起就是页面发起代码（跨 chrome/content 边界连续）。
    const stack = [];
    let frame = Components.stack;
    if (frame && frame.caller) {
      frame = frame.caller;
      let n = 0;
      while (frame && n < 60) {
        stack.push({
          file: frame.filename,
          line: frame.lineNumber,
          col: frame.columnNumber,
          fn: frame.name || "(anonymous)",
          ...(frame.asyncCause ? { async: frame.asyncCause } : {}),
        });
        frame = frame.caller || frame.asyncCaller;
        n++;
      }
    }
    if (!stack.length) {
      return;
    }
    _stash.set(channelId, stack);
    if (_stash.size > 500) {
      _stash.delete(_stash.keys().next().value);
    }
  },
};
function armNetObserver() {
  if (_armed) {
    return;
  }
  try {
    Services.obs.addObserver(_netObs, "http-on-opening-request");
    _armed = true;
  } catch {
    /* ignore */
  }
}
function disarmNetObserver() {
  if (!_armed) {
    return;
  }
  try {
    Services.obs.removeObserver(_netObs, "http-on-opening-request");
  } catch {
    /* ignore */
  }
  _armed = false;
  _stash.clear();
}
function drainNetStacks() {
  const out = [];
  for (const [channelId, stack] of _stash) {
    out.push({ channelId, stack });
  }
  _stash.clear();
  return out;
}

function safeSerialize(v, depth = 0, seen) {
  const t = typeof v;
  if (v === null || t === "number" || t === "boolean") {
    return v;
  }
  if (t === "string") {
    return v.length > 20000 ? v.slice(0, 20000) + "…(truncated " + v.length + ")" : v;
  }
  if (t === "undefined") {
    return undefined;
  }
  if (t === "function") {
    return "[function " + (v.name || "anonymous") + "]";
  }
  if (t === "bigint" || t === "symbol") {
    return String(v);
  }
  // object/array：**循环安全** + 深度/广度受限递归。旧版 `JSON.parse(JSON.stringify(v))` 一遇循环引用就抛
  // "cyclic object value"、退化成 String(v)="[object Object]"（没法看）——RE 里常要查含循环引用的运行时对象
  // （signer 内部 state、框架对象），所以这里用 seen(WeakSet) 标循环 + 限深限广，产出仍是结构化可经 actor 回传。
  if (depth >= 6) {
    return Array.isArray(v) ? "[Array]" : "[Object]";
  }
  seen = seen || new WeakSet();
  try {
    if (seen.has(v)) {
      return "[Circular]";
    }
    seen.add(v);
  } catch {
    return String(v);
  }
  try {
    if (Array.isArray(v)) {
      const n = Math.min(v.length, 200);
      const out = [];
      for (let i = 0; i < n; i++) {
        out.push(safeSerialize(v[i], depth + 1, seen));
      }
      if (v.length > n) {
        out.push("…(+" + (v.length - n) + " more)");
      }
      return out;
    }
    let keys;
    try {
      keys = Object.keys(v);
    } catch {
      return String(v);
    }
    const out = {};
    const n = Math.min(keys.length, 200);
    for (let i = 0; i < n; i++) {
      const k = keys[i];
      try {
        out[k] = safeSerialize(v[k], depth + 1, seen); // 逐属性 try：触发的 getter 抛错不毁全局
      } catch {
        out[k] = "[getter threw]";
      }
    }
    if (keys.length > n) {
      out["…"] = "(+" + (keys.length - n) + " more keys)";
    }
    return out;
  } catch {
    try {
      return String(v);
    } catch {
      return "[unserializable]";
    }
  }
}

// ── 引擎层「签名器真实入参」捕获（SpiderMonkey Debugger API：只**观测**页面函数调用、读 frame.arguments，
//    从特权 compartment 旁观，**不注入页面 JS、不改页面全局**——满足"hook 在引擎层"红线，等同 jsvmp/webapi tracer
//    的 JS 版）。专治"签名器到底喂了什么真实入参"（如签名函数收到的 URL/参数实参），免去逐字节破解+暴力猜输入。
//    进程级单例（跨 actor 实例/tool 调用存活）：start 装观测 → 页内触发请求 → query 取捕获 → stop 关。
let _dbg = null;
let _dbgCaps = [];
let _dbgConf = null;

// ── P5 白盒：浏览器侧"分支覆盖真值"采集（同款引擎层 Debugger + collectCoverageInfo）──
// 与 signer_trace 同一机制（分离 compartment、页面测不到），但开覆盖采集而非 onEnterFrame：
// getOffsetsCoverage() 给每个字节码偏移的命中数 → count==0=未走分支、>0=走了。归一化成
// whitebox_diff 吃的 schema，与 Node 复刻覆盖按"源码行"对齐找分叉。覆盖须在脚本运行时采集，
// 故 start(arm)→页内触发一次执行→query。
let _wbDbg = null;
let _wbConf = null;

// 把 Debugger.Object / 原始值安全描述成可经 actor 消息回传的普通值（深度≤2、截断大字符串）。
// 字符串/数字直接回（签名器的 url/ts 实参就是原始值）；对象浅层 dump 出原始属性（如请求配置 e 的 url/method/params）。
function describeDbgArg(v, depth = 0) {
  const t = typeof v;
  if (v === null || t === "undefined" || t === "boolean" || t === "number") {
    return v;
  }
  if (t === "string") {
    return v.length > 2000 ? v.slice(0, 2000) + "…(截断)" : v;
  }
  if (t === "bigint" || t === "symbol") {
    return String(v);
  }
  if (v && t === "object") {
    // Debugger.Object
    let cls = "Object";
    try {
      cls = v.class || "Object";
    } catch {
      /* ignore */
    }
    if (depth >= 2) {
      return "[" + cls + "]";
    }
    const out = {};
    let names = [];
    try {
      names = v.getOwnPropertyNames().slice(0, 40);
    } catch {
      /* 取不到属性名 */
    }
    for (const n of names) {
      let d;
      try {
        d = v.getOwnPropertyDescriptor(n);
      } catch {
        continue;
      }
      if (d && "value" in d) {
        out[n] = describeDbgArg(d.value, depth + 1);
      }
    }
    return Object.keys(out).length ? out : "[" + cls + "]";
  }
  try {
    return String(v);
  } catch {
    return "[unserializable]";
  }
}

function signerTraceStop() {
  try {
    if (_dbg) {
      try {
        _dbg.onEnterFrame = undefined;
      } catch {
        /* ignore */
      }
      try {
        _dbg.removeAllDebuggees();
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  const n = _dbgCaps.length;
  _dbg = null; // 保留 _dbgCaps，允许 stop 后再 query 取走
  return { ok: true, capturedBeforeStop: n };
}

function signerTraceStart(win, { scriptUrl = "", fn = "", line = null, maxCalls = 12, argMatch = "" } = {}) {
  signerTraceStop();
  _dbgCaps = [];
  if (!win) {
    return { ok: false, error: "no content window（页面没加载完？）" };
  }
  if (!scriptUrl && !fn && line == null) {
    return {
      ok: false,
      error: "至少给 scriptUrl(脚本URL子串) / fn(函数名) / line(定义行) 之一来锁定目标函数——全空会抓全页面每个函数=噪声爆炸、还卡页面。",
    };
  }
  let DebuggerCtor;
  try {
    const { addDebuggerToGlobal } = ChromeUtils.importESModule("resource://gre/modules/jsdebugger.sys.mjs");
    addDebuggerToGlobal(globalThis);
    DebuggerCtor = globalThis.Debugger;
  } catch (e) {
    return { ok: false, error: "Debugger API 不可用: " + ((e && e.message) || e) };
  }
  let dbg;
  try {
    dbg = new DebuggerCtor(win);
  } catch (e) {
    return { ok: false, error: "attach Debugger 失败: " + ((e && e.message) || e) };
  }
  // 一次性算出目标脚本集合（按 url 子串 / 行匹配）→ onEnterFrame 里 O(1) 判定（Set 成员），避免每帧字符串比较卡页面。
  // 仅当给了 scriptUrl / line 才预筛脚本；只给 fn 时不预筛（targets 空→onEnterFrame 退化为逐帧按函数名匹配）。
  const targets = new Set();
  let scanned = 0;
  if (scriptUrl || line != null) {
    try {
      for (const scr of dbg.findScripts()) {
        scanned++;
        const u = scr.url || "";
        if (scriptUrl && !u.includes(scriptUrl)) {
          continue;
        }
        if (line != null) {
          const sl = scr.startLine || 0;
          const lc = scr.lineCount || 1;
          if (!(line >= sl - 1 && line <= sl + lc + 1)) {
            continue;
          }
        }
        targets.add(scr);
      }
    } catch {
      /* findScripts 失败 → 退化到 onEnterFrame 里按 url 子串逐帧判 */
    }
  }
  // 跨导航/新全局存活：SPA 换路由 / 整页导航 / iframe / worker 产生新全局时，把它加为 debuggee，
  // 这样"签名请求只在页面加载期发 / 在 arm 之前已发"也能抓到（实战痛点：count=0 多半就是没新请求触发）。
  dbg.onNewGlobalObject = g => {
    try {
      dbg.addDebuggee(g);
      if (line != null) {
        // line-only 匹配靠 targets Set；把新全局里匹配的脚本补进去。
        for (const scr of dbg.findScripts()) {
          const u = scr.url || "";
          if (scriptUrl && !u.includes(scriptUrl)) {
            continue;
          }
          const sl = scr.startLine || 0;
          const lc = scr.lineCount || 1;
          if (line >= sl - 1 && line <= sl + lc + 1) {
            targets.add(scr);
          }
        }
      }
    } catch {
      /* 新全局加 debuggee 失败(非内容全局等)忽略 */
    }
  };
  _dbg = dbg;
  _dbgConf = { scriptUrl, fn, line, maxCalls, argMatch: argMatch || null, targetScripts: targets.size, scannedScripts: scanned };
  const argMatchRe = argMatch ? (() => { try { return new RegExp(argMatch, "i"); } catch { return null; } })() : null;
  let _examined = 0;
  let _frameTotal = 0;
  const _armedAt = Date.now();
  const FRAME_HARD_CAP = 2000000; // 总帧数硬上限：即便一直不匹配，跑够这么多帧也强制卸载，绝不无限拖死页面
  const TRACE_TTL_MS = 30000; // 时间盒：装好 30s 后自动卸载（agent 几秒内就触发；遗留 trace 也自愈，页面不被永久拖慢）
  dbg.onEnterFrame = frame => {
    // 【廉价总量/时间安全阀，放最前、每帧必走】onEnterFrame 在页面**每一帧**都触发；若 scriptUrl/fn 匹配不到
    // （targets 空 → 退化逐帧 url 子串判定），旧的 `_examined` 阀只数"命中"、永远到不了 → 内容进程被无限拖死
    // （实测：signer_trace 钩错目标后 page_eval 连 about:blank 都 20s 超时）。故这里数**总调用次数 + 墙钟**，
    // 无论匹配与否都强制自卸，把"wedge 页面"限制在 ≤30s 且自愈。位运算掩码每 8192 帧才查一次 Date.now()，开销极小。
    if (++_frameTotal > FRAME_HARD_CAP || ((_frameTotal & 0x1fff) === 0 && Date.now() - _armedAt > TRACE_TTL_MS)) {
      try {
        dbg.onEnterFrame = undefined;
        dbg.removeAllDebuggees();
      } catch {
        /* 卸载失败忽略 */
      }
      return;
    }
    try {
      const scr = frame.script;
      // 脚本匹配：scriptUrl → targets(快) 或 url 子串(覆盖导航后的新全局/新编译脚本)；line-only → 靠 targets。
      // 只给 fn（不给 scriptUrl/line）时不按脚本过滤，纯按函数名匹配（适合"知道函数名但不知在哪个脚本"）。
      if (scriptUrl) {
        if (!(targets.has(scr) || (((scr && scr.url) || "").includes(scriptUrl)))) {
          return;
        }
      } else if (line != null) {
        if (!targets.has(scr)) {
          return;
        }
      }
      let name = "";
      try {
        name = (frame.callee && frame.callee.name) || (scr && scr.displayName) || "";
      } catch {
        /* ignore */
      }
      if (fn && !(name === fn || String(name).includes(fn))) {
        return;
      }
      let args = [];
      try {
        args = (frame.arguments || []).map(a => describeDbgArg(a));
      } catch {
        /* ignore */
      }
      // argMatch：只留**实参里有匹配项**的调用——直接跳过初始化那些传配置对象的调用，精准抓 sign(url,ts)。
      // 治本实战痛点："参数入口一直没拦截到"——init 的几次调用占满了，真正的 sign 在它们之后被漏掉。
      if (argMatchRe) {
        let hit = false;
        for (const a of args) {
          try { if (argMatchRe.test(typeof a === "string" ? a : JSON.stringify(a))) { hit = true; break; } } catch {}
        }
        if (!hit) {
          return;
        }
      }
      // 环形缓冲：保留**最后** maxCalls 条匹配调用（旧设计"抓满前 maxCalls 就停 onEnterFrame"会把 init 之后才发生的
      // sign 调用永久漏掉——这就是实战里 signer_trace 反复 count=8 全是 init、抓不到真 sign 的根因）。
      _dbgCaps.push({ fn: name || "(anonymous)", url: (scr && scr.url) || "", line: (scr && scr.startLine) || null, args });
      if (_dbgCaps.length > maxCalls) {
        _dbgCaps.shift();
      }
      if (++_examined > 5000) {
        dbg.onEnterFrame = undefined; // runaway 安全阀（给了 argMatch 基本到不了；纯监控也够久）
      }
    } catch {
      /* 单帧异常绝不影响页面执行 */
    }
  };
  return {
    ok: true,
    armed: true,
    targetScripts: targets.size,
    scannedScripts: scanned,
    note:
      `已装好观测（预匹配 ${targets.size} 个脚本，观测**跨导航存活**）。现在**触发一次真实签名请求**` +
      `（page_click/page_scroll/page_navigate 都行；目标接口只首屏触发就直接 page_navigate 重载），再 signer_trace(action:query) 取真实入参。` +
      (targets.size === 0 && scriptUrl
        ? ` 注：暂未预匹配到 scriptUrl=「${scriptUrl}」的已编译脚本（可能还没加载）——已退化为逐帧 url 子串判定 + 新全局自动接管，触发后应能抓到；query 仍空就核对子串是否准确。`
        : ""),
  };
}

function whiteboxCovStop() {
  try {
    if (_wbDbg) {
      try { _wbDbg.onNewGlobalObject = undefined; } catch {}
      try { _wbDbg.collectCoverageInfo = false; } catch {}
      try { _wbDbg.removeAllDebuggees(); } catch {}
    }
  } catch {}
  _wbDbg = null;
  return { ok: true };
}

function whiteboxCovStart(win, { scriptUrl = "" } = {}) {
  whiteboxCovStop();
  if (!win) {
    return { ok: false, error: "no content window（页面没加载完？）" };
  }
  if (!scriptUrl) {
    return { ok: false, error: "需要 scriptUrl（目标脚本 URL 子串）锁定要采覆盖的脚本——全页采覆盖会卡。" };
  }
  let DebuggerCtor;
  try {
    const { addDebuggerToGlobal } = ChromeUtils.importESModule("resource://gre/modules/jsdebugger.sys.mjs");
    addDebuggerToGlobal(globalThis);
    DebuggerCtor = globalThis.Debugger;
  } catch (e) {
    return { ok: false, error: "Debugger API 不可用: " + ((e && e.message) || e) };
  }
  let dbg;
  try {
    dbg = new DebuggerCtor(win);
  } catch (e) {
    return { ok: false, error: "attach Debugger 失败: " + ((e && e.message) || e) };
  }
  try {
    dbg.collectCoverageInfo = true; // 引擎内部 PCCount 计数（非 JS 可见、不改 toString）；覆盖从此刻起对运行的脚本生效
  } catch (e) {
    return { ok: false, error: "collectCoverageInfo 不支持: " + ((e && e.message) || e) };
  }
  // 跨导航/新全局存活：整页刷新/SPA 换页产生新全局时继续采（覆盖须在脚本运行时采集，常需重载触发）。
  dbg.onNewGlobalObject = g => {
    try { dbg.addDebuggee(g); } catch { /* 非内容全局忽略 */ }
  };
  _wbDbg = dbg;
  _wbConf = { scriptUrl };
  return {
    ok: true, armed: true,
    note:
      `已装分支覆盖采集（scriptUrl=「${scriptUrl}」，跨导航存活）。**覆盖须在脚本运行时采集**——现在` +
      `触发一次真实执行（目标多在页面加载/交互时跑，直接 page_navigate 重载目标页最稳），再 whitebox_diff(action:query) 取分支覆盖。`,
  };
}

function whiteboxCovQuery() {
  if (!_wbDbg) {
    return { ok: false, error: "未 arm（先 whitebox_diff action:start）" };
  }
  const scriptUrl = (_wbConf && _wbConf.scriptUrl) || "";
  const scriptsOut = {};
  let scanned = 0, matched = 0, withCov = 0;
  const basename = u => String(u).replace(/^[a-z]+:\/\//, "").split(/[?#]/)[0].split("/").pop() || String(u);
  const shortUrl = u => String(u).replace(/^[a-z]+:\/\//, "").split("/").slice(-2).join("/");
  try {
    for (const scr of _wbDbg.findScripts()) {
      scanned++;
      const url = (scr && scr.url) || "";
      if (scriptUrl && !url.includes(scriptUrl)) {
        continue;
      }
      matched++;
      let cov = null;
      try { cov = scr.getOffsetsCoverage(); } catch { /* 该脚本无覆盖数据 */ }
      if (!cov) {
        continue;
      }
      withCov++;
      const key = basename(url);
      let lines = null, lineStarts = null;
      try {
        const t = scr.source && scr.source.text;
        if (t) { lines = t.split("\n"); lineStarts = [0]; let acc = 0; for (const L of lines) { acc += L.length + 1; lineStarts.push(acc); } }
      } catch {}
      let e = scriptsOut[key];
      if (!e) { e = scriptsOut[key] = { url: shortUrl(url), taken: [], notTaken: [] }; }
      const fn = (scr.displayName) || "(anon)";
      for (const c of cov) {
        const lnIdx = (c.lineNumber || 1) - 1;
        const ln = lines ? (lines[lnIdx] || "") : "";
        const from = Math.max(0, (c.columnNumber || 1) - 1);   // SpiderMonkey columnNumber 视为 1-based → 0-based 偏移（真机校准）
        // startOffset：原文字符偏移（与 Node 侧剥 wrapper 后的偏移同坐标系）→ diff 按偏移跨引擎对齐
        const startOffset = lineStarts ? ((lineStarts[lnIdx] || 0) + from) : null;
        const rec = {
          fn, line: c.lineNumber, col: c.columnNumber, startOffset,
          snippet: ln ? ln.slice(from, from + 90).trim() : null,
          lineText: ln ? ln.slice(0, 200).trim() : null,   // 整行(含条件)→ driver 认 env 名
        };
        if (c.count > 0) { if (e.taken.length < 5000) e.taken.push(rec); }
        else { if (e.notTaken.length < 5000) e.notTaken.push(rec); }
      }
    }
  } catch (e) {
    return { ok: false, error: "覆盖采集失败: " + ((e && e.message) || e) };
  }
  return {
    ok: true, side: "browser", scripts: scriptsOut, scanned, matched, withCov,
    note: withCov
      ? `采到 ${withCov} 个匹配脚本的分支覆盖（真值）。`
      : `匹配 ${matched} 脚本但无覆盖数据——多半是 arm 后没重新触发执行（覆盖须在脚本运行时采集）。page_navigate 重载目标页再 query。`,
  };
}

export class AgentEvalChild extends JSWindowActorChild {
  async receiveMessage(message) {
    // ── 发起者栈控制（父进程 NetworkBackend 经 PageBackend 驱动）──
    if (message.name === "arm-netstack") {
      armNetObserver();
      return { ok: true, armed: _armed };
    }
    if (message.name === "disarm-netstack") {
      disarmNetObserver();
      return { ok: true };
    }
    if (message.name === "drain-netstack") {
      return { ok: true, stacks: drainNetStacks() };
    }
    // ── 签名器真实入参捕获（引擎层 Debugger 观测）──
    if (message.name === "signer-trace-start") {
      return signerTraceStart(this.contentWindow, message.data || {});
    }
    if (message.name === "signer-trace-query") {
      // 显示**最后** 20 条匹配调用——环形缓冲里 sign(在 init 之后)落在末尾，slice(-20) 才看得到它。
      return { ok: true, armed: !!_dbg, count: _dbgCaps.length, captures: _dbgCaps.slice(-20), conf: _dbgConf };
    }
    if (message.name === "signer-trace-stop") {
      return signerTraceStop();
    }
    // ── P5 白盒：浏览器侧分支覆盖真值（引擎层 Debugger collectCoverageInfo）──
    if (message.name === "whitebox-cov-start") {
      return whiteboxCovStart(this.contentWindow, message.data || {});
    }
    if (message.name === "whitebox-cov-query") {
      return whiteboxCovQuery();
    }
    if (message.name === "whitebox-cov-stop") {
      return whiteboxCovStop();
    }
    if (message.name !== "eval") {
      return null;
    }
    const { expression, awaitPromise = true } = message.data || {};
    const win = this.contentWindow;
    if (!win) {
      return { ok: false, error: "no content window" };
    }
    try {
      const sandbox = Cu.Sandbox(win, { sandboxPrototype: win, wantXrays: false });
      let result = Cu.evalInSandbox(`(function(){ return (${expression}); })()`, sandbox);
      if (awaitPromise && result && typeof result.then === "function") {
        result = await result;
      }
      return { ok: true, value: safeSerialize(result), type: typeof result };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }
}

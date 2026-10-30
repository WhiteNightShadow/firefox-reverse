/* PageDebugger.sys.mjs — debug_breakpoint 的内容侧：引擎层 Debugger 快照断点。
 *
 * 命中时**不暂停页面**：读这一帧的实参、this、作用域链上的变量和调用栈，存进环形缓冲就放行，页面照常跑。
 * 三种下断方式：
 *   text  源码片段（混淆代码没法按行号找：给一段独一无二的代码文本，定位到它后第一个可下断的字节码位置）
 *   line  行号（+ 可选列号）
 *   xhr   请求 url 匹配：http-on-opening-request 在内容进程里同步处于发起请求的 JS 栈中，此刻 getNewestFrame()
 *         就是页面里调 fetch/xhr.send 的那一帧，不用往页面注入任何东西
 * 与 signer_trace 同一机制（分离 compartment、页面测不到）；跨导航存活：新全局自动接管，脚本重新编译时重新下断。
 */
import { describeDbgArg, describeDbgDeep, previewDbg } from "./DebuggerValues.sys.mjs";

const HIT_HARD_CAP = 2000; // 总命中上限：热路径上的断点自动卸掉，别把内容进程拖死
const TTL_MS = 10 * 60 * 1000; // 时间盒：忘了 stop 也会自愈
const NAMES_PER_SCOPE = 60;
const STACK_DEPTH = 20;
const MAX_HITS = 50;

/** url 模式：带 * ? 的按 fnmatch，否则按子串。 */
export function urlMatcher(pattern) {
  const p = String(pattern || "");
  if (!p) return () => true;
  if (!/[*?]/.test(p)) return url => url.includes(p);
  const re = new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
  return url => re.test(url);
}

/** 在源码里找第 occurrence 次出现的 text，给出 1 起始的行、列（列按 UTF-16 单元数，和 Debugger 一致）。 */
export function locateText(sourceText, text, occurrence = 1) {
  if (!text) return null;
  let index = -1;
  for (let i = 0; i < Math.max(1, occurrence); i++) {
    index = sourceText.indexOf(text, index + 1);
    if (index < 0) return null;
  }
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < index; i++) {
    if (sourceText.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { index, line, column: index - lineStart + 1 };
}

function defaultDebugger(win) {
  const { addDebuggerToGlobal } = ChromeUtils.importESModule("resource://gre/modules/jsdebugger.sys.mjs");
  addDebuggerToGlobal(globalThis);
  return new globalThis.Debugger(win);
}

function defaultRequestTypes() {
  const P = Ci.nsIContentPolicy;
  return new Set([P.TYPE_XMLHTTPREQUEST, P.TYPE_FETCH, P.TYPE_BEACON, P.TYPE_WEBSOCKET]);
}

function safe(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export class PageDebugger {
  constructor({ createDebugger = defaultDebugger, observers = () => Services.obs, requestTypes = defaultRequestTypes, now = Date.now } = {}) {
    this.createDebugger = createDebugger;
    this.observers = observers;
    this.requestTypes = requestTypes;
    this.now = now;
    this.dbg = null;
    this.conf = null;
    this.hits = [];
    this.applied = [];
    this.stats = null;
    this.handledSources = new Set();
    this.observer = null;
  }

  get armed() {
    return !!this.dbg;
  }

  start(win, options = {}) {
    this.stop();
    const { scriptUrl = "", text = "", occurrence = 1, line = null, column = null, xhr = "", condition = "", vars = "", scopeDepth = 3, maxHits = 10, depth = 3, maxArr = 256 } = options;
    if (!win) return { ok: false, error: "no content window（页面没加载完？）" };
    const mode = text ? "text" : line != null ? "line" : xhr ? "xhr" : "";
    if (!mode) return { ok: false, error: "要给 text（源码片段）、line（行号）或 xhr（请求 url 匹配）之一来定位断点" };
    if (mode === "line" && !scriptUrl) return { ok: false, error: "按行号下断要同时给 scriptUrl（脚本 url 子串），否则不知道是哪个文件的第几行" };
    let dbg;
    try {
      dbg = this.createDebugger(win);
    } catch (e) {
      return { ok: false, error: "Debugger API 不可用: " + ((e && e.message) || e) };
    }
    this.dbg = dbg;
    this.conf = {
      mode, scriptUrl, text, occurrence: Math.max(1, Number(occurrence) || 1), line, column, xhr, condition,
      vars: String(vars || "").split(",").map(s => s.trim()).filter(Boolean),
      scopeDepth: Math.max(0, Math.min(10, Number(scopeDepth) || 0)),
      maxHits: Math.max(1, Math.min(MAX_HITS, Number(maxHits) || 10)),
      depth: Math.max(1, Math.min(8, Number(depth) || 3)),
      maxArr: Math.max(1, Math.min(4096, Number(maxArr) || 256)),
    };
    this.hits = [];
    this.applied = [];
    this.handledSources = new Set();
    this.stats = { total: 0, skippedByCondition: 0, conditionErrors: 0, scanned: 0, armedAt: this.now() };
    if (mode === "xhr") {
      this._armRequests();
    } else {
      this._scan();
      dbg.onNewScript = script => {
        try {
          this._consider(script.source, script.url || "");
        } catch {}
      };
    }
    // 新全局（整页导航 / iframe）自动接管；脚本重新编译时 onNewScript 会重新下断。
    dbg.onNewGlobalObject = global => {
      try {
        dbg.addDebuggee(global);
      } catch {}
    };
    return {
      ok: true,
      armed: true,
      mode,
      applied: this.applied.slice(),
      scanned: this.stats.scanned,
      note: this._startNote(),
    };
  }

  _startNote() {
    const { mode, scriptUrl, text } = this.conf;
    if (mode === "xhr") {
      return "已装好请求断点：之后匹配到的 fetch/XHR/beacon 发出那一刻，抓发起它的页面调用帧（实参、作用域变量、调用栈），不暂停页面。触发一次请求后 debug_breakpoint(action:query) 读取。";
    }
    if (!this.applied.length) {
      return `暂未在已编译脚本里定位到${mode === "text" ? "这段文本" : "这一行"}（脚本还没加载、或 scriptUrl「${scriptUrl}」/文本不准确？）。已登记：目标脚本一旦编译（page_navigate 重载也算）会自动下断；触发后 query 仍空就核对 scriptUrl 子串和 text 是否逐字一致。`;
    }
    return `已在 ${this.applied.length} 处下断（${this.applied.map(a => `${a.url.split("/").pop()}:${a.line}:${a.column}`).join("、")}）：命中时抓实参、this、作用域变量和调用栈，不暂停页面。现在触发页面执行到这里（交互或 page_navigate 重载），再 debug_breakpoint(action:query) 读取。` +
      (mode === "text" && text.length < 12 ? " 文本很短，可能定位到别处的同样片段；query 看 url:line 不对就换一段更独特的文本。" : "");
  }

  /** 已编译脚本里按 url 子串找目标源，逐个源下断。 */
  _scan() {
    const { scriptUrl } = this.conf;
    const sources = new Map();
    for (const script of safe(() => this.dbg.findScripts(), [])) {
      this.stats.scanned++;
      const url = script.url || "";
      if (scriptUrl && !url.includes(scriptUrl)) continue;
      if (script.source && !sources.has(script.source)) sources.set(script.source, url);
    }
    for (const [source, url] of sources) this._consider(source, url);
  }

  /** 一个源只处理一次：定位目标行列，在覆盖该位置的脚本里挑最贴近的可下断点。 */
  _consider(source, url) {
    const { mode, scriptUrl, text, occurrence, line, column } = this.conf;
    if (!source || this.handledSources.has(source)) return;
    if (scriptUrl && !String(url || "").includes(scriptUrl)) return;
    let target;
    if (mode === "text") {
      const sourceText = safe(() => source.text, "");
      const found = locateText(String(sourceText || ""), text, occurrence);
      if (!found) return; // 不是这个源：别标记，同 url 的其它源还要看
      const startLine = Number(safe(() => source.startLine, 1)) || 1;
      target = { line: startLine + found.line - 1, column: found.line === 1 ? (Number(safe(() => source.startColumn, 1)) || 1) + found.column - 1 : found.column };
    } else {
      target = { line: Number(line), column: column != null ? Number(column) : null };
    }
    this.handledSources.add(source);
    const candidates = [];
    for (const script of safe(() => this.dbg.findScripts({ source }), [])) {
      const points = safe(() => script.getPossibleBreakpoints({ line: target.line }), []);
      for (const point of points) {
        if (target.column != null && point.columnNumber < target.column) continue;
        candidates.push({ script, point, lineCount: Number(safe(() => script.lineCount, 0)) || 0 });
      }
    }
    if (!candidates.length) return;
    // 最贴近目标列的；同列时取最内层（行数最少）的函数。
    candidates.sort((a, b) => a.point.columnNumber - b.point.columnNumber || a.lineCount - b.lineCount);
    const { script, point } = candidates[0];
    try {
      script.setBreakpoint(point.offset, { hit: frame => this._hit(frame, {}) });
    } catch {
      return;
    }
    this.applied.push({ url: script.url || url || "", line: point.lineNumber, column: point.columnNumber, fn: safe(() => script.displayName, "") || "" });
  }

  _armRequests() {
    const match = urlMatcher(this.conf.xhr);
    const types = this.requestTypes();
    this.observer = {
      observe: (subject, topic) => {
        if (topic !== "http-on-opening-request" || !this.dbg) return;
        let channel;
        try {
          channel = subject.QueryInterface(Ci.nsIHttpChannel);
        } catch {
          return;
        }
        const type = safe(() => channel.loadInfo?.externalContentPolicyType, 0);
        if (type && !types.has(type)) return;
        const url = safe(() => channel.URI.spec, "");
        if (!match(url)) return;
        const frame = safe(() => this.dbg.getNewestFrame(), null);
        if (!frame) return;
        this._hit(frame, { request: { url: url.slice(0, 500), method: safe(() => channel.requestMethod, "") } });
      },
    };
    this.observers().addObserver(this.observer, "http-on-opening-request");
  }

  /** 断点/请求命中：按条件过滤后快照，然后放行（返回 undefined = 继续执行）。 */
  _hit(frame, extra) {
    try {
      if (!this.dbg || !this.stats) return undefined;
      this.stats.total++;
      if (this.stats.total > HIT_HARD_CAP || this.now() - this.stats.armedAt > TTL_MS) {
        this.stop();
        return undefined;
      }
      if (this.conf.condition) {
        const completion = safe(() => frame.eval(this.conf.condition), { throw: true });
        if (!completion || "throw" in completion) {
          this.stats.conditionErrors++;
          return undefined;
        }
        if (!completion.return) {
          this.stats.skippedByCondition++;
          return undefined;
        }
      }
      this.hits.push(this._snapshot(frame, extra));
      if (this.hits.length > this.conf.maxHits) this.hits.shift();
    } catch {
      /* 单次命中异常绝不影响页面 */
    }
    return undefined;
  }

  _location(frame) {
    const script = safe(() => frame.script, null);
    const meta = script && frame.offset != null ? safe(() => script.getOffsetMetadata(frame.offset), null) : null;
    return {
      fn: safe(() => frame.callee?.name, "") || safe(() => script?.displayName, "") || "(anonymous)",
      url: safe(() => script?.url, "") || "",
      line: meta?.lineNumber ?? safe(() => script?.startLine, null),
      column: meta?.columnNumber ?? null,
    };
  }

  _snapshot(frame, extra) {
    const { scopeDepth, vars, depth, maxArr } = this.conf;
    const hit = { n: this.stats.total, t: this.now(), ...this._location(frame), ...extra };
    hit.this = previewDbg(safe(() => frame.this));
    hit.arguments = (safe(() => frame.arguments, null) || []).map(a => describeDbgArg(a));
    hit.scopes = [];
    let env = safe(() => frame.environment, null);
    for (let i = 0; env && i < scopeDepth; i++) {
      const names = safe(() => env.names(), []) || [];
      const values = {};
      for (const name of names.slice(0, NAMES_PER_SCOPE)) values[name] = previewDbg(safe(() => env.getVariable(name)));
      hit.scopes.push({
        type: safe(() => env.type, ""),
        callee: safe(() => env.calleeScript?.displayName, "") || undefined,
        names: values,
        ...(names.length > NAMES_PER_SCOPE ? { more: names.length - NAMES_PER_SCOPE } : {}),
      });
      env = safe(() => env.parent, null);
    }
    if (vars.length) {
      hit.vars = {};
      for (const name of vars) {
        let scope = safe(() => frame.environment, null);
        let found = false;
        while (scope && !found) {
          if ((safe(() => scope.names(), []) || []).includes(name)) {
            hit.vars[name] = describeDbgDeep(safe(() => scope.getVariable(name)), 0, depth, maxArr);
            found = true;
          }
          scope = safe(() => scope.parent, null);
        }
        if (!found) hit.vars[name] = "[not in scope]";
      }
    }
    hit.stack = [];
    for (let f = frame, i = 0; f && i < STACK_DEPTH; f = safe(() => f.older, null), i++) {
      const at = this._location(f);
      hit.stack.push(`${at.fn}@${at.url || "?"}:${at.line ?? "?"}:${at.column ?? "?"}`);
    }
    return hit;
  }

  query({ limit } = {}) {
    const n = Math.max(1, Math.min(MAX_HITS, Number(limit) || MAX_HITS));
    const hits = this.hits.slice(-n);
    return {
      ok: true,
      armed: this.armed,
      mode: this.conf?.mode || null,
      count: hits.length,
      total: this.stats?.total || 0,
      applied: this.applied.slice(),
      skippedByCondition: this.stats?.skippedByCondition || 0,
      conditionErrors: this.stats?.conditionErrors || 0,
      hits,
      note: hits.length
        ? "每条 hit：fn/url:line:column 是命中位置，arguments 是实参，scopes 从最内层作用域往外列变量预览，vars 是指定变量的深序列化，stack 是调用栈（最上面是命中帧）。"
        : this.armed
          ? "还没有命中：触发页面执行到断点处（交互 / page_navigate 重载），或核对 applied 里的位置是否正确。"
          : "断点已停止，没有留下命中记录。",
    };
  }

  stop() {
    const dbg = this.dbg;
    if (dbg) {
      try { dbg.onNewScript = undefined; } catch {}
      try { dbg.onNewGlobalObject = undefined; } catch {}
      try { dbg.clearAllBreakpoints(); } catch {}
      try { dbg.removeAllDebuggees(); } catch {}
    }
    if (this.observer) {
      try { this.observers().removeObserver(this.observer, "http-on-opening-request"); } catch {}
      this.observer = null;
    }
    this.dbg = null;
    return { ok: true, capturedBeforeStop: this.hits.length };
  }
}

/* NetworkBackend.sys.mjs — 网络捕获控制（parent，http-on-* 观察者）。
 *
 * 用 Services.obs 订阅 http-on-modify-request / http-on-examine-response，
 * 在父进程看到所有 HTTP/XHR/fetch 通道（无需内容侧 hook，JS 不可见）。
 * 用 WeakMap 关联同一 nsIHttpChannel 的请求/响应两次回调。
 */

const REQ_TOPIC = "http-on-modify-request";
const RESP_TOPICS = ["http-on-examine-response", "http-on-examine-cached-response", "http-on-examine-merged-response"];

function globToRe(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(esc);
}
function visit(fn) {
  const h = {};
  try {
    fn({ visitHeader: (n, v) => (h[n] = v) });
  } catch {}
  return h;
}

export class NetworkBackend {
  constructor({ max = 3000, page = null } = {}) {
    this._on = false;
    this._buf = [];
    this._max = max;
    this._seq = 0;
    this._pattern = null;
    this._map = new WeakMap();
    this._obs = this.observe.bind(this);
    this._page = page; // 用于 arm/drain 内容侧发起者栈捕获
    // channelId → 发起者栈，用于"栈先于 http-on-modify-request 到达"的乱序情况暂存（有界）。
    this._pendingStacks = new Map();
  }

  /** 把内容侧 drain 来的发起者栈按 channelId 合并进请求记录（list/get 前调）。 */
  async _drainStacks(ctx) {
    if (!this._page || !this._page.drainNetStack) {
      return;
    }
    try {
      const arr = await this._page.drainNetStack(undefined, ctx);
      for (const s of arr) {
        this.recordStack(s.channelId, s.stack);
      }
    } catch {
      /* drain 失败不影响列表/取详情 */
    }
  }

  /** 按 channelId 合并发起者栈进请求记录（drain 后、或乱序暂存）。 */
  recordStack(channelId, stack) {
    const id = channelId && String(channelId);
    if (!id || !stack) {
      return;
    }
    const rec = this._buf.find(r => r.channelId === id);
    if (rec) {
      rec.initiatorStack = stack;
      return;
    }
    // 记录还没建（栈先到）→ 暂存，observe(REQ) 时回填。限 500 条防泄漏。
    this._pendingStacks.set(id, stack);
    if (this._pendingStacks.size > 500) {
      this._pendingStacks.delete(this._pendingStacks.keys().next().value);
    }
  }

  async capture({ action = "status", urlPattern } = {}, ctx) {
    if (action === "start") {
      this._pattern = urlPattern ? globToRe(urlPattern) : null;
      if (!this._on) {
        Services.obs.addObserver(this._obs, REQ_TOPIC);
        for (const t of RESP_TOPICS) {
          Services.obs.addObserver(this._obs, t);
        }
        this._on = true;
      }
      // 开启内容侧发起者栈捕获——**await** 确保观察者注册完成再返回（否则 start 后立刻触发的请求
      // 会赶在观察者就绪前发出 → initiatorStack 抓不到，正是之前的 null 根因之一）。
      let armed = false;
      try {
        if (this._page && this._page.armNetStack) {
          const r = await this._page.armNetStack(undefined, ctx);
          armed = !!(r && r.armed);
        }
      } catch {}
      return {
        ok: true,
        capturing: true,
        urlPattern: urlPattern || "*",
        initiatorStack: armed,
        note:
          "已开启捕获 + 发起者调用栈。**要抓 initiatorStack：保持本页、用滚动/点击触发目标请求**；" +
          "若刷新整页(page_navigate)，刷新后的请求可能换内容进程导致栈抓不到——尽量用页内交互触发，或刷新后等页面稳定再触发。",
      };
    }
    if (action === "stop") {
      try {
        this._page && this._page.disarmNetStack && this._page.disarmNetStack(undefined, ctx);
      } catch {}
      if (this._on) {
        try {
          Services.obs.removeObserver(this._obs, REQ_TOPIC);
        } catch {}
        for (const t of RESP_TOPICS) {
          try {
            Services.obs.removeObserver(this._obs, t);
          } catch {}
        }
        this._on = false;
      }
      return { ok: true, capturing: false };
    }
    if (action === "clear") {
      this._buf = [];
      return { ok: true, cleared: true };
    }
    return { ok: true, capturing: this._on, count: this._buf.length };
  }

  observe(subject, topic) {
    let ch;
    try {
      ch = subject.QueryInterface(Ci.nsIHttpChannel);
    } catch {
      return;
    }
    let url;
    try {
      url = ch.URI.spec;
    } catch {
      return;
    }
    if (this._pattern && !this._pattern.test(url)) {
      return;
    }
    if (topic === REQ_TOPIC) {
      const channelId = safe(() => String(ch.channelId)) || null;
      const rec = {
        id: ++this._seq,
        t: Date.now(),
        method: safe(() => ch.requestMethod) || "",
        url,
        channelId,
        status: null,
        contentType: null,
        reqHeaders: visit(v => ch.visitRequestHeaders(v)),
        respHeaders: null,
        initiatorStack: null, // 内容侧发起者 JS 栈（开了 net_capture 后由 AgentEvalParent 回填）
      };
      // 栈可能先于本记录到达（不同进程异步）→ 回填暂存的。
      if (channelId && this._pendingStacks.has(channelId)) {
        rec.initiatorStack = this._pendingStacks.get(channelId);
        this._pendingStacks.delete(channelId);
      }
      this._map.set(ch, rec);
      this._buf.push(rec);
      if (this._buf.length > this._max) {
        this._buf.shift();
      }
    } else {
      const rec = this._map.get(ch);
      if (rec) {
        rec.status = safe(() => ch.responseStatus);
        rec.contentType = safe(() => ch.getResponseHeader("Content-Type"));
        rec.respHeaders = visit(v => ch.visitResponseHeaders(v));
      }
    }
  }

  /** 列出摘要（不含 headers）。先 drain 内容侧发起者栈合并进来。 */
  async list({ urlPattern, method, limit = 100 } = {}, ctx) {
    await this._drainStacks(ctx);
    const re = urlPattern ? globToRe(urlPattern) : null;
    let out = this._buf.filter(
      r => (!re || re.test(r.url)) && (!method || r.method === method)
    );
    out = out.slice(-limit).map(r => ({ id: r.id, method: r.method, url: r.url, status: r.status, contentType: r.contentType, t: r.t }));
    return { ok: true, count: out.length, requests: out };
  }

  /** 取单条完整记录（含 headers + initiatorStack）。先 drain 内容侧发起者栈合并进来。 */
  async get({ requestId } = {}, ctx) {
    await this._drainStacks(ctx);
    const rec = this._buf.find(r => r.id === Number(requestId));
    if (!rec) {
      return { ok: false, error: "request not found: " + requestId };
    }
    return { ok: true, request: rec };
  }
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

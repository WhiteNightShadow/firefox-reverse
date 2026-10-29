/* NetworkBackend.sys.mjs — 网络捕获控制（parent，http-on-* 观察者）。
 *
 * 用 Services.obs 订阅 http-on-modify-request / http-on-examine-response，
 * 在父进程看到所有 HTTP/XHR/fetch 通道（无需内容侧 hook，JS 不可见）。
 * 用 WeakMap 关联同一 nsIHttpChannel 的请求/响应两次回调。
 * captureBody 时经 nsITraceableChannel 旁路复制响应体（解码后的内容，原数据照常交给页面），
 * 并读出请求体；这些录制可交给 net_replay 离线回放，或存成 HAR。
 */

import { NetworkReplay, entriesFromHar, harFromEntries, readUploadBody, textFromBytes } from "./NetworkReplay.sys.mjs";

const REQ_TOPIC = "http-on-modify-request";
const RESP_TOPICS = ["http-on-examine-response", "http-on-examine-cached-response", "http-on-examine-merged-response"];
const BODY_LIMIT = 8 * 1024 * 1024;
const BODY_BUDGET = 64 * 1024 * 1024;
const SHOW_LIMIT = 20000;
const TEXTUAL = /^(text\/|application\/([\w.+-]*\+)?(json|javascript|ecmascript|xml|x-www-form-urlencoded)\b)/i;

const DECODED = new Set(["gzip", "x-gzip", "deflate", "x-deflate", "br", "zstd"]);

function readBytes(stream, count) {
  const reader = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
  reader.setInputStream(stream);
  return reader.readBytes(count);
}

function byteStream(bytes) {
  const stream = Cc["@mozilla.org/io/string-input-stream;1"].createInstance(Ci.nsIStringInputStream);
  stream.setByteStringData(bytes);
  return stream;
}

/**
 * Passes the response through unchanged while keeping a bounded copy of the decoded body. In the parent the
 * channel hands on the transfer as received (content decoding happens in the content process), so the copy
 * goes through the same stream converters DevTools uses for Content-Encoding.
 */
class BodyTee {
  constructor(done) {
    this.done = done;
    this.chunks = [];
    this.size = 0;
    this.truncated = false;
    this.next = null;
    this.QueryInterface = ChromeUtils.generateQI(["nsIStreamListener", "nsIRequestObserver"]);
    const tee = this;
    this.collector = {
      QueryInterface: ChromeUtils.generateQI(["nsIStreamListener", "nsIRequestObserver"]),
      onStartRequest() {},
      onDataAvailable(_request, stream, _offset, count) {
        const data = readBytes(stream, count);
        const keep = data.slice(0, Math.max(0, BODY_LIMIT - tee.size));
        tee.chunks.push(keep);
        tee.size += keep.length;
        tee.truncated ||= keep.length < data.length;
      },
      onStopRequest() {},
    };
  }

  onStartRequest(request) {
    // The listener we replaced decides first: HttpChannelParent turns applyConversion off here when the
    // content process will decode, which is when the bytes reaching us are still encoded.
    this.next.onStartRequest(request);
    this.decoder = this.collector;
    try {
      const channel = request.QueryInterface(Ci.nsIHttpChannel);
      if (channel instanceof Ci.nsIEncodedChannel && !channel.applyConversion && !channel.hasContentDecompressed) {
        const converters = Cc["@mozilla.org/streamConverters;1"].getService(Ci.nsIStreamConverterService);
        const header = safe(() => channel.getResponseHeader("Content-Encoding")) || "";
        // Each converter feeds the previous one, so the last encoding applied is undone first.
        for (const encoding of header.split(",").map(item => item.trim().toLowerCase()).filter(item => DECODED.has(item))) {
          this.decoder = converters.asyncConvertData(encoding, "uncompressed", this.decoder, null);
        }
      }
    } catch {}
    try { this.decoder.onStartRequest(request, null); } catch { this.decoder = null; }
  }

  onDataAvailable(request, stream, offset, count) {
    const data = readBytes(stream, count);
    if (this.decoder) {
      try { this.decoder.onDataAvailable(request, byteStream(data), offset, count); } catch { this.decoder = null; this.truncated = true; }
    }
    this.next.onDataAvailable(request, byteStream(data), offset, count);
  }

  onStopRequest(request, status) {
    try { this.decoder?.onStopRequest(request, status); } catch {}
    // nsresult failure codes have the high bit set.
    this.done({ bytes: this.chunks.join(""), truncated: this.truncated, complete: !(status & 0x80000000) && !!this.decoder });
    this.next.onStopRequest(request, status);
  }
}

function showBody(bytes, contentType) {
  if (bytes == null) return null;
  if (TEXTUAL.test(contentType || "")) {
    const text = textFromBytes(bytes);
    return { encoding: "utf8", size: bytes.length, text: text.slice(0, SHOW_LIMIT), shownTruncated: text.length > SHOW_LIMIT };
  }
  return { encoding: "base64", size: bytes.length, base64: btoa(bytes.slice(0, SHOW_LIMIT)), shownTruncated: bytes.length > SHOW_LIMIT };
}

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
    this._captureBody = false;
    this._bodyBytes = 0;
    this._replay = new NetworkReplay();
    this._workspace = null; // 由 Backends 注入：解析 HAR 路径（只允许工作目录内）
  }

  /** 记下一条响应体；总量超出预算时丢掉最早的响应体（记录本身保留）。 */
  _keepBody(rec, body) {
    if (!this._buf.includes(rec)) return;
    rec.body = body;
    this._bodyBytes += body.bytes.length;
    for (const old of this._buf) {
      if (this._bodyBytes <= BODY_BUDGET) break;
      if (old !== rec && old.body?.bytes) {
        this._bodyBytes -= old.body.bytes.length;
        old.body = { evicted: true };
      }
    }
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

  async capture({ action = "status", urlPattern, captureBody = false } = {}, ctx) {
    if (action === "start") {
      this._pattern = urlPattern ? globToRe(urlPattern) : null;
      this._captureBody = !!captureBody;
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
        captureBody: this._captureBody,
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
      this._bodyBytes = 0;
      return { ok: true, cleared: true };
    }
    return { ok: true, capturing: this._on, captureBody: this._captureBody, count: this._buf.length, bodies: this._buf.filter(r => r.body?.bytes != null).length };
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
        reqBody: this._captureBody ? readUploadBody(ch) : null,
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
        const old = this._buf.shift();
        if (old.body?.bytes) this._bodyBytes -= old.body.bytes.length;
      }
    } else {
      const rec = this._map.get(ch);
      if (rec) {
        rec.status = safe(() => ch.responseStatus);
        rec.statusText = safe(() => ch.responseStatusText);
        rec.contentType = safe(() => ch.getResponseHeader("Content-Type"));
        rec.respHeaders = visit(v => ch.visitResponseHeaders(v));
        if (this._captureBody && !rec.teed) {
          rec.teed = true;
          try {
            const tee = new BodyTee(body => this._keepBody(rec, body));
            tee.next = ch.QueryInterface(Ci.nsITraceableChannel).setNewListener(tee);
          } catch {
            rec.body = { unavailable: true };
          }
        }
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

  /** 取单条完整记录（含 headers + initiatorStack）。先 drain 内容侧发起者栈合并进来。
   *  **id 兼容**：net_list 返回字段是 `id`，模型常按此原样回传 `id`（而 schema 名为 requestId）→ 旧版只认
   *  requestId 时收到 undefined、报 "request not found: undefined"。这里同时接受 requestId / id，治这个反复踩的入参错配。 */
  async get({ requestId, id, includeBody = false } = {}, ctx) {
    await this._drainStacks(ctx);
    const want = requestId != null ? requestId : id;
    if (want == null) {
      return { ok: false, error: "需要 requestId（= net_list 返回的 id）。把 net_list 里那条记录的 id 原样传进来。" };
    }
    const rec = this._buf.find(r => r.id === Number(want));
    if (!rec) {
      const ids = this._buf.slice(-10).map(r => r.id);
      return { ok: false, error: "request not found: " + want, hint: "最近可取的 id：" + JSON.stringify(ids) + "（先 net_list 拿 id 再 net_get）" };
    }
    const { body, reqBody, teed, ...request } = rec;
    if (includeBody) {
      request.requestBody = showBody(reqBody, rec.reqHeaders?.["Content-Type"]);
      request.responseBody = body?.bytes != null
        ? { ...showBody(body.bytes, rec.contentType), truncated: body.truncated, complete: body.complete }
        : body?.evicted ? { evicted: true } : body?.unavailable ? { unavailable: true }
          : { missing: true, hint: "响应体只在 net_capture(start, captureBody:true) 之后的请求里录制" };
    } else {
      request.hasResponseBody = body?.bytes != null;
    }
    return { ok: true, request };
  }

  /** 可回放的录制：响应体完整、未截断。 */
  _recorded({ urlPattern, ids } = {}) {
    const re = urlPattern ? globToRe(urlPattern) : null;
    const want = Array.isArray(ids) && ids.length ? new Set(ids.map(Number)) : null;
    return this._buf
      .filter(r => r.status && r.body?.bytes != null && r.body.complete && !r.body.truncated && (!re || re.test(r.url)) && (!want || want.has(r.id)))
      .map(r => ({
        id: "capture:" + r.id, t: r.t, method: r.method, url: r.url, requestBody: r.reqBody ?? null,
        requestHeaders: Object.entries(r.reqHeaders || {}), status: r.status, statusText: r.statusText || "",
        headers: Object.entries(r.respHeaders || {}), body: r.body.bytes,
      }));
  }

  /** 离线回放：start / stop / status / log，save 把录制存成工作目录里的 HAR。 */
  async replay({ action = "status", source = "capture", harPath, path, urlPattern, ids, query, matchBody, unmatched, reuse, scope = "tab", limit } = {}, ctx) {
    if (action === "status") return { ok: true, ...this._replay.status() };
    if (action === "log") return { ok: true, ...this._replay.status(), decisions: this._replay.log(limit) };
    if (action === "stop") return { ok: true, ...this._replay.stop() };
    if (action === "save") {
      const entries = this._recorded({ urlPattern, ids });
      if (!entries.length) throw new Error("没有可保存的录制：先 net_capture(action:start, captureBody:true)，再把页面正常加载一遍");
      if (!this._workspace) throw new Error("工作目录不可用");
      const file = this._workspace._resolve(path || "work/capture.har", ctx);
      await IOUtils.makeDirectory(PathUtils.parent(file), { ignoreExisting: true, createAncestors: true });
      await IOUtils.writeUTF8(file, JSON.stringify(harFromEntries(entries, Services.appinfo.version)));
      return { ok: true, saved: path || "work/capture.har", entries: entries.length };
    }
    if (action !== "start") throw new Error("action 只能是 start / stop / status / log / save");
    let entries;
    if (source === "har") {
      if (!harPath) throw new Error("source=har 需要 harPath（工作目录内的 HAR 文件）");
      if (!this._workspace) throw new Error("工作目录不可用");
      const re = urlPattern ? globToRe(urlPattern) : null;
      entries = entriesFromHar(JSON.parse(await IOUtils.readUTF8(this._workspace._resolve(harPath, ctx)))).filter(e => !re || re.test(e.url));
    } else {
      entries = this._recorded({ urlPattern, ids });
    }
    if (!entries.length) {
      throw new Error("没有可回放的响应：先 net_capture(action:start, captureBody:true) 再把页面正常加载一遍，或给 source=har + harPath");
    }
    const browserId = scope === "all" ? null : this._page?.browser(ctx)?.browserId ?? null;
    const summary = this._replay.start({ entries, query, matchBody, unmatched, reuse, scope, browserId });
    return {
      ok: true,
      ...summary,
      note: "已开始离线回放：之后的请求按录制作答、不走网络" + (summary.unmatched === "block" ? "，没录到的请求会被拦截" : "，没录到的请求照常联网") +
        "。刷新或重新触发请求后用 net_replay(action:log) 看每条是回放、拦截还是放行；结束用 net_replay(action:stop)。",
    };
  }
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

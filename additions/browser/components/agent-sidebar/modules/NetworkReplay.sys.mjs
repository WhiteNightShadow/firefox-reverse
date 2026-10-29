/* NetworkReplay.sys.mjs — 离线回放（parent，http-on-modify-request 观察者）。
 *
 * 请求发出前用录好的响应作答，不走网络：响应经 nsIHttpChannelInternal.setResponseOverride 交给通道，
 * 与 WebDriver BiDi network.provideResponse 是同一机制。录制来自 net_capture(captureBody) 或 HAR 文件。
 * 匹配键 = 方法 + 规范化 URL（+ 请求体哈希）；同一键的多条按录制顺序作答。
 */

// Bodies are recorded after content decoding, so the encoding and length of the original transfer no longer apply.
const HOP_BY_HOP = /^(content-encoding|content-length|transfer-encoding|connection|keep-alive)$/i;
const UPLOAD_LIMIT = 1024 * 1024;
const LOG_LIMIT = 300;

/** UTF-8 text → byte string (one char per byte), the form nsIReplacedHttpResponse.responseBody takes. */
export function bytesFromText(text) {
  const bytes = new TextEncoder().encode(String(text));
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return out;
}

export function textFromBytes(bytes) {
  return new TextDecoder().decode(Uint8Array.from(bytes, c => c.charCodeAt(0)));
}

function fnv1a(bytes) {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < bytes.length; i++) hash = ((hash ^ BigInt(bytes.charCodeAt(i) & 0xff)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return hash.toString(16).padStart(16, "0");
}

/** query: exact | ignore-order | ignore. The fragment never takes part; the body only when matchBody and present. */
export function requestKey({ method, url, body }, { query = "exact", matchBody = true } = {}) {
  const parsed = new URL(url);
  parsed.hash = "";
  if (query === "ignore") parsed.search = "";
  if (query === "ignore-order") {
    const params = [...parsed.searchParams].sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0));
    parsed.search = params.length ? "?" + new URLSearchParams(params).toString() : "";
  }
  return [String(method || "GET").toUpperCase(), parsed.href, matchBody && body ? fnv1a(body) : ""].join(" ");
}

/** HAR 1.2 entries with a recorded response body. Bodies stay byte strings; base64 content is decoded. */
export function entriesFromHar(har) {
  const entries = [];
  for (const [index, item] of (har?.log?.entries || []).entries()) {
    const request = item?.request || {};
    const response = item?.response || {};
    const content = response.content || {};
    if (typeof content.text !== "string" || !request.url) continue;
    entries.push({
      id: "har:" + index,
      method: request.method || "GET",
      url: request.url,
      requestBody: typeof request.postData?.text === "string" ? bytesFromText(request.postData.text) : null,
      status: Number(response.status) || 200,
      statusText: response.statusText || "",
      headers: (response.headers || []).map(header => [String(header.name), String(header.value)]),
      body: content.encoding === "base64" ? atob(content.text) : bytesFromText(content.text),
    });
  }
  return entries;
}

export function harFromEntries(entries, version = "") {
  const pairs = headers => headers.map(([name, value]) => ({ name, value }));
  return {
    log: {
      version: "1.2",
      creator: { name: "Firefox Reverse", version },
      entries: entries.map(entry => ({
        startedDateTime: new Date(entry.t || Date.now()).toISOString(),
        time: 0,
        request: {
          method: entry.method, url: entry.url, httpVersion: "HTTP/1.1", cookies: [], headers: pairs(entry.requestHeaders || []),
          queryString: [], headersSize: -1, bodySize: entry.requestBody ? entry.requestBody.length : 0,
          ...(entry.requestBody ? { postData: { mimeType: "", text: textFromBytes(entry.requestBody) } } : {}),
        },
        response: {
          status: entry.status, statusText: entry.statusText || "", httpVersion: "HTTP/1.1", cookies: [], headers: pairs(entry.headers),
          content: { size: entry.body.length, mimeType: (entry.headers.find(([name]) => /^content-type$/i.test(name)) || [, ""])[1], text: btoa(entry.body), encoding: "base64" },
          redirectURL: "", headersSize: -1, bodySize: entry.body.length,
        },
        cache: {},
        timings: { send: 0, wait: 0, receive: 0 },
      })),
    },
  };
}

/** The request body without disturbing the upload: read from the start, then put the stream back where it was. */
export function readUploadBody(channel) {
  try {
    const upload = channel.QueryInterface(Ci.nsIUploadChannel).uploadStream;
    if (!upload) return null;
    const seekable = upload.QueryInterface(Ci.nsISeekableStream);
    const position = seekable.tell();
    seekable.seek(Ci.nsISeekableStream.NS_SEEK_SET, 0);
    const reader = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
    reader.setInputStream(upload);
    const body = reader.readBytes(Math.min(upload.available(), UPLOAD_LIMIT));
    seekable.seek(Ci.nsISeekableStream.NS_SEEK_SET, position);
    return body;
  } catch {
    return null;
  }
}

export function applyOverride(channel, entry) {
  const response = Cc["@mozilla.org/network/replaced-http-response;1"].createInstance(Ci.nsIReplacedHttpResponse);
  response.responseStatus = entry.status;
  response.responseStatusText = entry.statusText || "";
  for (const [name, value] of entry.headers) {
    if (!HOP_BY_HOP.test(name)) response.setResponseHeader(name, value, true);
  }
  response.responseBody = entry.body;
  channel.QueryInterface(Ci.nsIHttpChannelInternal).setResponseOverride(response);
}

export class NetworkReplay {
  constructor({ observers = () => Services.obs, override = applyOverride, uploadBody = readUploadBody } = {}) {
    this.observers = observers;
    this.override = override;
    this.uploadBody = uploadBody;
    this.active = false;
  }

  /**
   * reuse=true answers repeated requests with the recorded sequence and keeps the last response once it runs out;
   * reuse=false answers each recording once. scope "tab" limits replay to one tab, by its browserId: unlike the
   * top browsing context id it survives the browsing context swap of a cross-process navigation.
   */
  start({ entries, query = "exact", matchBody = true, unmatched = "block", reuse = true, scope = "tab", browserId = null }) {
    this.stop();
    if (!["exact", "ignore-order", "ignore"].includes(query)) throw new Error("query 只能是 exact / ignore-order / ignore");
    if (!["block", "pass"].includes(unmatched)) throw new Error("unmatched 只能是 block / pass");
    if (scope === "tab" && browserId == null) throw new Error("scope=tab 需要当前标签页");
    this.options = { query, matchBody, unmatched, reuse, scope, browserId };
    this.table = new Map();
    for (const entry of entries) {
      const key = requestKey({ method: entry.method, url: entry.url, body: entry.requestBody }, this.options);
      if (!this.table.has(key)) this.table.set(key, []);
      this.table.get(key).push(entry);
    }
    this.served = new Map();
    this.stats = { replayed: 0, blocked: 0, passed: 0 };
    this.decisions = [];
    this.observers().addObserver(this, "http-on-modify-request");
    this.active = true;
    return { replaying: true, entries: entries.length, keys: this.table.size, ...this.options };
  }

  stop() {
    if (!this.active) return { replaying: false };
    try { this.observers().removeObserver(this, "http-on-modify-request"); } catch {}
    this.active = false;
    return { replaying: false, ...this.stats };
  }

  status() {
    return this.active ? { replaying: true, keys: this.table.size, ...this.stats, ...this.options } : { replaying: false };
  }

  log(limit = 50) {
    return (this.decisions || []).slice(-Math.max(1, Math.min(LOG_LIMIT, limit)));
  }

  inScope(channel) {
    if (this.options.scope === "all") return true;
    try {
      const context = channel.loadInfo?.browsingContext || channel.loadInfo?.workerAssociatedBrowsingContext;
      return context?.browserId === this.options.browserId;
    } catch {
      return false;
    }
  }

  /** The recording that answers `request`, or null. */
  pick(request) {
    const key = requestKey(request, this.options);
    const queue = this.table.get(key);
    if (!queue) return null;
    const count = this.served.get(key) || 0;
    if (count >= queue.length && !this.options.reuse) return null;
    this.served.set(key, count + 1);
    return queue[Math.min(count, queue.length - 1)];
  }

  observe(subject, topic) {
    if (topic !== "http-on-modify-request" || !this.active) return;
    let channel;
    try {
      channel = subject.QueryInterface(Ci.nsIHttpChannel);
    } catch {
      return;
    }
    if (!this.inScope(channel)) return;
    const method = channel.requestMethod;
    const url = channel.URI.spec;
    const entry = this.pick({ method, url, body: this.options.matchBody ? this.uploadBody(channel) : null });
    let decision;
    if (entry) {
      this.override(channel, entry);
      decision = "replayed";
    } else if (this.options.unmatched === "block") {
      channel.cancel(Cr.NS_ERROR_CONNECTION_REFUSED);
      decision = "blocked";
    } else {
      decision = "passed";
    }
    this.stats[decision]++;
    this.decisions.push({ t: Date.now(), method, url: url.slice(0, 500), decision, ...(entry ? { entry: entry.id } : {}) });
    if (this.decisions.length > LOG_LIMIT) this.decisions.shift();
  }
}

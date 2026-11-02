/* CookieBackend.sys.mjs — `cookies` 工具：经引擎 nsICookieManager 读写 cookie 存储，含 httpOnly
 * （page_eval 的 document.cookie 够不到 httpOnly），可跨域、可管理登录态。
 *
 * 同一个 host+name+path 可以在几个 cookie 罐里各有一份，用 originAttributes 区分：
 *   userContextId > 0      容器标签页
 *   partitionKey 非空       分区 cookie（第三方 iframe 里的，dFPI / CHIPS）
 *   privateBrowsingId > 0  隐私窗口：单独的存储，nsICookieManager.cookies 不含，要按模式另取
 *   firstPartyDomain       first-party isolation
 * remove 按每个 cookie 自己的 originAttributes 删，删完再查一遍，只把确实没了的算进 removed；
 * set 写进指定的罐（默认普通罐），改已有的分区 cookie 时沿用它的 Partitioned 属性。
 */

const OA_DEFAULTS = Object.freeze({
  userContextId: 0,
  privateBrowsingId: 0,
  firstPartyDomain: "",
  geckoViewSessionContextId: "",
  partitionKey: "",
});
const PRIVATE_PATTERN = JSON.stringify({ privateBrowsingId: 1 });
const LIST_LIMIT = 500;
const DETAIL_LIMIT = 50;

/** 只留非默认字段：普通罐的 cookie 得到 {}。list 输出用它，原样传回 set/remove 就指向同一个罐。 */
export function compactOriginAttributes(oa) {
  const out = {};
  for (const [key, def] of Object.entries(OA_DEFAULTS)) {
    const value = oa && oa[key];
    if (value !== undefined && value !== null && value !== def) {
      out[key] = value;
    }
  }
  return out;
}

/** 参数里的 originAttributes → 完整对象（没写的字段取默认值）。不认识的字段、类型不对都直接报错，
 *  免得写进或删掉意料之外的罐。 */
export function fullOriginAttributes(input) {
  if (input === undefined || input === null) {
    return { ...OA_DEFAULTS };
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new Error('originAttributes 必须是对象，例如 {"userContextId":2}');
  }
  const out = { ...OA_DEFAULTS };
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(OA_DEFAULTS, key)) {
      throw new Error(`originAttributes 不认识字段 ${key}（可用：${Object.keys(OA_DEFAULTS).join("、")}）`);
    }
    if (typeof OA_DEFAULTS[key] === "number") {
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`originAttributes.${key} 要非负整数`);
      }
    } else if (typeof value !== "string") {
      throw new Error(`originAttributes.${key} 要字符串`);
    }
    out[key] = value;
  }
  return out;
}

const oaKey = oa => JSON.stringify(Object.keys(OA_DEFAULTS).map(key => (oa && oa[key] !== undefined ? oa[key] : OA_DEFAULTS[key])));
const sameOriginAttributes = (a, b) => oaKey(a) === oaKey(b);
const cookieKey = c => [c.host, c.name, c.path, oaKey(c.originAttributes)].join("\n");

// domain 参数不区分前导点：example.com 和 .example.com 指同一个 host（host-only 与域 cookie 都算）。
// add() 会把 host 规范成小写 ASCII（IDN 转 punycode、去掉末尾的点），比对前这里也这样转。
function asciiHost(host) {
  const bare = String(host || "").trim().replace(/^\./, "").replace(/\.$/, "").toLowerCase();
  if (!bare) {
    return "";
  }
  try {
    return new URL(`http://${bare}/`).hostname || bare;
  } catch {
    return bare;
  }
}

function cookieJSON(c) {
  const out = {
    name: c.name,
    value: c.value,
    host: c.host,
    path: c.path,
    isSecure: c.isSecure,
    isHttpOnly: c.isHttpOnly,
    isSession: c.isSession,
    sameSite: c.sameSite,
    expiry: c.expiry, // 毫秒 since epoch（nsICookie.expiry）；会话 cookie 见 isSession
  };
  const oa = compactOriginAttributes(c.originAttributes);
  if (Object.keys(oa).length) {
    out.originAttributes = oa;
  }
  if (c.isPartitioned) {
    out.isPartitioned = true;
  }
  return out;
}

function briefJSON(c) {
  const out = { name: c.name, host: c.host, path: c.path };
  const oa = compactOriginAttributes(c.originAttributes);
  if (Object.keys(oa).length) {
    out.originAttributes = oa;
  }
  return out;
}

function constants() {
  const ci = typeof Ci === "undefined" ? {} : Ci;
  const cookie = ci.nsICookie || {};
  return {
    schemeMap: ((cookie.SCHEME_HTTP ?? 1) | (cookie.SCHEME_HTTPS ?? 2)) || 3,
    sameSiteUnset: cookie.SAMESITE_UNSET ?? 256,
    validationOK: (ci.nsICookieValidation && ci.nsICookieValidation.eOK) ?? 0,
  };
}

export class CookieBackend {
  /** @param {object} [opts] { manager: 换掉 Services.cookies（自测用） } */
  constructor({ manager } = {}) {
    this._manager = manager || null;
  }

  get manager() {
    return this._manager || Services.cookies;
  }

  /** 候选 cookie：给了 originAttributes 就只看那一个罐（privateBrowsingId>0 去隐私存储取）；
   *  没给就是普通存储里的全部罐（含容器、分区），includePrivate 再加上隐私窗口的。 */
  _pool({ originAttributes, includePrivate = false } = {}) {
    const cm = this.manager;
    if (originAttributes !== undefined && originAttributes !== null) {
      const oa = fullOriginAttributes(originAttributes);
      const source = oa.privateBrowsingId > 0
        ? cm.getCookiesWithOriginAttributes(JSON.stringify({ privateBrowsingId: oa.privateBrowsingId })) || []
        : cm.cookies || [];
      return source.filter(c => sameOriginAttributes(c.originAttributes, oa));
    }
    const pool = [...(cm.cookies || [])];
    if (includePrivate === true) {
      pool.push(...(cm.getCookiesWithOriginAttributes(PRIVATE_PATTERN) || []));
    }
    return pool;
  }

  /** host（含前导点与否要和 cookie 一致）+ name + path + 罐 都相同的那一份。同一个罐里最多一份。 */
  _find(host, name, path, oa) {
    let candidates;
    try {
      candidates = this.manager.getCookiesFromHost(asciiHost(host), oa) || [];
    } catch {
      candidates = this._pool({ originAttributes: oa });
    }
    return candidates.find(c => c.host === host && c.name === name && c.path === path && sameOriginAttributes(c.originAttributes, oa)) || null;
  }

  /** 列出 cookie（含 httpOnly）。domain=按 host 子串过滤；name=按名过滤（精确或子串）。只读。 */
  async list({ domain, name, originAttributes, includePrivate } = {}) {
    let all = this._pool({ originAttributes, includePrivate });
    if (domain) {
      const d = String(domain).toLowerCase();
      all = all.filter(c => c.host && c.host.toLowerCase().includes(d));
    }
    if (name) {
      all = all.filter(c => c.name === name || c.name.includes(name));
    }
    const cookies = all.slice(0, LIST_LIMIT).map(cookieJSON);
    const out = { ok: true, count: all.length, cookies };
    if (all.length > LIST_LIMIT) {
      out.truncated = true;
    }
    if (cookies.some(c => c.originAttributes)) {
      out.hint = "带 originAttributes 的在容器标签页、分区或隐私窗口的罐里；set/remove 时原样带上它，就只动那一个罐。";
    }
    return out;
  }

  /** 新增/修改一个 cookie（同 host+path+name+罐 即覆盖）。originAttributes 省略=普通罐。
   *  改已有的：没给的属性（secure、httpOnly、sameSite、过期方式、partitioned）沿用原值，只改给了的；
   *  新建的：默认非 secure、非 httpOnly、持久一年。expires=unix 秒、maxAge=相对秒、session:true=会话 cookie。 */
  async set({ name, value, domain, path = "/", secure, httpOnly, session, expires, maxAge, sameSite, originAttributes, partitioned } = {}) {
    if (!name || !domain) {
      throw new Error("cookies set: name 和 domain 必填");
    }
    const oa = fullOriginAttributes(originAttributes);
    const { schemeMap, sameSiteUnset, validationOK } = constants();
    // add() 存的 host：小写 ASCII，前导点表示域 cookie。
    const host = (String(domain).trim().startsWith(".") ? "." : "") + asciiHost(domain);
    const existing = this._find(host, name, path, oa);
    const nowMs = Date.now();
    let isSession;
    let expiryMs;
    if (maxAge != null) {
      isSession = session === true;
      expiryMs = nowMs + Number(maxAge) * 1000;
    } else if (expires != null) {
      isSession = session === true;
      expiryMs = Number(expires) * 1000; // 入参 expires 是 unix 秒 → 毫秒
    } else if (session === true) {
      isSession = true;
      expiryMs = nowMs + 3600 * 1000;
    } else if (existing && session === undefined) {
      isSession = !!existing.isSession;
      expiryMs = existing.expiry;
    } else {
      isSession = false;
      expiryMs = nowMs + 365 * 24 * 3600 * 1000; // 默认持久一年
    }
    const keep = (given, current, fallback) => (given !== undefined && given !== null ? given : existing ? current : fallback);
    const isSecure = !!keep(secure, existing && existing.isSecure, false);
    const isHttpOnly = !!keep(httpOnly, existing && existing.isHttpOnly, false);
    const ss = Number(keep(sameSite, existing && existing.sameSite, sameSiteUnset));
    const isPartitioned = !!keep(partitioned, existing && existing.isPartitioned, false);
    const cv = this.manager.add(
      domain, path, name, String(value == null ? "" : value),
      isSecure, isHttpOnly, isSession, expiryMs, oa, ss, schemeMap, isPartitioned
    );
    if (cv && cv.result !== undefined && cv.result !== validationOK) {
      return { ok: false, error: "cookie 被拒：" + (cv.errorString || "validation result " + cv.result) };
    }
    const after = this._find(host, name, path, oa);
    return after
      ? { ok: true, replaced: !!existing, set: cookieJSON(after) }
      : { ok: false, error: "add 已调用但读回为空——检查 domain 是否为有效 host（如 example.com）" };
  }

  /** 删除：只给 domain 删该 host 全部（不分前导点）；name、path 缩小范围；originAttributes 只删那一个罐，
   *  不给就删所有罐里匹配的；all:true 清空所有（隐私窗口的要再加 includePrivate:true）。 */
  async remove({ name, domain, path, originAttributes, includePrivate = false, all = false } = {}) {
    const cm = this.manager;
    if (all === true && !name && !domain) {
      const n = (cm.cookies || []).length;
      cm.removeAll(); // 只清普通存储（含容器、分区），隐私窗口的不在其内
      const out = { ok: true, removed: n, scope: "ALL" };
      if (includePrivate === true) {
        const privateCount = (cm.getCookiesWithOriginAttributes(PRIVATE_PATTERN) || []).length;
        cm.removeCookiesWithOriginAttributes(PRIVATE_PATTERN);
        out.removed += privateCount;
        out.privateRemoved = privateCount;
      }
      return out;
    }
    if (!domain) {
      throw new Error("cookies remove: domain 必填（或 all:true 清空全部）");
    }
    const want = asciiHost(domain);
    const scope = { originAttributes, includePrivate };
    // 存储里的 host 已是小写 ASCII，去掉前导点即可比对。
    const targets = this._pool(scope).filter(
      c => String(c.host || "").replace(/^\./, "") === want && (!name || c.name === name) && (path === undefined || path === null || c.path === path)
    );
    const errors = new Map();
    for (const c of targets) {
      try {
        cm.remove(c.host, c.name, c.path, c.originAttributes);
      } catch (e) {
        errors.set(cookieKey(c), String((e && e.message) || e));
      }
    }
    // 删完再取一遍：还在的就是没删掉，不算进 removed。
    const left = new Set(targets.length ? this._pool(scope).map(cookieKey) : []);
    const removed = [];
    const failed = [];
    for (const c of targets) {
      const key = cookieKey(c);
      if (left.has(key)) {
        failed.push(errors.has(key) ? { ...briefJSON(c), error: errors.get(key) } : briefJSON(c));
      } else {
        removed.push(briefJSON(c));
      }
    }
    const out = { ok: failed.length === 0, removed: removed.length, matched: targets.length, host: domain };
    if (name) {
      out.name = name;
    }
    if (path !== undefined && path !== null) {
      out.path = path;
    }
    if (removed.length) {
      out.cookies = removed.slice(0, DETAIL_LIMIT);
    }
    if (failed.length) {
      out.failed = failed.slice(0, DETAIL_LIMIT);
    }
    if (!targets.length) {
      out.hint = "没有匹配的 cookie：domain 写 list 里的 host（前导点可省）；隐私窗口里的要加 includePrivate:true。";
    }
    return out;
  }

  /** 单一 `cookies` 工具的 action 分发入口（list/set/remove）。 */
  async run(a = {}) {
    const act = a && a.action;
    if (act === "list") {
      return this.list(a);
    }
    if (act === "set") {
      return this.set(a);
    }
    if (act === "remove") {
      return this.remove(a);
    }
    throw new Error(`cookies: 未知 action "${act}"（用 list / set / remove）`);
  }
}

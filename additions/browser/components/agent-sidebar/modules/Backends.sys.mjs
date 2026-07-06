/* Backends.sys.mjs — 把各能力后端组装成 ToolRouter 需要的 backends 注册表（单例）。
 *
 *   page    执行JS / 页面控制   (PageBackend, JSWindowActor)
 *   net     网络捕获            (NetworkBackend, http-on-* 观察者)
 *   scripts 存JS                (ScriptsBackend, 特权 fetch + IOUtils)
 *   code    搜索                (CodeBackend, IOUtils 语料搜索)
 *   jsvmp   JSVMP trace 读取    (JsvmpBackend, 读 C++ NDJSON，自动镜像到工作目录)
 *   workspace 工作目录          (WorkspaceBackend, 文件读写 + node/python 执行)
 *   find    定位加密入口        (组合 net + code)
 */
import { PageBackend } from "./PageBackend.sys.mjs";
import { NetworkBackend } from "./NetworkBackend.sys.mjs";
import { ScriptsBackend } from "./ScriptsBackend.sys.mjs";
import { CodeBackend } from "./CodeBackend.sys.mjs";
import { JsvmpBackend } from "./JsvmpBackend.sys.mjs";
import { WebApiBackend } from "./WebApiBackend.sys.mjs";
import { WorkspaceBackend } from "./WorkspaceBackend.sys.mjs";
import { NotesBackend } from "./NotesBackend.sys.mjs";
import { LedgerBackend } from "./LedgerBackend.sys.mjs";
import { SkillBackend } from "./SkillBackend.sys.mjs";
import { EnvironmentBackend } from "./EnvironmentBackend.sys.mjs";
import { configStore } from "./ConfigStore.sys.mjs";

let _singleton = null;

export function getBackends() {
  if (_singleton) {
    return _singleton;
  }
  const page = new PageBackend();
  // net 拿 page 引用：net_capture 时 arm 内容侧发起者栈捕获，net_list/net_get 时 drain 合并 initiatorStack。
  const net = new NetworkBackend({ page });
  // page 反向拿 net 引用：navigate 后若仍在捕获，自动重新 arm（覆盖刷新/换进程导致观察者丢失）。
  page._net = net;
  // 工作目录后端：文件读写 + 本地 node/python 执行（config 提供 exe 路径覆盖）。
  const workspace = new WorkspaceBackend({ config: configStore });
  // code_search 传 workspace：除语料外，**同时搜工作目录**(scripts/work/wasm)，省去退化成 run_node grep。
  const code = new CodeBackend({ workspace });
  // scripts 传 workspace：scripts_save(toWorkspace) 可把 signer 源码直接落到工作目录，立即 run_node。
  const scripts = new ScriptsBackend({ page, workspace });
  // JsvmpBackend 读 workspace 根（trace 镜像）+ 用 workspace 跑离线工具（dispatcher_split/disassemble）。
  const jsvmp = new JsvmpBackend({ workspace });
  // WebApiBackend 读 C++ 引擎层通用 Web-API 调用 trace（环境依赖/IO 边界/WASM 边界，JS 不可检测）。
  // 传 workspace：env/flow 查询时把完整指纹清单落盘到 <工作目录>/webapi/，用户/AI 都能找到。
  const webapi = new WebApiBackend({ workspace });
  // 逆向进展笔记：跨会话按站点记"验证过的突破点/坑"，落 <工作目录>/.frx-notes.ndjson。
  const notes = new NotesBackend({ workspace });
  // 任务级「沉淀式记忆」账本：已确认事实/已否决死路落 <工作目录>/.frx-ledger.ndjson + ledger.md，
  // 引擎每轮+压缩后整本注入上下文（治压缩后重新发现/重走死路）。remember 工具写、digest 注入、mergeHandoff 自动沉淀。
  const ledger = new LedgerBackend({ workspace });
  // 逆向方法论全文（skill_get）：随浏览器内置，开工按需拉进上下文。
  const skill = new SkillBackend({ workspace }); // skill_get 时把内置脚手架释放到工作目录
  // 环境管理：一个环境一个 profile + 一个独立 Firefox 进程。UI 和 MCP 共用同一套 env manifest。
  const env = new EnvironmentBackend();

  const find = {
    /** 定位某加密/签名参数的入口：它出现在哪些请求 + 它的字面量在哪些已存 JS 里。 */
    async paramEntry({ param, urlPattern } = {}) {
      if (!param) {
        throw new Error("param required（要定位的参数名，如 sign / token / 加密签名参数）");
      }
      const out = { ok: true, param, requests: [], codeHits: [] };
      try {
        // 紧凑化：有的站点单条 URL 可达 1-2KB，截短 + 限 12 条，避免结果被 ToolRouter 截断。
        out.requests = net
          .list({ urlPattern: urlPattern || "*" + param + "*", limit: 12 })
          .requests.map(r => ({
            id: r.id,
            method: r.method,
            status: r.status,
            url: r.url.length > 220 ? r.url.slice(0, 220) + "…" : r.url,
          }));
      } catch (e) {
        out.netError = String((e && e.message) || e);
      }
      try {
        out.codeHits = (await code.search({ query: param, maxResults: 30 })).hits;
      } catch (e) {
        out.codeError = String((e && e.message) || e);
      }
      out.hint =
        "requests=该参数出现在哪些请求 URL；codeHits=该参数字面量在哪些已存 JS 的行号。" +
        "若 codeHits 为空，先用 scripts_capture_all 把页面脚本落盘再试。";
      return out;
    },
  };

  // Cookie 管理（站点无关）：用 nsICookieManager 直接读写 cookie 存储——含 **httpOnly**（page_eval 的
  // document.cookie 够不到 httpOnly），可跨域读、可增删改。纯新增能力，不影响任何现有 backend。
  const cookieJSON = c => ({
    name: c.name,
    value: c.value,
    host: c.host,
    path: c.path,
    isSecure: c.isSecure,
    isHttpOnly: c.isHttpOnly,
    isSession: c.isSession,
    sameSite: c.sameSite,
    expiry: c.expiry, // 毫秒 since epoch（nsICookie.expiry）；0/会话见 isSession
  });
  const cookieSchemeMap =
    (((Ci.nsICookie && Ci.nsICookie.SCHEME_HTTP) || 1) | ((Ci.nsICookie && Ci.nsICookie.SCHEME_HTTPS) || 2)) || 3;
  const cookieEOK = (Ci.nsICookieValidation && Ci.nsICookieValidation.eOK) ?? 0;
  const dnorm = d => String(d || "").replace(/^\./, "").toLowerCase();
  const cookies = {
    /** 列出 cookie（含 httpOnly）。domain=按 host 子串过滤；name=按名过滤（精确或子串）。只读。 */
    async list({ domain, name } = {}) {
      let out = (Services.cookies.cookies || []).map(cookieJSON);
      if (domain) {
        out = out.filter(c => c.host && c.host.toLowerCase().includes(String(domain).toLowerCase()));
      }
      if (name) {
        out = out.filter(c => c.name === name || c.name.includes(name));
      }
      return { ok: true, count: out.length, cookies: out.slice(0, 500) };
    },
    /** 新增/修改一个 cookie（同 host+path+name 即覆盖）。expiry 用毫秒（nsICookie 语义）；
     *  expires=unix 秒、maxAge=相对秒（内部转毫秒）；都不给则默认持久一年；session:true=会话 cookie。 */
    async set({ name, value, domain, path = "/", secure = false, httpOnly = false, session, expires, maxAge, sameSite } = {}) {
      if (!name || !domain) {
        throw new Error("cookies_set: name 和 domain 必填");
      }
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
      } else {
        isSession = false;
        expiryMs = nowMs + 365 * 24 * 3600 * 1000; // 默认持久一年
      }
      const ss = sameSite != null ? Number(sameSite) : ((Ci.nsICookie && Ci.nsICookie.SAMESITE_UNSET) ?? 0);
      const cv = Services.cookies.add(
        domain, path, name, String(value == null ? "" : value),
        !!secure, !!httpOnly, !!isSession, expiryMs, {}, ss, cookieSchemeMap
      );
      if (cv && cv.result !== undefined && cv.result !== cookieEOK) {
        return { ok: false, error: "cookie 被拒：" + (cv.errorString || "validation result " + cv.result) };
      }
      // 读回确认（host 可能被规范化；按 name+path+host(去前点/小写) 匹配）
      const dn = dnorm(domain);
      const after = (Services.cookies.cookies || []).find(
        c => c.name === name && c.path === path && dnorm(c.host) === dn
      );
      return after
        ? { ok: true, set: cookieJSON(after) }
        : { ok: false, error: "add 已调用但读回为空——检查 domain 是否为有效 host（如 example.com）" };
    },
    /** 删除：name+domain 删单个；只给 domain 删该 host 全部；all:true 清空所有(危险)。 */
    async remove({ name, domain, path = "/", all = false } = {}) {
      if (all === true && !name && !domain) {
        const n = (Services.cookies.cookies || []).length;
        Services.cookies.removeAll();
        return { ok: true, removed: n, scope: "ALL" };
      }
      if (!domain) {
        throw new Error("cookies_remove: domain 必填（或 all:true 清空全部）");
      }
      if (name) {
        Services.cookies.remove(domain, name, path, {});
        return { ok: true, removed: 1, name, host: domain, path };
      }
      const dn = dnorm(domain);
      let n = 0;
      for (const c of (Services.cookies.cookies || []).filter(c => dnorm(c.host) === dn)) {
        try {
          Services.cookies.remove(c.host, c.name, c.path, {});
          n++;
        } catch {
          /* skip */
        }
      }
      return { ok: true, removed: n, host: domain };
    },
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
    },
  };

  _singleton = { page, net, scripts, code, jsvmp, webapi, workspace, notes, ledger, skill, env, find, cookies };
  return _singleton;
}

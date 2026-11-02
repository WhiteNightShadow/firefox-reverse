/* selftest-cookies.mjs — `cookies` 工具（CookieBackend）对容器、分区、隐私窗口 cookie 的处理。
 *
 * FakeCookieManager 按锁定基线 nsICookieManager 的语义模拟：
 *   - 普通存储与隐私存储分开；`cookies` 只返回普通存储（含容器、分区）；
 *   - remove(host,name,path,oa) 按 host（域 cookie 带前导点）+name+path+完整 originAttributes 精确删，找不到不报错；
 *   - add() 把 host 规范成小写 ASCII、去掉末尾的点，前导点保留；originAttributes 没写的字段取默认值；
 *   - getCookiesWithOriginAttributes(pattern) 在 pattern.privateBrowsingId>0 时查隐私存储；removeAll 只清普通存储；
 *   - add() 拒绝非 secure 的 SameSite=None（eRejectedNoneRequiresSecure）；Partitioned 要求 secure 只在按页面上下文
 *     校验时检查（bug 1965880），经 add() 不拒，这里也不拒。
 */
import { CookieBackend, compactOriginAttributes, fullOriginAttributes } from "../modules/CookieBackend.sys.mjs";
import { createBuiltinTools } from "../modules/Tools.sys.mjs";
import { ToolRouter } from "../modules/ToolRouter.sys.mjs";

let pass = 0;
let fail = 0;
const ok = (condition, message) => {
  if (condition) {
    pass++;
    console.log("  ✓", message);
  } else {
    fail++;
    console.error("  ✗ FAIL:", message);
  }
};
const throwsWith = async (fn, pattern, message) => {
  try {
    await fn();
    ok(false, message + "（没有报错）");
  } catch (e) {
    ok(pattern.test(String(e && e.message)), message);
  }
};

const OA_KEYS = ["userContextId", "privateBrowsingId", "firstPartyDomain", "geckoViewSessionContextId", "partitionKey"];
const OA_DEFAULT = { userContextId: 0, privateBrowsingId: 0, firstPartyDomain: "", geckoViewSessionContextId: "", partitionKey: "" };
function initOA(value) {
  // 同 OriginAttributes::Init(jsval)：必须是对象，没写的字段取默认值。
  if (!value || typeof value !== "object") {
    throw new Error("NS_ERROR_INVALID_ARG");
  }
  const out = { ...OA_DEFAULT };
  for (const key of OA_KEYS) {
    if (value[key] !== undefined) {
      out[key] = value[key];
    }
  }
  return out;
}
function normHost(host) {
  const s = String(host).trim().toLowerCase().replace(/\.$/, "");
  const dot = s.startsWith(".") ? "." : "";
  try {
    return dot + new URL(`http://${s.replace(/^\./, "")}/`).hostname;
  } catch {
    return s;
  }
}
const oaSig = oa => JSON.stringify(OA_KEYS.map(k => oa[k]));
const keyOf = (host, name, path, oa) => [host, name, path, oaSig(oa)].join("|");
const baseDomain = host => host.replace(/^\./, "").split(".").slice(-2).join(".");
const matchesPattern = (oa, pattern) => Object.entries(pattern).every(([k, v]) => oa[k] === v);

class FakeCookieManager {
  constructor() {
    this.persistent = new Map();
    this.private = new Map();
    this.calls = [];
    this.refuseRemove = new Set(); // 模拟引擎没删掉某个 cookie
  }
  store(oa) {
    return oa.privateBrowsingId > 0 ? this.private : this.persistent;
  }
  seed(c) {
    const oa = initOA(c.originAttributes || {});
    const host = normHost(c.host);
    const cookie = {
      value: "v",
      path: "/",
      isSecure: false,
      isHttpOnly: false,
      isSession: false,
      sameSite: 256,
      expiry: Date.now() + 86400000,
      isPartitioned: false,
      ...c,
      host,
      originAttributes: oa,
    };
    this.store(oa).set(keyOf(host, cookie.name, cookie.path, oa), cookie);
    return cookie;
  }
  get cookies() {
    return [...this.persistent.values()];
  }
  add(host, path, name, value, isSecure, isHttpOnly, isSession, expiry, oa, sameSite, schemeMap, isPartitioned = false) {
    const attrs = initOA(oa);
    this.calls.push({ op: "add", host, path, name, oa: attrs, isPartitioned, isSecure, isHttpOnly, isSession, expiry, sameSite });
    if (sameSite === 0 && !isSecure) {
      return { result: 8, errorString: "SameSite=None requires Secure" };
    }
    const h = normHost(host);
    this.store(attrs).set(keyOf(h, name, path, attrs), {
      name, value, host: h, path, isSecure, isHttpOnly, isSession, sameSite, expiry, originAttributes: attrs, isPartitioned: !!isPartitioned,
    });
    return { result: 0 };
  }
  remove(host, name, path, oa) {
    const attrs = initOA(oa);
    this.calls.push({ op: "remove", host, name, path, oa: attrs });
    const key = keyOf(normHost(host), name, path, attrs);
    if (!this.refuseRemove.has(key)) {
      this.store(attrs).delete(key);
    }
  }
  cookieExists(host, path, name, oa) {
    const attrs = initOA(oa);
    return this.store(attrs).has(keyOf(normHost(host), name, path, attrs));
  }
  getCookiesFromHost(host, oa) {
    const attrs = initOA(oa);
    const bd = baseDomain(normHost(host));
    return [...this.store(attrs).values()].filter(c => baseDomain(c.host) === bd && oaSig(c.originAttributes) === oaSig(attrs));
  }
  getCookiesWithOriginAttributes(patternJSON) {
    const pattern = JSON.parse(patternJSON);
    const st = pattern.privateBrowsingId > 0 ? this.private : this.persistent;
    return [...st.values()].filter(c => matchesPattern(c.originAttributes, pattern));
  }
  removeAll() {
    this.calls.push({ op: "removeAll" });
    this.persistent.clear();
  }
  removeCookiesWithOriginAttributes(patternJSON) {
    const pattern = JSON.parse(patternJSON);
    const st = pattern.privateBrowsingId > 0 ? this.private : this.persistent;
    for (const [key, c] of st) {
      if (matchesPattern(c.originAttributes, pattern)) {
        st.delete(key);
      }
    }
  }
}

const PARTITION = "(https,top.test)";
function seeded() {
  const m = new FakeCookieManager();
  m.seed({ host: "example.com", name: "sid", value: "plain" }); // host-only，普通罐
  m.seed({ host: ".example.com", name: "sid", value: "domain" }); // 域 cookie，普通罐
  m.seed({ host: "example.com", name: "pref", path: "/app" });
  m.seed({ host: "example.com", name: "sid", value: "container", originAttributes: { userContextId: 2 } });
  m.seed({ host: ".example.com", name: "sid", value: "partitioned", isSecure: true, isPartitioned: true, originAttributes: { partitionKey: PARTITION } });
  m.seed({ host: "example.com", name: "sid", value: "private", originAttributes: { privateBrowsingId: 1 } });
  m.seed({ host: "other.test", name: "a" });
  return m;
}
const values = cookies => cookies.map(c => c.value).sort();

console.log("originAttributes 规范化");
ok(JSON.stringify(compactOriginAttributes(OA_DEFAULT)) === "{}", "普通罐压缩成 {}");
ok(JSON.stringify(compactOriginAttributes({ ...OA_DEFAULT, userContextId: 2 })) === '{"userContextId":2}', "只保留非默认字段");
ok(fullOriginAttributes({ partitionKey: PARTITION }).userContextId === 0, "没写的字段补默认值");
await throwsWith(() => fullOriginAttributes({ foo: 1 }), /不认识字段 foo/, "未知字段直接报错");
await throwsWith(() => fullOriginAttributes({ userContextId: "2" }), /非负整数/, "userContextId 不是整数时报错");
await throwsWith(() => fullOriginAttributes("userContextId=2"), /必须是对象/, "originAttributes 不是对象时报错");

console.log("list");
{
  const backend = new CookieBackend({ manager: seeded() });
  const all = await backend.list({ domain: "example.com", name: "sid" });
  ok(all.count === 4, "默认列出普通存储里四个罐的 sid（不含隐私窗口）");
  ok(all.cookies.filter(c => !c.originAttributes).length === 2, "普通罐的 cookie 不带 originAttributes 字段");
  const container = all.cookies.find(c => c.value === "container");
  ok(container && container.originAttributes.userContextId === 2 && Object.keys(container.originAttributes).length === 1, "容器 cookie 标出 userContextId");
  const part = all.cookies.find(c => c.value === "partitioned");
  ok(part && part.originAttributes.partitionKey === PARTITION && part.isPartitioned === true, "分区 cookie 标出 partitionKey 和 isPartitioned");
  ok(typeof all.hint === "string" && all.hint.includes("originAttributes"), "有非普通罐的 cookie 时给出提示");
  const withPrivate = await backend.list({ domain: "example.com", name: "sid", includePrivate: true });
  ok(withPrivate.count === 5 && withPrivate.cookies.some(c => c.originAttributes && c.originAttributes.privateBrowsingId === 1), "includePrivate 加上隐私窗口的");
  const onlyContainer = await backend.list({ domain: "example.com", originAttributes: { userContextId: 2 } });
  ok(onlyContainer.count === 1 && onlyContainer.cookies[0].value === "container", "带 originAttributes 只列那一个罐");
  const onlyDefault = await backend.list({ domain: "example.com", name: "sid", originAttributes: {} });
  ok(values(onlyDefault.cookies).join() === "domain,plain", "originAttributes:{} 只列普通罐");
  const onlyPrivate = await backend.list({ originAttributes: { privateBrowsingId: 1 } });
  ok(onlyPrivate.count === 1 && onlyPrivate.cookies[0].value === "private", "privateBrowsingId:1 去隐私存储取");
  const plainOnly = await backend.list({ domain: "other.test" });
  ok(plainOnly.count === 1 && plainOnly.hint === undefined, "全是普通罐时不加提示");
}

console.log("remove");
{
  const m = seeded();
  const backend = new CookieBackend({ manager: m });
  const r = await backend.remove({ domain: "example.com", name: "sid" });
  ok(r.ok === true && r.removed === 4 && r.matched === 4, "按名删除覆盖普通、域、容器、分区四个罐（隐私窗口的不动）");
  ok(m.calls.filter(c => c.op === "remove").every(c => c.oa && (c.host === "example.com" || c.host === ".example.com")), "每个都用 cookie 自己的 host 和 originAttributes 删");
  ok(m.calls.some(c => c.op === "remove" && c.host === ".example.com" && c.oa.partitionKey === PARTITION), "分区 cookie 用它的 partitionKey 删");
  ok(r.cookies.some(c => c.originAttributes && c.originAttributes.userContextId === 2), "结果列出删掉的 cookie 和所在的罐");
  const left = await backend.list({ domain: "example.com", includePrivate: true });
  ok(values(left.cookies).join() === "private,v", "剩下隐私窗口的 sid 和别的名字");
}
{
  const m = seeded();
  const backend = new CookieBackend({ manager: m });
  const r = await backend.remove({ domain: ".example.com", name: "sid", originAttributes: { userContextId: 2 } });
  ok(r.removed === 1 && r.cookies[0].originAttributes.userContextId === 2, "带 originAttributes 只删那个罐，domain 的前导点可省可留");
  const r2 = await backend.remove({ domain: "example.com", name: "sid", originAttributes: {} });
  ok(r2.removed === 2 && values((await backend.list({ domain: "example.com", name: "sid" })).cookies).join() === "partitioned", "originAttributes:{} 只删普通罐里的 host-only 和域 cookie");
}
{
  const backend = new CookieBackend({ manager: seeded() });
  const r = await backend.remove({ domain: "example.com", path: "/app" });
  ok(r.removed === 1 && r.cookies[0].name === "pref" && r.path === "/app", "给 path 只删这个路径的");
  const none = await backend.remove({ domain: "example.com", name: "missing" });
  ok(none.ok === true && none.removed === 0 && none.matched === 0 && typeof none.hint === "string", "没有匹配时 removed=0 并给出提示（以前会报删了 1 个）");
}
{
  const m = seeded();
  m.refuseRemove.add(keyOf(".example.com", "sid", "/", initOA({ partitionKey: PARTITION })));
  const backend = new CookieBackend({ manager: m });
  const r = await backend.remove({ domain: "example.com", name: "sid" });
  ok(r.ok === false && r.removed === 3 && r.failed.length === 1 && r.failed[0].originAttributes.partitionKey === PARTITION, "没删掉的不算进 removed，列在 failed 里");
}
{
  const m = seeded();
  const backend = new CookieBackend({ manager: m });
  const r = await backend.remove({ domain: "example.com", name: "sid", includePrivate: true });
  ok(r.removed === 5 && m.private.size === 0, "includePrivate 时连隐私窗口的一起删");
}
{
  const m = seeded();
  const backend = new CookieBackend({ manager: m });
  const r = await backend.remove({ all: true });
  ok(r.removed === 6 && m.persistent.size === 0 && m.private.size === 1, "all:true 清普通存储，隐私窗口的不在其内");
  const m2 = seeded();
  const r2 = await new CookieBackend({ manager: m2 }).remove({ all: true, includePrivate: true });
  ok(r2.removed === 7 && r2.privateRemoved === 1 && m2.private.size === 0, "all:true 加 includePrivate 一起清");
  await throwsWith(() => backend.remove({ name: "sid" }), /domain 必填/, "不给 domain 也不是 all 时报错");
}

console.log("set");
{
  const m = seeded();
  const backend = new CookieBackend({ manager: m });
  const r = await backend.set({ name: "sid", value: "c2", domain: "example.com", originAttributes: { userContextId: 2 } });
  ok(r.ok === true && r.replaced === true && r.set.value === "c2" && r.set.originAttributes.userContextId === 2, "改容器里的 cookie");
  const plain = (await backend.list({ domain: "example.com", name: "sid", originAttributes: {} })).cookies;
  ok(values(plain).join() === "domain,plain", "普通罐的同名 cookie 没被改");
  const p = await backend.set({ name: "sid", value: "p2", domain: ".example.com", originAttributes: { partitionKey: PARTITION } });
  const addCall = m.calls.filter(c => c.op === "add").at(-1);
  ok(p.ok === true && p.set.isPartitioned === true && addCall.isPartitioned === true, "改分区 cookie 沿用原来的 Partitioned 属性");
  const fresh = await backend.set({ name: "new", value: "1", domain: "example.com" });
  ok(fresh.ok === true && fresh.replaced === false && fresh.set.host === "example.com" && !fresh.set.originAttributes, "不带 originAttributes 写普通罐");
  const hostOnly = await backend.set({ name: "sid", value: "plain2", domain: "Example.COM" });
  ok(hostOnly.ok === true && hostOnly.set.host === "example.com" && hostOnly.set.value === "plain2", "读回认 host 是否带前导点，不会错拿成同名的域 cookie");
  const chips = await backend.set({ name: "chips", value: "1", domain: "example.com", originAttributes: { partitionKey: PARTITION }, partitioned: true, secure: true });
  ok(chips.ok === true && chips.set.isPartitioned === true, "partitioned:true 加 secure 新建 CHIPS cookie");
  const priv = await backend.set({ name: "sid", value: "private2", domain: "example.com", originAttributes: { privateBrowsingId: 1 } });
  ok(priv.ok === true && m.private.size === 1 && [...m.private.values()][0].value === "private2", "写隐私窗口的罐");
  await throwsWith(() => backend.set({ name: "x", domain: "example.com", originAttributes: { container: 2 } }), /不认识字段 container/, "originAttributes 写错字段时不写入");
  await throwsWith(() => backend.set({ name: "x" }), /name 和 domain 必填/, "缺 domain 报错");
}

{
  // 改已有的只改给了的属性：httpOnly 会话 cookie 改值后还是 httpOnly、会话、原过期时间。
  const m = new FakeCookieManager();
  const expiry = Date.now() + 7200000;
  m.seed({ host: "login.example.com", name: "token", value: "old", isHttpOnly: true, isSession: true, sameSite: 1, expiry });
  const backend = new CookieBackend({ manager: m });
  const r = await backend.set({ name: "token", value: "new", domain: "login.example.com" });
  const call = m.calls.filter(c => c.op === "add").at(-1);
  ok(r.ok === true && r.set.value === "new" && r.set.isHttpOnly === true && r.set.isSession === true && call.expiry === expiry && call.sameSite === 1, "改值时 httpOnly、会话、过期时间和 sameSite 沿用原值");
  const r2 = await backend.set({ name: "token", value: "v3", domain: "login.example.com", httpOnly: false, maxAge: 60 });
  ok(r2.ok === true && r2.set.isHttpOnly === false && r2.set.isSession === false, "显式给的属性照给的改");
  const fresh = await backend.set({ name: "brand-new", value: "1", domain: "login.example.com" });
  const freshCall = m.calls.filter(c => c.op === "add").at(-1);
  ok(fresh.ok === true && freshCall.isSecure === false && freshCall.isHttpOnly === false && freshCall.isSession === false && freshCall.sameSite === 256, "新建的仍用默认属性");
}
{
  const m = seeded();
  const backend = new CookieBackend({ manager: m });
  const r = await backend.set({ name: "sid", value: "p3", domain: ".example.com", originAttributes: { partitionKey: PARTITION } });
  ok(r.ok === true && r.set.isPartitioned === true && r.set.isSecure === true, "只改分区 cookie 的值：secure 和 Partitioned 都沿用");
  m.seed({ host: "api.example.com", name: "cross", value: "1", isSecure: true, sameSite: 0 });
  const none = await backend.set({ name: "cross", value: "2", domain: "api.example.com" });
  ok(none.ok === true && none.set.isSecure === true && none.set.sameSite === 0, "只改 SameSite=None cookie 的值：secure 沿用，引擎不会拒");
  const rejected = await backend.set({ name: "cross", value: "3", domain: "api.example.com", secure: false });
  ok(rejected.ok === false && /SameSite=None requires Secure/.test(rejected.error), "显式去掉 secure 时引擎拒绝，原样报出原因");
}

console.log("工具注册与路由");
{
  const backend = new CookieBackend({ manager: seeded() });
  const router = new ToolRouter();
  router.registerAll(createBuiltinTools({ cookies: backend }));
  ok(router.has("cookies") && router.needsConfirm("cookies"), "cookies 工具注册，仍需用户确认");
  const spec = router.listSpecs().find(s => s.function && s.function.name === "cookies");
  const props = spec && spec.function.parameters.properties;
  ok(props && props.originAttributes && props.originAttributes.properties.userContextId && props.includePrivate && props.partitioned, "参数里有 originAttributes、includePrivate、partitioned");
  const listed = await router.dispatch("cookies", { action: "list", domain: "example.com", name: "sid" });
  ok(listed.ok === true && listed.data.count === 4, "经 ToolRouter 调 list");
  const removed = await router.dispatch("cookies", { action: "remove", domain: "example.com", name: "sid", originAttributes: { userContextId: 2 } });
  ok(removed.ok === true && removed.data.removed === 1, "经 ToolRouter 调 remove");
  const bad = await router.dispatch("cookies", { action: "remove", domain: "example.com", originAttributes: { foo: 1 } });
  ok(bad.ok === false && /不认识字段/.test(bad.error), "参数错误以工具错误返回");
  const unknown = await router.dispatch("cookies", { action: "purge" });
  ok(unknown.ok === false && /未知 action/.test(unknown.error), "未知 action 报错");
}

console.log(`\nCookieBackend selftest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

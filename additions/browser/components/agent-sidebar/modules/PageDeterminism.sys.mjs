/* PageDeterminism.sys.mjs — page_determinism：同一个种子让页面的 Math.random、crypto.getRandomValues、
 * crypto.randomUUID 每次给出同一串值。
 *
 * 引擎层实现（additions/dom/base/FrxDeterministicRandom.h）：Math.random 直接设 realm 自己的生成器状态，
 * 页面看到的仍是原生函数。父进程把配置写进 sharedData 并注册 AgentDeterminism actor，之后每个新文档（含
 * iframe、跨进程导航后的文档）在页面脚本运行前由内容侧设种子；已经打开的文档在 start/stop 时补设或撤销。
 * replicaSource() 是同一套算法的 Node 版：写进工作目录，签名复现脚本 require 它就能拿到和页面一样的随机数。
 */
const ACTOR = "AgentDeterminism";
const CONFIG_KEY = "agentsidebar:determinism"; // 与 AgentDeterminismChild.sys.mjs 同一个键
const DEFAULT_SEED = "frx";
const DEFAULT_REPLICA = "work/determinism-replica.cjs";

/** CommonJS 源码；算法与 FrxDeterministicRandom.cpp 逐位一致，改一边必须改另一边。 */
export function replicaSource() {
  return `// page_determinism replica from Firefox Reverse: with the same seed, a seeded document's Math.random,
// crypto.getRandomValues and crypto.randomUUID return exactly these values, call for call, in call order.
//   const { seeded } = require("./determinism-replica.cjs");
//   const r = seeded("frx"); r.random(); r.getRandomValues(new Uint8Array(16)); r.randomUUID();
"use strict";

const MASK = (1n << 64n) - 1n;

// The seed's UTF-8 bytes; lone surrogates become U+FFFD as in the browser.
function utf8(text) {
  const bytes = [];
  for (const char of String(text)) {
    let c = char.codePointAt(0);
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return bytes;
}

// FNV-1a 64 over the seed, then SplitMix64.
function seedSequence(seed) {
  let state = 0xcbf29ce484222325n;
  for (const byte of utf8(seed)) state = ((state ^ BigInt(byte)) * 0x100000001b3n) & MASK;
  return () => {
    state = (state + 0x9e3779b97f4a7c15n) & MASK;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
    return z ^ (z >> 31n);
  };
}

// xorshift128+ as in mfbt/XorShift128PlusRNG.h, started from two SplitMix64 outputs (an all-zero pair gets 1).
function xorshift128plus(next) {
  let s0 = next();
  let s1 = next();
  if (s0 === 0n && s1 === 0n) s1 = 1n;
  return () => {
    let a = s0;
    const b = s1;
    s0 = b;
    a = (a ^ (a << 23n)) & MASK;
    s1 = a ^ b ^ (a >> 17n) ^ (b >> 26n);
    return (s1 + b) & MASK;
  };
}

function seeded(seed) {
  const sequence = seedSequence(seed);
  const math = xorshift128plus(sequence);
  const crypto = xorshift128plus(sequence);
  return {
    // Math.random: the low 53 bits over 2^53.
    random: () => Number(math() & 0x1fffffffffffffn) / 2 ** 53,
    // Every call starts on a fresh 64-bit output, least significant byte first.
    getRandomValues(view) {
      if (!ArrayBuffer.isView(view) || view instanceof DataView || /Float/.test(view.constructor.name)) {
        throw new TypeError("getRandomValues takes an integer typed array");
      }
      if (view.byteLength > 65536) throw new RangeError("getRandomValues fills at most 65536 bytes");
      const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      for (let offset = 0; offset < bytes.length; offset += 8) {
        let value = crypto();
        for (let i = 0; i < 8 && offset + i < bytes.length; i++, value >>= 8n) bytes[offset + i] = Number(value & 0xffn);
      }
      return view;
    },
    // Version 4 UUID from two outputs, most significant digit first.
    randomUUID() {
      const digits = [...(crypto().toString(16).padStart(16, "0") + crypto().toString(16).padStart(16, "0"))];
      digits[12] = "4";
      digits[16] = (8 | (parseInt(digits[16], 16) & 3)).toString(16);
      const hex = digits.join("");
      return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
    },
  };
}

module.exports = { seeded };
`;
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

export class PageDeterminism {
  constructor({ page, workspace, shared = () => Services.ppmm.sharedData, actors = ChromeUtils, tops = defaultTops } = {}) {
    this.page = page;
    this.workspace = workspace;
    this.shared = shared;
    this.actors = actors;
    this.tops = tops;
    this.config = null;
  }

  async run({ action = "status", seed, scope = "tab", path } = {}, ctx) {
    if (action === "status") return { ok: true, ...this.status() };
    if (action === "start") return this.start({ seed, scope }, ctx);
    if (action === "stop") return this.stop();
    if (action === "replica") return this.replica(path, ctx);
    throw new Error("action 只能是 start / stop / status / replica");
  }

  status() {
    return this.config ? { active: true, ...this.config } : { active: false };
  }

  async start({ seed = DEFAULT_SEED, scope = "tab" }, ctx) {
    seed = String(seed ?? "");
    if (!seed) throw new Error("seed 不能为空：恢复真随机用 action:stop");
    if (!["tab", "all"].includes(scope)) throw new Error("scope 只能是 tab / all");
    const browser = this.page.browser(ctx);
    if (this.config) await this.stop();
    this.register();
    this.config = { seed, scope, browserId: scope === "all" ? null : browser.browserId };
    this.publish(this.config);
    const seededNow = await this.apply([browser.browsingContext], seed);
    return {
      ok: true,
      ...this.status(),
      seededNow,
      note:
        `已固定随机数：${scope === "all" ? "所有标签页" : "当前标签页"}之后打开的每个文档（含 iframe）在页面脚本运行前设种子，` +
        `当前页的 ${seededNow} 个文档也已从种子开头重新取数。要从第一行脚本起可重复，用 page_navigate 重新打开当前地址。` +
        "要在 node 里得到同样的值：page_determinism(action:replica)。Date.now、performance.now 和 Worker 里的随机数不受影响。",
    };
  }

  async stop() {
    if (!this.config) return { ok: true, active: false };
    const was = this.config;
    this.publish(null);
    const tops = this.tops(was.scope === "all" ? null : was.browserId);
    const resetNow = await this.apply(tops, "");
    this.config = null;
    this.unregister();
    return { ok: true, active: false, seed: was.seed, resetNow, note: "已恢复真随机：已打开的文档立即恢复，新文档不再设种子。" };
  }

  async replica(path, ctx) {
    if (!this.workspace) throw new Error("工作目录不可用");
    const target = path || DEFAULT_REPLICA;
    const file = this.workspace._resolve(target, ctx);
    await IOUtils.makeDirectory(PathUtils.parent(file), { ignoreExisting: true, createAncestors: true });
    await IOUtils.writeUTF8(file, replicaSource());
    const seed = JSON.stringify(this.config?.seed ?? DEFAULT_SEED);
    return {
      ok: true,
      saved: target,
      usage: `const { seeded } = require("./${target.split("/").pop()}"); const r = seeded(${seed}); r.random(); r.getRandomValues(new Uint8Array(16)); r.randomUUID();`,
      note: "按页面里的调用顺序取数才对得上：Math.random 一条序列，getRandomValues 和 randomUUID 共用另一条；每个文档都从种子开头算起。",
    };
  }

  register() {
    try {
      this.actors.registerWindowActor(ACTOR, {
        child: {
          esModuleURI: "resource:///modules/agentsidebar/AgentDeterminismChild.sys.mjs",
          events: { DOMWindowCreated: {} },
        },
        allFrames: true,
      });
    } catch (error) {
      if (!/already.*regist/i.test(String(error?.message))) throw error;
    }
  }

  unregister() {
    try {
      this.actors.unregisterWindowActor(ACTOR);
    } catch {}
  }

  publish(config) {
    const shared = this.shared();
    if (config) shared.set(CONFIG_KEY, config);
    else shared.delete(CONFIG_KEY);
    shared.flush();
  }

  /** 给这些标签页里已经打开的文档设种子（seed 为空串则恢复真随机），返回成功的文档数。 */
  async apply(tops, seed) {
    let count = 0;
    for (const top of tops) {
      for (const context of safe(() => top.getAllBrowsingContextsInSubtree()) || []) {
        const actor = safe(() => context.currentWindowGlobal?.getActor(ACTOR));
        const result = actor ? await actor.sendQuery("Determinism:Seed", { seed }).catch(() => null) : null;
        if (result?.ok) count++;
      }
    }
    return count;
  }
}

/** browserId 对应标签页的顶层 browsing context；不给则是所有窗口的所有标签页。 */
function defaultTops(browserId) {
  if (browserId != null) return [BrowsingContext.getCurrentTopByBrowserId(browserId)].filter(Boolean);
  const tops = [];
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    for (const browser of win.gBrowser?.browsers || []) {
      if (browser.browsingContext) tops.push(browser.browsingContext);
    }
  }
  return tops;
}

// webpack-chunk-loader.js —— 在 Node 加载「webpack / loadable-components 代码分割 chunk」的通用 loader
// （站点无关脚手架：fs_copy 到 work/ 改 2 处——sdk 路径 + url——即可用）
//
// 解决的高频卡点：抓到的 signer 文件是一个 **code-split chunk**（不是自包含 bundle），
// 直接 require/eval **不会**设上 window.XXX，因为它只是 `(self.__LOADABLE_LOADED_CHUNKS__||[]).push([...])`
// 或 `(self.webpackChunkXXX=...).push([...])`——必须①先建好那个全局数组②再 eval③用 webpack runtime
// 手动 require 入口模块；且 chunk 常 `__webpack_require__(外部id)` 引用**本文件没有的**其它 chunk 模块
// → 必须对缺失 id 自动返回 stub，否则 "Cannot read properties of undefined (reading 'call')"。
//
// 这三招（建全局数组→eval→手动 require + auto-stub 外部依赖）能让绝大多数 code-split signer 在 Node 跑起来，
// 不用手搓完整 webpack runtime、不用把整站所有 chunk 都抓全。
//
// 依赖：jsdom（npm_install jsdom）。纯 wasm-bindgen 签名器用 wasm-signer-loader.js；
// 自包含单文件混淆用 node-env-loader.js；本模板专治「代码分割」。

const fs = require("fs");

// 缺失外部模块的占位：可被当函数调/取属性/new，都返回自身，避免链式访问崩。
// 若 stub 影响结果（签名值不对），再针对性把真实那个外部 chunk 也抓来喂进 extraModules。
function makeStub() {
  const f = function () { return f; };
  return new Proxy(f, {
    get: (t, k) => (k === Symbol.toPrimitive ? () => 0 : k === "default" ? f : f),
    apply: () => f,
    construct: () => ({}),
  });
}

// 建一个浏览器样环境（jsdom）。navigator.webdriver=false；按需 globals 覆盖（指纹真值用 webapi_trace 抓了填）。
function buildEnv(opts = {}) {
  const { JSDOM } = require("jsdom");
  const dom = new JSDOM(opts.html || "<!doctype html><html><body></body></html>", {
    url: opts.url || "https://example.com/",
    referrer: opts.referrer || undefined,
    pretendToBeVisual: true,
  });
  const w = dom.window;
  // 只从 jsdom 取 **DOM 专属**全局（Node 没有的）。⚠通用 JS 全局（atob/btoa/TextEncoder/TextDecoder/
  // URL/URLSearchParams/crypto）**用 Node 原生**——jsdom 的 atob 比浏览器/Node 更严格，bundle init 期
  // 调 atob 会抛 InvalidCharacterError 导致 window.XXX 设不上（实测踩坑）。
  for (const k of ["window", "document", "navigator", "self", "location", "history",
                   "XMLHttpRequest", "Blob", "FormData", "FileReader", "Event", "CustomEvent",
                   "MutationObserver", "getComputedStyle", "requestAnimationFrame"]) {
    try { if (w[k] !== undefined) global[k] = w[k]; } catch {}
  }
  global.self = global.window = w;
  try { Object.defineProperty(w.navigator, "webdriver", { value: false, configurable: true }); } catch {}
  // 反爬常探 process（探到=判定 Node 环境）。⚠但**加载/init 期别藏**——很多 webpack bundle 初始化读
  // process.env.NODE_ENV，藏了会让模块工厂抛错、window.XXX 设不上。默认保留；确认是签名期被探到再 opts.hideProcess
  // （或加载完、调 signer 前用 hideProcess() 手动藏）。
  if (opts.hideProcess) { try { Object.defineProperty(global, "process", { value: undefined, configurable: true }); } catch {} }
  for (const [k, v] of Object.entries(opts.globals || {})) { try { global[k] = w[k] = v; } catch {} }
  return dom;
}

// 标准 webpack runtime 辅助（r/d/o/n + e/u/g/p 空实现），缺失模块走 onMissing。
function makeRequire(modules, onMissing) {
  const cache = {};
  const stubbed = [];
  function req(id) {
    if (cache[id]) return cache[id].exports;
    if (!modules[id]) {
      stubbed.push(id);
      const ex = onMissing ? onMissing(id) : makeStub();
      cache[id] = { exports: ex };
      return ex;
    }
    const m = (cache[id] = { exports: {} });
    try { modules[id].call(m.exports, m, m.exports, req); } catch (e) { m.error = e; }
    return m.exports;
  }
  req.r = (e) => { try { Object.defineProperty(e, "__esModule", { value: true }); } catch {}
                   try { if (typeof Symbol !== "undefined" && Symbol.toStringTag) Object.defineProperty(e, Symbol.toStringTag, { value: "Module" }); } catch {} };
  req.d = (e, d) => { for (const k in d) if (!Object.prototype.hasOwnProperty.call(e, k)) try { Object.defineProperty(e, k, { enumerable: true, get: d[k] }); } catch {} };
  req.o = (o, p) => Object.prototype.hasOwnProperty.call(o, p);
  req.n = (m) => { const g = m && m.__esModule ? () => m.default : () => m; req.d(g, { a: g }); return g; };
  req.g = global;
  req.e = () => Promise.resolve();
  req.u = (x) => x + ".js";
  req.f = {};
  req.p = "";
  req.cache = cache;
  req.stubbed = stubbed;
  return req;
}

// 收集 eval chunk 后被 push 进来的所有模块（合并多 chunk）。支持三种 push 容器。
function collectModules(globalObj) {
  const out = {};
  const containers = [];
  if (Array.isArray(globalObj.__LOADABLE_LOADED_CHUNKS__)) containers.push(globalObj.__LOADABLE_LOADED_CHUNKS__);
  for (const k of Object.keys(globalObj)) {
    if (/^webpackChunk/.test(k) && Array.isArray(globalObj[k])) containers.push(globalObj[k]);
  }
  if (Array.isArray(globalObj.webpackJsonp)) containers.push(globalObj.webpackJsonp);
  const chunkIds = [];
  for (const arr of containers) {
    for (const entry of arr) {
      // entry 形如 [chunkIds, modules] 或 [chunkIds, modules, runtime]
      if (Array.isArray(entry) && entry[1] && typeof entry[1] === "object") {
        chunkIds.push(entry[0]);
        Object.assign(out, entry[1]);
      }
    }
  }
  return { modules: out, chunkIds };
}

/**
 * 加载一个 code-split chunk 文件。
 * @param {string} sdkPath  chunk .js 路径
 * @param {object} opts  { url, html, globals, keepProcess, entry, onMissing, extraModules }
 *   entry: 'auto'(默认,执行所有入口模块) | moduleId | [moduleId,...]
 * @returns { window, modules, require, chunkIds, stubbed }
 */
function loadBundle(sdkPath, opts = {}) {
  return loadBundles([sdkPath], opts);
}

/**
 * 加载**多个** code-split chunk 到同一上下文（治"纠缠型 signer"：一个 chunk `__webpack_require__(外部id)`
 * 引用别的 chunk 里的模块——单文件加载会 stub 几十~几百个外部依赖、把签名器的真依赖也 stub 掉而失败）。
 * 把签名器所在 chunk + 它依赖的那些 chunk（用 scripts_capture_all 抓全、看 stubbed 列表缺哪些就补哪个 chunk）
 * 一起 eval → 各 chunk 的模块合进同一 registry → 跨 chunk 依赖就能解析。
 * @param {string[]} sdkPaths  chunk .js 路径数组（顺序无关，push 容器累积）
 * @param {object} opts  同 loadBundle
 */
function loadBundles(sdkPaths, opts = {}) {
  const dom = buildEnv(opts);
  global.self.__LOADABLE_LOADED_CHUNKS__ = global.self.__LOADABLE_LOADED_CHUNKS__ || [];
  const evalErrors = [];
  for (const p of [].concat(sdkPaths)) {
    try { (0, eval)(fs.readFileSync(p, "utf8")); }
    catch (e) { evalErrors.push({ path: p, err: String(e && e.message || e) }); } // 单个 chunk eval 失败不阻断其余
  }
  let { modules, chunkIds } = collectModules(global.self);
  if (opts.extraModules) modules = Object.assign({}, opts.extraModules, modules);
  const req = makeRequire(modules, opts.onMissing);
  const ids = Object.keys(modules);
  let entries = opts.entry && opts.entry !== "auto" ? [].concat(opts.entry) : ids;
  for (const id of entries) { try { req(id); } catch {} }
  return { window: dom.window, modules, require: req, chunkIds, stubbed: req.stubbed, entryIds: entries, evalErrors };
}

/**
 * 狩猎：遍历所有内部模块导出（含函数），用 probe 测每个，返回命中的。
 * 治"signer 是 nested bundle 内部函数、没暴露在 window 上"——逐个调看哪个产出目标特征（如解码后 N 字节）。
 * @param {object} loaded  loadBundle 返回值
 * @param {function} probe (exportValue, name, moduleId) => truthy 命中
 */
function huntExports(loaded, probe) {
  const hits = [];
  for (const id of Object.keys(loaded.modules)) {
    let ex;
    try { ex = loaded.require(id); } catch { continue; }
    if (!ex || (typeof ex !== "object" && typeof ex !== "function")) continue;
    for (const name of Object.keys(ex)) {
      let v; try { v = ex[name]; } catch { continue; }
      try { if (probe(v, name, id)) hits.push({ moduleId: id, name, value: v }); } catch {}
    }
  }
  return hits;
}

/**
 * 纠缠型 chunk 的「缺哪些外部模块」报告（站点无关、纯分析）。把 loadBundles 后被 stub 的模块 id 按
 * **被 require 的次数**降序汇总——高频被引用的更可能是签名器**真依赖**、优先补抓那几个 chunk；低频多是
 * 边角依赖、stub 掉也不影响签名值。治"纠缠型 signer 依赖散在几十~几百个未抓 chunk、不知补哪个"。
 * 拿到 missing 后：scripts_capture_all 抓全页面脚本 / 浏览器里 __webpack_require__.u(<id>) 求文件名 →
 * 把对应 chunk 加进 loadBundles([...]) 重跑，只补**签名值对不上时真正缺**的那几个，别全补。
 * @param {object} loaded  loadBundles 返回值
 * @returns { missingCount, missing:[{id,requiredTimes}], note }
 */
function missingReport(loaded) {
  const freq = Object.create(null);
  for (const id of (loaded && loaded.stubbed) || []) { freq[id] = (freq[id] || 0) + 1; }
  const ranked = Object.keys(freq)
    .sort((a, b) => freq[b] - freq[a])
    .map(id => ({ id, requiredTimes: freq[id] }));
  return {
    missingCount: ranked.length,
    missing: ranked.slice(0, 100),
    note: ranked.length
      ? `${ranked.length} 个模块被引用但未加载（被 stub，按被 require 次数降序——高频的更可能是签名器真依赖、优先补；低频边角依赖 stub 掉多半不影响）。它们在**别的 chunk** 里：scripts_capture_all 抓全页面脚本 / 浏览器里 __webpack_require__.u(<id>) 求文件名 → 把对应 chunk 加进 loadBundles([...]) 重跑。只补签名值对不上时真正缺的那几个。`
      : "无缺失外部模块（自包含）——直接用导出 / huntExports，不必补抓 chunk。",
  };
}

// 跑一段逻辑，超时即报（防 signer init 起 timer/loop 挂死整个进程）。
function withWatchdog(ms, label, fn) {
  const wd = setTimeout(() => { console.error("[watchdog] " + (label || "task") + " 超 " + ms + "ms（疑似 timer/loop）"); process.exit(2); }, ms);
  try { return fn(); } finally { clearTimeout(wd); }
}

// 加载完、调 signer 前手动藏 process（反 Node 检测）；返回还原函数。
function hideProcess() {
  const real = global.process;
  try { Object.defineProperty(global, "process", { value: undefined, configurable: true }); } catch {}
  return () => { try { Object.defineProperty(global, "process", { value: real, configurable: true }); } catch {} };
}

module.exports = { loadBundle, loadBundles, huntExports, missingReport, buildEnv, makeStub, makeRequire, collectModules, withWatchdog, hideProcess };

// ── 自检/示例（node webpack-chunk-loader.js <chunk.js>）──
if (require.main === module) {
  const p = process.argv[2];
  if (!p) { console.log("用法: node webpack-chunk-loader.js <chunk.js> [chunk 装到 window 上的对象名]"); process.exit(0); }
  const name = process.argv[3];
  const r = withWatchdog(8000, "load", () => loadBundle(p, { url: "https://www.example.com/" }));
  console.log("chunkIds:", JSON.stringify(r.chunkIds), "| stubbed externals:", JSON.stringify(r.stubbed.slice(0, 20)));
  const mr = missingReport(r);
  console.log("missingReport:", mr.missingCount, "missing →", JSON.stringify(mr.missing.slice(0, 10)));
  if (name) console.log("window." + name + ":", r.window[name] ? Object.keys(r.window[name]) : "(未设上)");
  else console.log("window keys 新增（部分）:", Object.keys(r.window).filter(k => !/^[A-Z]/.test(k)).slice(0, 30));
}

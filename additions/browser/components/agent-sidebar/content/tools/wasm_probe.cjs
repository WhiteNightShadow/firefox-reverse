#!/usr/bin/env node
/* wasm_probe.cjs — 通用 wasm-bindgen 签名器 import-trace（站点无关、零三方依赖）。
 *
 * 给一个 wasm-bindgen 的 JS glue + .wasm，在 Node 里加载并 hook 所有 wbg import：
 *   - monkeypatch WebAssembly.instantiate(Streaming) → 用本地 wasm 字节 + 给 imports.wbg 套日志 Proxy
 *   - 极简 fake DOM（document.querySelector / element.getAttribute / navigator / window）由 config 驱动
 *   - 跨 chunk 的 ESM import 用通用 __stub 占位；import.meta 中性化
 *   - 解析 (ptr,len) 字符串实参 → 可读 selector/属性名
 * 输出 JSON：{ ok, calls:[...], signOut, signKind, exportsKeys, error }
 *
 * 用法: node wasm_probe.cjs <config.json>
 * config: { wasmPath, gluePath, url?, navigator?:{webdriver,userAgent,platform,language},
 *           selectors?:{ "<css>": {"<attr>":"<value>", content?:..} }, attrDefault?:"",
 *           callExpr? (在 init 后 eval，作用域有 __G；默认自动找名字含 sign 的导出并以传入实参调用它),
 *           signUrl?, signTs? }
 */
const fs = require('fs');

const cfgPath = process.argv[2];
if (!cfgPath) { console.log(JSON.stringify({ ok: false, error: 'usage: wasm_probe.cjs <config.json>' })); process.exit(1); }
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const ATTR_DEFAULT = cfg.attrDefault != null ? cfg.attrDefault : '';

// ---- 极简 fake DOM（按需返回 config 里的值；未知 selector/属性返回 attrDefault，避免 Rust unwrap panic）----
function makeEl(attrs) {
  attrs = attrs || {};
  const el = {
    getAttribute: (n) => (n in attrs ? attrs[n] : ATTR_DEFAULT),
    setAttribute: () => {},
    get content() { return 'content' in attrs ? attrs.content : ATTR_DEFAULT; },
    get href() { return 'href' in attrs ? attrs.href : ATTR_DEFAULT; },
    get textContent() { return 'textContent' in attrs ? attrs.textContent : ATTR_DEFAULT; },
    getElementsByTagName: () => [],
    nodeType: 1,
  };
  return el;
}
const selectors = cfg.selectors || {};
const fakeDoc = {
  querySelector: (sel) => makeEl(selectors[sel]),
  querySelectorAll: (sel) => [makeEl(selectors[sel])],
  getElementsByTagName: () => [],
  createElement: () => makeEl({}),
  documentElement: makeEl({}),
  location: { href: cfg.url || 'https://example.com/' },
  cookie: cfg.cookie || '',
  nodeType: 9,
};
const nav = Object.assign({ webdriver: false, userAgent: 'Mozilla/5.0', platform: 'MacIntel', language: 'zh-CN', languages: ['zh-CN'] }, cfg.navigator || {});
function FakeWindow() {}
const fakeWin = Object.create(FakeWindow.prototype);
Object.assign(fakeWin, { document: fakeDoc, navigator: nav, location: fakeDoc.location, self: null });
fakeWin.self = fakeWin; fakeWin.window = fakeWin;
global.window = fakeWin; global.document = fakeDoc; global.navigator = nav;
global.self = fakeWin; global.Window = FakeWindow; global.location = fakeDoc.location;
if (!global.crypto) global.crypto = require('crypto').webcrypto;
fakeWin.crypto = global.crypto;

const wasmBytes = fs.readFileSync(cfg.wasmPath);
global.fetch = async () => ({ ok: true, arrayBuffer: async () => wasmBytes, headers: { get: () => 'application/wasm' } });

// ---- 日志 + (ptr,len)→字符串解码 ----
const calls = [];
const allImports = {}; // 所有被调用的 wbg import 名→次数（含 INTEREST 白名单外的）——治"隐藏的 env 读取看不见、反复纠结只读 favicon"
let MEM = null;
const short = (v) => {
  try {
    if (typeof v === 'string') return JSON.stringify(v.length > 80 ? v.slice(0, 80) + '…(' + v.length + ')' : v);
    if (typeof v === 'number' || typeof v === 'boolean' || v == null) return String(v);
    if (typeof v === 'function') return 'fn';
    return Object.prototype.toString.call(v);
  } catch { return '?'; }
};
function decodeArgs(a) {
  const u8 = MEM ? new Uint8Array(MEM.buffer) : null;
  const out = [];
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = a[i + 1];
    if (u8 && typeof x === 'number' && typeof y === 'number' && x > 1024 && y > 0 && y < 4096 && x + y <= u8.length) {
      try {
        const s = new TextDecoder('utf-8', { fatal: true }).decode(u8.subarray(x, x + y));
        if (s.length && /[\x20-\x7e]/.test(s[0])) { out.push(JSON.stringify(s.length > 120 ? s.slice(0, 120) + '…' : s)); i++; continue; }
      } catch {}
    }
    out.push(short(x));
  }
  return out.join(',');
}
const INTEREST = /querySelector|getAttribute|getElementsBy|navigator|document|Window|WINDOW|webdriver|location|href|userAgent|platform|language|cookie|title|content|crypto|getRandomValues|now|Date|string_new|number_get|boolean_get/i;
function wrap(imports) {
  if (imports && imports.wbg) {
    const wbg = imports.wbg;
    imports.wbg = new Proxy(wbg, {
      get(t, k) {
        const v = t[k];
        if (typeof v !== 'function') return v;
        return function (...a) {
          let r, threw;
          try { r = v.apply(this, a); } catch (e) { threw = e; }
          const kn = k.replace(/_[0-9a-f]{16}$/, '');
          allImports[kn] = (allImports[kn] || 0) + 1;   // 记**所有** import（不漏白名单外的隐藏读取）
          if (INTEREST.test(k)) calls.push(kn + '(' + decodeArgs(a) + ')' + (threw ? ' THREW' : ''));
          if (threw) throw threw;
          return r;
        };
      },
    });
  }
  return imports;
}
const _inst = WebAssembly.instantiate;
function grabMem(p) {
  return Promise.resolve(p).then((res) => {
    const inst = res && res.instance ? res.instance : res;
    if (inst && inst.exports && inst.exports.memory) MEM = inst.exports.memory;
    return res;
  });
}
WebAssembly.instantiateStreaming = (_src, imports) => WebAssembly.instantiate(wasmBytes, imports);
WebAssembly.instantiate = function (buf, imports) {
  const bytes = buf && buf.arrayBuffer ? wasmBytes : buf;
  return grabMem(_inst.call(WebAssembly, bytes, wrap(imports)));
};

// ---- ESM glue → flat eval-able ----
let src = fs.readFileSync(cfg.gluePath, 'utf8');
src = src.replace(/import\.meta\.url/g, '"file:///x"');
src = src.replace(/import\.meta/g, '({url:"file:///x"})');
src = src.replace(/import\{([^}]*)\}from"[^"]*";?/g, (_m, names) => {
  const decls = names.split(',').map(s => { const m = s.trim().match(/(?:\S+\s+as\s+)?(\S+)$/); return m ? m[1] : null; }).filter(Boolean).map(n => `${n}=__stub`).join(',');
  return decls ? `var ${decls};` : '';
});
src = src.replace(/import\s+[A-Za-z$_][\w$]*\s+from"[^"]*";?/g, '');
src = src.replace(/export\{([^}]*)\};?/g, (_m, names) => {
  const pairs = names.split(',').map(s => {
    const m = s.trim().match(/(\S+)\s+as\s+(\S+)/);
    if (m) return `${m[2]}:(typeof ${m[1]}!=="undefined"?${m[1]}:undefined)`;
    const b = s.trim(); return b ? `${b}:(typeof ${b}!=="undefined"?${b}:undefined)` : null;
  }).filter(Boolean).join(',');
  return `;globalThis.__G={${pairs}};`;
});
src = src.replace(/export default /g, ';globalThis.__default=');
// signerExpr：签名器常是 glue **闭包里**的类（如 pe，靠工厂 Ee() 造）。callExpr 只能在 eval 作用域看到 __G，
// 够不到 pe/Ee（实战里 AI 为此绕几十轮、最后被迫手改 glue 导出）。这里在 glue 末尾追加一个**闭包 thunk**：
// 它定义在 glue 的模块作用域内（能引用 pe/Ee/_ 等），挂到 __G 上 → init 完成后从外部调 __G.__mkSigner()
// 就拿到签名器，再 .sign(url,ts)。一步到位，无需改 glue。thunk 体只在被调时执行，故坏表达式不会炸 glue 的 eval。
if (cfg.signerExpr) {
  src += '\n;try{globalThis.__G=globalThis.__G||{};globalThis.__G.__mkSigner=function(){return (' + cfg.signerExpr + ');};}catch(__e){}';
}
// CJS shim：AI 常把 glue patch 成 CommonJS（module.exports）；这里给 eval 作用域备好 module/exports/require，
// 避免在改造过的 glue 上报 "module is not defined"（实战痛点：报错后 AI 弃用 wasm_probe、回去手写 loader 又把 glue 改坏）。
const preamble = 'var __stub=new Proxy(function(){return __stub;},{get:function(){return __stub;},apply:function(){return __stub;}});' +
  'var module={exports:{}},exports=module.exports,require=function(){return __stub;};';

const result = { ok: false, calls, allImports, signOut: null, signKind: null, exportsKeys: [], error: null };
let printed = false;
const _stdout = process.stdout, _stderr = process.stderr; // 引用留存：藏掉 process 后仍能写
const emit = (r) => { if (printed) return; printed = true; try { _stdout.write('__WASM_PROBE_JSON__' + JSON.stringify(r) + '\n'); } catch {} };
process.on('exit', () => emit({ ...result, calls, error: result.error || 'event-loop-ended-before-finish' }));
const dbg = (m) => { try { _stderr.write('STEP:' + m + ' calls=' + calls.length + '\n'); } catch {} };
// 关键(通用)：浏览器里 globalThis.process 是 undefined；node 里它存在 → wasm-bindgen 的
// getrandom 会走 Node 分支并 abort（且与浏览器路径算出的签名不一致）。藏掉 process 强制走
// 浏览器 crypto.getRandomValues 路径，与真实浏览器一致。cfg.hideProcess:false 可关。
const _origProcess = globalThis.process;
// 给任意 promise 套超时：真实 wasm-bindgen glue 的高层 sign 导出常是工厂链 + 依赖被 stub 的别的 chunk，
// await 它可能**永不 resolve**（挂死）→ 整个探针卡住、连已抓到的边界 I/O(calls) 都丢。套超时后：
// sign 抓不到也照样 emit calls（边界 I/O 才是 wasm_probe 的核心价值；真实 sign 输出走裸 loader 脚手架）。
const withTimeout = (p, ms, label) => Promise.race([
  Promise.resolve(p),
  new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' timed out ' + ms + 'ms')), ms)),
]);
(async () => {
  if (cfg.hideProcess !== false) { try { globalThis.process = undefined; } catch {} }
  const SIGN_TO = cfg.signTimeoutMs || 5000;
  try {
    (0, eval)(preamble + '\n' + src);
    dbg('evaled');
    const G = globalThis.__G || (typeof globalThis.module === 'object' && globalThis.module && globalThis.module.exports) || {};
    result.exportsKeys = Object.keys(G);
    for (const k of Object.keys(G)) {
      if (G[k] && typeof G[k].then === 'function') {
        try { await withTimeout(G[k], SIGN_TO, 'init[' + k + ']'); dbg('awaited ' + k); } catch (e) { dbg('await-rej ' + k); }
      }
    }
    dbg('init-done');
    await new Promise(r => setTimeout(r, 200));
    const URL_ = cfg.signUrl || '/';
    const TS_ = cfg.signTs != null ? cfg.signTs : Math.floor(Date.now() / 1000);
    let out;
    try {
      if (cfg.signerExpr && G && typeof G.__mkSigner === 'function') {
        // 首选：模块作用域 thunk 拿到闭包签名器（pe/Ee 等）→ 自动 .sign(url,ts)。
        out = await withTimeout((async () => {
          let sg = G.__mkSigner();
          if (sg && typeof sg.then === 'function') sg = await sg;
          if (sg && typeof sg.sign === 'function') { let o = sg.sign(URL_, TS_); if (o && typeof o.then === 'function') o = await o; return o; }
          // signerExpr 直接就是签名结果（少见）或没有 .sign → 原样返回看类型。
          return sg;
        })(), SIGN_TO, 'signerExpr');
      } else if (cfg.callExpr) {
        out = await withTimeout((async () => { let o = (0, eval)(cfg.callExpr); if (o && typeof o.then === 'function') o = await o; return o; })(), SIGN_TO, 'callExpr');
      } else {
        // 自动找 sign：导出可能是 实例 / 返回实例的工厂 / 返回工厂的工厂（最多再下探一层）。
        out = await withTimeout((async () => {
          for (const k of result.exportsKeys) {
            if (typeof G[k] !== 'function') continue;
            try {
              let v = G[k]();
              if (v && typeof v.then === 'function') v = await v;
              if (v && typeof v.sign === 'function') return v.sign(URL_, TS_);
              if (typeof v === 'function') {
                let v2 = v();
                if (v2 && typeof v2.then === 'function') v2 = await v2;
                if (v2 && typeof v2.sign === 'function') return v2.sign(URL_, TS_);
              }
            } catch {}
          }
          return undefined;
        })(), SIGN_TO, 'auto-sign');
      }
      if (out instanceof Promise) out = await withTimeout(out, SIGN_TO, 'sign-result');
    } catch (e) {
      // sign 没出/超时**不影响**已抓到的边界 I/O —— 把它当提示，不当致命错。
      result.signError = String((e && e.message) || e);
    }
    result.signKind = out == null ? 'null' : typeof out;
    result.signOut = typeof out === 'string' ? out : null;
    result.signPreview = typeof out === 'string' ? (out.length > 200 ? out.slice(0, 200) + '…' : out) : null;
    if (result.signOut == null) {
      result.note = '已抓到边界 I/O（calls=' + calls.length + '）= wasm 读的 DOM/env 清单。真实 sign 输出请走**裸 wasm loader**（自己 instantiate + 补 import + 藏 process），wasm_probe 不保证能自动调出高层工厂链的 sign。';
    }
    result.ok = calls.length > 0; // 边界 I/O 抓到即算成功（不强求 sign 出）
  } catch (e) {
    result.error = String((e && e.stack) || e);
  } finally {
    globalThis.process = _origProcess; // 还原，emit/exit 正常
  }
  emit(result);
  try { process.exit(0); } catch {} // 主动退出：别被挂着的 sign 定时器/句柄拖住
})();

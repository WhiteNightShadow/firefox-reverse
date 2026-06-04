/* wasm-signer-loader.js — wasm-bindgen 签名器（Rust→WASM）补环境脚手架。
 * 适用：glue 里有 __wbg_* import、signtool/类 + .wasm；构造时检测 instanceof Window、读 DOM（favicon/meta）。
 * fs_copy 到 work/ 后改三处：① WASM_PATH/GLUE_PATH ② DOM 真值(用 page_eval 抓) ③ 末尾按真实导出调 sign。
 *
 * 关键坑（这脚手架已替你处理）：
 *  · wasm-bindgen + jsdom **第二次 sign() 常崩**（FinalizationRegistry/内存视图跨调用失效）→ 本脚手架
 *    **每次 sign 都新建一个 signer 实例**（newSignerEachCall），彻底回避二次调用崩溃。
 *  · 构造期 panic(unreachable)：多半 instanceof Window 返回 false / querySelector 返回 null → 用 jsdom 提供
 *    真 window，并把 wasm 读的 DOM 元素（favicon link、meta keywords…）按**真值**注入。
 *  · 含随机 nonce 的签名**每次不同、不可逐字节复现**——别和历史样本 byte-match；用 FIXED_NONCE 模式做
 *    "固定输入→固定中段哈希"的对照排查，最终以**实打接口返回有效数据**为准。
 *
 * 装依赖：npm_install(['jsdom'])
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const WASM_PATH = 'wasm/sign.wasm';   // ① scripts_save 落的 .wasm（二进制，已修复落盘不再损坏）
const GLUE_PATH = 'scripts/glue.js';  // ① wasm-bindgen glue（.js）

// ② DOM 真值：用 page_eval 在真实页面抓。wasm 构造/sign 时会读这些，喂错值会 panic 或签名错。
//    抓法举例：page_eval("document.querySelector(\"link[rel*='icon']\").getAttribute('href')")
const DOM = {
  url: 'https://www.example.com/',
  faviconHref: '/favicon.ico',                 // <link rel*='icon'> 的 getAttribute('href') 原始值
  keywords: '',                                 // <meta name='keywords'> 的 content
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

// FIXED_NONCE=true → 把 getRandomValues 填成确定值，用于"固定输入→固定输出中段"的对照排查（不是最终产物）。
const FIXED_NONCE = process.env.FIXED_NONCE === '1';

function makeDom() {
  const html = `<!DOCTYPE html><html><head>
    <link rel="icon" href="${DOM.faviconHref}">
    <meta name="keywords" content="${DOM.keywords}">
  </head><body></body></html>`;
  const dom = new JSDOM(html, { url: DOM.url, pretendToBeVisual: true });
  const win = dom.window;
  // 真 crypto.getRandomValues（或固定 nonce 模式）
  if (!win.crypto || !win.crypto.getRandomValues) {
    win.crypto = {};
  }
  win.crypto.getRandomValues = (a) => {
    for (let i = 0; i < a.length; i++) a[i] = FIXED_NONCE ? 0 : Math.floor(Math.random() * 256);
    return a;
  };
  win.navigator.__defineGetter__ && Object.defineProperty(win.navigator, 'userAgent', { get: () => DOM.userAgent, configurable: true });
  return win;
}

// 把 wasm-bindgen glue（ESM 或被无关 import 污染）加载成可用模块。
// 思路：在一个带 jsdom 全局的 vm context 里跑 glue，桩掉与签名无关的外部 import（router/dayjs/axios 等），
// 取到 glue 导出的 signtool 类 + wasm 加载函数。具体导出名看 glue（搜 signtool_new / class / export）。
function loadSigner() {
  const win = makeDom();
  const g = win; // 让 glue 里的 window/document/self 都指向 jsdom window
  g.window = win; g.self = win; g.globalThis = win; g.global = win;
  g.Window = win.Window;                 // instanceof Window 检测要真
  g.process = undefined;                 // 藏 process：wasm-bindgen getrandom 走浏览器 crypto 分支
  // 把 Node 内置构造器补到 window —— 防 "X is not a constructor"
  for (const k of ['Uint8Array','Int8Array','Uint16Array','Int32Array','Uint32Array','Float32Array','Float64Array',
                   'ArrayBuffer','DataView','TextEncoder','TextDecoder','Map','Set','WeakMap','Proxy','Reflect','BigInt']) {
    if (typeof globalThis[k] !== 'undefined' && win[k] === undefined) win[k] = globalThis[k];
  }
  const vm = require('vm');
  const ctx = vm.createContext(win);

  let glueSrc = fs.readFileSync(path.resolve(GLUE_PATH), 'utf8');
  // ③ 改造 glue → 可在 vm 里跑：删顶部 import 行、桩掉无关外部符号、去掉 ESM export。具体按你的 glue 调整。
  glueSrc = glueSrc
    .replace(/^\s*import[^\n;]+;?\s*$/gm, '')         // 删 import 行
    .replace(/\bexport\s*\{[^}]*\}\s*;?/g, '');        // 删 export {...}
  // 把同步实例化 wasm 接进来：glue 里通常有个 async init/加载函数。若是同步 instantiate，可直接 runInContext。
  ctx.__WASM_BYTES__ = new Uint8Array(fs.readFileSync(path.resolve(WASM_PATH)));
  vm.runInContext(glueSrc, ctx, { filename: GLUE_PATH, timeout: 20000 });

  // 探测导出：在 ctx 里找 signtool 类 / new 函数。打印出来按真实名改下面一行。
  const names = Object.keys(ctx).filter(k => /sign|tool|wasm|init/i.test(k));
  console.error('[glue exports candidates]', names.slice(0, 30));
  // 例（按你的 glue 真实导出改）：return (url, ts) => new ctx.SignTool().sign(url, ts);
  throw new Error('改 loadSigner 末尾：按上面打印的导出名，返回 (url,ts)=>新建signer并sign。');
}

// 每次调用都新建实例（回避 wasm-bindgen+jsdom 二次调用崩溃）
function sign(url, ts) {
  const doSign = loadSigner();
  return doSign(url, ts);
}

module.exports = { sign, makeDom };

// 直接跑：自检一次
if (require.main === module) {
  const url = '/api/v1/example';              // 注意：签名常对**不含随机参数**的裸 url（看 http 封装层 encodeURI 的实参）
  const ts = Math.floor(Date.now() / 1000);
  console.log('M-T:', ts);
  console.log('M-S:', sign(url, ts));
}

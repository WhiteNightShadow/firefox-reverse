/* node-env-loader.js — 在 Node 里补最小浏览器环境、加载站点 signer 脚本的脚手架。
 * 用法：fs_copy 到 work/ 后改三处 —— ① SCRIPTS 改成你 scripts/ 下的真实文件 ② FINGERPRINT 用 webapi_trace 抓的真值
 * ③ 末尾按 signer 的真实导出/入口调用。报错驱动：跑→看缺什么→在 makeWindow 里补一个→再跑。 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

// ① 要加载的脚本（顺序敏感！signer 常由 glue/init 编排多个脚本，必须按页面真实加载顺序全部加上）
const SCRIPTS = [
  'scripts/acrawler.js',
  // 'scripts/sdk-glue.js',
  // 'scripts/bdms.js',
];

// ② 指纹真值（用 webapi_trace env 模式 / page_eval 从真实浏览器抓，别瞎填）
const FINGERPRINT = {
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  platform: 'MacIntel',
  language: 'zh-CN',
  href: 'https://example.com/',
  hostname: 'example.com',
};

function makeWindow() {
  const win = {};
  // 把 Node 的内置构造器挂到 window —— JSVMP/混淆代码常 `new window.Object/Array/Date/...`，
  // 不挂全会报 "X is not a constructor"。报这个错就回这里加对应名字。
  for (const k of ['Object','Array','String','Number','Boolean','Date','RegExp','Error','Function',
                   'Math','JSON','Promise','Symbol','Map','Set','WeakMap','WeakSet','Proxy','Reflect',
                   'Uint8Array','Int8Array','Uint16Array','Int32Array','Float64Array','ArrayBuffer','DataView',
                   'TextEncoder','TextDecoder','parseInt','parseFloat','isNaN','encodeURIComponent','decodeURIComponent',
                   'btoa','atob','setTimeout','clearTimeout','setInterval','clearInterval']) {
    if (typeof globalThis[k] !== 'undefined') win[k] = globalThis[k];
  }
  win.btoa = s => Buffer.from(s, 'binary').toString('base64');
  win.atob = s => Buffer.from(s, 'base64').toString('binary');
  win.navigator = { userAgent: FINGERPRINT.userAgent, platform: FINGERPRINT.platform,
                    language: FINGERPRINT.language, languages: [FINGERPRINT.language, 'en'],
                    webdriver: false, cookieEnabled: true, plugins: { length: 5 } };
  win.location = { href: FINGERPRINT.href, hostname: FINGERPRINT.hostname, protocol: 'https:', pathname: '/', search: '', origin: 'https://' + FINGERPRINT.hostname };
  win.document = {
    cookie: '', referrer: '', title: '', readyState: 'complete',
    location: win.location, documentElement: { style: {} },
    createElement: t => ({ tagName: String(t).toUpperCase(), style: {}, setAttribute(){}, getAttribute(){return null;}, appendChild(){}, addEventListener(){}, children: [] }),
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    getElementsByTagName: () => [], head: { appendChild(){} }, body: { appendChild(){}, style: {} },
    addEventListener(){}, createTextNode: d => ({ data: d }),
  };
  win.screen = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1080, colorDepth: 24, pixelDepth: 24 };
  win.performance = { now: () => Date.now(), timing: {} };
  win.crypto = globalThis.crypto || { getRandomValues(a){ for (let i=0;i<a.length;i++) a[i]=Math.floor(Math.random()*256); return a; } };
  win.window = win; win.self = win; win.globalThis = win; win.top = win; win.parent = win;
  win.addEventListener = () => {};
  return win;
}

const win = makeWindow();
// wasm-bindgen getrandom：检测到 process 就走 Node 分支 → 常崩/与浏览器路径不一致。藏掉它。
const ctx = vm.createContext(win);
ctx.process = undefined;

for (const rel of SCRIPTS) {
  const src = fs.readFileSync(path.resolve(rel), 'utf8');
  try { vm.runInContext(src, ctx, { filename: rel, timeout: 15000 }); }
  catch (e) { console.error('[load fail]', rel, String(e && e.stack || e).slice(0, 500)); process.exit(1); }
}

// ③ 调 signer。先探测它挂哪了，再按真实导出调用。
const candidates = ['byted_acrawler', 'bdms', '_$jsvmprt', 'sign', 'frontierSign'];
console.log('globals present:', candidates.filter(k => ctx[k] !== undefined));
// 例：const out = ctx.byted_acrawler.sign({ url: 'https://...&目标query' }); console.log(out);

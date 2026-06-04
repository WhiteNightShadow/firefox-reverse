#!/usr/bin/env node
'use strict';
/* whitebox_wasm_trace.cjs — P5 白盒诊断 · WASM 侧 import-trace（站点无关、零三方依赖）
 *
 * 在 Node 里加载 wasm，记录 wasm 调用的每个 JS import 的**有序序列**（含 (ptr,len)→字符串解码），
 * 输出归一化 schema 供 whitebox_diff 与浏览器真值对齐 → 找"哪一步 import / 读到的值不同"。
 *
 * 为什么非侵入：观测点在 wasm↔JS import 边界——wasm 模块无法反射/检测它的 JS import（不像 Proxy 包
 * window/navigator 那样能被页面 JS 用 toString/descriptor/timing 探到），所以对 wasm 签名器是隐形的。
 *
 * bare 模式（自己 instantiate，自动 stub 全部 import 并记录）：
 *   config: { wasmPath, callExport?, callArgs?:[], neutralizeCrash?=true }
 *   —— 适合纯 wasm-bindgen signer 的裸 instantiate；wasm-bindgen+glue 的高层编排走 wasm_probe，
 *      其 calls[] 同样能被 whitebox_diff 当 wasm 序列吃。
 * 输出: __WHITEBOX_WASM_JSON__<json>
 *   { ok, side:'node', kind:'wasm', wasmImports:[{i,name,args}], crashes:[...], exportsKeys, error }
 */
const fs = require('fs');
const OUT = '__WHITEBOX_WASM_JSON__';
const cfgPath = process.argv[2];
const _realExit = (process.reallyExit ? process.reallyExit.bind(process) : process.exit.bind(process));
function emit(o) { try { process.stdout.write(OUT + JSON.stringify(o)); } catch {} }
if (!cfgPath) { emit({ ok: false, error: 'usage: whitebox_wasm_trace.cjs <config.json>' }); _realExit(1); }

const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const neutralize = cfg.neutralizeCrash !== false;

// ── crash sinks（与 JS harness 同款；glue 模式下 wasm-bindgen 见 Node 的 process 会 abort，这里可见）──
const crashes = [];
const SINKS = ['abort', 'exit', 'reallyExit', '_exit', 'kill'];
const origs = {};
for (const k of SINKS) {
  const o = process[k]; if (typeof o !== 'function') continue; origs[k] = o;
  process[k] = function (...a) {
    crashes.push({ sink: k, args: a.map(x => { try { return String(x); } catch { return '?'; } }).slice(0, 4), stack: (new Error().stack || '').split('\n').slice(2, 8).map(s => s.trim()).join(' | ') });
    if (!neutralize) { try { return o.apply(this, a); } catch {} }
    return undefined;
  };
}
const restore = () => { for (const k in origs) { try { process[k] = origs[k]; } catch {} } };

// ── (ptr,len)→字符串解码（沿用 wasm_probe 已在真实 wasm 上验证过的解码）──
let MEM = null;
const short = v => { try { if (typeof v === 'string') return JSON.stringify(v.length > 80 ? v.slice(0, 80) + '…' : v); if (typeof v === 'number' || typeof v === 'boolean' || v == null) return String(v); if (typeof v === 'function') return 'fn'; return Object.prototype.toString.call(v); } catch { return '?'; } };
function decodeArgs(a) {
  const u8 = MEM ? new Uint8Array(MEM.buffer) : null; const out = [];
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = a[i + 1];
    if (u8 && typeof x === 'number' && typeof y === 'number' && x > 1024 && y > 0 && y < 4096 && x + y <= u8.length) {
      try { const s = new TextDecoder('utf-8', { fatal: true }).decode(u8.subarray(x, x + y)); if (s.length && /[\x20-\x7e]/.test(s[0])) { out.push(JSON.stringify(s.length > 120 ? s.slice(0, 120) + '…' : s)); i++; continue; } } catch {}
    }
    out.push(short(x));
  }
  return out.join(',');
}

const wasmImports = []; let seq = 0;
function logCall(name, a) { wasmImports.push({ i: seq++, name: String(name).replace(/_[0-9a-f]{16}$/, ''), args: decodeArgs(a) }); }

(async () => {
  try {
    const wasmBytes = fs.readFileSync(cfg.wasmPath);
    const mod = new WebAssembly.Module(wasmBytes);
    const needed = WebAssembly.Module.imports(mod);
    const importObj = {}; let providedMem = null;
    for (const im of needed) {
      importObj[im.module] = importObj[im.module] || {};
      if (im.kind === 'function') importObj[im.module][im.name] = ((nm) => (...a) => { logCall(nm, a); return 0; })(im.name);
      else if (im.kind === 'memory') { providedMem = new WebAssembly.Memory({ initial: 1 }); importObj[im.module][im.name] = providedMem; }
      else if (im.kind === 'global') importObj[im.module][im.name] = new WebAssembly.Global({ value: 'i32', mutable: false }, 0);
      else if (im.kind === 'table') importObj[im.module][im.name] = new WebAssembly.Table({ initial: 1, element: 'anyfunc' });
    }
    const inst = new WebAssembly.Instance(mod, importObj);
    MEM = inst.exports.memory || providedMem;
    const exportsKeys = Object.keys(inst.exports);
    const callName = cfg.callExport || exportsKeys.find(k => typeof inst.exports[k] === 'function');
    let result;
    if (callName && typeof inst.exports[callName] === 'function') {
      try { result = inst.exports[callName](...(cfg.callArgs || [])); } catch (e) { /* import 已抓到，调用报错不致命 */ }
    }
    emit({
      ok: true, side: 'node', kind: 'wasm', wasmImports, crashes, exportsKeys,
      result: (typeof result === 'number' || typeof result === 'string') ? result : undefined,
      note: `wasm import 序列 ${wasmImports.length} 条；崩溃 ${crashes.length} 次。与浏览器真值 diff 找分叉 import / 解码值。`,
    });
  } catch (e) {
    emit({ ok: false, side: 'node', kind: 'wasm', wasmImports, crashes, error: String((e && e.stack) || e).slice(0, 500) });
  } finally { restore(); _realExit(0); }
})();

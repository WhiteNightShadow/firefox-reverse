#!/usr/bin/env node
'use strict';
/* whitebox_node_trace.cjs — P5 白盒诊断 · Node 侧引擎级"非侵入"追踪器（站点无关、零三方依赖）
 *
 * 把一个 Node 复刻 loader 跑在 node:inspector（in-process V8 引擎调试器）下，
 * 不改 signer 源码、不包 Proxy、不开调试端口（无 CDP 端口可探），抓两类白盒信号：
 *   ① 分支覆盖：V8 Profiler 精确覆盖(detailed block) → 每段源码字符区间"走了/没走"(count)。
 *      未走的区间(count==0)= 与浏览器真值 diff 时"分叉分支"的候选（M2 用）。
 *   ② 崩溃/自杀：patch 宿主 process.abort/exit/... → 记触发栈（补环境层，不动 signer 源码）；
 *      neutralize 后让执行继续，暴露后续分支（如 wasm-bindgen 见 Node 的 process 就 abort）。
 *
 * 为什么非侵入：覆盖来自 V8 引擎自身(不注入计数器、不改 toString)；in-process Session 不开端口
 * (比 node --inspect 更隐，signer 探不到端口、无 Runtime.enable 那个 ownKeys 探针面)；崩溃 sink
 * patch 的是宿主 process(补环境范畴)，signer 的源码/自校验看不到任何改动。
 *
 * 输出: __WHITEBOX_JSON__<json>
 * 用法: node whitebox_node_trace.cjs <config.json>
 * config: { entry, entryFn?, entryArgs?:[], neutralizeCrash?=true, maxBranches?=4000,
 *           includeTaken?=false }
 */
const fs = require('fs');
const path = require('path');
const inspector = require('node:inspector');

const OUT = '__WHITEBOX_JSON__';
const SELF = path.basename(__filename);
const cfgPath = process.argv[2];

function emit(o) { try { process.stdout.write(OUT + JSON.stringify(o)); } catch {} }
if (!cfgPath) { emit({ ok: false, error: 'usage: whitebox_node_trace.cjs <config.json>' }); process.exit(1); }

// 留存原始 exit：finally 里要用它真正退出（process.exit 会被下面 patch 掉）
const _realExit = (process.reallyExit ? process.reallyExit.bind(process) : process.exit.bind(process));

(async () => {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
  catch (e) { emit({ ok: false, error: 'bad config: ' + e.message }); _realExit(1); return; }

  const entry = cfg.entry && path.resolve(cfg.entry);
  if (!entry || !fs.existsSync(entry)) { emit({ ok: false, error: 'entry not found: ' + cfg.entry }); _realExit(1); return; }
  const neutralize = cfg.neutralizeCrash !== false;
  const MAXB = cfg.maxBranches || 4000;

  // ── ① 崩溃/自杀 sink：patch 宿主 process（不动 signer 源码）──────────────
  const crashes = [];
  const SINKS = ['abort', 'exit', 'reallyExit', '_exit', 'kill'];
  const origs = {};
  for (const k of SINKS) {
    const orig = process[k];
    if (typeof orig !== 'function') continue;
    origs[k] = orig;
    process[k] = function (...a) {
      crashes.push({
        sink: k,
        args: a.map(x => { try { return String(x); } catch { return '?'; } }).slice(0, 4),
        stack: (new Error().stack || '').split('\n').slice(2, 9).map(s => s.trim()).join(' | '),
      });
      if (!neutralize) { try { return orig.apply(this, a); } catch {} }
      return undefined; // neutralize：记下就返回，让执行继续暴露后续分支
    };
  }
  const restore = () => { for (const k in origs) { try { process[k] = origs[k]; } catch {} } };

  // ── ② node:inspector in-process Session（不开端口）────────────────────────
  const session = new inspector.Session();
  session.connect();
  const post = (m, p) => new Promise((res, rej) => session.post(m, p || {}, (e, r) => e ? rej(e) : res(r)));
  const scriptUrls = new Map(); // scriptId -> url（scriptParsed 兜底，coverage 自带 url 时不必用）
  session.on('Debugger.scriptParsed', (msg) => { try { scriptUrls.set(msg.params.scriptId, msg.params.url); } catch {} });

  let err = null, ranResult = null;
  try {
    await post('Debugger.enable');
    await post('Profiler.enable');
    await post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });

    // ── 跑 entry：require → 调 entryFn / module 函数 / default ──
    try {
      const mod = require(entry);
      const fn = cfg.entryFn ? (mod && mod[cfg.entryFn])
        : (typeof mod === 'function' ? mod : (mod && mod.default));
      if (typeof fn === 'function') {
        let r = fn.apply(null, cfg.entryArgs || []);
        if (r && typeof r.then === 'function') r = await r;
        ranResult = (typeof r === 'string') ? r.slice(0, 300) : (r == null ? null : typeof r);
      } else if (cfg.entryFn) {
        err = `entryFn "${cfg.entryFn}" 不是函数（exports: ${mod && typeof mod === 'object' ? Object.keys(mod).slice(0, 20).join(',') : typeof mod}）`;
      }
    } catch (e) { err = 'entry threw: ' + String((e && e.stack) || e).slice(0, 500); }

    await new Promise(r => setTimeout(r, 50)); // 给微任务收尾

    // ── 取覆盖 → 抽分支 ──
    const cov = await post('Profiler.takePreciseCoverage');
    try { await post('Profiler.stopPreciseCoverage'); } catch {}

    const scriptsOut = {};
    let scriptCount = 0, takenRanges = 0, notTakenRanges = 0;
    const srcCache = new Map();
    const getSrc = async (id) => {
      if (srcCache.has(id)) return srcCache.get(id);
      let s = null;
      try { s = (await post('Debugger.getScriptSource', { scriptId: id })).scriptSource; } catch {}
      srcCache.set(id, s); return s;
    };

    // CJS require 把模块源码包成 `(function (exports, require, module, __filename, __dirname) { … });`
    // → V8 覆盖偏移是**包装后**坐标。剥掉前缀长度，offset 归一到**原文**坐标，与浏览器 source.text 同坐标系，
    //   diff 引擎按字符偏移即可跨引擎(V8↔SpiderMonkey)对齐——压缩成一行的 signer 也能区分分支。
    const WRAP_RE = /^\(function \(exports, require, module, __filename, __dirname\) \{ ?/;
    for (const sc of (cov.result || [])) {
      const url = sc.url || scriptUrls.get(sc.scriptId) || '';
      if (!url || url.startsWith('node:') || url.includes(SELF) || url.startsWith('internal/')) continue;
      const key = basename(url);                       // ← scriptKey：两侧用同一份脚本的 basename 对齐
      const wrapped = await getSrc(sc.scriptId);
      let src = wrapped, off0 = 0;
      if (wrapped) { const wm = wrapped.match(WRAP_RE); if (wm) { off0 = wm[0].length; src = wrapped.slice(off0).replace(/\n\}\);\s*$/, ''); } }
      const lines = src ? src.split('\n') : null;
      let entryS = scriptsOut[key];
      if (!entryS) { entryS = scriptsOut[key] = { url: shortUrl(url), taken: [], notTaken: [] }; scriptCount++; }
      for (const f of (sc.functions || [])) {
        for (const rg of (f.ranges || [])) {
          const so = rg.startOffset - off0, eo = rg.endOffset - off0;
          if (so < 0) continue;                        // 落在 wrapper 前缀里的覆盖点（理论上无）跳过
          const loc = offToLineCol(src, so);
          const rec = {
            fn: f.functionName || '(anon)',
            startOffset: so, endOffset: eo,             // ← 原文偏移
            line: loc.line, col: loc.col,
            snippet: src ? src.slice(so, Math.min(eo, so + 90)).replace(/\s+/g, ' ').trim() : null,
            lineText: lines ? (lines[loc.line - 1] || '').slice(0, 200).trim() : null,  // 整行(含条件)→ driver 认 env 名
          };
          // detailed block 覆盖 → ranges 已是"分支块"粒度（不是每条语句），taken+notTaken 体量可控
          if (rg.count > 0) { takenRanges++; if (entryS.taken.length < MAXB) entryS.taken.push(rec); }
          else { notTakenRanges++; if (entryS.notTaken.length < MAXB) entryS.notTaken.push(rec); }
        }
      }
    }

    // 人看的：未走分支摘要（跨脚本汇总，按源码行序）
    const notTakenFlat = [];
    for (const [k, s] of Object.entries(scriptsOut)) for (const b of s.notTaken) notTakenFlat.push({ scriptKey: k, fn: b.fn, line: b.line, col: b.col, snippet: b.snippet });
    notTakenFlat.sort((a, b) => (a.line || 0) - (b.line || 0));

    emit({
      ok: true,
      side: 'node',
      entry: cfg.entry,
      result: ranResult,
      scripts: scriptsOut,        // ← 归一化 schema（diff 引擎吃这个）
      envReads: [],               // M2：node 侧 env 读（分叉分支断点读 scope / loader getter）—— 当前占位
      crashes,
      crashNeutralized: neutralize,
      scriptCount, takenRanges, notTakenRanges,
      notTakenPreview: notTakenFlat.slice(0, 20),
      error: err || undefined,
      note: `引擎级非侵入：覆盖 ${scriptCount} 脚本（走 ${takenRanges} 段 / 未走 ${notTakenRanges} 段，未走段=与浏览器 diff 的分叉候选）；` +
        `崩溃/自杀触发 ${crashes.length} 次${neutralize ? '（已 neutralize，执行继续）' : ''}。`,
    });
  } catch (e) {
    emit({ ok: false, error: String((e && e.stack) || e).slice(0, 600), crashes });
  } finally {
    restore();
    try { session.disconnect(); } catch {}
    _realExit(0);
  }

  function offToLineCol(src, off) {
    if (!src || off == null) return { line: 0, col: 0 };
    let line = 1, col = 1;
    const n = Math.min(off, src.length);
    for (let i = 0; i < n; i++) { if (src[i] === '\n') { line++; col = 1; } else col++; }
    return { line, col };
  }
  function shortUrl(u) { return String(u).replace(/^file:\/\//, '').split('/').slice(-2).join('/'); }
  function basename(u) { return String(u).replace(/^file:\/\//, '').split(/[\\/]/).pop() || String(u); }
})();

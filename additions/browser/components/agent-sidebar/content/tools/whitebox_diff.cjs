#!/usr/bin/env node
'use strict';
/* whitebox_diff.cjs — P5 白盒诊断 · 浏览器真值 vs Node 复刻 的引擎级 trace 差分（站点无关、零依赖）
 *
 * 吃两条"归一化 trace"（node 侧来自 whitebox_node_trace.cjs；browser 侧来自浏览器采集器，同 schema），
 * 对齐同一份抽取脚本的覆盖，输出：
 *   ① 第一个分叉分支（定位到源码行/列）——浏览器走了/Node 没走(node_missed) 或 反之(node_decoy)
 *   ② 驱动分叉的 env 值——把分叉就近关联到 env 读真值不符项
 *   ③ env 真值 diff 全表 + Node 侧崩溃/自杀点
 *
 * 归一化 trace schema（两侧 producer 都 emit 这个）:
 *   { side, scripts:{ "<scriptKey>":{ url, taken:[{line,col,startOffset,endOffset,snippet}], notTaken:[...] } },
 *     envReads:[{name,value,line?,scriptKey?}], crashes:[{sink,args,stack}] }
 *
 * 对齐策略 matchBy:
 *   "snippet"(默认) = scriptKey + 行号 + 归一化片段(掩去字符串/数字)。CJS 包装无换行→行号两侧守恒，
 *                     对压缩/混淆鲁棒；压成一行时退化为 scriptKey+片段形状。
 *   "offset"        = scriptKey + 起止字符偏移。仅当两侧保证同一偏移空间（同一份裸源码、无包装）时用。
 *
 * 用法: node whitebox_diff.cjs <diffConfig.json>
 *   diffConfig: { nodeTrace, browserTrace, matchBy?, envWindow?=40 }
 *     nodeTrace/browserTrace = 内联对象 | json 文件路径 | 含 __WHITEBOX_JSON__ 前缀的原始 harness 输出文件
 * 输出: __WHITEBOX_DIFF_JSON__<json>
 */

function normSnippet(s) {
  return String(s || '').replace(/\s+/g, ' ').trim()
    .replace(/(['"`])(?:\\.|(?!\1).)*\1/g, 'STR')   // 掩字符串字面量
    .replace(/\b\d+\b/g, 'NUM')                      // 掩数字字面量
    .replace(/\/\/[^]*$/, '').trim()                 // 去行尾注释（V8 块片段可能含注释）
    .slice(0, 80);
}
function rangeKey(scriptKey, b, matchBy) {
  if (matchBy === 'offset') return scriptKey + '|o|' + b.startOffset + '-' + b.endOffset;       // 同一裸源码偏移空间
  if (matchBy === 'line') return scriptKey + '|L' + (b.line || 0);                               // 跨引擎(V8↔SpiderMonkey)按行对齐
  return scriptKey + '|s|L' + (b.line || 0) + '|' + normSnippet(b.snippet);                       // 同引擎：行+片段
}
function indexSide(trace, matchBy) {
  const scripts = {};
  for (const [sk, sc] of Object.entries((trace && trace.scripts) || {})) {
    const notTaken = new Map();      // key -> branch rec（引擎只对"未走"块单独 emit range）
    const coveredFns = new Set();    // 跑过的函数名（来自 taken/count>0 range）—— 函数覆盖门控
    const takenKeys = new Set();
    for (const b of (sc.taken || [])) { takenKeys.add(rangeKey(sk, b, matchBy)); coveredFns.add(b.fn || '(anon)'); }
    // 同侧"走过的 key"从未走集合里剔除：同一行/块可能因 顶层脚本+函数脚本 或 多次运行 既有 count>0 又有
    // count=0；走过即算走过，否则会和对面的"走过"两边都标未走而互相抵消（漏报分叉）。
    for (const b of (sc.notTaken || [])) { const k = rangeKey(sk, b, matchBy); if (!takenKeys.has(k)) notTaken.set(k, b); }
    scripts[sk] = { notTaken, coveredFns, url: sc.url };
  }
  return scripts;
}

/** 核心：纯函数，无 Node 依赖，M4 直接搬进 .sys.mjs */
function whiteboxDiff(nodeTrace, browserTrace, opts) {
  opts = opts || {};
  const matchBy = opts.matchBy || 'snippet';
  const envWindow = opts.envWindow || 40;
  nodeTrace = nodeTrace || {}; browserTrace = browserTrace || {};

  // wasm 模式优先：任一侧是 wasm import 序列（whitebox_wasm_trace 的 wasmImports / wasm_probe 的 calls）
  // → 走序列 + 解码值 diff，而非 JS 分支覆盖。
  const nWasm = wasmSeq(nodeTrace), bWasm = wasmSeq(browserTrace);
  if (nWasm || bWasm) return wasmDiff(nWasm || [], bWasm || [], nodeTrace.crashes || []);

  // ── 分支分叉：offset(默认，跨引擎 V8↔SpiderMonkey + 压缩单行 鲁棒，带 ±tol 容差) / line / snippet ──
  const divergences = matchBy === 'offset'
    ? diffByOffset(nodeTrace, browserTrace, opts.offsetTol != null ? opts.offsetTol : 2)
    : diffByKey(nodeTrace, browserTrace, matchBy);

  // ── env 真值表（browser=真值；node=复刻服务到的值/未提供）──
  const browserEnv = new Map();
  for (const e of (browserTrace.envReads || [])) if (e && e.name && !browserEnv.has(e.name)) browserEnv.set(e.name, e);
  const nodeEnv = new Map();
  for (const e of (nodeTrace.envReads || [])) if (e && e.name && !nodeEnv.has(e.name)) nodeEnv.set(e.name, e);
  const envList = [...browserEnv.values()].map(be => ({ name: be.name, browser: be.value, node: nodeEnv.has(be.name) ? nodeEnv.get(be.name).value : undefined }));
  const envMismatch = envList.filter(e => e.node !== undefined && JSON.stringify(e.browser) !== JSON.stringify(e.node));

  divergences.sort((a, b) => (a.startOffset ?? 1e15) - (b.startOffset ?? 1e15) || (a.line ?? 1e9) - (b.line ?? 1e9));
  const first = divergences.find(d => d.type === 'node_missed' || d.type === 'node_decoy') || divergences[0] || null;

  // ── driver：分叉那行的条件源码(lineText) 里出现的 env 成员名 = 驱动它的 env，给浏览器真值
  //    （不需 node 的值——分叉本身已证明 node 那侧走法不同 = 那个 env 在 node 里不一样）──
  const driver = pickDriver(first, browserEnv, envMismatch);

  return {
    ok: true,
    firstDivergence: first,
    driver,
    divergenceCount: divergences.length,
    divergences: divergences.slice(0, 50),
    envTruth: envList.slice(0, 20),
    envMismatch,
    crashes: (nodeTrace.crashes || []),
    summary: buildSummary(first, driver, envList, envMismatch, nodeTrace.crashes || []),
  };
}

/** 现有 line/snippet 按键匹配（引擎块覆盖只 emit 未走块 → notTaken XOR + 脚本覆盖门控）。 */
function diffByKey(nodeTrace, browserTrace, matchBy) {
  const N = indexSide(nodeTrace, matchBy), B = indexSide(browserTrace, matchBy);
  const out = [];
  for (const sk of new Set([...Object.keys(N), ...Object.keys(B)])) {
    const ns = N[sk], bs = B[sk];
    if (!ns || !bs) {
      if (bs && !ns) out.push({ type: 'script_only_browser', scriptKey: sk, line: 0, note: `脚本 ${sk} 浏览器跑到、Node 没跑到` });
      if (ns && !bs) out.push({ type: 'script_only_node', scriptKey: sk, line: 0, note: `脚本 ${sk} Node 跑到、浏览器没` });
      continue;
    }
    for (const k of new Set([...ns.notTaken.keys(), ...bs.notTaken.keys()])) {
      const inN = ns.notTaken.has(k), inB = bs.notTaken.has(k);
      if (inN === inB) continue;
      if (inB && !inN) { const b = bs.notTaken.get(k); if (ns.coveredFns.size > 0) out.push({ type: 'node_decoy', scriptKey: sk, line: b.line, col: b.col, startOffset: b.startOffset, snippet: b.snippet, lineText: b.lineText }); }
      else { const b = ns.notTaken.get(k); if (bs.coveredFns.size > 0) out.push({ type: 'node_missed', scriptKey: sk, line: b.line, col: b.col, startOffset: b.startOffset, snippet: b.snippet, lineText: b.lineText }); }
    }
  }
  return out;
}

/** offset 容差匹配（默认）：两侧 startOffset 归一到同一份原始脚本字符偏移，±tol 容跨引擎列约定/取整误差。
 *  跨引擎块覆盖仍是"只 emit 未走块"，故判据同 XOR：某未走块在对面 tol 内没被标未走 + 对面跑过该脚本 = 分叉。 */
function diffByOffset(nodeTrace, browserTrace, tol) {
  const collect = (trace) => {
    const m = {};
    for (const [sk, sc] of Object.entries((trace && trace.scripts) || {})) {
      const takenOff = [];
      for (const b of (sc.taken || [])) if (b.startOffset != null) takenOff.push(b.startOffset);
      const notTaken = (sc.notTaken || []).filter(b => b.startOffset != null);
      m[sk] = { takenOff, notTaken, covered: ((sc.taken || []).length + (sc.notTaken || []).length) > 0 };
    }
    return m;
  };
  const near = (arr, x) => arr.some(v => Math.abs(v - x) <= tol);
  const N = collect(nodeTrace), B = collect(browserTrace);
  const out = [];
  for (const sk of new Set([...Object.keys(N), ...Object.keys(B)])) {
    const ns = N[sk], bs = B[sk];
    if (!ns || !bs) {
      if (bs && !ns) out.push({ type: 'script_only_browser', scriptKey: sk, line: 0, startOffset: 0, note: `脚本 ${sk} 浏览器跑到、Node 没跑到` });
      if (ns && !bs) out.push({ type: 'script_only_node', scriptKey: sk, line: 0, startOffset: 0, note: `脚本 ${sk} Node 跑到、浏览器没` });
      continue;
    }
    const bNot = bs.notTaken.map(b => b.startOffset), nNot = ns.notTaken.map(b => b.startOffset);
    for (const b of bs.notTaken) {            // browser 未走、node 附近没标未走 + node 跑过 → node 走了它 = decoy
      if (near(bs.takenOff, b.startOffset)) continue;
      if (!near(nNot, b.startOffset) && ns.covered) out.push({ type: 'node_decoy', scriptKey: sk, line: b.line, col: b.col, startOffset: b.startOffset, snippet: b.snippet, lineText: b.lineText });
    }
    for (const b of ns.notTaken) {            // node 未走、browser 附近没标未走 + browser 跑过 → browser 走了它 = node_missed
      if (near(ns.takenOff, b.startOffset)) continue;
      if (!near(bNot, b.startOffset) && bs.covered) out.push({ type: 'node_missed', scriptKey: sk, line: b.line, col: b.col, startOffset: b.startOffset, snippet: b.snippet, lineText: b.lineText });
    }
  }
  return out;
}

/** 分叉那行条件里出现的 env 成员名 = 驱动 env（取最长匹配避短词噪声）；拿不到则全局 env 不符兜底。 */
function pickDriver(first, browserEnv, envMismatch) {
  if (!first) return null;
  const lt = String(first.lineText || first.snippet || '').toLowerCase();
  if (lt) {
    let best = null, bestLen = 0;
    for (const be of browserEnv.values()) {
      const member = String(be.member || (be.name || '').split('.').pop() || '').toLowerCase();
      if (member.length >= 4 && lt.includes(member) && member.length > bestLen) { best = be; bestLen = member.length; }
    }
    if (best) {
      const nm = envMismatch.find(e => e.name === best.name);
      return { via: 'condition', name: best.name, browser: best.value, node: nm ? nm.node : undefined };
    }
  }
  if (envMismatch.length) return Object.assign({ via: 'env-mismatch' }, envMismatch[0]);
  return null;
}

// ── WASM 模式：把 wasmImports / wasm_probe.calls 归一成 "name(args)" 字符串序列 ──
function wasmSeq(t) {
  if (!t) return null;
  if (Array.isArray(t.wasmImports)) return t.wasmImports.map(w => typeof w === 'string' ? w : (w.name + '(' + (w.args || '') + ')'));
  if (Array.isArray(t.calls)) return t.calls.slice();   // wasm_probe 格式（已是 "name(args)" 字符串）
  if (t.kind === 'wasm') return [];
  return null;
}
function wasmDiff(nodeSeq, browserSeq, crashes) {
  // 首个序列分叉：index walk + 单步 lookahead 容忍一次插入/删除
  let i = 0, j = 0, first = null;
  while (i < nodeSeq.length && j < browserSeq.length) {
    if (nodeSeq[i] === browserSeq[j]) { i++; j++; continue; }
    if (browserSeq[j + 1] === nodeSeq[i]) { first = first || { type: 'browser_extra', index: j, browser: browserSeq[j], node: '(无)' }; j++; continue; }
    if (nodeSeq[i + 1] === browserSeq[j]) { first = first || { type: 'node_extra', index: i, node: nodeSeq[i], browser: '(无)' }; i++; continue; }
    first = first || { type: 'import_diff', index: i, node: nodeSeq[i], browser: browserSeq[j] };
    break;
  }
  if (!first && nodeSeq.length !== browserSeq.length) {
    const at = Math.min(nodeSeq.length, browserSeq.length);
    first = { type: nodeSeq.length > browserSeq.length ? 'node_extra' : 'browser_extra', index: at, node: nodeSeq[at] || '(无)', browser: browserSeq[at] || '(无)' };
  }
  const ns = new Set(nodeSeq), bs = new Set(browserSeq);
  const onlyNode = [...ns].filter(x => !bs.has(x)), onlyBrowser = [...bs].filter(x => !ns.has(x));
  const L = [];
  if (first) {
    if (first.type === 'import_diff') L.push(`wasm import 序列第 ${first.index} 步分叉：浏览器「${first.browser}」 / Node「${first.node}」——多半是某 env 读到的值不同，导致 wasm 内部走了不同分支。`);
    else L.push(`wasm import 序列分叉(${first.type}) @${first.index}：浏览器「${first.browser}」 / Node「${first.node}」。`);
  } else L.push('wasm import 序列两侧一致（未发现分叉）。');
  if (onlyBrowser.length) L.push(`仅浏览器调到的 import：${onlyBrowser.slice(0, 6).join(' | ')}`);
  if (onlyNode.length) L.push(`仅 Node 调到的 import：${onlyNode.slice(0, 6).join(' | ')}`);
  if (crashes.length) L.push(`Node 侧崩溃/自杀 ${crashes.length} 次：${crashes.map(c => c.sink).join(',')}。`);
  return { ok: true, kind: 'wasm', firstDivergence: first, divergenceCount: first ? 1 : 0, onlyNode, onlyBrowser, crashes, summary: L.join('\n') };
}

function buildSummary(first, driver, envList, envMismatch, crashes) {
  const L = [];
  if (first) {
    if (first.type === 'node_decoy') L.push(`Node 复刻走了 decoy/错分支：${first.scriptKey} 行${first.line} 「${(first.snippet || '').slice(0, 60)}」——浏览器没走这条。`);
    else if (first.type === 'node_missed') L.push(`Node 复刻没走到浏览器走的真分支：${first.scriptKey} 行${first.line} 「${(first.snippet || '').slice(0, 60)}」。`);
    else L.push(`首个分叉：${first.note || JSON.stringify(first)}`);
  } else L.push('未发现分支分叉（两侧覆盖一致，或脚本未对齐）。');
  if (driver) L.push(`很可能的驱动 env：${driver.name}${driver.via === 'condition' ? '（出现在分叉那行的条件里）' : ''} —— 浏览器真值=${JSON.stringify(driver.browser)}${driver.node !== undefined ? ` / Node=${JSON.stringify(driver.node)}` : ''}。把 Node 补环境这个值对齐到浏览器真值再跑。`);
  else if (first && (first.type === 'node_missed' || first.type === 'node_decoy') && !(envList && envList.length)) L.push('未拿到 env 真值对照 → 先 webapi_trace(env 模式) 落 webapi/fingerprint-env.ndjson，whitebox_diff(action:diff) 会自动捞来点亮驱动 env。');
  if (envMismatch.length) L.push(`env 真值不符 ${envMismatch.length} 项：${envMismatch.slice(0, 6).map(m => m.name).join(', ')}${envMismatch.length > 6 ? '…' : ''}`);
  if (crashes.length) L.push(`Node 侧崩溃/自杀 ${crashes.length} 次：${crashes.map(c => c.sink).join(',')}（已 neutralize，栈见 crashes）。`);
  return L.join('\n');
}

// ── CLI ──
if (require.main === module) {
  const fs = require('fs');
  const OUT = '__WHITEBOX_DIFF_JSON__';
  const loadTrace = (x) => {
    if (x == null) return {};
    if (typeof x === 'object') return x;
    let s = String(x);
    if (fs.existsSync(s)) s = fs.readFileSync(s, 'utf8');     // 路径 → 读文件
    const i = s.indexOf('{');                                 // 容忍 __WHITEBOX_JSON__ 前缀
    if (i > 0) s = s.slice(i);
    return JSON.parse(s);
  };
  try {
    const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const r = whiteboxDiff(loadTrace(cfg.nodeTrace), loadTrace(cfg.browserTrace), { matchBy: cfg.matchBy, envWindow: cfg.envWindow });
    process.stdout.write(OUT + JSON.stringify(r));
  } catch (e) {
    process.stdout.write(OUT + JSON.stringify({ ok: false, error: String((e && e.stack) || e) }));
  }
}

module.exports = { whiteboxDiff, normSnippet };

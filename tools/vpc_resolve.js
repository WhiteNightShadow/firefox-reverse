#!/usr/bin/env node
/* ===========================================================================
 * vpc_resolve.js —— 从 firefox-reverse vpc_trace(虚拟寄存器快照) 还原执行控制流，
 *                   补全静态反汇编里解不出的跳转目标。通用、数据驱动，不写死任何槽号/站点。
 *
 * 输入: vpc.ndjson —— 每行 {"_vpc":{"l":[...locals...],"a":[...args...]}}
 *       (firefox-reverse MOZ_JSVMP_VPC_TRACE=1 在派发循环头每条虚拟指令记一行)
 *
 * 做法:
 *  1. 给每个寄存器槽打分，自动找出「虚拟 pc」槽(取值多、95%+ 是小正增量、范围有界)。
 *  2. 扫该槽的取值序列，统计 pc → 后继 pc 的转移。
 *  3. 每个 pc 的「最常见小正增量后继」= 顺序执行；其余后继 = 观测到的跳转目标。
 *  4. 输出 resolved.json: { vpc_slot, transitions, jump_targets } 供 disassemble --cfg --vpc 用。
 *
 * 用法: node vpc_resolve.js <vpc.ndjson> [--out=resolved.json]
 * =========================================================================== */
'use strict';
const fs = require('fs');

function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  const outArg = args.find(a => a.startsWith('--out='));
  const out = outArg ? outArg.slice(6) : null;
  if (!file) { console.error('用法: node vpc_resolve.js <vpc.ndjson> [--out=resolved.json]'); process.exit(2); }

  const rows = fs.readFileSync(file, 'utf8').trim().split('\n')
    .map(l => { try { return JSON.parse(l)._vpc; } catch { return null; } }).filter(Boolean);
  if (!rows.length) { console.error('no _vpc rows'); process.exit(1); }
  const N = rows.length;
  const nl = Math.max(...rows.map(r => r.l.length));
  const na = Math.max(...rows.map(r => r.a.length));

  // 1) 自动找虚拟 pc 槽：取值多、增量多为小正数(顺序执行)、范围有界
  function score(key, i) {
    const s = rows.map(r => r[key][i]);
    const vals = s.filter(x => typeof x === 'number');
    if (vals.length < N * 0.8) return null;
    const distinct = new Set(vals).size;
    if (distinct < 8) return null;
    let small = 0, jumps = 0;
    for (let k = 1; k < s.length; k++) {
      if (typeof s[k] !== 'number' || typeof s[k - 1] !== 'number') continue;
      const d = s[k] - s[k - 1];
      if (d > 0 && d <= 16) small++; else jumps++;
    }
    const smallRatio = small / (small + jumps || 1);
    // vpc 典型：smallRatio 高(顺序为主) 但有少量跳转；distinct 适中
    if (smallRatio < 0.6 || jumps === 0) return null;
    return { key, i, distinct, small, jumps, smallRatio, min: Math.min(...vals), max: Math.max(...vals),
             rank: distinct * smallRatio };
  }
  const cands = [];
  for (let i = 0; i < nl; i++) { const sc = score('l', i); if (sc) cands.push(sc); }
  for (let i = 0; i < na; i++) { const sc = score('a', i); if (sc) cands.push(sc); }
  cands.sort((a, b) => b.rank - a.rank);
  if (!cands.length) { console.error('找不到 vpc 槽(可能 trigger pc 不对/寄存器全是 null)'); process.exit(1); }
  const vpcSlot = cands[0];
  console.error(`[*] 虚拟 pc 槽 = ${vpcSlot.key}[${vpcSlot.i}]  (distinct=${vpcSlot.distinct}, smallRatio=${vpcSlot.smallRatio.toFixed(2)}, range=[${vpcSlot.min},${vpcSlot.max}], jumps=${vpcSlot.jumps})`);
  if (cands.length > 1) console.error(`    其他候选: ${cands.slice(1, 4).map(c => c.key + '[' + c.i + ']').join(', ')}`);

  // 2) pc → 后继 计数
  const seq = rows.map(r => r[vpcSlot.key][vpcSlot.i]);
  const succ = new Map();  // pc -> Map(nextPc -> count)
  for (let k = 1; k < seq.length; k++) {
    const a = seq[k - 1], b = seq[k];
    if (typeof a !== 'number' || typeof b !== 'number') continue;
    if (!succ.has(a)) succ.set(a, new Map());
    const m = succ.get(a); m.set(b, (m.get(b) || 0) + 1);
  }

  // 3) 分类每个 pc 的后继：最常见小正增量=顺序；其余=跳转目标
  const transitions = {}, jumpTargets = {};
  for (const [pc, m] of succ) {
    const succs = [...m.entries()].sort((a, b) => b[1] - a[1]);
    transitions[pc] = succs.map(([to, c]) => ({ to, count: c }));
    // 跳转目标 = 非「pc + 小正增量(<=16)」的后继，或有多个后继时的非顺序分支
    const jt = succs.filter(([to]) => !(to > pc && to - pc <= 16)).map(([to]) => to);
    if (jt.length) jumpTargets[pc] = jt;
  }

  const result = {
    _meta: { source: file, rows: N, vpc_slot: `${vpcSlot.key}[${vpcSlot.i}]`,
             pc_range: [vpcSlot.min, vpcSlot.max], distinct_pcs: vpcSlot.distinct },
    jump_targets: jumpTargets,     // pc(被执行的跳转指令) → 观测到的目标 pc 列表
    transitions,                   // pc → 全部后继(带次数)
  };
  const json = JSON.stringify(result, null, 1);
  if (out) { fs.writeFileSync(out, json); console.error(`[*] 写入 ${out} (${Object.keys(jumpTargets).length} 个跳转点已解析目标)`); }
  else process.stdout.write(json);

  // 概要
  console.error(`[*] 执行了 ${vpcSlot.distinct} 个不同 pc；${Object.keys(jumpTargets).length} 个 pc 观测到跳转目标`);
  const backedges = Object.entries(jumpTargets).filter(([pc, ts]) => ts.some(t => t <= pc));
  console.error(`[*] 其中 ${backedges.length} 个含回边(循环): ${backedges.slice(0, 6).map(([pc, ts]) => pc + '→' + ts.filter(t => t <= pc)[0]).join(', ')}`);
}
main();

#!/usr/bin/env node
/* ===========================================================================
 * disassemble.js —— 通用 JSVMP 字节码反汇编器（byte → 伪汇编）
 *
 * 输入:
 *   --handlers <handlers.json>   dispatcher_split.js 产出（含 decode_table /
 *                                base_advance / bytecode_style / 每 op 操作数字节数）
 *   --bytecode <file>            字节码文件:
 *                                  hex-string 风格 → 纯 hex 字符串(如 "484e4f...")
 *                                  array 风格     → JSON 数组(如 [12,3,...])
 *   [--start=N]   起始 pc（默认 0；很多 JSVMP 头部是 magic/meta，可跳过）
 *   [--limit=N]   最多反汇编多少条指令（默认 全部）
 *   [--out file]  输出到文件（默认 stdout）
 *
 * 设计原则【通用，不写死任何站点】:
 *   - 全部映射(byte→op、操作数字节数、解码单元大小)都来自 handlers.json，
 *     由 dispatcher_split.js 从 AST 自动推导，本脚本只做「查表 + 推进 pc」。
 *   - hex-string 风格: 每单元 = base_advance 个 hex 字符，
 *     字节值 = parseInt(hex 串.substr(pc, 2), 16)。
 *   - array 风格(多数 switch VM): 每单元 = 1 个数组元素。
 *   - 跳转指令(has_jump: JMP/CALL/RET) 标注 ⚠，线性反汇编不强行跟随。
 * =========================================================================== */
'use strict';
const fs = require('fs');

function parseArgs(argv) {
  const o = { start: 0, limit: Infinity };
  for (const a of argv) {
    if (a.startsWith('--handlers=')) o.handlers = a.slice(11);
    else if (a.startsWith('--bytecode=')) o.bytecode = a.slice(11);
    else if (a.startsWith('--start=')) o.start = parseInt(a.slice(8), 10);
    else if (a.startsWith('--limit=')) o.limit = parseInt(a.slice(8), 10);
    else if (a === '--scan') o.scan = true;
    else if (a.startsWith('--scan=')) { o.scan = true; o.scanMax = parseInt(a.slice(7), 10); }
    else if (a === '--cfg') o.cfg = true;
    else if (a.startsWith('--vpc=')) o.vpc = a.slice(6);   // vpc_resolve.json：动态补全跳转目标
    else if (a.startsWith('--out=')) o.out = a.slice(6);
    else if (!o.handlers) o.handlers = a;
    else if (!o.bytecode) o.bytecode = a;
  }
  return o;
}

// 把字节码文件读成「单元读取器」：unitAt(pc) 返回该位置的字节值；rawAt(pc,n) 返回 n 个单元的原始片段
function loadBytecode(file, style) {
  const txt = fs.readFileSync(file, 'utf8').trim();
  if (style === 'array' || txt.startsWith('[')) {
    const arr = JSON.parse(txt);
    return {
      style: 'array',
      length: arr.length,
      unitAt: (pc) => arr[pc],
      rawAt: (pc, n) => arr.slice(pc, pc + n),
      fmt: (v) => String(v),
    };
  }
  // hex-string: 默认每字节 2 hex 字符
  const hex = txt.replace(/\s+/g, '');
  return {
    style: 'hex-string',
    length: hex.length,
    unitAt: (pc) => parseInt(hex.substr(pc, 2), 16),
    rawAt: (pc, n) => hex.substr(pc, n),
    fmt: (v) => '0x' + (v & 0xff).toString(16).padStart(2, '0'),
  };
}

// 解析跳转目标：用 handler 的 jump_target_expr(如 pc+(2*op-2)) + 从字节码解出操作数。
function resolveTarget(ins, bc, base) {
  const expr = ins.h.jump_target_expr;
  if (!expr) return null;
  const ids = (expr.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) || []).filter(x => x !== 'pc');
  const opVar = ids[0] || '__x';
  const jou = ins.h.jump_operand_units || 0;
  let opVal;
  if (bc.style === 'hex-string') {            // 操作数默认 int16(4 hex)，紧跟 opcode
    opVal = parseInt(bc.rawAt(ins.pc + base, 4) || '0', 16);
    if (opVal >= 0x8000) opVal -= 0x10000;    // signed
  } else opVal = bc.unitAt(ins.pc + base);
  // 跳转时 handler 里的 pc 已越过 opcode + 自身操作数
  const pcAtJump = ins.pc + base + jou;
  try {
    const tgt = new Function('pc', opVar, `return (${expr});`)(pcAtJump, opVal);
    if (Number.isFinite(tgt) && tgt >= 0 && tgt < bc.length) return { target: tgt, opVal };
  } catch (e) {}
  return null;
}

// 控制流恢复：基本块切分 + 跳转目标解析 + 回边=循环 / 前向=分支。
function emitCFG(instrs, bc, base, log, vpcJumps) {
  const real = instrs.filter(i => !i.bad);
  if (!real.length) { log('; (无可解码指令)'); return; }
  const byPc = new Map(real.map(i => [i.pc, i]));

  // 1) 解析跳转目标：先静态(target_expr+操作数)，解不出再用 vpc 动态观测补全
  for (const ins of real) if (ins.h.has_jump) {
    ins.resolved = resolveTarget(ins, bc, base);
    if (!ins.resolved && vpcJumps && vpcJumps[ins.pc]) {
      const ts = vpcJumps[ins.pc];
      ins.vpcTargets = ts;                       // 观测到的目标(可能多个=条件分支)
      ins.resolved = { target: ts[0], opVal: null, dyn: true };
    }
  }

  // 2) leaders：起点 / 终结指令(跳转/return)的下一条 / 跳转目标
  const leaders = new Set([real[0].pc]);
  for (let i = 0; i < real.length; i++) {
    const ins = real[i];
    if (ins.h.has_jump || ins.h.is_return) { if (real[i + 1]) leaders.add(real[i + 1].pc); }
    if (ins.resolved && byPc.has(ins.resolved.target)) leaders.add(ins.resolved.target);
  }
  // 3) 切基本块
  const blocks = []; let cur = null;
  for (const ins of real) {
    if (leaders.has(ins.pc) || !cur) { cur = { start: ins.pc, ins: [] }; blocks.push(cur); }
    cur.ins.push(ins);
  }
  const blockAt = (pc) => blocks.find(b => b.start === pc);

  // 4) 边 + 循环检测
  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi]; const last = b.ins[b.ins.length - 1];
    b.edges = [];
    if (last.h.is_return && !last.h.has_jump) { b.term = 'return'; }
    else if (last.h.has_jump) {
      b.term = (last.h.jump_kind || 'jmp') + (last.h.jump_cond ? '/cond' : '') + (last.resolved && last.resolved.dyn ? '/vpc' : '');
      if (last.vpcTargets) { for (const t of last.vpcTargets) b.edges.push({ to: t, kind: 'jump' }); }  // 多目标=条件分支
      else if (last.resolved) b.edges.push({ to: last.resolved.target, kind: 'jump' });
      else b.edges.push({ to: null, kind: 'jump-dyn' });
      if (last.h.jump_cond && !last.vpcTargets && blocks[bi + 1]) b.edges.push({ to: blocks[bi + 1].start, kind: 'fallthrough' });
    } else { b.term = 'fallthrough'; if (blocks[bi + 1]) b.edges.push({ to: blocks[bi + 1].start, kind: 'fallthrough' }); }
    for (const e of b.edges) if (e.to != null && e.to <= b.start) e.loop = true;
  }

  // 5) 输出。循环头 = 回边的「目标」块(被跳回的)，回边的「源」块是 latch。
  const lbl = (pc) => 'L' + pc.toString(16).padStart(4, '0');
  const loopHeaders = new Set();
  for (const b of blocks) for (const e of b.edges) if (e.loop && e.to != null) loopHeaders.add(e.to);
  log(`; ===== 控制流恢复 (基本块 + CFG) =====`);
  log(`; ${blocks.length} 基本块；回边(↑loop)=循环, 前向(↓)=分支`);
  let resolved = 0, dyn = 0;
  for (const b of blocks) {
    const isHeader = loopHeaders.has(b.start);
    log(`\n${lbl(b.start)}:${isHeader ? '   ; ⟲ LOOP header (被回边跳回)' : ''}`);
    for (const ins of b.ins) {
      const os = ins.operandHex ? `[${ins.operandHex}]` : '';
      log(`  ${ins.pc.toString(16).padStart(4, '0')}  ${ins.name.padEnd(16)} ${os}`);
    }
    const parts = b.edges.map(e => {
      if (e.kind === 'jump-dyn') { dyn++; return `jmp→(动态: ${b.ins[b.ins.length-1].h.jump_target_expr})`; }
      resolved++;
      const dir = e.loop ? '↑loop' : (e.to > b.start ? '↓' : '→');
      return `${e.kind}→${lbl(e.to)} ${dir}`;
    });
    log(`  └─[${b.term}] ${parts.join('  ') || '(exit/return)'}`);
  }
  log(`\n; ===== 统计 ===== 基本块 ${blocks.length} | 循环头 ${loopHeaders.size} | 已解析跳转 ${resolved} | 动态跳转 ${dyn}`);
}

// 轨迹驱动 CFG：节点=观测到的 pc，边=观测到的转移，每个 pc 解码出 opcode。
// 完全对齐(真实 pc 边界)+全解析(边都是观测到的)，专治变长 opcode / 决策树读操作数的站点。
function emitVpcCFG(resolved, bc, decodeTable, handlers, base, log) {
  const trans = resolved.transitions || {};
  const opName = (pc) => {
    const bv = bc.unitAt(pc); if (bv == null || Number.isNaN(bv)) return '???';
    const ok = decodeTable[bv]; const h = ok != null ? handlers[ok] : null;
    return h && h.inferred_name && h.inferred_name !== 'UNKNOWN' ? h.inferred_name : ('OP_' + (ok ?? '?'));
  };
  const pcs = new Set();
  for (const pc in trans) { pcs.add(+pc); for (const e of trans[pc]) pcs.add(e.to); }
  const sorted = [...pcs].sort((a, b) => a - b);
  // 前驱计数 + 每个 pc 的后继
  const preds = {}, succOf = {};
  for (const pc in trans) {
    succOf[+pc] = trans[pc].map(e => e.to);
    for (const e of trans[pc]) preds[e.to] = (preds[e.to] || 0) + 1;
  }
  // leaders：最小 pc / 跳转目标(非顺序后继) / 多前驱 / 多后继块的各后继
  const isSeq = (a, b) => b > a && b - a <= 16;
  const leaders = new Set([sorted[0]]);
  for (const pc in trans) {
    const es = trans[pc].map(e => e.to);
    if (es.length > 1) es.forEach(t => leaders.add(t));         // 分支目标
    for (const t of es) if (!isSeq(+pc, t)) leaders.add(t);     // 跳转目标
  }
  for (const pc in preds) if (preds[pc] > 1) leaders.add(+pc);  // 汇合点

  // 切块：从每个 leader 顺着「唯一顺序后继且后继单前驱」延伸
  const blocks = []; const placed = new Set();
  for (const L of [...leaders].sort((a, b) => a - b)) {
    if (placed.has(L)) continue;
    const blk = { start: L, pcs: [] }; let cur = L;
    while (cur != null && !placed.has(cur)) {
      blk.pcs.push(cur); placed.add(cur);
      const ss = succOf[cur] || [];
      if (ss.length === 1 && isSeq(cur, ss[0]) && !leaders.has(ss[0]) && (preds[ss[0]] || 0) <= 1) cur = ss[0];
      else break;
    }
    blk.term = cur;  // 块最后一条
    blocks.push(blk);
  }
  const loopHeaders = new Set();
  for (const pc in trans) for (const e of trans[pc]) if (e.to <= +pc) loopHeaders.add(e.to);

  const lbl = (pc) => 'L' + pc.toString(16).padStart(4, '0');
  log(`; ===== 控制流恢复 (轨迹驱动 / vpc) =====`);
  log(`; vpc 槽 ${resolved._meta.vpc_slot}, 执行 ${resolved._meta.distinct_pcs} 个 pc, ${blocks.length} 基本块, range ${JSON.stringify(resolved._meta.pc_range)}`);
  for (const b of blocks) {
    const isH = loopHeaders.has(b.start);
    log(`\n${lbl(b.start)}:${isH ? '   ; ⟲ LOOP header' : ''}`);
    for (const pc of b.pcs) log(`  ${pc.toString(16).padStart(4, '0')}  ${opName(pc)}`);
    const last = b.pcs[b.pcs.length - 1];
    const es = (succOf[last] || []);
    const parts = es.map(t => {
      const dir = t <= last ? '↑loop' : (isSeq(last, t) ? '↓seq' : '↓jump');
      return `${lbl(t)} ${dir}`;
    });
    log(`  └─→ ${parts.join('  ') || '(exit)'}`);
  }
  log(`\n; ===== 统计 ===== 基本块 ${blocks.length} | 循环头 ${loopHeaders.size} | 边全部来自实际执行观测(无未解析)`);
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.handlers || !o.bytecode) {
    console.error('用法: node disassemble.js --handlers=<h.json> --bytecode=<file> [--start=N] [--limit=N] [--out=file]');
    process.exit(2);
  }

  const H = JSON.parse(fs.readFileSync(o.handlers, 'utf8'));
  const meta = H._meta || {};
  const handlers = H.handlers || {};
  const decodeTable = meta.decode_table;
  if (!decodeTable) { console.error('FATAL: handlers.json 缺少 decode_table（请用新版 dispatcher_split.js 重新生成）'); process.exit(1); }
  const base = meta.base_advance || 1;
  const bc = loadBytecode(o.bytecode, meta.bytecode_style);

  // --scan: 在前缀里找最可能的代码起点（跳过 magic/meta 头）。
  // 通用启发式：以 base 为步长试各 offset，对一段窗口算「命名 op 占比 - 解码失败惩罚」，取峰值。
  if (o.scan) {
    const scanMax = o.scanMax || Math.min(bc.length, 256);
    const win = 40;
    let best = { off: o.start, score: -1e9 };
    for (let off = 0; off <= scanMax; off += base) {
      let pc = off, named = 0, bad = 0, n = 0;
      while (pc < bc.length && n < win) {
        const bv = bc.unitAt(pc);
        if (bv == null || Number.isNaN(bv)) break;
        const ok = decodeTable[bv];
        const hh = ok != null ? handlers[ok] : null;
        if (!hh) bad++;
        else if (hh.inferred_name && hh.inferred_name !== 'UNKNOWN') named++;
        const adv = hh && !hh.has_jump ? base + (hh.operand_units || 0) : base;
        pc += adv > 0 ? adv : base; n++;
      }
      const score = named - bad * 2;
      if (score > best.score) best = { off, score, named, bad };
    }
    console.error(`[*] --scan: 建议起点 pc=${best.off} (窗口内 命名=${best.named} 解码失败=${best.bad}, score=${best.score})`);
    o.start = best.off;
  }

  const lines = [];
  const log = (s) => lines.push(s);

  log(`; ===== JSVMP 反汇编 (通用) =====`);
  log(`; source       : ${meta.source || '?'}`);
  log(`; dispatcher    : mode=${meta.mode} 寄存器=${JSON.stringify(meta.detected_registers || {})}`);
  log(`; decode        : ${meta.decode_formula ? meta.decode_formula.branch_on : '?'}  (base_advance=${base}, ${bc.style})`);
  log(`; bytecode len  : ${bc.length} ${bc.style === 'hex-string' ? 'hex 字符' : '元素'}`);
  log(`; start pc      : ${o.start}`);
  log(`;`);

  // ---- 第一遍：线性解码成指令列表 ----
  let pc = o.start, count = 0;
  const stats = { total: 0, named: 0, unknown: 0, jumps: 0, badDecode: 0 };
  const instrs = [];
  while (pc < bc.length && count < o.limit) {
    const byteVal = bc.unitAt(pc);
    if (byteVal == null || Number.isNaN(byteVal)) break;
    const opKey = decodeTable[byteVal];
    const h = opKey != null ? handlers[opKey] : null;
    if (!h) {
      instrs.push({ pc, byteVal, bad: true, advance: base });
      stats.badDecode++; stats.total++; pc += base; count++; continue;
    }
    const name = h.inferred_name && h.inferred_name !== 'UNKNOWN' ? h.inferred_name : `OP_${opKey}`;
    if (h.inferred_name && h.inferred_name !== 'UNKNOWN') stats.named++; else stats.unknown++;
    let operandHex = null, advance = base;
    if (h.has_jump) { stats.jumps++; const jou = h.jump_operand_units || 0; if (jou > 0) operandHex = bc.rawAt(pc + base, jou); advance = base + jou; }
    else { const ou = h.operand_units || 0; if (ou > 0) operandHex = bc.rawAt(pc + base, ou); advance = base + ou; }
    instrs.push({ pc, byteVal, opKey, name, operandHex, advance, h });
    stats.total++; count++; pc += advance > 0 ? advance : base;
  }

  if (o.vpc && o.cfg) {
    // 轨迹驱动 CFG：直接用 vpc 观测到的 pc 转移图(真实指令边界+每条边都已解析)，
    // 不靠线性解码(变长 opcode 会漂移)。这是变长 opcode 站点拿到「完整控制流」的正道。
    let resolved; try { resolved = JSON.parse(fs.readFileSync(o.vpc, 'utf8')); } catch (e) { console.error('[!] --vpc 读取失败: ' + e.message); process.exit(1); }
    emitVpcCFG(resolved, bc, decodeTable, handlers, base, log);
  } else if (o.cfg) {
    emitCFG(instrs, bc, base, log, null);
  } else {
    for (const ins of instrs) {
      const pcHex = ins.pc.toString(16).padStart(6, '0');
      if (ins.bad) { log(`${pcHex}:  ${bc.fmt(ins.byteVal).padEnd(6)}  ??? (byte=${ins.byteVal})`); continue; }
      let os = '';
      if (ins.h.has_jump) os = `  ⚠ jump/call (${ins.h.jump_kind||'?'}${ins.h.jump_cond?',cond':''}) ${ins.h.jump_target_expr?'→ '+ins.h.jump_target_expr:''}`;
      else if (ins.operandHex) os = '  ' + (bc.style === 'hex-string' ? `[${ins.operandHex}]` : `[${ins.operandHex.join(',')}]`);
      log(`${pcHex}:  ${bc.fmt(ins.byteVal).padEnd(6)}  ${ins.name.padEnd(18)}${os}  ; op_key=${ins.opKey}`);
    }
    log(`;`);
    log(`; ===== 统计 =====`);
    log(`; 指令数 ${stats.total} | 命名 ${stats.named} | UNKNOWN ${stats.unknown} | 跳转 ${stats.jumps} | 解码失败 ${stats.badDecode}`);
  }

  const out = lines.join('\n') + '\n';
  if (o.out) { fs.writeFileSync(o.out, out); console.error(`[*] 反汇编写入: ${o.out} (${stats.total} 条指令)`); }
  else process.stdout.write(out);
}

main();

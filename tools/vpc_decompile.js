#!/usr/bin/env node
/* ===========================================================================
 * vpc_decompile.js —— 轨迹驱动符号反编译：把 firefox-reverse 抓到的「执行序列」
 *   (vpc l[pc] 序列) + handler 语义 + 字节码操作数 → 符号栈执行 → 伪代码。
 *
 * 通用、数据驱动：op 效果按 inferred_name(通用 JSVMP op 名) 映射；子分发 handler
 *   (内部 `op<C ? A : op<C2 ? B` 链)按源码里的阈值+分支体「泛型」拆出子 op
 *   (用 rawOp=(decode公式) 逐次定位)。不写死任何站点。
 *
 * 用法: node vpc_decompile.js <handlers.json> <bytecode.hex> <vpc.ndjson> [--from=N --to=M]
 * =========================================================================== */
'use strict';
const fs = require('fs');

// 通用 op 效果表（名字来自 dispatcher_split 的通用模式识别，非站点特定）
const BIN = { ADD:'+', SUB:'-', MUL:'*', DIV:'/', MOD:'%', XOR:'^', BOR:'|', BAND:'&',
              SHL:'<<', SHR:'>>', USHR:'>>>', LT:'<', LE:'<=', GT:'>', GE:'>=',
              EQ:'==', NE:'!=', SEQ:'===', SNE:'!==' };
const UN  = { NOT:'!', NEG:'-', BNOT:'~', TYPEOF:'typeof ' };

function main() {
  const [hf, bf, vf] = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const arg = k => { const a = process.argv.find(x => x.startsWith('--'+k+'=')); return a ? +a.split('=')[1] : null; };
  if (!hf || !bf || !vf) { console.error('用法: node vpc_decompile.js <handlers.json> <bytecode.hex> <vpc.ndjson> [--from=N --to=M]'); process.exit(2); }

  const H = JSON.parse(fs.readFileSync(hf, 'utf8')); const handlers = H.handlers; const dt = H._meta.decode_table;
  const hex = fs.readFileSync(bf, 'utf8').trim();
  const decode = H._meta.decode_formula;
  // rawOp 公式：从 decode_formula 推；常见形态 (K*byte)%M。从 preamble 提 K,M（泛型，folded）。
  let K = 13, M = 241;  // 默认（disassemble 已折叠出的常量）
  const mm = (decode && decode.preamble || '').match(/(\d+)\s*\*\s*\w+\s*%\s*(\d+)/);
  if (mm) { K = +mm[1]; M = +mm[2]; }
  const byteAt = pc => parseInt(hex.substr(pc, 2), 16);
  const rawOpAt = pc => (K * byteAt(pc)) % M;
  const nameAt = pc => { const k = dt[byteAt(pc)]; const h = k != null ? handlers[k] : null;
    return h ? (h.inferred_name && h.inferred_name !== 'UNKNOWN' ? h.inferred_name : 'OP_' + k) : '?'; };

  // 泛型解析子分发 handler：源码里 `VAR < THRESH ? EFFECT ...` 链 → [{lt, kind}]
  // kind 由分支体判断：含 '^'→xor, 'stack[sp--]' 单独→pop, 含 'pc +='/'_0x1218ef'→call。
  function subDispatch(opKey) {
    const src = handlers[opKey] && handlers[opKey].source || '';
    if (!/\?/.test(src) || !/<\s*[-0-9x* +()]+/.test(src)) return null;
    const branches = [];
    // 折叠 < 阈值：匹配 `< <expr>` 后跟 `?`
    const re = /<\s*([-0-9x*+ ()]+?)\s*\?([^?:]*)/g; let m;
    while ((m = re.exec(src))) {
      let thr; try { thr = Function('return (' + m[1] + ')')(); } catch { continue; }
      const body = m[2];
      let kind = 'misc';
      if (/\^/.test(body)) kind = 'XOR';
      else if (/stack\[sp--\]/.test(body) && !/=/.test(body.replace(/stack\[sp--\]/,''))) kind = 'POP';
      else if (/pc\s*\+=|_0x1218ef|_0x1fc4a4/.test(body)) kind = 'CALL';
      branches.push({ lt: thr, kind });
    }
    return branches.length ? branches : null;
  }
  const subCache = {};
  const subOp = (opKey, raw) => {
    if (!(opKey in subCache)) subCache[opKey] = subDispatch(opKey);
    const br = subCache[opKey]; if (!br) return null;
    for (const b of br) if (raw < b.lt) return b.kind;
    return 'misc';
  };

  const rows = fs.readFileSync(vf, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l)._vpc; } catch { return null; } }).filter(Boolean);
  const seq = rows.map(r => r.l[7]).filter(x => typeof x === 'number');
  const from = arg('from') || 0, to = arg('to') || seq.length;

  // 符号栈执行
  const stack = []; let t = 0; const out = [];
  const push = e => stack.push(e); const pop = () => stack.length ? stack.pop() : '?';
  const stats = { xor: 0, pop: 0, call: 0, named: {} };
  for (let i = from; i < to && i < seq.length; i++) {
    const pc = seq[i]; const nm = nameAt(pc); const raw = rawOpAt(pc);
    if (BIN[nm]) { const b = pop(), a = pop(); const v = `t${t++}`; push(v); out.push(`${v} = (${a} ${BIN[nm]} ${b})`); stats.named[nm] = (stats.named[nm]||0)+1; }
    else if (UN[nm]) { const a = pop(); const v = `t${t++}`; push(v); out.push(`${v} = ${UN[nm]}${a}`); stats.named[nm]=(stats.named[nm]||0)+1; }
    else if (nm === 'DUP') { const a = stack[stack.length-1] ?? '?'; push(a); }
    else if (/^PUSH/.test(nm) || nm === 'GET_PROP_BY_CONST') { const v=`t${t++}`; push(v); out.push(`${v} = ${nm}@${pc}`); }
    else {
      const so = subOp(dt[byteAt(pc)], raw);   // 子分发：拆出真实子 op
      if (so === 'XOR') { const b = pop(); const a = stack.length?stack[stack.length-1]:'?'; if(stack.length)stack[stack.length-1]=`(${a} ^ ${b})`; out.push(`stack ^= ${b}   ; [${nm} raw=${raw} 子op=XOR]`); stats.xor++; }
      else if (so === 'POP') { pop(); stats.pop++; }
      else if (so === 'CALL') { stats.call++; }
      else { stats.named[nm]=(stats.named[nm]||0)+1; }
    }
  }
  console.log(`; 反编译执行序列 [${from}, ${to}) / 共 ${seq.length} 条`);
  console.log(`; XOR=${stats.xor}  POP=${stats.pop}  CALL=${stats.call}`);
  console.log(out.slice(0, 80).join('\n'));
  console.log(`\n; ===== 执行序列子op统计 =====`);
  console.log(`; XOR(加密核心)=${stats.xor} 次, POP=${stats.pop}, CALL=${stats.call}`);
}
main();

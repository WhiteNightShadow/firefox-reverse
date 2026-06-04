#!/usr/bin/env node
/**
 * JSVMP Dispatcher Babel-AST 拆解器
 *
 * 输入: 含 `while (true) { ... switch(opcode) { case N: ... } }` 结构的 dispatcher JS
 * 输出: handlers.json - 每个 op 的 case body + 自动模式识别命名
 *
 * 用法:
 *   node dispatcher_split.js <input.js> [output.json]
 *
 * 支持两种 dispatcher 方言:
 *   A. 方法调用栈 (stack.push()/stack.pop())
 *   B. 索引栈 (stack[sp--] / stack[++sp])
 *
 * 不走 fuzz 路线 - 纯 AST 静态分析，毫秒级。
 */

const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const generator = require('@babel/generator').default;
const fs = require('fs');

// ===========================================================================
// 注意：此处不再有任何写死的站点变量名映射表（REGISTER_MAP）。
// 所有 stack/sp/pc/bytecode/consts/thisArg 都由 autoDetectRegisters() 启发式识别，
// 对任意 JSVMP 站点通用，不写死任何站点变量名。
// ===========================================================================

// ===========================================================================
// 步骤 1: 加载 + parse
// ===========================================================================
function loadDispatcher(filePath) {
  const src = fs.readFileSync(filePath, 'utf8');
  return parser.parse(src, {
    sourceType: 'script',
    errorRecovery: true,
    plugins: ['classProperties'],
  });
}

// ===========================================================================
// 步骤 2: 找 main dispatcher (两种模式)
//   A. while + switch (方法调用栈方言)
//   B. 嵌套 if/三元 decision tree (索引栈方言)
// ===========================================================================
function findDispatcherWhile(ast) {
  let result = null;
  traverse(ast, {
    WhileStatement(path) {
      const body = path.node.body;
      if (!t.isBlockStatement(body)) return;
      const switchStmt = body.body.find(s => t.isSwitchStatement(s));
      if (switchStmt && switchStmt.cases.length >= 5) {
        result = { whilePath: path, switchNode: switchStmt, mode: 'switch' };
        path.stop();
      }
    },
  });
  return result;
}

// 按 col 找 dispatcher 函数（已知 col 时的兜底定位）
function findDispatcherByCol(ast, targetCol, tolerance = 30) {
  let result = null;
  traverse(ast, {
    FunctionDeclaration(path) {
      const loc = path.node.loc;
      if (loc && loc.start.column >= targetCol - tolerance && loc.start.column <= targetCol + tolerance) {
        result = path.node;
        path.stop();
      }
    },
  });
  return result;
}

// 在函数体里找 main dispatch loop (For/While)
function findDispatchLoopInFn(fnNode) {
  for (const stmt of fnNode.body.body) {
    if (t.isForStatement(stmt) || t.isWhileStatement(stmt)) return stmt;
    if (t.isIfStatement(stmt)) {
      if (t.isForStatement(stmt.consequent) || t.isWhileStatement(stmt.consequent)) {
        return stmt.consequent;
      }
    }
  }
  return null;
}

// ===========================================================================
// 【通用】自动检测 dispatcher —— 不靠人工 --col。
// 思路：遍历文件里所有循环(while/for/do-while)，按 JSVMP 特征打分，取最高分。
// 特征（站点无关）：栈操作(push/pop/arr[++i]/arr[i--]) + 字节码推进(arr[i++]/pc+=N)
//   + 大分支(switch≥5 cases 或 深层 if/三元决策树) + 死循环(while(1)/for(;;))
// ===========================================================================
function scoreDispatchLoop(loopNode) {
  let stackUpdates = 0, advanceOps = 0, branchNodes = 0;
  let switchCases = 0, hasSwitch = false, switchNode = null;

  const wrapped = t.cloneNode(loopNode, true);
  const program = t.file(t.program([wrapped]));
  traverse(program, {
    CallExpression(p) {
      const c = p.node.callee;
      if (t.isMemberExpression(c) && t.isIdentifier(c.property) &&
          (c.property.name === 'push' || c.property.name === 'pop')) stackUpdates++;
    },
    MemberExpression(p) {
      const prop = p.node.property;
      if (t.isUpdateExpression(prop) && t.isIdentifier(prop.argument)) {
        if (prop.operator === '++' && prop.prefix) stackUpdates++;        // arr[++i] push
        else if (prop.operator === '--') stackUpdates++;                  // arr[i--]/arr[--i] pop
        else if (prop.operator === '++' && !prop.prefix) advanceOps++;    // arr[i++] 顺序读
      }
    },
    AssignmentExpression(p) {
      // pc += N（字节码推进），排除栈指针自身的 sp -= N（虽也是推进，但仍是有效信号）
      if ((p.node.operator === '+=' || p.node.operator === '-=') && t.isIdentifier(p.node.left)) advanceOps++;
    },
    IfStatement() { branchNodes++; },
    ConditionalExpression() { branchNodes++; },
    SwitchStatement(p) {
      if (p.node.cases.length > switchCases) { switchCases = p.node.cases.length; hasSwitch = true; switchNode = p.node; }
    },
  });

  // 死循环判定
  const test = loopNode.test;
  const loopForever = !test
      || (t.isBooleanLiteral(test) && test.value === true)
      || (t.isNumericLiteral(test) && test.value !== 0)
      || (t.isUnaryExpression(test) && test.operator === '!' && t.isNumericLiteral(test.argument)); // while(!0)

  const qualified = stackUpdates >= 3 && (branchNodes >= 5 || (hasSwitch && switchCases >= 5));
  const score = stackUpdates * 3 + advanceOps * 2 + Math.min(branchNodes, 80)
      + (hasSwitch && switchCases >= 5 ? 20 : 0) + (loopForever ? 5 : 0);

  return { qualified, score, stackUpdates, advanceOps, branchNodes, switchCases, hasSwitch, switchNode };
}

function findDispatcherAuto(ast) {
  let best = null;
  traverse(ast, {
    'WhileStatement|ForStatement|DoWhileStatement'(path) {
      const s = scoreDispatchLoop(path.node);
      if (!s.qualified) return;
      if (!best || s.score > best.score) {
        const fnParent = path.getFunctionParent && path.getFunctionParent();
        best = {
          loop: path.node,
          score: s.score,
          mode: s.hasSwitch && s.switchCases >= 5 ? 'switch' : 'tree',
          switchNode: s.switchNode,
          stats: s,
          loc: path.node.loc,
          fnParams: fnParent && fnParent.node && fnParent.node.params
            ? fnParent.node.params.map(p => (t.isIdentifier(p) ? p.name : null)).filter(Boolean)
            : [],
        };
      }
    },
  });
  return best;
}

// ===========================================================================
// Decision tree mode: 提取嵌套 if/三元/&& 的所有叶子
// ===========================================================================
function extractDecisionTreeLeaves(rootNode) {
  const leaves = [];
  let leafCounter = 0;

  function walk(node, pathParts) {
    if (!node) return;

    if (t.isIfStatement(node)) {
      walk(node.consequent, [...pathParts, 'T']);
      if (node.alternate) walk(node.alternate, [...pathParts, 'F']);
      return;
    }
    if (t.isConditionalExpression(node)) {
      walk(node.consequent, [...pathParts, '?']);
      walk(node.alternate, [...pathParts, ':']);
      return;
    }
    if (t.isLogicalExpression(node) && node.operator === '&&') {
      // X && body → if X then body
      walk(node.right, [...pathParts, 'A']);
      return;
    }
    if (t.isBlockStatement(node)) {
      // 找 block 中**最后一个含控制流**的 stmt
      // 前面的是 setup（不算 leaf，体现为 path 的"前导"语义但不显式记录）
      // 如果完全没有控制流 → 整段 block 作为 leaf (含 setup + statements)
      let lastCfIdx = -1;
      for (let i = node.body.length - 1; i >= 0; i--) {
        const s = node.body[i];
        if (t.isIfStatement(s)) { lastCfIdx = i; break; }
        if (t.isExpressionStatement(s) &&
            (t.isConditionalExpression(s.expression) ||
             (t.isLogicalExpression(s.expression) && s.expression.operator === '&&'))) {
          lastCfIdx = i;
          break;
        }
      }
      if (lastCfIdx >= 0) {
        // 只 walk 最后一个控制流 stmt（前面的是 setup，path 体现层级即可）
        walk(node.body[lastCfIdx], pathParts);
      } else if (node.body.length === 1) {
        walk(node.body[0], pathParts);
      } else {
        // pure handler body（block 含多个 stmt 但都不是控制流）
        leaves.push({ path: pathParts.join('') || `L${leafCounter++}`, body: node.body });
      }
      return;
    }
    if (t.isExpressionStatement(node)) {
      const e = node.expression;
      if (t.isConditionalExpression(e) ||
          (t.isLogicalExpression(e) && e.operator === '&&')) {
        walk(e, pathParts);
        return;
      }
      if (t.isSequenceExpression(e)) {
        // 序列表达式作为一个 handler（多个语句压成 sequence）
        leaves.push({
          path: pathParts.join('') || `L${leafCounter++}`,
          body: e.expressions.map(x => t.expressionStatement(x)),
        });
        return;
      }
      leaves.push({ path: pathParts.join('') || `L${leafCounter++}`, body: [node] });
      return;
    }
    // 其他 leaf 类型
    leaves.push({ path: pathParts.join('') || `L${leafCounter++}`, body: [node] });
  }

  walk(rootNode, []);
  return leaves;
}

// ===========================================================================
// 【通用】提取 decode 公式 —— byte→opcode 的变换前导。
// 取「循环体里、主分支(switch / 第一个 if/三元)之前」的所有语句，
// 这些语句把字节码原始值算成 opcode（如 13*byte%241 再位拆 &7 >>3 &3）。
// disassemble.js 用它来复刻 byte→op 映射，不写死 (13*byte)%241。
// ===========================================================================
function extractDecodeFormula(loopBody, knownSwitch) {
  if (!loopBody || !t.isBlockStatement(loopBody)) return null;
  const stmts = loopBody.body;

  // 1) 定位主分发节点：已知 switch 优先 → 顶层 switch → 最后一个顶层 if/三元(决策树根)
  let dispatchIdx = -1, branchOn = null, branchType = null;
  if (knownSwitch) {
    const i = stmts.indexOf(knownSwitch);
    if (i >= 0) { dispatchIdx = i; branchOn = knownSwitch.discriminant; branchType = 'switch'; }
  }
  if (dispatchIdx < 0) {
    for (let i = 0; i < stmts.length; i++) {
      if (t.isSwitchStatement(stmts[i])) { dispatchIdx = i; branchOn = stmts[i].discriminant; branchType = 'switch'; break; }
    }
  }
  if (dispatchIdx < 0) {
    // 决策树：最后一个顶层 if / 三元，是分发根（前面的小 if 多为 guard）
    for (let i = stmts.length - 1; i >= 0; i--) {
      const s = stmts[i];
      if (t.isIfStatement(s)) { dispatchIdx = i; branchOn = s.test; branchType = 'if'; break; }
      if (t.isExpressionStatement(s) &&
          (t.isConditionalExpression(s.expression) ||
           (t.isLogicalExpression(s.expression) && s.expression.operator === '&&'))) {
        branchOn = t.isConditionalExpression(s.expression) ? s.expression.test : s.expression.left;
        branchType = 'ternary'; dispatchIdx = i; break;
      }
    }
  }
  if (dispatchIdx < 0) return null;

  // 2) preamble = 分发前的「计算语句」(var/赋值/自增/序列)，跳过 guard if
  const preamble = [];
  for (let i = 0; i < dispatchIdx; i++) {
    const s = stmts[i];
    if (t.isVariableDeclaration(s)) preamble.push(s);
    else if (t.isExpressionStatement(s) &&
             (t.isAssignmentExpression(s.expression) ||
              t.isUpdateExpression(s.expression) ||
              t.isSequenceExpression(s.expression))) preamble.push(s);
    // 其余(IfStatement 等 guard)跳过
  }
  return { preamble, branchOn, branchType };
}

// ===========================================================================
// 【通用】把决策树编译成「导航器」语句：每个叶子替换为 return "<path>"，
// 保留所有 if/三元 测试 + rawOp/op 位运算 setup（这些只依赖解码值，不依赖栈）。
// 跑一次 = 仅靠字节码解码出该 opcode 的叶子路径(op_key)，不需要真实运行时状态。
// ===========================================================================
function buildNavStmts(node, pathParts) {
  const ret = () => [t.returnStatement(t.stringLiteral(pathParts.join('') || '?'))];
  if (t.isIfStatement(node)) {
    const cons = t.blockStatement(buildNavStmts(node.consequent, [...pathParts, 'T']));
    const alt = node.alternate ? t.blockStatement(buildNavStmts(node.alternate, [...pathParts, 'F'])) : null;
    return [t.ifStatement(node.test, cons, alt)];
  }
  if (t.isConditionalExpression(node)) {
    return [t.ifStatement(node.test,
      t.blockStatement(buildNavStmts(node.consequent, [...pathParts, '?'])),
      t.blockStatement(buildNavStmts(node.alternate, [...pathParts, ':'])))];
  }
  if (t.isLogicalExpression(node) && node.operator === '&&') {
    return [t.ifStatement(node.left, t.blockStatement(buildNavStmts(node.right, [...pathParts, 'A'])))];
  }
  if (t.isBlockStatement(node)) {
    let lastCfIdx = -1;
    for (let i = node.body.length - 1; i >= 0; i--) {
      const s = node.body[i];
      if (t.isIfStatement(s)) { lastCfIdx = i; break; }
      if (t.isExpressionStatement(s) &&
          (t.isConditionalExpression(s.expression) ||
           (t.isLogicalExpression(s.expression) && s.expression.operator === '&&'))) { lastCfIdx = i; break; }
    }
    if (lastCfIdx >= 0) {
      const setup = node.body.slice(0, lastCfIdx);  // 保留 rawOp/op 位运算 setup
      return [...setup.map(s => t.cloneNode(s, true)), ...buildNavStmts(node.body[lastCfIdx], pathParts)];
    }
    if (node.body.length === 1) return buildNavStmts(node.body[0], pathParts);
    return ret();  // 纯叶子(handler body)
  }
  if (t.isExpressionStatement(node)) {
    const e = node.expression;
    if (t.isConditionalExpression(e) || (t.isLogicalExpression(e) && e.operator === '&&')) return buildNavStmts(e, pathParts);
    return ret();
  }
  return ret();
}

// 统计一段语句里 pc 的推进量（操作数字节数）：pc++ 计 1；pc += N 计 N。
// 含控制流(跳转)时返回 {delta, hasJump:true} —— 线性反汇编对跳转 op 标注但不精确推进。
function countPcDelta(stmts, pcName) {
  let delta = 0, hasJump = false, jumpKind = null, jumpExpr = null, jumpCond = false;
  // 先折叠混淆常量(pc += -0x9b2+...) → pc += 2，否则会被误判为跳转
  const folded = foldConstants(stmts.map(s => t.isStatement(s) ? t.cloneNode(s, true) : t.expressionStatement(t.cloneNode(s, true))));
  const program = t.file(t.program(folded));
  const inLoop = (p) => !!p.findParent(pp =>
    pp.isForStatement() || pp.isWhileStatement() || pp.isDoWhileStatement() || pp.isForInStatement() || pp.isForOfStatement());
  const inCond = (p) => !!p.findParent(pp => pp.isIfStatement() || pp.isConditionalExpression() ||
    (pp.isLogicalExpression() && (pp.node.operator === '&&' || pp.node.operator === '||')));
  const markJump = (k, p) => { hasJump = true; if (k === 'abs' || !jumpKind) jumpKind = k; if (p && inCond(p)) jumpCond = true; };  // abs 优先
  traverse(program, {
    UpdateExpression(p) {
      if (t.isIdentifier(p.node.argument) && p.node.argument.name === pcName) {
        if (inLoop(p)) markJump('rel', p);       // 循环里改 pc → 变量次数 = 跳转
        else delta += (p.node.operator === '--') ? -1 : 1;
      }
    },
    AssignmentExpression(p) {
      if (t.isIdentifier(p.node.left) && p.node.left.name === pcName) {
        if (inLoop(p)) markJump('rel', p);
        else if (p.node.operator === '=') {                                // pc = X  绝对跳转
          markJump('abs', p); jumpExpr = generator(p.node.right, { compact: true }).code;
        } else if (p.node.operator === '+=' && t.isNumericLiteral(p.node.right)) {
          delta += p.node.right.value;                                     // pc += 常量 = 吃操作数(线性)
        } else {                                                           // pc += 变量 / pc -= X = 相对跳转
          markJump('rel', p);
          const op = p.node.operator === '-=' ? '-' : '+';
          jumpExpr = `${pcName}${op}(${generator(p.node.right, { compact: true }).code})`;
        }
      }
    },
    // 注意：不再把「任何 for/while」当跳转——只数据循环(不碰 pc)的不是跳转
  });
  return { delta, hasJump, jumpKind, jumpExpr, jumpCond };
}

// 【通用】构建 byte→opcode 解码表：对 0..255 每个字节值，跑导航器得 op_key。
// tree 模式: 编译决策树导航器；switch 模式: 跑 preamble 取判别式。
// 字节注入: parseInt 风格(hex 串) 喂 2-hex-char；数组风格喂 [V,...]。
function buildDecodeTable(mode, renamedLoopBody, dispatchSwitch, branchOnNode, renameMap, detected) {
  // navBody 由「已重命名」的循环体生成 → 寄存器统一为规范名 bytecode/pc/stack/sp/consts...
  // 注意 dispatchSwitch 是【原始】节点；switch 模式要用重命名后循环体里的 switch。
  let navBody;
  try {
    if (mode === 'tree') {
      navBody = buildNavStmts(renamedLoopBody, []);
    } else {
      const rSwitch = renamedLoopBody.body.find(s => t.isSwitchStatement(s));
      const df = extractDecodeFormula(renamedLoopBody, rSwitch);
      const pre = df && df.preamble ? df.preamble.map(s => t.cloneNode(s, true)) : [];
      const disc = (rSwitch && rSwitch.discriminant) || (df && df.branchOn);
      navBody = [...pre, t.returnStatement(t.callExpression(t.identifier('String'), [t.cloneNode(disc, true)]))];
    }
  } catch (e) { return { error: 'build_nav_failed: ' + e.message }; }

  const navSrc = generator(t.program(navBody.map(s => t.isStatement(s) ? s : t.expressionStatement(s))), { compact: false }).code;
  const usesParseInt = /parseInt|charCodeAt/.test(navSrc);

  // 包装 + eval：规范寄存器名都声明；stack/consts/sp 等用 stub（分支只依赖解码值，不依赖栈）
  const wrapped = `(function(__feed){
    var pc = 0, sp = 0;
    var __stub = new Proxy({}, { get: function(){ return 0; }, set: function(){ return true; }, has: function(){ return true; } });
    var stack = __stub, consts = __stub, thisArg = __stub, acc = __stub, args = __stub;
    var bytecode = __feed;
    try { ${navSrc} } catch (e) { return '__ERR__:' + e.message; }
    return null;
  })`;

  let navFn;
  try { navFn = eval(wrapped); } catch (e) { return { error: 'eval_failed: ' + e.message, navSrc: navSrc.slice(0, 400) }; }

  const byteToOp = {};
  let errors = 0, nulls = 0;
  for (let v = 0; v <= 255; v++) {
    const feed = usesParseInt ? v.toString(16).padStart(2, '0') : [v, 0, 0, 0, 0, 0, 0, 0];
    let r;
    try { r = navFn(feed); } catch (e) { r = '__ERR__'; }
    if (typeof r === 'string' && r.startsWith('__ERR__')) { errors++; continue; }
    if (r == null) { nulls++; continue; }
    byteToOp[v] = String(r);
  }
  return { byteToOp, stats: { errors, nulls, mapped: Object.keys(byteToOp).length }, usesParseInt };
}

// ===========================================================================
// 步骤 3: 提取每个 case body
// ===========================================================================
function extractCases(switchNode) {
  const cases = [];
  for (const c of switchNode.cases) {
    if (!c.test) {
      // default branch
      cases.push({ value: null, isDefault: true, body: c.consequent });
      continue;
    }
    // 提取数字 case label（支持负数）
    let value = null;
    if (t.isNumericLiteral(c.test)) {
      value = c.test.value;
    } else if (t.isUnaryExpression(c.test) && c.test.operator === '-' && t.isNumericLiteral(c.test.argument)) {
      value = -c.test.argument.value;
    } else {
      // 复杂 case test (e.g. function call) - skip
      continue;
    }
    // 过滤掉 break 语句
    const body = c.consequent.filter(s => !t.isBreakStatement(s));
    cases.push({ value, isDefault: false, body });
  }
  return cases;
}

// ===========================================================================
// 步骤 4: 寄存器重命名（AST in-place）
// ===========================================================================
// ===========================================================================
// 【通用】自动识别虚拟寄存器（stack / sp / pc / bytecode / thisArg）
// 靠 AST 使用模式启发式，不写死任何站点的变量名。
// 这样任意 JSVMP dispatcher（任意结构）都能拆。
// ===========================================================================
function autoDetectRegisters(rootNode, fnParams = []) {
  const pushObj = {};        // 栈 push: .push() 或 arr[++x]=（prefix ++）
  const popObj = {};         // 栈 pop: .pop() 或 arr[x--]/arr[--x]
  const stackIdxRecord = []; // [{arr, idxVar}] 记录 arr[update-idx] 用于找 sp
  const bytecodeReadArr = {};// arr[x++]（postfix ++ 读）→ bytecode 候选
  const plainIdxArr = {};    // arr → {idxVar → count}（arr[plainVar]）
  const incVar = {}, decVar = {};
  const thisAssign = {};
  const immVarSources = {};  // varName → Set(srcName)：X 来源于该名字（arr[..] 的 arr，或 call(...,arg,...) 的 arg）
  const arrWritten = {};     // arr → 作为 arr[x]= / arr[x]++ 写目标的次数（consts 必须只读）

  // 记录立即数来源：X = arr[idx]（来源 arr）或 X = f(...args...)（来源每个 Identifier arg）
  // 用于识别「从字节码流读出的操作数」：bytecode[pc++] 或 helper(bytecode, pc) 两种形态
  const addSrc = (lhsName, srcName) =>
    (immVarSources[lhsName] || (immVarSources[lhsName] = new Set())).add(srcName);
  const recordImmSource = (lhsName, rhs) => {
    if (t.isMemberExpression(rhs) && t.isIdentifier(rhs.object)) {
      addSrc(lhsName, rhs.object.name);
    } else if (t.isCallExpression(rhs)) {
      for (const a of rhs.arguments) if (t.isIdentifier(a)) addSrc(lhsName, a.name);
    }
  };

  const wrapped = t.isStatement(rootNode)
      ? t.cloneNode(rootNode, true)
      : t.expressionStatement(t.cloneNode(rootNode, true));
  const program = t.file(t.program([wrapped]));

  traverse(program, {
    CallExpression(path) {
      const c = path.node.callee;
      if (t.isMemberExpression(c) && t.isIdentifier(c.object) && t.isIdentifier(c.property)) {
        if (c.property.name === 'push') pushObj[c.object.name] = (pushObj[c.object.name] || 0) + 1;
        if (c.property.name === 'pop') popObj[c.object.name] = (popObj[c.object.name] || 0) + 1;
      }
    },
    MemberExpression(path) {
      const obj = path.node.object, prop = path.node.property;
      if (!t.isIdentifier(obj)) return;
      if (t.isUpdateExpression(prop) && t.isIdentifier(prop.argument)) {
        const idx = prop.argument.name, op = prop.operator, prefix = prop.prefix;
        stackIdxRecord.push({ arr: obj.name, idxVar: idx });
        if (op === '++' && prefix) {
          // arr[++x]: 经典 push (先增后写)
          pushObj[obj.name] = (pushObj[obj.name] || 0) + 1;
        } else if (op === '--') {
          // arr[x--] / arr[--x]: 经典 pop
          popObj[obj.name] = (popObj[obj.name] || 0) + 1;
        } else if (op === '++' && !prefix) {
          // arr[x++]: 顺序读字节码 (postfix ++ = bytecode read)
          bytecodeReadArr[obj.name] = (bytecodeReadArr[obj.name] || 0) + 1;
        }
      } else if (t.isIdentifier(prop)) {
        if (!plainIdxArr[obj.name]) plainIdxArr[obj.name] = {};
        plainIdxArr[obj.name][prop.name] = (plainIdxArr[obj.name][prop.name] || 0) + 1;
      }
      // 该数组成员是否为写目标？arr[x]= / arr[x]+= / arr[x]++ → 排除出 consts 候选
      const par = path.parent;
      const isWriteLHS =
        (t.isAssignmentExpression(par) && par.left === path.node) ||
        (t.isUpdateExpression(par) && par.argument === path.node);
      if (isWriteLHS) arrWritten[obj.name] = (arrWritten[obj.name] || 0) + 1;
    },
    UpdateExpression(path) {
      if (t.isIdentifier(path.node.argument)) {
        const n = path.node.argument.name;
        if (path.node.operator === '++') incVar[n] = (incVar[n] || 0) + 1;
        if (path.node.operator === '--') decVar[n] = (decVar[n] || 0) + 1;
      }
    },
    AssignmentExpression(path) {
      if (path.node.operator === '=' && t.isIdentifier(path.node.left)) {
        if (t.isThisExpression(path.node.right)) {
          thisAssign[path.node.left.name] = (thisAssign[path.node.left.name] || 0) + 1;
        }
        recordImmSource(path.node.left.name, path.node.right);
      }
    },
    VariableDeclarator(path) {
      if (t.isIdentifier(path.node.id) && path.node.init) {
        recordImmSource(path.node.id.name, path.node.init);
      }
    },
  });

  const topKey = (obj, exclude = []) => {
    let best = null, max = 0;
    for (const k in obj) {
      if (exclude.includes(k)) continue;
      if (obj[k] > max) { max = obj[k]; best = k; }
    }
    return best;
  };

  // stack = push+pop 总数最高的数组
  const stackScore = {};
  for (const k in pushObj) stackScore[k] = (stackScore[k] || 0) + pushObj[k];
  for (const k in popObj) stackScore[k] = (stackScore[k] || 0) + popObj[k];
  const stack = topKey(stackScore);

  // sp = 在 stack[...update...] 索引位置出现的变量
  const spCand = {};
  for (const r of stackIdxRecord) {
    if (r.arr === stack) spCand[r.idxVar] = (spCand[r.idxVar] || 0) + 1;
  }
  const sp = topKey(spCand);

  // bytecode 强先验：dispatcher 第一个参数（被索引过的话）
  let bytecode = null;
  if (fnParams.length > 0) {
    const p0 = fnParams[0];
    if (plainIdxArr[p0] || bytecodeReadArr[p0]) bytecode = p0;
  }
  // 次选：postfix++ 读最多的数组（非 stack）
  if (!bytecode) bytecode = topKey(bytecodeReadArr, [stack]);
  // 兜底：被「只增不减」变量索引的非 stack 数组
  if (!bytecode) {
    let best = 0;
    for (const arr in plainIdxArr) {
      if (arr === stack) continue;
      for (const idx in plainIdxArr[arr]) {
        if (idx === sp) continue;
        const inc = (incVar[idx] || 0), dec = (decVar[idx] || 0);
        const score = (inc > 0 && dec === 0) ? inc * 3 + plainIdxArr[arr][idx] : 0;
        if (score > best) { best = score; bytecode = arr; }
      }
    }
  }

  // pc = 索引 bytecode 的变量中、自增最多且非 sp 的
  let pc = null;
  if (bytecode) {
    let best = -1;
    const idxCounts = plainIdxArr[bytecode] || {};
    for (const idx in idxCounts) {
      if (idx === sp) continue;
      const score = (incVar[idx] || 0) * 3 + idxCounts[idx];
      if (score > best) { best = score; pc = idx; }
    }
    // 若 bytecode 用 postfix++ 形式读（如 arr[start++]），从 stackIdxRecord 找
    if (!pc) {
      for (const r of stackIdxRecord) {
        if (r.arr === bytecode && r.idxVar !== sp) { pc = r.idxVar; break; }
      }
    }
  }

  const thisArg = topKey(thisAssign);

  // consts = 被「字节码立即数变量」索引最多的数组（≠stack ≠bytecode）
  // 立即数变量 = 曾被 `X = bytecode[...]` 赋值过的变量（PUSH_CONST: tmp=bytecode[pc++]; stack.push(consts[tmp])）
  let consts = null;
  if (bytecode) {
    const bcImmVars = new Set();
    for (const v in immVarSources) {
      if (immVarSources[v].has(bytecode)) bcImmVars.add(v);
    }
    const constsScore = {};
    for (const arr in plainIdxArr) {
      if (arr === stack || arr === bytecode) continue;
      if (arrWritten[arr]) continue;  // consts 是只读常量池，从不被 arr[x]= 写
      for (const idx in plainIdxArr[arr]) {
        if (bcImmVars.has(idx)) constsScore[arr] = (constsScore[arr] || 0) + plainIdxArr[arr][idx];
      }
    }
    consts = topKey(constsScore);
  }

  return { stack, sp, pc, bytecode, thisArg, consts };
}

function buildRenameMap(detected) {
  const map = {};
  if (detected.stack) map[detected.stack] = 'stack';
  if (detected.sp) map[detected.sp] = 'sp';
  if (detected.pc) map[detected.pc] = 'pc';
  if (detected.bytecode) map[detected.bytecode] = 'bytecode';
  if (detected.thisArg) map[detected.thisArg] = 'thisArg';
  if (detected.consts) map[detected.consts] = 'consts';
  return map;
}

// ===========================================================================
// 寄存器重命名（用动态识别出的 map，不依赖写死的 REGISTER_MAP）
// ===========================================================================
function renameRegisters(stmts, renameMap) {
  const map = renameMap || {};
  const cloned = stmts.map(s => {
    const c = t.cloneNode(s, true);
    if (t.isStatement(c)) return c;
    return t.expressionStatement(c);  // 裸 expression → wrap
  });
  const program = t.file(t.program(cloned));
  traverse(program, {
    Identifier(path) {
      if (map[path.node.name]) path.node.name = map[path.node.name];
    },
  });
  return cloned;
}

// 重命名单个表达式节点（给 decode branch_on 用），返回克隆后的节点
function renameNode(node, renameMap) {
  const map = renameMap || {};
  const wrapped = t.expressionStatement(t.cloneNode(node, true));
  const program = t.file(t.program([wrapped]));
  traverse(program, {
    Identifier(path) {
      if (map[path.node.name]) path.node.name = map[path.node.name];
    },
  });
  return wrapped.expression;
}

// 【通用】常量折叠：把混淆的纯数字算式(如 -0xe5d*0x1+0x1bdf+-0xd81)折成真实值(=1)。
// 让 decode 公式直接可读：13 * byte % 241。对任意站点的数字混淆都有效。
function foldConstants(stmts) {
  const list = Array.isArray(stmts) ? stmts : [stmts];
  const program = t.file(t.program(list.map(s => t.isStatement(s) ? s : t.expressionStatement(s))));
  traverse(program, {
    'BinaryExpression|UnaryExpression': {
      exit(path) {
        if (t.isUnaryExpression(path.node) && path.node.operator === '!') return; // 别把 !0 折成 true（保留 while(!0) 语义）
        const ev = path.evaluate();
        if (ev.confident && typeof ev.value === 'number' && Number.isFinite(ev.value)) {
          path.replaceWith(t.numericLiteral(ev.value));
        }
      },
    },
  });
  return program.program.body;
}

// ===========================================================================
// 模式识别 v2: AST-based matcher (更可靠，识别率比正则高几倍)
// ===========================================================================

function isId(node, name) {
  return t.isIdentifier(node) && (name ? node.name === name : true);
}

function exprOf(stmt) {
  return t.isExpressionStatement(stmt) ? stmt.expression : null;
}

function isStackPop(node) {
  // 方法调用栈方言: stack.pop()
  return t.isCallExpression(node)
      && t.isMemberExpression(node.callee)
      && isId(node.callee.object, 'stack')
      && isId(node.callee.property, 'pop')
      && node.arguments.length === 0;
}

function isStackPush(stmt) {
  // 方法调用栈方言: stack.push(X); returns the pushed argument node or null
  const e = exprOf(stmt);
  if (!e || !t.isCallExpression(e)) return null;
  if (!t.isMemberExpression(e.callee)) return null;
  if (!isId(e.callee.object, 'stack')) return null;
  if (!isId(e.callee.property, 'push')) return null;
  if (e.arguments.length !== 1) return null;
  return e.arguments[0];
}

// 索引栈方言: stack[sp--] (post-decrement)
function isStackIndexPop(node) {
  return t.isMemberExpression(node)
      && isId(node.object, 'stack')
      && t.isUpdateExpression(node.property)
      && node.property.operator === '--'
      && !node.property.prefix
      && isId(node.property.argument, 'sp');
}

// 索引栈方言: stack[++sp] = X
function isStackIndexPushAssign(expr) {
  if (!t.isAssignmentExpression(expr) || expr.operator !== '=') return null;
  if (!t.isMemberExpression(expr.left)) return null;
  if (!isId(expr.left.object, 'stack')) return null;
  if (!t.isUpdateExpression(expr.left.property)) return null;
  if (expr.left.property.operator !== '++') return null;
  if (!expr.left.property.prefix) return null;
  if (!isId(expr.left.property.argument, 'sp')) return null;
  return expr.right;
}

// 索引栈方言: stack[sp] (top read 或 write)
function isStackTop(node) {
  return t.isMemberExpression(node)
      && isId(node.object, 'stack')
      && isId(node.property, 'sp');
}

// 统一抽象: 任意风格的 pop 表达式
function isPopAny(node) {
  return isStackPop(node) || isStackIndexPop(node);
}

// 把 body 规整成 expression 数组（处理 SequenceExpression）
function flattenExprs(body) {
  const exprs = [];
  for (const stmt of body) {
    const e = exprOf(stmt);
    if (!e) continue;
    if (t.isSequenceExpression(e)) {
      exprs.push(...e.expressions);
    } else {
      exprs.push(e);
    }
  }
  return exprs;
}

function isAssignFrom(stmt, rhsCheck) {
  // tmpN = <rhs that satisfies rhsCheck>; returns left.name or null
  const e = exprOf(stmt);
  if (!e || !t.isAssignmentExpression(e) || e.operator !== '=') return null;
  if (!t.isIdentifier(e.left)) return null;
  if (!rhsCheck(e.right)) return null;
  return e.left.name;
}

function isBytecodeRead(node) {
  // bytecode[pc++]
  return t.isMemberExpression(node)
      && isId(node.object, 'bytecode')
      && t.isUpdateExpression(node.property)
      && node.property.operator === '++'
      && isId(node.property.argument, 'pc');
}

function isConstsRead(node) {
  // consts[X]
  return t.isMemberExpression(node)
      && isId(node.object, 'consts');
}

function isPcAddAssign(stmt) {
  // pc += X
  const e = exprOf(stmt);
  if (!e || !t.isAssignmentExpression(e) || e.operator !== '+=') return null;
  if (!isId(e.left, 'pc')) return null;
  return e.right;
}

// ===========================================================================
// op patterns
// ===========================================================================

// pop-pop-binop-push: tmp = stack.pop(); tmp2 = stack.pop(); tmp = tmp2 OP tmp; stack.push(tmp)
function matchBinaryStackOp(body) {
  if (body.length < 4) return null;

  const var1 = isAssignFrom(body[0], isStackPop);
  if (!var1) return null;
  const var2 = isAssignFrom(body[1], isStackPop);
  if (!var2) return null;

  // step 3: var3 = varA <OP> varB
  const e3 = exprOf(body[2]);
  if (!e3 || !t.isAssignmentExpression(e3) || e3.operator !== '=') return null;
  if (!t.isIdentifier(e3.left)) return null;
  if (!t.isBinaryExpression(e3.right) && !t.isLogicalExpression(e3.right)) return null;
  const op = e3.right.operator;
  // 顺序无关：var2 OP var1 / var1 OP var2 都接受
  const ok = (isId(e3.right.left, var2) && isId(e3.right.right, var1))
          || (isId(e3.right.left, var1) && isId(e3.right.right, var2));
  if (!ok) return null;

  const pushed = isStackPush(body[3]);
  if (!pushed || !isId(pushed, e3.left.name)) return null;

  return op;
}

// pop-unaryOp-push
function matchUnaryStackOp(body) {
  if (body.length !== 2) return null;
  const var1 = isAssignFrom(body[0], isStackPop);
  if (!var1) return null;

  const pushed = isStackPush(body[1]);
  if (!pushed) return null;
  if (t.isUnaryExpression(pushed) && isId(pushed.argument, var1)) {
    return pushed.operator;  // -, !, ~, void, typeof
  }
  return null;
}

// tmp = bytecode[pc++]; stack.push(consts[tmp])   或者   tmp=bytecode[pc++]; tmp=consts[tmp]; stack.push(tmp)
function matchPushConst(body) {
  // form A: 2 stmts
  if (body.length === 2) {
    const v = isAssignFrom(body[0], isBytecodeRead);
    if (!v) return null;
    const pushed = isStackPush(body[1]);
    if (pushed && t.isMemberExpression(pushed) && isId(pushed.object, 'consts')
        && isId(pushed.property, v)) {
      return 'PUSH_CONST';
    }
  }
  // form B: 3 stmts (tmp1=bytecode[pc++]; tmp1=consts[tmp1]; stack.push(tmp1))
  if (body.length === 3) {
    const v = isAssignFrom(body[0], isBytecodeRead);
    if (!v) return null;
    const e2 = exprOf(body[1]);
    if (!e2 || !t.isAssignmentExpression(e2) || !isId(e2.left, v)) return null;
    if (!isConstsRead(e2.right)) return null;
    const pushed = isStackPush(body[2]);
    if (pushed && isId(pushed, v)) return 'PUSH_CONST';
  }
  return null;
}

// tmp = bytecode[pc++]; stack.push(tmp)   → PUSH_IMM (push immediate from bytecode, no consts lookup)
function matchPushImm(body) {
  if (body.length !== 2) return null;
  const v = isAssignFrom(body[0], isBytecodeRead);
  if (!v) return null;
  const pushed = isStackPush(body[1]);
  if (pushed && isId(pushed, v)) return 'PUSH_IMM';
  return null;
}

// 0-arg push: stack.push(<literal/var>) only
function matchPushAtom(body) {
  if (body.length !== 1) return null;
  const pushed = isStackPush(body[0]);
  if (!pushed) return null;
  if (t.isObjectExpression(pushed) && pushed.properties.length === 0) return 'PUSH_NEW_OBJ';
  if (t.isArrayExpression(pushed) && pushed.elements.length === 0) return 'PUSH_NEW_ARR';
  if (isId(pushed, 'thisArg')) return 'PUSH_THIS';
  if (isId(pushed, 'globalThis')) return 'PUSH_GLOBAL_THIS';
  return null;
}

// pc-related (no pop): tmp = bytecode[pc++]; pc += tmp
function matchJmp(body) {
  if (body.length !== 2) return null;
  const v = isAssignFrom(body[0], isBytecodeRead);
  if (!v) return null;
  const pcRhs = isPcAddAssign(body[1]);
  if (pcRhs && isId(pcRhs, v)) return 'JMP';
  return null;
}

// conditional jump: tmp = pop; tmp2 = bytecode[pc++]; if (cond) pc += tmp2
function matchCondJmp(body) {
  if (body.length < 3) return null;
  // 找 pop / bytecode-read / if-pc+= 的组合（允许顺序不严格）
  let popVar = null, immVar = null, ifNode = null;
  for (const stmt of body) {
    if (t.isIfStatement(stmt)) { ifNode = stmt; continue; }
    const e = exprOf(stmt);
    if (!e || !t.isAssignmentExpression(e) || !t.isIdentifier(e.left)) continue;
    if (isStackPop(e.right)) popVar = e.left.name;
    else if (isBytecodeRead(e.right)) immVar = e.left.name;
  }
  if (!popVar || !immVar || !ifNode) return null;

  // test 是 popVar 或 !popVar
  let isNegated = false;
  if (t.isIdentifier(ifNode.test) && ifNode.test.name === popVar) {
    isNegated = false;
  } else if (t.isUnaryExpression(ifNode.test) && ifNode.test.operator === '!'
             && isId(ifNode.test.argument, popVar)) {
    isNegated = true;
  } else {
    return null;
  }
  // consequent: pc += immVar
  const conseq = t.isBlockStatement(ifNode.consequent) ? ifNode.consequent.body[0] : ifNode.consequent;
  const pcRhs = isPcAddAssign(conseq);
  if (!pcRhs || !isId(pcRhs, immVar)) return null;

  return isNegated ? 'JNF' : 'JIF';
}

// throw: tmp = stack.pop(); throw tmp
function matchThrow(body) {
  if (body.length !== 2) return null;
  const v = isAssignFrom(body[0], isStackPop);
  if (!v) return null;
  if (!t.isThrowStatement(body[1])) return null;
  if (!isId(body[1].argument, v)) return null;
  return 'THROW';
}

function matchReturn(body) {
  if (body.length === 1 && t.isReturnStatement(body[0])) return 'RETURN';
  return null;
}

// debugger
function matchDebugger(body) {
  if (body.length === 1 && t.isDebuggerStatement(body[0])) return 'DEBUGGER';
  return null;
}

// set-prop: tmp1 = bytecode[pc++]; tmp3 = stack.pop(); tmp2 = stack.pop(); tmp2[consts[tmp1]] = tmp3
function matchSetPropConst(body) {
  if (body.length !== 4) return null;
  const immVar = isAssignFrom(body[0], isBytecodeRead);
  if (!immVar) return null;
  const valVar = isAssignFrom(body[1], isStackPop);
  if (!valVar) return null;
  const objVar = isAssignFrom(body[2], isStackPop);
  if (!objVar) return null;
  // tmp2[consts[tmp1]] = tmp3
  const e4 = exprOf(body[3]);
  if (!e4 || !t.isAssignmentExpression(e4) || e4.operator !== '=') return null;
  if (!t.isMemberExpression(e4.left)) return null;
  if (!isId(e4.left.object, objVar)) return null;
  if (!t.isMemberExpression(e4.left.property)) return null;  // consts[immVar]
  if (!isId(e4.left.property.object, 'consts')) return null;
  if (!isId(e4.left.property.property, immVar)) return null;
  if (!isId(e4.right, valVar)) return null;
  return 'SET_PROP_CONST';
}

// get-prop dynamic: tmp1 = pop; tmp2 = pop; push(tmp2[tmp1])
function matchGetPropDynamic(body) {
  if (body.length !== 3) return null;
  const v1 = isAssignFrom(body[0], isStackPop);
  if (!v1) return null;
  const v2 = isAssignFrom(body[1], isStackPop);
  if (!v2) return null;
  const pushed = isStackPush(body[2]);
  if (!pushed || !t.isMemberExpression(pushed)) return null;
  if (!isId(pushed.object, v2) || !isId(pushed.property, v1)) return null;
  return 'GET_PROP_DYNAMIC';
}

// POP_DISCARD: tmp = stack.pop()  (single stmt，丢弃栈顶)
function matchPopDiscard(body) {
  if (body.length !== 1) return null;
  return isAssignFrom(body[0], isStackPop) ? 'POP_DISCARD' : null;
}

// LOAD_THIS (方法调用栈方言): acc = thisArg; stack.push(thisArg)
function matchLoadThis(body) {
  if (body.length !== 2) return null;
  const e1 = exprOf(body[0]);
  if (!e1 || !t.isAssignmentExpression(e1) || e1.operator !== '=') return null;
  if (!isId(e1.left, 'acc') || !isId(e1.right, 'thisArg')) return null;
  const pushed = isStackPush(body[1]);
  if (pushed && isId(pushed, 'thisArg')) return 'LOAD_THIS';
  return null;
}

// SET_PROP_CONST 宽松版: tmp1=bytecode[pc++]; tmp2=pop; tmp3=pop; <var>[consts[tmp1]]=<var>
function matchSetPropConstLoose(body) {
  if (body.length !== 4) return null;
  const immVar = isAssignFrom(body[0], isBytecodeRead);
  if (!immVar) return null;
  const v1 = isAssignFrom(body[1], isStackPop);
  if (!v1) return null;
  const v2 = isAssignFrom(body[2], isStackPop);
  if (!v2) return null;
  const e4 = exprOf(body[3]);
  if (!e4 || !t.isAssignmentExpression(e4) || e4.operator !== '=') return null;
  if (!t.isMemberExpression(e4.left)) return null;
  if (!t.isMemberExpression(e4.left.property)) return null;
  if (!isId(e4.left.property.object, 'consts')) return null;
  if (!isId(e4.left.property.property, immVar)) return null;
  return 'SET_PROP_CONST';
}

// ARRAY_PUSH (case 40): tmp1=pop; tmp2=pop; tmp2.push(tmp1); stack.push(tmp2)
function matchArrayPush(body) {
  if (body.length !== 4) return null;
  const v1 = isAssignFrom(body[0], isStackPop);
  if (!v1) return null;
  const v2 = isAssignFrom(body[1], isStackPop);
  if (!v2) return null;
  // var2.push(var1)
  const e3 = exprOf(body[2]);
  if (!e3 || !t.isCallExpression(e3)) return null;
  if (!t.isMemberExpression(e3.callee)) return null;
  if (!isId(e3.callee.object, v2) || !isId(e3.callee.property, 'push')) return null;
  if (e3.arguments.length !== 1 || !isId(e3.arguments[0], v1)) return null;
  // stack.push(var2)
  const pushed = isStackPush(body[3]);
  if (!pushed || !isId(pushed, v2)) return null;
  return 'ARRAY_PUSH';
}

// INC/DEC PROP_CONST (case 26/52): tmp1=pop; tmp3=bytecode[pc++]; tmp1[consts[tmp3]] +=/-=  1
function matchIncDecPropConst(body) {
  if (body.length !== 3) return null;
  const v1 = isAssignFrom(body[0], isStackPop);
  if (!v1) return null;
  const immVar = isAssignFrom(body[1], isBytecodeRead);
  if (!immVar) return null;
  const e3 = exprOf(body[2]);
  if (!e3 || !t.isAssignmentExpression(e3)) return null;
  if (e3.operator !== '+=' && e3.operator !== '-=') return null;
  if (!t.isMemberExpression(e3.left)) return null;
  if (!isId(e3.left.object, v1)) return null;
  if (!t.isMemberExpression(e3.left.property)) return null;
  if (!isId(e3.left.property.object, 'consts')) return null;
  if (!isId(e3.left.property.property, immVar)) return null;
  if (!t.isNumericLiteral(e3.right) || e3.right.value !== 1) return null;
  return e3.operator === '+=' ? 'INC_PROP_CONST' : 'DEC_PROP_CONST';
}

// DELETE: tmp1=pop; tmp2=pop; tmp3=delete tmp2[tmp1]; stack.push(tmp3)
function matchDelete(body) {
  if (body.length !== 4) return null;
  const v1 = isAssignFrom(body[0], isStackPop);
  if (!v1) return null;
  const v2 = isAssignFrom(body[1], isStackPop);
  if (!v2) return null;
  const v3 = isAssignFrom(body[2], (rhs) =>
    t.isUnaryExpression(rhs) && rhs.operator === 'delete'
    && t.isMemberExpression(rhs.argument)
    && isId(rhs.argument.object, v2)
    && isId(rhs.argument.property, v1));
  if (!v3) return null;
  const pushed = isStackPush(body[3]);
  return (pushed && isId(pushed, v3)) ? 'DELETE_PROP' : null;
}

// NEW_REGEXP: tmp1=bytecode[pc++]; tmp2=bytecode[pc++]; tmp1=new RegExp(consts[tmp1], consts[tmp2]); push(tmp1)
function matchNewRegExp(body) {
  if (body.length !== 4) return null;
  const v1 = isAssignFrom(body[0], isBytecodeRead);
  if (!v1) return null;
  const v2 = isAssignFrom(body[1], isBytecodeRead);
  if (!v2) return null;
  const e3 = exprOf(body[2]);
  if (!e3 || !t.isAssignmentExpression(e3)) return null;
  if (!t.isNewExpression(e3.right)) return null;
  if (!isId(e3.right.callee, 'RegExp')) return null;
  const pushed = isStackPush(body[3]);
  return pushed ? 'NEW_REGEXP' : null;
}

// CALL_N_ARGS (case 46/150): tmp1=bytecode[pc++]; tmp3=pop; args=[]; for{...args.splice(0,0,pop)...}; ...; push(result)
function matchCallN(body) {
  // 启发式：含 bytecode 读 + stack.pop + for 循环 + args 操作 + 调用 / push
  let hasBytecodeRead = false;
  let hasFor = false;
  let hasArgsSplice = false;
  let hasFunctionCall = false;
  for (const stmt of body) {
    if (t.isForStatement(stmt)) hasFor = true;
    const e = exprOf(stmt);
    if (e && t.isAssignmentExpression(e) && isBytecodeRead(e.right)) hasBytecodeRead = true;
    // walk traverse 找 args.splice / .apply / .call
    traverse({ type: 'File', program: { type: 'Program', body: [stmt], sourceType: 'script' }, errors: [] }, {
      noScope: true,
      CallExpression(p) {
        if (t.isMemberExpression(p.node.callee)) {
          if (isId(p.node.callee.property, 'splice')) hasArgsSplice = true;
          if (isId(p.node.callee.property, 'apply') || isId(p.node.callee.property, 'call'))
            hasFunctionCall = true;
        }
      }
    });
  }
  if (hasBytecodeRead && hasFor && hasArgsSplice && hasFunctionCall) {
    return 'CALL_N_ARGS';
  }
  return null;
}

// in operator: stack.push(tmp2 in tmp1) - 已被 matchBinaryStackOp 处理（in 是 BinaryExpression op="in"）

// ===========================================================================
// 主 detectPattern
// ===========================================================================
const BINOP_NAMES = {
  '+': 'ADD', '-': 'SUB', '*': 'MUL', '/': 'DIV', '%': 'MOD',
  '<': 'LT', '>': 'GT', '<=': 'LE', '>=': 'GE',
  '==': 'EQ', '!=': 'NE', '===': 'SEQ', '!==': 'SNE',
  '&': 'BAND', '|': 'BOR', '^': 'XOR',
  '<<': 'SHL', '>>': 'SHR', '>>>': 'USHR',
  '**': 'POW',
  'in': 'IN', 'instanceof': 'INSTANCEOF',
  '&&': 'LAND', '||': 'LOR',
};
const UNOP_NAMES = {
  '-': 'NEG', '!': 'NOT', '~': 'BNOT', 'void': 'VOID', 'typeof': 'TYPEOF', '+': 'PLUS',
};

// ===========================================================================
// 索引栈方言 patterns（stack[sp--] / stack[++sp]= / stack[sp]= 风格）
// ===========================================================================

// 索引栈 binary op: { tmpA = stack[sp--], stack[sp] = stack[sp] OP tmpA }
//                     或 { tmpA = stack[sp--]; stack[sp] = stack[sp] OP tmpA; }
function matchIdxStackBinaryOp(body) {
  const exprs = flattenExprs(body);
  if (exprs.length !== 2) return null;
  // 第 1: tmpA = stack[sp--]
  const a1 = exprs[0];
  if (!t.isAssignmentExpression(a1) || a1.operator !== '=') return null;
  if (!t.isIdentifier(a1.left)) return null;
  if (!isStackIndexPop(a1.right)) return null;
  const tmpName = a1.left.name;
  // 第 2: stack[sp] = stack[sp] OP tmpA
  const a2 = exprs[1];
  if (!t.isAssignmentExpression(a2) || a2.operator !== '=') return null;
  if (!isStackTop(a2.left)) return null;
  if (!t.isBinaryExpression(a2.right) && !t.isLogicalExpression(a2.right)) return null;
  if (!isStackTop(a2.right.left)) return null;
  if (!isId(a2.right.right, tmpName)) return null;
  return a2.right.operator;
}

// 索引栈 push atom: stack[++sp] = LITERAL or thisArg etc.
function matchIdxStackPushAtom(body) {
  if (body.length !== 1) return null;
  const e = exprOf(body[0]);
  if (!e) return null;
  const pushed = isStackIndexPushAssign(e);
  if (!pushed) return null;
  if (t.isNullLiteral(pushed)) return 'PUSH_NULL';
  if (t.isUnaryExpression(pushed) && pushed.operator === 'void') return 'PUSH_UNDEFINED';
  if (t.isNumericLiteral(pushed)) return `PUSH_NUM(${pushed.value})`;
  if (t.isStringLiteral(pushed)) return 'PUSH_STR';
  if (isId(pushed, 'thisArg')) return 'PUSH_THIS';
  if (isId(pushed, 'globalThis')) return 'PUSH_GLOBAL_THIS';
  if (t.isUnaryExpression(pushed) && pushed.operator === '!') return 'PUSH_BOOL';
  if (t.isIdentifier(pushed)) return `PUSH_VAR_${pushed.name}`;
  return null;
}

// 索引栈 unary op: { tmpA = stack[sp--]; stack[sp] = OP tmpA }
//                    或 { stack[sp] = OP stack[sp] }
function matchIdxStackUnaryOp(body) {
  const exprs = flattenExprs(body);

  // form A: 2 exprs
  if (exprs.length === 2) {
    const a1 = exprs[0];
    if (!t.isAssignmentExpression(a1) || !t.isIdentifier(a1.left)) return null;
    if (!isStackIndexPop(a1.right)) return null;
    const tmpName = a1.left.name;
    const a2 = exprs[1];
    if (!t.isAssignmentExpression(a2) || !isStackTop(a2.left)) return null;
    if (!t.isUnaryExpression(a2.right)) return null;
    if (!isId(a2.right.argument, tmpName)) return null;
    return a2.right.operator;
  }
  // form B: 1 expr - stack[sp] = !stack[sp]
  if (exprs.length === 1) {
    const a = exprs[0];
    if (!t.isAssignmentExpression(a) || !isStackTop(a.left)) return null;
    if (!t.isUnaryExpression(a.right)) return null;
    if (!isStackTop(a.right.argument)) return null;
    return a.right.operator;
  }
  return null;
}

// 索引栈 throw: throw stack[sp--]
function matchIdxStackThrow(body) {
  if (body.length !== 1) return null;
  if (!t.isThrowStatement(body[0])) return null;
  if (!isStackIndexPop(body[0].argument)) return null;
  return 'THROW';
}

// helpers for advanced 索引栈 matchers
function isHelperCallWithBytecodePc(node) {
  return t.isCallExpression(node)
      && t.isIdentifier(node.callee)
      && node.arguments.length === 2
      && isId(node.arguments[0], 'bytecode')
      && isId(node.arguments[1], 'pc');
}
function isPcAdd(expr) {
  return t.isAssignmentExpression(expr) && expr.operator === '+=' && isId(expr.left, 'pc');
}

// JMP_REL: { pc += N }
function matchIdxStackJmpRel(body) {
  const exprs = flattenExprs(body);
  if (exprs.length !== 1) return null;
  return isPcAdd(exprs[0]) ? 'JMP_REL' : null;
}

// DUP: tmpA = stack[sp]; stack[++sp] = tmpA
function matchIdxStackDup(body) {
  const exprs = flattenExprs(body);
  if (exprs.length !== 2) return null;
  const a1 = exprs[0];
  if (!t.isAssignmentExpression(a1) || !t.isIdentifier(a1.left)) return null;
  if (!isStackTop(a1.right)) return null;
  const v = a1.left.name;
  const pushed = isStackIndexPushAssign(exprs[1]);
  return (pushed && isId(pushed, v)) ? 'DUP' : null;
}

// PRE_INC_TOS: stack[sp] = ++stack[sp]
function matchIdxStackPreIncTos(body) {
  if (body.length !== 1) return null;
  const e = exprOf(body[0]);
  if (!e || !t.isAssignmentExpression(e) || !isStackTop(e.left)) return null;
  if (!t.isUpdateExpression(e.right) || e.right.operator !== '++' || !e.right.prefix) return null;
  return isStackTop(e.right.argument) ? 'PRE_INC_TOS' : null;
}

// DELETE_PROP: tmpB = stack[sp--], tmpA = delete stack[sp--][tmpB]
function matchIdxStackDeleteProp(body) {
  const exprs = flattenExprs(body);
  if (exprs.length !== 2) return null;
  const a1 = exprs[0];
  if (!t.isAssignmentExpression(a1) || !t.isIdentifier(a1.left)) return null;
  if (!isStackIndexPop(a1.right)) return null;
  const keyVar = a1.left.name;
  const a2 = exprs[1];
  if (!t.isAssignmentExpression(a2) || !t.isIdentifier(a2.left)) return null;
  if (!t.isUnaryExpression(a2.right) || a2.right.operator !== 'delete') return null;
  const arg = a2.right.argument;
  if (!t.isMemberExpression(arg)) return null;
  if (!isStackIndexPop(arg.object)) return null;
  return isId(arg.property, keyVar) ? 'DELETE_PROP' : null;
}

// LOAD_PARAM4: tmpD = helper(bytecode, pc), pc += K, tmpA = param4[tmpD], stack[++sp] = tmpA
function matchIdxStackLoadParam4(body) {
  const exprs = flattenExprs(body);
  if (exprs.length !== 4) return null;
  const a1 = exprs[0];
  if (!t.isAssignmentExpression(a1) || !t.isIdentifier(a1.left) || !isHelperCallWithBytecodePc(a1.right)) return null;
  const idxVar = a1.left.name;
  if (!isPcAdd(exprs[1])) return null;
  const a3 = exprs[2];
  if (!t.isAssignmentExpression(a3) || !t.isIdentifier(a3.left)) return null;
  if (!t.isMemberExpression(a3.right) || !isId(a3.right.object, 'param4') || !isId(a3.right.property, idxVar)) return null;
  const valVar = a3.left.name;
  const pushed = isStackIndexPushAssign(exprs[3]);
  return (pushed && isId(pushed, valVar)) ? 'LOAD_PARAM4' : null;
}

// STORE_PARAM4: tmpD = helper(bytecode, pc), pc += K, tmpA = stack[sp--], param4[tmpD] = tmpA
function matchIdxStackStoreParam4(body) {
  const exprs = flattenExprs(body);
  if (exprs.length !== 4) return null;
  const a1 = exprs[0];
  if (!t.isAssignmentExpression(a1) || !t.isIdentifier(a1.left) || !isHelperCallWithBytecodePc(a1.right)) return null;
  const idxVar = a1.left.name;
  if (!isPcAdd(exprs[1])) return null;
  const a3 = exprs[2];
  if (!t.isAssignmentExpression(a3) || !t.isIdentifier(a3.left) || !isStackIndexPop(a3.right)) return null;
  const valVar = a3.left.name;
  const a4 = exprs[3];
  if (!t.isAssignmentExpression(a4) || a4.operator !== '=' || !t.isMemberExpression(a4.left)) return null;
  if (!isId(a4.left.object, 'param4') || !isId(a4.left.property, idxVar)) return null;
  return isId(a4.right, valVar) ? 'STORE_PARAM4' : null;
}

// PUSH_HELPER_RESULT: stack[++sp] = helper(bytecode, pc), pc += K
function matchIdxStackPushHelperResult(body) {
  const exprs = flattenExprs(body);
  if (exprs.length !== 2) return null;
  const pushed = isStackIndexPushAssign(exprs[0]);
  if (!pushed || !isHelperCallWithBytecodePc(pushed)) return null;
  return isPcAdd(exprs[1]) ? 'PUSH_HELPER_RESULT' : null;
}

// GET_PROP_BY_CONST: tmpD = helper(bytecode, pc), pc += K, stack[sp] = stack[sp][tmpD]
function matchIdxStackGetPropByConst(body) {
  const exprs = flattenExprs(body);
  if (exprs.length !== 3) return null;
  const a1 = exprs[0];
  if (!t.isAssignmentExpression(a1) || !t.isIdentifier(a1.left) || !isHelperCallWithBytecodePc(a1.right)) return null;
  const idxVar = a1.left.name;
  if (!isPcAdd(exprs[1])) return null;
  const a3 = exprs[2];
  if (!t.isAssignmentExpression(a3) || !isStackTop(a3.left) || !t.isMemberExpression(a3.right)) return null;
  if (!isStackTop(a3.right.object) || !isId(a3.right.property, idxVar)) return null;
  return 'GET_PROP_BY_CONST';
}

// TAIL_CALL_DISPATCHER: modeFlag = N, dispatcher_entry(bytecode, initPc, ...), pc += M
function matchIdxStackTailCall(body) {
  const exprs = flattenExprs(body);
  if (exprs.length !== 3) return null;
  const a1 = exprs[0];
  if (!t.isAssignmentExpression(a1) || a1.operator !== '=' || !isId(a1.left, 'modeFlag')) return null;
  const a2 = exprs[1];
  if (!t.isCallExpression(a2) || !isId(a2.callee, 'dispatcher_entry')) return null;
  return isPcAdd(exprs[2]) ? 'TAIL_CALL_DISPATCHER' : null;
}

function detectPattern(body) {
  // unwrap single block
  let stmts = body;
  if (stmts.length === 1 && t.isBlockStatement(stmts[0])) stmts = stmts[0].body;

  let m;

  // === 索引栈方言 先试（更广泛）===
  m = matchIdxStackThrow(stmts); if (m) return m;
  m = matchIdxStackBinaryOp(stmts);
  if (m) return BINOP_NAMES[m] || `BINOP_${m}`;
  m = matchIdxStackUnaryOp(stmts);
  if (m) return UNOP_NAMES[m] || `UNOP_${m}`;
  m = matchIdxStackPushAtom(stmts); if (m) return m;
  m = matchIdxStackJmpRel(stmts); if (m) return m;
  m = matchIdxStackDup(stmts); if (m) return m;
  m = matchIdxStackPreIncTos(stmts); if (m) return m;
  m = matchIdxStackDeleteProp(stmts); if (m) return m;
  m = matchIdxStackLoadParam4(stmts); if (m) return m;
  m = matchIdxStackStoreParam4(stmts); if (m) return m;
  m = matchIdxStackPushHelperResult(stmts); if (m) return m;
  m = matchIdxStackGetPropByConst(stmts); if (m) return m;
  m = matchIdxStackTailCall(stmts); if (m) return m;

  // === 方法调用栈方言 ===

  m = matchReturn(stmts); if (m) return m;
  m = matchDebugger(stmts); if (m) return m;
  m = matchThrow(stmts); if (m) return m;

  m = matchBinaryStackOp(stmts);
  if (m) return BINOP_NAMES[m] || `BINOP_${m}`;

  m = matchUnaryStackOp(stmts);
  if (m) return UNOP_NAMES[m] || `UNOP_${m}`;

  m = matchPushAtom(stmts); if (m) return m;
  m = matchPushConst(stmts); if (m) return m;
  m = matchPushImm(stmts); if (m) return m;

  m = matchJmp(stmts); if (m) return m;
  m = matchCondJmp(stmts); if (m) return m;

  m = matchSetPropConst(stmts); if (m) return m;
  m = matchSetPropConstLoose(stmts); if (m) return m;
  m = matchGetPropDynamic(stmts); if (m) return m;

  m = matchLoadThis(stmts); if (m) return m;
  m = matchPopDiscard(stmts); if (m) return m;
  m = matchArrayPush(stmts); if (m) return m;
  m = matchIncDecPropConst(stmts); if (m) return m;
  m = matchDelete(stmts); if (m) return m;
  m = matchNewRegExp(stmts); if (m) return m;
  m = matchCallN(stmts); if (m) return m;

  return 'UNKNOWN';
}

// ===========================================================================
// 主流程
// ===========================================================================
function splitDispatcher(filePath, outputPath, options = {}) {
  console.log(`[*] Loading: ${filePath}`);
  const ast = loadDispatcher(filePath);

  let mode, cases;
  let dispatcherRoot = null;  // 给 autoDetectRegisters 用
  let fnParams = [];          // dispatcher 函数形参名（bytecode 强先验）
  let dispatchLoop = null;    // 主分发循环（给 extractDecodeFormula 用）
  let dispatchSwitch = null;  // 主分发 switch 节点（switch 模式时，给 decode 锚定）

  // 工具：从一个 loop 节点提取 cases（switch 或 decision tree）
  const casesFromLoop = (loop, knownSwitch) => {
    const sw = knownSwitch || (loop.body && loop.body.body && loop.body.body.find(s => t.isSwitchStatement(s)));
    if (sw && sw.cases.length >= 5) {
      dispatchSwitch = sw;
      mode = 'switch';
      cases = extractCases(sw).filter(c => !c.isDefault);
      console.log(`[*] Mode: switch (${cases.length} cases)`);
    } else {
      mode = 'tree';
      const leaves = extractDecisionTreeLeaves(loop.body);
      cases = leaves.map(l => ({ value: l.path, body: l.body, isDefault: false }));
      console.log(`[*] Mode: decision_tree (${cases.length} leaves)`);
    }
  };

  if (options.col != null) {
    // 显式 --col 覆盖（调试 / 自动检测失败时兜底）
    const fn = findDispatcherByCol(ast, options.col);
    if (!fn) throw new Error(`No function at col ${options.col}`);
    console.log(`[*] (--col override) dispatcher fn ${fn.id?.name} at col ${fn.loc.start.column}`);
    dispatcherRoot = fn;
    fnParams = (fn.params || []).map(p => (t.isIdentifier(p) ? p.name : null)).filter(Boolean);
    const loop = findDispatchLoopInFn(fn);
    if (!loop) throw new Error('No dispatch loop in function');
    dispatchLoop = loop;
    casesFromLoop(loop);
  } else {
    // 【通用】自动检测，无需人工 col。先试经典 while+switch，再用打分法（覆盖决策树）。
    const wsFound = findDispatcherWhile(ast);
    if (wsFound) {
      dispatcherRoot = wsFound.whilePath.node;
      dispatchLoop = wsFound.whilePath.node;
      const fp = wsFound.whilePath.getFunctionParent && wsFound.whilePath.getFunctionParent();
      if (fp && fp.node && fp.node.params) fnParams = fp.node.params.map(p => (t.isIdentifier(p) ? p.name : null)).filter(Boolean);
      console.log(`[*] 自动检测 dispatcher: while+switch @ line ${wsFound.whilePath.node.loc?.start.line}`);
      casesFromLoop(wsFound.whilePath.node, wsFound.switchNode);
    } else {
      const auto = findDispatcherAuto(ast);
      if (!auto) throw new Error('Could not auto-detect dispatcher (try --col=N as fallback)');
      dispatcherRoot = auto.loop;
      dispatchLoop = auto.loop;
      fnParams = auto.fnParams;
      const L = auto.loc?.start;
      console.log(`[*] 自动检测 dispatcher: ${auto.mode} 循环 @ line ${L?.line} col ${L?.column} `
        + `(score=${auto.score}, stack-ops=${auto.stats.stackUpdates}, 分支=${auto.stats.branchNodes}, switch-cases=${auto.stats.switchCases})`);
      casesFromLoop(auto.loop, auto.switchNode);
    }
  }

  // 【通用】自动识别虚拟寄存器（不写死任何站点变量名）
  const detected = autoDetectRegisters(dispatcherRoot, fnParams);
  const renameMap = buildRenameMap(detected);
  console.log(`[*] 自动识别寄存器:`);
  console.log(`      stack    = ${detected.stack || '(未识别)'}`);
  console.log(`      sp       = ${detected.sp || '(未识别)'}`);
  console.log(`      pc       = ${detected.pc || '(未识别)'}`);
  console.log(`      bytecode = ${detected.bytecode || '(未识别)'}`);
  console.log(`      consts   = ${detected.consts || '(未识别)'}`);
  console.log(`      thisArg  = ${detected.thisArg || '(未识别)'}`);

  // 【通用】提取 decode 公式（byte→opcode 变换，给 disassemble.js 复刻用）
  let decode = null;
  if (dispatchLoop && t.isBlockStatement(dispatchLoop.body)) {
    const df = extractDecodeFormula(dispatchLoop.body, dispatchSwitch);
    if (df) {
      const preSrc = df.preamble.length
        ? generator(t.blockStatement(foldConstants(renameRegisters(df.preamble, renameMap))), { compact: false }).code
        : '';
      const branchSrc = df.branchOn
        ? generator(foldConstants(renameNode(df.branchOn, renameMap))[0].expression, { compact: true }).code
        : null;
      decode = { branch_type: df.branchType, preamble: preSrc, branch_on: branchSrc };
      console.log(`[*] decode 公式 (branch=${df.branchType}): dispatch on  ${branchSrc}`);
    }
  }

  // Process each case
  const handlers = {};
  let identified = 0;
  const pcName = 'pc';  // 统一在「已重命名」body 上数 pc 推进，规范名恒为 pc
  for (const c of cases) {
    const renamedBody = renameRegisters(c.body, renameMap);
    const name = detectPattern(renamedBody);
    if (name !== 'UNKNOWN') identified++;

    // 操作数字节数（pc 推进量）：减去 decode preamble 自身的推进后，handler 内额外读的就是操作数
    const pcd = countPcDelta(renamedBody, pcName);

    handlers[String(c.value)] = {
      op_key: c.value,
      mode,
      inferred_name: name,
      operand_units: pcd.hasJump ? null : pcd.delta,   // null = 含跳转(JMP/abs)，线性反汇编特殊处理
      jump_operand_units: pcd.hasJump ? pcd.delta : null, // 跳转指令自身读的操作数字节数(pc++ 部分)
      has_jump: pcd.hasJump,
      jump_kind: pcd.jumpKind,                          // 'abs'(pc=X) | 'rel'(pc+=var) | null
      jump_cond: pcd.jumpCond,                           // true=条件跳转(在 if/三元内) → 有 fallthrough
      jump_target_expr: pcd.jumpExpr,                   // pc 赋值 RHS(folded)，disassemble 用它解目标
      is_return: /\breturn\b/.test(generator(t.blockStatement(renamedBody), { compact: true }).code),
      source: generator(t.blockStatement(renamedBody), { compact: false }).code,
    };
  }

  // 【通用】byte→opcode 解码表（给 disassemble.js 做静态反汇编）
  let decodeTable = null, bytecodeStyle = null;
  if (dispatchLoop && t.isBlockStatement(dispatchLoop.body)) {
    const renamedLoopBody = renameRegisters([dispatchLoop.body], renameMap)[0];
    const dt = buildDecodeTable(mode, renamedLoopBody, dispatchSwitch, null, renameMap, detected);
    if (dt && dt.byteToOp) {
      decodeTable = dt.byteToOp;
      bytecodeStyle = dt.usesParseInt ? 'hex-string' : 'array';
      console.log(`[*] decode 表: byte→op 映射 ${dt.stats.mapped}/256 (err=${dt.stats.errors}, null=${dt.stats.nulls}, ${bytecodeStyle} 风格)`);
    } else if (dt && dt.error) {
      console.log(`[!] decode 表构建失败: ${dt.error}`);
    }
  }
  // decode preamble 自身 pc 推进（每条 op 的基础消耗）
  let baseAdvance = 0;
  if (dispatchLoop && t.isBlockStatement(dispatchLoop.body)) {
    const df2 = extractDecodeFormula(dispatchLoop.body, dispatchSwitch);
    if (df2) baseAdvance = countPcDelta(renameRegisters(df2.preamble, renameMap), pcName).delta;
  }

  const output = {
    _meta: {
      source: filePath,
      mode,
      total_cases: cases.length,
      identified,
      unknown: cases.length - identified,
      identified_pct: (100 * identified / cases.length).toFixed(1) + '%',
      detected_registers: detected,
      rename_map: renameMap,
      decode_formula: decode,
      base_advance: baseAdvance,   // 每条 opcode 解码自身消耗的字节(操作数从此之后算)
      bytecode_style: bytecodeStyle, // hex-string(parseInt 2 hex/单元) | array(数组下标)
      decode_table: decodeTable,   // byte(0..255) → op_key（静态反汇编用）
      generated_at: new Date().toISOString(),
    },
    handlers,
  };

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

  // ========== 控制台报告 ==========
  console.log(`[*] Wrote: ${outputPath}`);
  const total = cases.length;
  console.log(`\n=== 命中 (${identified}/${total} = ${output._meta.identified_pct}) ===`);
  for (const [opKey, h] of Object.entries(handlers)) {
    if (h.inferred_name !== 'UNKNOWN') {
      console.log(`  ${opKey.padStart(8)}: ${h.inferred_name}`);
    }
  }
  console.log(`\n=== UNKNOWN (${total - identified}) - 需要 LLM 命名或补 pattern ===`);
  for (const [opKey, h] of Object.entries(handlers)) {
    if (h.inferred_name === 'UNKNOWN') {
      const preview = h.source.replace(/\s+/g, ' ').slice(0, 130);
      console.log(`  ${opKey.padStart(8)}: ${preview}`);
    }
  }
}

// ===========================================================================
// CLI
// ===========================================================================
// 用法:
//   node dispatcher_split.js <input.js> <output.json> [--col=N]
//   默认：自动检测 dispatcher（while+switch 或打分法决策树），无需 --col
//   --col=N  可选覆盖：当自动检测失败时，按 column 偏移强制指定 dispatcher 函数
const args = process.argv.slice(2);
const inputFile = args[0] || '/tmp/dispatcher.js';
const outputFile = args[1] || 'handlers.json';
const colArg = args.find(a => a.startsWith('--col='));
const col = colArg ? parseInt(colArg.split('=')[1], 10) : null;

try {
  splitDispatcher(inputFile, outputFile, { col });
} catch (e) {
  console.error('FATAL:', e.message);
  console.error(e.stack);
  process.exit(1);
}

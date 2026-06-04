/* AST 结构速查：parse 一个 JS 文件，定位 dispatcher 函数并打印其分发循环结构。
 * 用法: node inspect_ast.js <file.js> [targetCol] [targetLine]
 *   - 给 targetCol：定位该列附近的函数（dispatcher 入口）
 *   - 不给：自动找第一个含 while/switch(或 if) 分发循环的最大函数
 */
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const fs = require('fs');

const file = process.argv[2];
if (!file) {
  console.error('用法: node inspect_ast.js <file.js> [targetCol] [targetLine]');
  process.exit(1);
}
const targetCol = process.argv[3] != null ? parseInt(process.argv[3], 10) : null;
const targetLine = process.argv[4] != null ? parseInt(process.argv[4], 10) : null;

const src = fs.readFileSync(file, 'utf8');
console.log(`Source size: ${src.length} bytes`);

const ast = parser.parse(src, { sourceType: 'script', errorRecovery: true });
console.log(`Parse OK`);

let dispatcherFn = null;
if (targetCol != null) {
  traverse(ast, {
    FunctionDeclaration(path) {
      const loc = path.node.loc;
      if (loc && (targetLine == null || loc.start.line === targetLine)
          && Math.abs(loc.start.column - targetCol) <= 40) {
        dispatcherFn = path.node;
        console.log(`Found function ${path.node.id?.name} at line ${loc.start.line} col ${loc.start.column}`);
        path.stop();
      }
    },
  });
}
if (!dispatcherFn) {
  // 自动找含 while/for + switch/if 分发循环的最大函数
  let best = null, bestSize = 0;
  traverse(ast, {
    FunctionDeclaration(path) {
      let hasLoop = false;
      path.traverse({
        'WhileStatement|ForStatement'(p) {
          if (p.node.body && t.isBlockStatement(p.node.body)
              && p.node.body.body.some(s => t.isSwitchStatement(s) || t.isIfStatement(s))) hasLoop = true;
        },
      });
      if (hasLoop) {
        const size = (path.node.end || 0) - (path.node.start || 0);
        if (size > bestSize) { bestSize = size; best = path.node; }
      }
    },
  });
  dispatcherFn = best;
  if (dispatcherFn) {
    console.log(`Auto-detected dispatcher: ${dispatcherFn.id?.name} at col ${dispatcherFn.loc?.start?.column} (size ${bestSize})`);
  }
}

if (!dispatcherFn) {
  console.log('No dispatcher function found');
  process.exit(1);
}

console.log(`\n=== ${dispatcherFn.id?.name} ===`);
console.log(`Params (${dispatcherFn.params.length}): ${dispatcherFn.params.map(p => p.name).join(', ')}`);
console.log(`Body stmts: ${dispatcherFn.body.body.length}`);

function nodeStr(node) {
  if (!node) return '?';
  if (t.isIdentifier(node)) return node.name;
  if (t.isNumericLiteral(node)) return String(node.value);
  if (t.isStringLiteral(node)) return JSON.stringify(node.value);
  if (t.isBinaryExpression(node)) return `(${nodeStr(node.left)} ${node.operator} ${nodeStr(node.right)})`;
  if (t.isLogicalExpression(node)) return `(${nodeStr(node.left)} ${node.operator} ${nodeStr(node.right)})`;
  if (t.isAssignmentExpression(node)) return `${nodeStr(node.left)}${node.operator}${nodeStr(node.right)}`;
  if (t.isUpdateExpression(node)) return `${node.prefix?node.operator:''}${nodeStr(node.argument)}${node.prefix?'':node.operator}`;
  if (t.isMemberExpression(node)) return `${nodeStr(node.object)}[${nodeStr(node.property)}]`;
  if (t.isCallExpression(node)) return `${nodeStr(node.callee)}(...)`;
  if (t.isUnaryExpression(node)) return `${node.operator}${nodeStr(node.argument)}`;
  if (t.isSequenceExpression(node)) return `(${node.expressions.map(nodeStr).join(',')})`;
  if (t.isConditionalExpression(node)) return `${nodeStr(node.test)}?...:...`;
  return node.type;
}

function describe(node, depth = 0, maxDepth = 8) {
  if (!node) return '';
  if (depth > maxDepth) return `${'  '.repeat(depth)}...(more nested)\n`;
  const pad = '  '.repeat(depth);
  if (t.isIfStatement(node)) {
    let s = `${pad}IF (${nodeStr(node.test)}) {\n`;
    s += describe(node.consequent, depth + 1, maxDepth);
    if (node.alternate) {
      s += `${pad}} ELSE {\n`;
      s += describe(node.alternate, depth + 1, maxDepth);
    }
    s += `${pad}}\n`;
    return s;
  }
  if (t.isBlockStatement(node)) {
    let s = '';
    for (const stmt of node.body) {
      s += describe(stmt, depth, maxDepth);
    }
    return s;
  }
  if (t.isExpressionStatement(node)) {
    return describe(node.expression, depth, maxDepth);
  }
  if (t.isConditionalExpression(node)) {
    let s = `${pad}TERNARY (${nodeStr(node.test)}):\n`;
    s += `${pad}  THEN: ${(t.isConditionalExpression(node.consequent) ? '\n' + describe(node.consequent, depth+2, maxDepth) : nodeStr(node.consequent))}\n`;
    s += `${pad}  ELSE: ${(t.isConditionalExpression(node.alternate) ? '\n' + describe(node.alternate, depth+2, maxDepth) : nodeStr(node.alternate))}\n`;
    return s;
  }
  if (t.isLogicalExpression(node)) {
    let s = `${pad}LOGICAL (${node.operator}) test=${nodeStr(node.left)}\n`;
    s += `${pad}  RHS: ${nodeStr(node.right)}\n`;
    return s;
  }
  if (t.isSequenceExpression(node)) {
    let s = `${pad}SEQ [${node.expressions.length}]\n`;
    for (let i = 0; i < node.expressions.length; i++) {
      s += `${pad}  [${i}]: ${nodeStr(node.expressions[i])}\n`;
    }
    return s;
  }
  if (t.isForStatement(node) || t.isWhileStatement(node)) {
    let s = `${pad}${node.type} (test: ${nodeStr(node.test)}):\n`;
    s += describe(node.body, depth + 1, maxDepth);
    return s;
  }
  return `${pad}LEAF[${node.type}]: ${nodeStr(node).slice(0, 100)}\n`;
}

// 找 main dispatch loop
let loop = null;
for (const stmt of dispatcherFn.body.body) {
  if (t.isIfStatement(stmt) && (t.isForStatement(stmt.consequent) || t.isWhileStatement(stmt.consequent))) {
    loop = stmt.consequent;
    console.log(`\nFound dispatch loop: ${stmt.type}.consequent.${loop.type}`);
    break;
  }
  if (t.isForStatement(stmt) || t.isWhileStatement(stmt)) {
    loop = stmt;
    console.log(`\nFound dispatch loop: ${stmt.type}`);
    break;
  }
}

if (!loop) {
  console.log('No dispatch loop found, dumping function body:');
  console.log(describe(dispatcherFn.body, 0, 4));
  process.exit(1);
}

console.log(`\n=== Dispatch loop body structure (depth-limited) ===`);
console.log(describe(loop.body, 0, 6));

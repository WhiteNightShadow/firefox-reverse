#!/usr/bin/env node
'use strict';
/* js_trace.cjs — 通用 JS 静态 AST 插桩 + Node 执行追踪。站点无关。
 * 用法: node js_trace.cjs <config.json>
 * config: { scriptPath, workDir, mode="static"|"instrument"|"run",
 *           entryFn?, entryArgs?[], filterFn?, maxCalls?=2000 }
 * 输出: __JS_TRACE_JSON__<json>
 * 需要: acorn（backend 自动 npm install，首次慢一次）
 */
const fs = require('fs'), path = require('path'), cp = require('child_process');

let acorn;
try { acorn = require('acorn'); }
catch (e) {
  process.stdout.write('__JS_TRACE_JSON__' + JSON.stringify({
    ok: false, error: 'acorn 未安装（backend 会自动 npm install acorn，重试即可）',
  }));
  process.exit(0);
}

const OUT = '__JS_TRACE_JSON__';

(async () => {
  try {
    const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const { scriptPath, workDir, mode = 'static', entryFn, entryArgs = [],
            filterFn, maxCalls = 2000 } = cfg;
    if (!scriptPath) throw new Error('需要 scriptPath');

    const code = fs.readFileSync(scriptPath, 'utf8');

    // ── 解析（script 优先；失败则 module）──────────────────────────────
    let ast;
    for (const srcType of ['script', 'module']) {
      try {
        ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: srcType,
                                   locations: true, ranges: true });
        break;
      } catch (e) {
        if (srcType === 'module') throw new Error('JS 解析失败: ' + e.message);
      }
    }

    // ── 递归遍历 AST，收集函数节点 ────────────────────────────────────
    const filterRe = filterFn ? new RegExp(filterFn, 'i') : null;
    const fns = [];
    let seq = 0;

    function walk(node, ctx) {
      if (!node || typeof node !== 'object') return;
      let myCtx = null;

      if (node.type === 'FunctionDeclaration' ||
          node.type === 'FunctionExpression'  ||
          node.type === 'ArrowFunctionExpression') {
        let name = ctx || '(anonymous)';
        if (node.id && node.id.name) name = node.id.name;
        const body = node.body, hasBlock = !!(body && body.type === 'BlockStatement');
        if (!filterRe || filterRe.test(name)) {
          fns.push({
            id: ++seq, name,
            type: node.type.replace('Expression', 'Expr').replace('Declaration', 'Decl'),
            line: node.loc ? node.loc.start.line : 0,
            col:  node.loc ? node.loc.start.column : 0,
            params: (node.params || []).map(p =>
              p.type === 'Identifier'   ? p.name :
              p.type === 'RestElement'  ? '...' + (p.argument && p.argument.name || '?') :
              p.type === 'AssignmentPattern' && p.left ? p.left.name + '=?' : '?'),
            bodyStart: hasBlock ? body.start : null,
            bodyEnd:   hasBlock ? body.end   : null,
            hasBlock,
          });
        }
        myCtx = name;
      }

      for (const k of Object.keys(node)) {
        if (k === 'type' || !node[k] || typeof node[k] !== 'object') continue;
        const v = node[k];
        // 从父节点上下文推断匿名函数名
        let childCtx = null;
        if (node.type === 'VariableDeclarator' && k === 'init' && node.id && node.id.name)
          childCtx = node.id.name;
        else if ((node.type === 'Property' || node.type === 'MethodDefinition') && k === 'value' && node.key)
          childCtx = node.key.name || String(node.key.value || '');
        else if (node.type === 'AssignmentExpression' && k === 'right' && node.left) {
          if (node.left.type === 'Identifier') childCtx = node.left.name;
          else if (node.left.type === 'MemberExpression' && node.left.property)
            childCtx = node.left.property.name || null;
        }
        if (Array.isArray(v)) {
          for (const item of v) if (item && typeof item === 'object' && item.type) walk(item, childCtx || myCtx);
        } else if (v.type) {
          walk(v, childCtx || myCtx);
        }
      }
    }
    walk(ast, null);

    const base = path.basename(scriptPath).replace(/\.[^.]+$/, '');
    const fnList = fns.map(f => ({ name: f.name, line: f.line, col: f.col,
                                    params: f.params, type: f.type }));

    // ── mode: static ──────────────────────────────────────────────────
    if (mode === 'static') {
      process.stdout.write(OUT + JSON.stringify({
        ok: true, mode: 'static', scriptPath,
        functionCount: fns.length,
        functions: fnList.slice(0, 80),
        note: `找到 ${fns.length} 个函数（展示前 80）。` +
          `下一步 js_trace(mode:"run", scriptPath, entryFn=<目标函数名>, entryArgs=[...]) 执行并看调用树。` +
          `filterFn 传正则子串可缩小插桩范围（如 "sign|hash|enc"）。`,
      }));
      return;
    }

    if (!workDir) throw new Error('instrument/run 模式需要 workDir');
    const wdir = path.resolve(workDir);

    // ── 插桩：单遍正向扫描，所有 pos 引用原始偏移 ───────────────────
    const injectable = fns.filter(f => f.hasBlock);
    const injPoints = [];
    for (const f of injectable) {
      const n = f.name.replace(/["\\\n]/g, '_').slice(0, 40);
      injPoints.push({ pos: f.bodyStart + 1, code: `\n__T_ENTER(${f.id},"${n}",arguments);try{` });
      injPoints.push({ pos: f.bodyEnd - 1,   code: `}finally{__T_EXIT(${f.id},"${n}")}\n` });
    }
    injPoints.sort((a, b) => a.pos - b.pos);
    let instrumented = '', last = 0;
    for (const inj of injPoints) {
      instrumented += code.slice(last, inj.pos) + inj.code;
      last = inj.pos;
    }
    instrumented += code.slice(last);

    // ── 写文件 ────────────────────────────────────────────────────────
    try { fs.mkdirSync(path.join(wdir, 'work'), { recursive: true }); } catch {}
    const iPath = path.join(wdir, 'work', base + '.traced.js');
    const rPath = path.join(wdir, 'work', base + '.runner.js');
    fs.writeFileSync(iPath, instrumented);

    // ── runner：vm.createContext + 浏览器 stub ────────────────────────
    const mc = maxCalls || 2000;
    const eArgsStr = JSON.stringify(entryArgs || []);
    const entryCall = entryFn
      ? `const _fn=_ctx[${JSON.stringify(entryFn)}];
  if(typeof _fn==='function'){try{_r=_fn(...${eArgsStr});}catch(e){_err=String(e.stack||e);}}
  else{_err='entry function '+${JSON.stringify(entryFn)}+' not found in vm context (functions: '+Object.keys(_ctx).filter(k=>typeof _ctx[k]==='function').slice(0,20).join(',')+')';}`
      : '/* no entryFn — top-level code already ran */';

    const runner = `'use strict';
/* js_trace runner — generated, do not edit */
const _vm=require('vm'),_fs=require('fs');
const _log=[],_done={v:false};let _d=0;
function __T_ENTER(id,n,args){
  if(_done.v||_log.length>=${mc}){_done.v=true;return;}
  const a=[];try{for(let i=0;i<Math.min((args&&args.length)||0,6);i++){try{a.push(JSON.stringify(args[i])?.slice(0,100));}catch{a.push(typeof args[i]);}}}catch{}
  _log.push({k:'e',d:_d++,id,n,a});
}
function __T_EXIT(id,n){if(_d>0)_d--;if(!_done.v)_log.push({k:'x',d:_d,id,n});}
const _ctx=_vm.createContext({
  __T_ENTER,__T_EXIT,
  window:null,self:null,globalThis:null,
  document:{createElement:function(t){return{tagName:t,style:{},setAttribute:function(){},getAttribute:function(){return null;},addEventListener:function(){},appendChild:function(){},children:[]};},
    getElementById:function(){return null;},querySelector:function(){return null;},querySelectorAll:function(){return[];},
    cookie:'',location:{href:'https://example.com',hostname:'example.com',protocol:'https:',pathname:'/',search:''},
    head:{appendChild:function(){}},body:{appendChild:function(){},style:{}},
    addEventListener:function(){},createTextNode:function(t){return{data:t};}},
  navigator:{userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    platform:'MacIntel',language:'zh-CN',languages:['zh-CN','en'],webdriver:false,cookieEnabled:true,plugins:{length:5}},
  location:{href:'https://example.com',hostname:'example.com',protocol:'https:',pathname:'/'},
  performance:{now:function(){return Date.now();}},
  crypto:{getRandomValues:function(a){for(let i=0;i<a.length;i++)a[i]=Math.floor(Math.random()*256);return a;},
    subtle:{digest:function(){return Promise.resolve(new ArrayBuffer(32));}}},
  XMLHttpRequest:function(){this.open=function(){};this.setRequestHeader=function(){};this.send=function(){};this.readyState=4;this.status=200;},
  fetch:function(){return Promise.resolve({json:function(){return Promise.resolve({});},text:function(){return Promise.resolve('');},ok:true,status:200});},
  setTimeout:function(f){try{f();}catch{}return 0;},clearTimeout:function(){},setInterval:function(){return 0;},clearInterval:function(){},
  TextEncoder:TextEncoder,TextDecoder:TextDecoder,
  btoa:function(s){return Buffer.from(s,'binary').toString('base64');},
  atob:function(s){return Buffer.from(s,'base64').toString('binary');},
  console:{log:function(){},warn:function(){},error:function(){},info:function(){}},
  require:require,process:process,Buffer:Buffer,
  Math:Math,JSON:JSON,Date:Date,Array:Array,Object:Object,String:String,Number:Number,
  Promise:Promise,Symbol:Symbol,Map:Map,Set:Set,WeakMap:WeakMap,RegExp:RegExp,Error:Error,
});
_ctx.window=_ctx;_ctx.self=_ctx;_ctx.globalThis=_ctx;
let _r,_err;
try{
  _vm.runInContext(_fs.readFileSync(${JSON.stringify(iPath)},'utf8'),_ctx,{timeout:15000,filename:${JSON.stringify(iPath)}});
  ${entryCall}
}catch(e){_err=String(e.stack||e);}
const _note=_log.length>0
  ?'调用树已捕获。callLog: k=\\"e\\"(enter)|\\"x\\"(exit), d=深度, n=函数名, a=参数（截断）。'
  :'未捕获到调用。常见原因: ①IIFE包裹的代码内部函数不暴露到全局(vm context)→用 entryFn/window.fn; ②代码报错未执行。见 error。';
process.stdout.write('__JS_TRACE_JSON__'+JSON.stringify({ok:!_err||_log.length>0,
  callLogCount:_log.length,truncated:_done.v,callLog:_log,
  result:_r!==undefined?String(JSON.stringify(_r)||'').slice(0,400):undefined,
  error:_err||undefined,note:_note}));
`;
    fs.writeFileSync(rPath, runner);

    const instrRelPath = 'work/' + base + '.traced.js';
    const runnerRelPath = 'work/' + base + '.runner.js';

    if (mode === 'instrument') {
      process.stdout.write(OUT + JSON.stringify({
        ok: true, mode: 'instrument',
        instrumentedPath: instrRelPath,
        runnerPath: runnerRelPath,
        functionCount: fns.length,
        instrumentedCount: injectable.length,
        functions: fnList.slice(0, 30),
        note: `已生成插桩文件 + runner。用 run_node(file:"${runnerRelPath}") 执行看调用树。` +
          (entryFn ? '' : 'entryFn 未指定，runner 只执行顶层代码（IIFE/自执行）。用 entryFn 指定要单独调的函数名。'),
      }));
      return;
    }

    // ── mode: run — 执行 runner，透传 __JS_TRACE_JSON__ 输出 ─────────
    let runOut = '';
    try {
      runOut = cp.execFileSync(process.execPath, [rPath], {
        timeout: 20000, encoding: 'utf8', cwd: wdir,
      });
    } catch (e) {
      runOut = String(e.stdout || '') + String(e.stderr || '') + String(e.message || '');
    }
    const mm = runOut.match(/__JS_TRACE_JSON__(.+)/);
    if (mm) {
      process.stdout.write(OUT + mm[1]);
    } else {
      process.stdout.write(OUT + JSON.stringify({ ok: false, error: 'runner 无输出: ' + runOut.slice(0, 400) }));
    }

  } catch (e) {
    process.stdout.write(OUT + JSON.stringify({ ok: false, error: String(e.stack || e.message || e) }));
  }
})();

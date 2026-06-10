/* wasm-call-logger.js — 通用 WASM 调用日志器（站点无关、零三方依赖）。
 *
 * 痛点：wasm_probe / wasm_disasm 只管"独立 wasm-bindgen glue"那种顶层 WASM；
 *   但有些签名是 **JS-VM 在自己的闭包里 instantiate 一个小 WASM**（比如算完整性 hash / 自定义变换），
 *   那个 WASM 没有公开 glue、在 VM 内部被实例化 —— 现有工具够不到。
 *
 * 通用方案：在 **加载 signer / 跑 VM 之前**，monkeypatch 全局的
 *     WebAssembly.instantiate / WebAssembly.instantiateStreaming / WebAssembly.Instance / WebAssembly.compile(Streaming)
 *   不论是哪个站点、哪种 VM，只要它走标准 WebAssembly API 实例化，就会被拦下：
 *     · 给 instance.exports 的每个**导出函数**套日志 Proxy → 记 (导出名, 入参, 返回值)
 *     · 给 imports 里的每个**回调函数**套日志 Proxy → 记 VM 喂给 WASM 的回调(揭示 WASM 反向读了什么)
 *   触发一次签名 → log 里就能看到 VM 调了 WASM 哪些函数、传了什么、返回了什么
 *   （= 揭示这块 WASM 到底在算哪种 hash / 变换）。
 *
 * 站点无关：只 hook WebAssembly 标准 API，**不认任何站点/常量/表/字段名**，对所有站点一视同仁。
 * 零副作用：只在 **当前 Node 进程**的全局 patch，并提供 restore()；不 hook 浏览器、不改其它进程、
 *   它根本不在浏览器跑 → 对其它站点的分析天然零影响。
 *
 * 用法（在你的 loader / VM 脚本里）：
 *     const { installWasmLogger } = require('.../wasm-call-logger.js');
 *     const wl = installWasmLogger();          // ← 必须在 require/eval signer 之前
 *     ... 触发一次签名 ...
 *     wl.restore();                            // 还原全局（可选；进程退出也行）
 *     console.log(JSON.stringify(wl.dump(), null, 2));   // 看 WASM 调用清单
 *
 * 导出：installWasmLogger(opts) → { restore, log, dump, getMemory, clear }
 *   opts(均可选):
 *     maxArgs       每次调用最多记录的实参个数(默认 16)
 *     maxBytes      decode (ptr,len) 字符串/截断 buffer 的上限(默认 256)
 *     decodeStrings 是否尝试把 (ptr,len) 实参对解成可读字符串(默认 true)
 *     captureExports 是否日志导出函数(默认 true)
 *     captureImports 是否日志 import 回调(默认 true)
 *     onCall        function(record){...} 每条调用的回调(可做实时打印/过滤)
 *     keep          要保留 buffer 副本的导出名正则(默认 null=不存原始 buffer，省内存)
 */
'use strict';

function installWasmLogger(opts) {
  opts = opts || {};
  const MAX_ARGS = opts.maxArgs != null ? opts.maxArgs : 16;
  const MAX_BYTES = opts.maxBytes != null ? opts.maxBytes : 256;
  const DECODE_STRINGS = opts.decodeStrings !== false;
  const CAP_EXPORTS = opts.captureExports !== false;
  const CAP_IMPORTS = opts.captureImports !== false;
  const onCall = typeof opts.onCall === 'function' ? opts.onCall : null;
  const keepRe = opts.keep instanceof RegExp ? opts.keep : null;

  const WA = (typeof WebAssembly !== 'undefined') ? WebAssembly
    : (typeof globalThis !== 'undefined' ? globalThis.WebAssembly : null);
  if (!WA) throw new Error('WebAssembly 不可用，无法安装 logger');

  const log = [];                 // 全部调用记录（导出+import）累积
  const instances = [];           // 记录到的每个 instance 的 {id, exportNames, memory}
  let instSeq = 0;

  // ---- 值的可读化 ----
  const td = new TextDecoder('utf-8', { fatal: true });
  function shortVal(v) {
    try {
      const t = typeof v;
      if (t === 'number' || t === 'boolean') return v;
      if (t === 'bigint') return String(v) + 'n';
      if (v == null) return v === null ? null : 'undefined';
      if (t === 'string') return v.length > MAX_BYTES ? v.slice(0, MAX_BYTES) + '…(' + v.length + ')' : v;
      if (t === 'function') return '[fn ' + (v.name || '') + ']';
      if (v instanceof WA.Memory) return '[WebAssembly.Memory]';
      if (ArrayBuffer.isView(v)) return '[' + v.constructor.name + ' len=' + v.length + ']';
      if (v instanceof ArrayBuffer) return '[ArrayBuffer ' + v.byteLength + ']';
      return Object.prototype.toString.call(v);
    } catch { return '[unprintable]'; }
  }

  // 尝试把 (ptr,len) 这种相邻数值对解码成 WASM 线性内存里的字符串（wasm-bindgen / 多数 VM 传字符串的方式）。
  // mem 是该 instance 的 WebAssembly.Memory；解不出就返回 null（不强解，避免误报）。
  function tryDecodeStr(ptr, len, mem) {
    if (!DECODE_STRINGS || !mem) return null;
    if (typeof ptr !== 'number' || typeof len !== 'number') return null;
    if (!Number.isInteger(ptr) || !Number.isInteger(len)) return null;
    if (ptr <= 0 || len <= 0 || len > MAX_BYTES * 8) return null;
    let buf;
    try { buf = new Uint8Array(mem.buffer); } catch { return null; }
    if (ptr + len > buf.length) return null;
    try {
      const s = td.decode(buf.subarray(ptr, ptr + len));
      // 至少第一个字符可见、且大部分是可打印字符，才认为是真字符串
      if (!s.length) return null;
      let printable = 0;
      for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c >= 0x20 && c < 0x7f) printable++; }
      if (printable / s.length < 0.6) return null;
      return s.length > MAX_BYTES ? s.slice(0, MAX_BYTES) + '…(' + s.length + ')' : s;
    } catch { return null; }
  }

  // 把整段实参数组解析成可读列表；连续 (number,number) 若能解成字符串则合并为一条 {str,ptr,len}。
  function decodeArgs(args, mem) {
    const out = [];
    const n = Math.min(args.length, MAX_ARGS);
    for (let i = 0; i < n; i++) {
      const x = args[i], y = args[i + 1];
      const s = (typeof x === 'number' && typeof y === 'number') ? tryDecodeStr(x, y, mem) : null;
      if (s != null) { out.push({ ptr: x, len: y, str: s }); i++; continue; }
      out.push(shortVal(x));
    }
    if (args.length > MAX_ARGS) out.push('…(+' + (args.length - MAX_ARGS) + ' args)');
    return out;
  }

  function record(rec) {
    log.push(rec);
    if (onCall) { try { onCall(rec); } catch {} }
    return rec;
  }

  // ---- 给一个 exports 对象的所有导出函数套日志 ----
  // 注意：instance.exports 的属性是 **read-only + non-configurable**（引擎冻结），
  //   Proxy 的 get 不变量禁止对这种属性返回"非原值"→ 必须用一个**全新的普通对象**承载包过的函数，
  //   非函数导出（memory/table/global）原样转引用。
  function wrapExports(exportsObj, instId, getMem) {
    if (!CAP_EXPORTS || !exportsObj) return exportsObj;
    const out = {};
    let keys;
    try { keys = Object.keys(exportsObj); } catch { return exportsObj; }
    for (const key of keys) {
      let v;
      try { v = exportsObj[key]; } catch { continue; }
      if (typeof v !== 'function') { out[key] = v; continue; } // memory/table/global 原样
      const name = key;
      const origFn = v;
      out[key] = function (...args) {
        const mem = getMem();
        const rec = { kind: 'export', inst: instId, name, args: decodeArgs(args, mem), t: Date.now() };
        if (keepRe && keepRe.test(name)) rec.rawArgs = args.slice(0, MAX_ARGS);
        let ret, threw;
        try { ret = origFn.apply(exportsObj, args); } // this 绑回原 exports，避免 wasm-bindgen 内部 this 出错
        catch (e) { threw = e; }
        // 返回值若是 (ptr) 形态拿不到 len，无法解串；尽量给可读形态。
        rec.ret = threw ? undefined : shortVal(ret);
        if (threw) { rec.threw = String((threw && threw.message) || threw); record(rec); throw threw; }
        record(rec);
        return ret;
      };
    }
    return out;
  }

  // ---- 给 imports 里的每个回调函数套日志（VM 喂给 WASM 的回调：揭示 WASM 反读了哪些宿主数据）----
  function wrapImports(importObj, instId, getMem) {
    if (!CAP_IMPORTS || !importObj || typeof importObj !== 'object') return importObj;
    const outer = {};
    for (const modName of Object.keys(importObj)) {
      const mod = importObj[modName];
      if (!mod || typeof mod !== 'object') { outer[modName] = mod; continue; }
      const wrappedMod = {};
      for (const fnName of Object.keys(mod)) {
        const orig = mod[fnName];
        if (typeof orig !== 'function') { wrappedMod[fnName] = orig; continue; }
        wrappedMod[fnName] = function (...args) {
          const mem = getMem();
          const rec = { kind: 'import', inst: instId, name: modName + '.' + fnName, args: decodeArgs(args, mem), t: Date.now() };
          let ret, threw;
          try { ret = orig.apply(this, args); }
          catch (e) { threw = e; }
          rec.ret = threw ? undefined : shortVal(ret);
          if (threw) { rec.threw = String((threw && threw.message) || threw); record(rec); throw threw; }
          record(rec);
          return ret;
        };
      }
      outer[modName] = wrappedMod;
    }
    return outer;
  }

  // 注册一个 instance：找它的 memory（导出名常为 'memory'，否则取第一个 Memory），登记并包 exports。
  function registerInstance(instance) {
    if (!instance || !instance.exports) return instance;
    const id = ++instSeq;
    let memObj = null;
    try {
      const ex = instance.exports;
      if (ex.memory instanceof WA.Memory) memObj = ex.memory;
      else { for (const k of Object.keys(ex)) { if (ex[k] instanceof WA.Memory) { memObj = ex[k]; break; } } }
    } catch {}
    const getMem = () => memObj; // memory.buffer 会随 grow 变化，故每次取实时 buffer（getMem 返回 Memory 对象本身）
    const meta = {
      id,
      exportNames: (() => { try { return Object.keys(instance.exports); } catch { return []; } })(),
      hasMemory: !!memObj,
      memory: memObj,
    };
    instances.push(meta);
    // 用包过的 exports 替换原 exports（instance.exports 多数实现可写；不可写则降级用 Object.defineProperty）
    const wrapped = wrapExports(instance.exports, id, getMem);
    try { instance.exports = wrapped; }
    catch {
      try { Object.defineProperty(instance, 'exports', { value: wrapped, configurable: true }); } catch {}
    }
    return instance;
  }

  // ---- 保存原 API ----
  const orig = {
    instantiate: WA.instantiate,
    instantiateStreaming: WA.instantiateStreaming,
    Instance: WA.Instance,
    compile: WA.compile,
    compileStreaming: WA.compileStreaming,
  };

  // WebAssembly.instantiate(bytes|module, imports) → 包 imports、登记结果 instance
  WA.instantiate = function (src, importObject) {
    const id = '(pending)';
    const wrappedImports = wrapImports(importObject, id, () => null);
    const p = orig.instantiate.call(WA, src, wrappedImports);
    return Promise.resolve(p).then((res) => {
      // 两种返回形态：{module,instance}（传 bytes）或 Instance（传 Module）
      if (res && res.instance) { registerInstance(res.instance); return res; }
      return registerInstance(res);
    });
  };

  WA.instantiateStreaming = function (source, importObject) {
    const wrappedImports = wrapImports(importObject, '(pending)', () => null);
    const doIt = (resp) => {
      // 把 streaming 降级成普通 instantiate：拿到 bytes 再走已 hook 的 WA.instantiate（自然被登记）
      const p = Promise.resolve(resp).then((r) => (r && r.arrayBuffer ? r.arrayBuffer() : r));
      return p.then((bytes) => WA.instantiate(bytes, importObject));
    };
    if (orig.instantiateStreaming) {
      // 优先用原生 streaming（保 imports 包裹），失败再降级
      try {
        const p = orig.instantiateStreaming.call(WA, source, wrappedImports);
        return Promise.resolve(p).then((res) => {
          if (res && res.instance) { registerInstance(res.instance); return res; }
          return registerInstance(res);
        }).catch(() => doIt(source));
      } catch { return doIt(source); }
    }
    return doIt(source);
  };

  // new WebAssembly.Instance(module, imports) —— 同步路径（VM 内部常用这个）
  function LoggedInstance(module, importObject) {
    const wrappedImports = wrapImports(importObject, '(pending)', () => null);
    const inst = new orig.Instance(module, wrappedImports);
    return registerInstance(inst);
  }
  LoggedInstance.prototype = orig.Instance.prototype;
  try {
    Object.defineProperty(LoggedInstance, 'name', { value: 'Instance' });
    WA.Instance = LoggedInstance;
  } catch {}

  // compile / compileStreaming 不产生 instance（只编译），不需要包；保留原样，仅为 restore 完整性留引用。
  // （若站点用 compile 再 new Instance，上面的 Instance hook 会接住）

  function restore() {
    try { WA.instantiate = orig.instantiate; } catch {}
    try { WA.instantiateStreaming = orig.instantiateStreaming; } catch {}
    try { WA.Instance = orig.Instance; } catch {}
    try { WA.compile = orig.compile; } catch {}
    try { WA.compileStreaming = orig.compileStreaming; } catch {}
  }

  // 汇总：每个导出/import 的调用次数 + 全部调用记录，便于一眼看清"VM 调了 WASM 哪些函数"。
  function dump() {
    const byName = {};
    for (const r of log) {
      const k = r.kind + ':' + r.name;
      byName[k] = (byName[k] || 0) + 1;
    }
    return {
      ok: true,
      totalCalls: log.length,
      instanceCount: instances.length,
      instances: instances.map((m) => ({ id: m.id, exportNames: m.exportNames, hasMemory: m.hasMemory })),
      callCounts: byName,
      calls: log,
    };
  }

  function clear() { log.length = 0; }
  function getMemory(instId) {
    const m = instances.find((x) => x.id === instId) || instances[instances.length - 1];
    return m ? m.memory : null;
  }

  return { restore, log, dump, clear, getMemory, instances };
}

module.exports = { installWasmLogger };

// ---- CLI 自检：require.main===module 时手搓一个最小 .wasm 验证 hook 能记到 export 入参/返回 + import 回调 ----
if (require.main === module) {
  (async () => {
    // 手搓一个最小合法 WASM（无需 wat2wasm/wasm-pack）：
    //   import env.log:(i32)->()  ;  export add:(i32,i32)->i32 { log(local0); local0+local1 }
    const u = (n) => { const b = []; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; b.push(x); } while (n); return b; };
    const sec = (id, p) => [id, ...u(p.length), ...p];
    const vec = (items) => [...u(items.length), ...items.flat()];
    const str = (x) => { const e = Buffer.from(x, 'utf8'); return [...u(e.length), ...e]; };
    const typeSec = sec(1, vec([
      [0x60, ...u(2), 0x7f, 0x7f, ...u(1), 0x7f], // type0 (i32,i32)->i32
      [0x60, ...u(1), 0x7f, ...u(0)],             // type1 (i32)->()
    ]));
    const importSec = sec(2, vec([[...str('env'), ...str('log'), 0x00, ...u(1)]])); // env.log type1
    const funcSec = sec(3, vec([[...u(0)]]));                                        // func0 type0
    const exportSec = sec(7, vec([[...str('add'), 0x00, ...u(1)]]));                 // export add -> funcidx1
    const body = [0x00, 0x20, 0x00, 0x10, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b];
    const codeSec = sec(10, vec([[...u(body.length), ...body]]));
    const wasm = Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...typeSec, ...importSec, ...funcSec, ...exportSec, ...codeSec]);

    const out = { ok: false, instantiate: null, syncInstance: null, restored: null, error: null };
    try {
      // 1) 安装 logger（模拟"加载 signer 之前"）
      const importLogHits = [];
      const wl = installWasmLogger({ onCall: (r) => { if (r.kind === 'import') importLogHits.push(r.name); } });

      // 2) 异步 instantiate 路径（VM 常用 WebAssembly.instantiate(bytes, imports)）
      const res = await WebAssembly.instantiate(wasm, { env: { log: (x) => { /* VM 回调 */ } } });
      const r1 = res.instance.exports.add(7, 5);

      // 3) 同步 new WebAssembly.Instance(Module, imports) 路径（VM 闭包内部常见）
      const mod = await WebAssembly.compile(wasm);
      const inst2 = new WebAssembly.Instance(mod, { env: { log: () => {} } });
      const r2 = inst2.exports.add(100, 23);

      const d = wl.dump();
      // 找到对 add 的两次导出调用 + 对 env.log 的两次 import 回调
      const addCalls = d.calls.filter((c) => c.kind === 'export' && c.name === 'add');
      const logCalls = d.calls.filter((c) => c.kind === 'import' && c.name === 'env.log');

      out.instantiate = { addResult: r1, expected: 12, pass: r1 === 12 };
      out.syncInstance = { addResult: r2, expected: 123, pass: r2 === 123 };
      out.captured = {
        totalCalls: d.totalCalls,
        instanceCount: d.instanceCount,
        callCounts: d.callCounts,
        firstAddArgs: addCalls[0] ? addCalls[0].args : null,
        firstAddRet: addCalls[0] ? addCalls[0].ret : null,
        importLogArgs: logCalls.map((c) => c.args),
      };

      // 4) restore 后，hook 应彻底消失：再实例化不应新增记录
      wl.restore();
      const before = wl.dump().totalCalls;
      const res3 = await WebAssembly.instantiate(wasm, { env: { log: () => {} } });
      res3.instance.exports.add(1, 1);
      const after = wl.dump().totalCalls;
      out.restored = { before, after, pass: before === after };

      // 断言：导出入参被记成 [7,5]、返回 12；import 回调 env.log 被记到（两次：每个 instance 各一次 add→log）
      const argsOk = addCalls[0] && Array.isArray(addCalls[0].args) &&
        addCalls[0].args[0] === 7 && addCalls[0].args[1] === 5 && addCalls[0].ret === 12;
      const importOk = logCalls.length === 2 && logCalls[0].args[0] === 7 && logCalls[1].args[0] === 100;
      out.assertions = {
        exportArgsAndRetCaptured: !!argsOk,
        importCallbackCaptured: !!importOk,
        bothPathsRun: out.instantiate.pass && out.syncInstance.pass,
        restoreClean: out.restored.pass,
      };
      out.ok = !!(argsOk && importOk && out.instantiate.pass && out.syncInstance.pass && out.restored.pass);
    } catch (e) {
      out.error = String((e && e.stack) || e);
    }
    console.log('__WASM_CALL_LOGGER_SELFTEST__' + JSON.stringify(out, null, 2));
    process.exit(out.ok ? 0 : 1);
  })();
}

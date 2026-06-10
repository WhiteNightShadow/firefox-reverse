// jsvmp-const-harvest.js —— 通用 JSVMP「常量收割器」（站点无关脚手架）
//
// ── 解决的高频卡点 ───────────────────────────────────────────────────────────
// jsvmp_trace / hook_jsvmp_interpreter 只记 **SpiderMonkey 引擎层** 的 opcode + 小立即数，
// 抓不到 **VM 自己字节码数组里的数据常量**：S-box / RC4 key / XXTEA delta / 自定义 base64 表 /
// 魔数 —— 这些值都是 VM 在执行 push-string / push-int / load-const 这类 handler 时，
// 从它的 bytecode 数组（一个被 PC 反复 GetElem 的字符串/数组）里**读出来**的。
// 想拿到它们，最稳的通用法 = **把 bytecode 数组本身包成一个 logging 容器**，
// 触发一次签名 → 顺序记录「所有从 bytecode 读出的值」=就是常量流（含 key/S-box/delta）。
//
// ── 通用方案（不认任何站点的变量名/格式）────────────────────────────────────
// 本工具只依赖一个**通用结构事实**：「JSVMP 有一个被 PC 反复索引读取的 bytecode 数组（或字符串）」。
//   ① 调用方（或 dispatcher_probe / jsvmp_split_dispatcher）给出 bytecodeVarHint = 那个数组的变量名/全局名；
//   ② 本工具用 logging Proxy 把它包住 → 索引读 / .length / .charCodeAt / .slice / .substr 全记下；
//   ③ triggerFn 跑一次签名 → reads[] = 按发生顺序的「读出值序列」= 常量流；
//   ④ 从 reads[] 提候选：u8(0~255 适合 S-box/key)、u32(适合 delta/魔数)、byteSeq(整段字节流)。
// 拿不到 bytecode 直接引用时给**通用兜底**：在本次 harvest 期间临时插桩
// Array.prototype / String.prototype 的索引访问（仅 Node sandbox 内、用完立刻还原），
// 把「短窗口内被密集顺序索引读的那个数组」当作 bytecode 自动认出来。
//
// ── 零副作用 ────────────────────────────────────────────────────────────────
// 纯 Node 分析：在已落盘 chunk / 数据上跑，**不 hook 浏览器、不常驻、不改任何全局**（兜底的原型插桩
// 在 finally 里无条件还原）。对其它站点分析天然零影响。
//
// 依赖：无三方依赖（crypto 可选）。可与同目录 webpack-chunk-loader.js 配合（在干净 vm 加载 signer chunk）。
//
// 导出 harvestConsts(opts) → { reads, candidates:{ u8, u32, byteSeq }, ... }

"use strict";

// ── 把任意「数组 / 字符串 / 类数组」包成 logging 容器，所有读出值塞进 sink ───────────
// 返回 { proxy, isString }。Proxy 透明转发，只在「数值索引读 / 取字符 / 切片」时记录读出值。
function wrapLogging(target, sink, label) {
  const isString = typeof target === "string";
  // 字符串不可被 Proxy 直接索引返回原值且保持 typeof==='string'；用 String 包装对象代理，
  // 但很多 VM 是 `bytecode[pc]` 取单字符 —— 包装对象索引访问会触发 get trap，能记录。
  // 数组 / 类数组直接 Proxy。
  const base = isString ? Object(target) : target; // String 对象 / 原数组
  const handler = {
    get(t, prop, recv) {
      const v = Reflect.get(t, prop, recv);
      // 数值下标读（'0','1',... 或 number）→ 记录单元值
      if (typeof prop === "string" && /^\d+$/.test(prop)) {
        record(sink, label, "index", Number(prop), v);
        return v;
      }
      // 常见「从 bytecode 抽值」的方法：包一层把读出来的子串/字符记录
      if (prop === "charCodeAt" || prop === "codePointAt") {
        return function (i) {
          const r = t[prop](i);
          record(sink, label, prop, i, r);
          return r;
        };
      }
      if (prop === "charAt") {
        return function (i) {
          const r = t.charAt(i);
          record(sink, label, "charAt", i, r);
          return r;
        };
      }
      if (prop === "slice" || prop === "substr" || prop === "substring") {
        return function (...a) {
          const r = String.prototype[prop] ? t[prop](...a) : Array.prototype[prop].apply(t, a);
          record(sink, label, prop, a, r);
          return r;
        };
      }
      // length / 其它属性透明返回
      return v;
    },
  };
  try {
    return { proxy: new Proxy(base, handler), isString };
  } catch (e) {
    // 某些 frozen/exotic 对象不可代理 → 退化为不包装（兜底插桩仍能覆盖）
    return { proxy: target, isString, proxyError: String(e && e.message || e) };
  }
}

// 统一记录一条读取事件。value 规整成「可比较的原始值」。
function record(sink, label, kind, key, value) {
  let v = value;
  // 单字符串字符 → 转字符码（便于按 u8 归类）；多字符子串 → 原样存
  let charCode = null;
  if (typeof v === "string" && v.length === 1) charCode = v.charCodeAt(0);
  sink.push({ src: label, kind, key, value: v, charCode });
}

// ── 从读取事件流里提取常量候选（站点无关：纯按数值域归类，不认任何具体表/值）─────────
function buildCandidates(reads) {
  const nums = []; // 所有「能解释成数字」的读出值，按顺序
  for (const r of reads) {
    if (typeof r.value === "number" && Number.isFinite(r.value)) nums.push(r.value);
    else if (r.charCode != null) nums.push(r.charCode);
    else if (typeof r.value === "string" && /^[0-9a-fA-F]{2}$/.test(r.value)) nums.push(parseInt(r.value, 16)); // hex-pair 字节码
  }
  // u8：落在 0~255 的值（S-box / RC4 key / base64 表的字符码都在此域）
  const u8 = nums.filter((n) => Number.isInteger(n) && n >= 0 && n <= 255);
  // u32：大整数候选（如 XXTEA 那类 delta 常量、各种魔数等），含负数补码
  const u32 = nums.filter((n) => Number.isInteger(n) && (n > 255 || n < 0));
  // byteSeq：把 u8 流拼成连续字节缓冲（便于 hexdump / 与已知 S-box 比对长度）
  const byteSeq = Buffer.from(u8.map((n) => n & 0xff));
  return { u8, u32, byteSeq };
}

// ── 在 reads 里找「长度=256 且为 0~255 全排列」的窗口（S-box 的通用结构特征，不认具体值）──
// 站点无关：只判断「256 长 + 是 0..255 的置换」这个数学性质，任何 RC4/类 RC4 S-box 都成立。
function findSboxWindows(u8) {
  const wins = [];
  for (let i = 0; i + 256 <= u8.length; i++) {
    const slice = u8.slice(i, i + 256);
    const seen = new Uint8Array(256);
    let ok = true;
    for (const v of slice) {
      if (seen[v]) { ok = false; break; }
      seen[v] = 1;
    }
    if (ok) { wins.push({ offset: i }); i += 255; } // 跳过重叠
  }
  return wins;
}

// ── 在 u8 流里找「可打印 ASCII 连续段」（自定义 base64 表 / key 字符串的通用特征）──────
// 站点无关：只认「连续 N 个可打印字符」，不匹配任何具体表内容。
function findAsciiRuns(u8, minLen) {
  minLen = minLen || 16;
  const runs = [];
  let start = -1;
  for (let i = 0; i <= u8.length; i++) {
    const c = u8[i];
    const printable = i < u8.length && c >= 0x20 && c <= 0x7e;
    if (printable) { if (start < 0) start = i; }
    else {
      if (start >= 0 && i - start >= minLen) {
        runs.push({ offset: start, length: i - start, text: Buffer.from(u8.slice(start, i)).toString("latin1") });
      }
      start = -1;
    }
  }
  return runs;
}

/**
 * 收割 JSVMP 内部常量。
 * @param {object} opts
 *   --- 取得 bytecode 的三选一 ---
 *   opts.bytecode          直接给出 bytecode（字符串 / 数组 / Buffer / 类数组）——最稳，优先用。
 *   opts.loadFn            () => ({ env / ctx })，自定义加载逻辑；配合 bytecodeVarHint 从返回对象/全局取 bytecode。
 *   opts.chunkPath         signer chunk 路径，用同目录 webpack-chunk-loader 加载（loadFn 的便捷写法）。
 *   --- 定位 bytecode 变量 ---
 *   opts.bytecodeVarHint   bytecode 数组的变量名/全局名（由 dispatcher_probe / jsvmp_split_dispatcher 给出）。
 *                          用于从 globalThis / loadFn 返回的 ctx 上取那个数组来包装。
 *   --- 触发签名 ---
 *   opts.triggerFn         (api) => void|any，跑一次签名以驱动 VM 读 bytecode。api={ wrapped, raw, reads }。
 *                          若调用方需要把「包装后的 bytecode」喂回 VM，用 api.wrapped。
 *   --- 兜底 ---
 *   opts.fallbackInstrument true 时启用「临时原型插桩」兜底（拿不到/没法包 bytecode 引用时用）。
 *   opts.fallbackMinRun    兜底里判定「这是 bytecode」的最小连续顺序索引读次数（默认 64）。
 *   opts.maxReads          安全上限，超过即停（默认 2_000_000，防失控）。
 * @returns {object} { ok, reads, candidates, sbox, ascii, stats, error? }
 */
function harvestConsts(opts = {}) {
  opts = opts || {};
  const reads = [];
  const maxReads = opts.maxReads || 2_000_000;
  const stats = { triggered: false, wrapped: false, fallbackUsed: false };

  // 安全 push：超上限即抛，避免 VM 死循环把内存撑爆
  const sink = {
    push(ev) {
      reads.push(ev);
      if (reads.length > maxReads) throw new Error("reads 超上限 " + maxReads + "（疑似 VM 死循环或包错了对象）");
    },
  };

  // ── 1) 解析 bytecode 来源 ──
  let bytecode = opts.bytecode;
  let loadedCtx = null;
  if (bytecode == null && (opts.loadFn || opts.chunkPath)) {
    try {
      if (opts.loadFn) loadedCtx = opts.loadFn();
      else {
        const { loadBundle } = require("./webpack-chunk-loader.js");
        loadedCtx = loadBundle(opts.chunkPath, opts.loadOpts || {});
      }
    } catch (e) {
      return { ok: false, error: "loadFn/chunkPath 加载失败: " + String(e && e.message || e), reads, stats };
    }
    // 用 hint 从 ctx / 全局取 bytecode
    if (opts.bytecodeVarHint) {
      bytecode = pickByHint(loadedCtx, opts.bytecodeVarHint);
    }
  }

  // ── 2) 包装 bytecode（拿得到引用时）──
  let wrapped = null;
  if (bytecode != null) {
    const w = wrapLogging(bytecode, sink, opts.bytecodeVarHint || "bytecode");
    wrapped = w.proxy;
    stats.wrapped = true;
    stats.wrapInfo = { isString: w.isString, proxyError: w.proxyError || null };
  }

  // ── 3) 兜底：临时原型插桩（拿不到引用，或调用方要求）──
  let restoreFallback = null;
  if (opts.fallbackInstrument && bytecode == null) {
    restoreFallback = installFallback(sink, opts.fallbackMinRun || 64);
    stats.fallbackUsed = true;
  }

  // ── 4) 触发签名 ──
  try {
    if (typeof opts.triggerFn === "function") {
      opts.triggerFn({ wrapped, raw: bytecode, reads, ctx: loadedCtx });
      stats.triggered = true;
    } else if (bytecode != null) {
      // 没给 triggerFn 但给了 bytecode：做一次「全量顺序扫描」自检——至少证明包装可记录
      const len = typeof bytecode === "string" ? bytecode.length : (bytecode.length | 0);
      for (let i = 0; i < len && i < maxReads; i++) { void wrapped[i]; }
      stats.triggered = "scan-only";
    }
  } catch (e) {
    stats.triggerError = String(e && e.message || e);
  } finally {
    if (restoreFallback) { try { restoreFallback(); } catch {} }
  }

  // ── 5) 提候选 ──
  const candidates = buildCandidates(reads);
  const sbox = findSboxWindows(candidates.u8);
  const ascii = findAsciiRuns(candidates.u8, opts.asciiMinLen || 16);

  return {
    ok: true,
    reads,
    candidates,
    sbox,
    ascii,
    stats: Object.assign(stats, {
      readCount: reads.length,
      u8Count: candidates.u8.length,
      u32Count: candidates.u32.length,
      byteSeqLen: candidates.byteSeq.length,
      sboxWindows: sbox.length,
      asciiRuns: ascii.length,
    }),
  };
}

// 从 loadFn 返回的 ctx / 全局里按 hint 取出 bytecode 数组。
// 支持：ctx[hint]、ctx.window[hint]、ctx.modules 任意模块导出里的 hint、globalThis[hint]。
function pickByHint(ctx, hint) {
  if (!hint) return null;
  const tryGet = (o) => { try { return o != null ? o[hint] : undefined; } catch { return undefined; } };
  let v = tryGet(ctx);
  if (v != null) return v;
  if (ctx && ctx.window) { v = tryGet(ctx.window); if (v != null) return v; }
  v = tryGet(globalThis); if (v != null) return v;
  // 遍历 webpack 模块导出找同名
  if (ctx && ctx.modules && typeof ctx.require === "function") {
    for (const id of Object.keys(ctx.modules)) {
      let ex; try { ex = ctx.require(id); } catch { continue; }
      const x = tryGet(ex); if (x != null) return x;
    }
  }
  return null;
}

// ── 兜底插桩：临时接管 Array/String 的索引访问，识别「短窗口内被密集顺序索引读」的数组 ──
// 纯 Node sandbox：包装 Array.prototype 的 Symbol.iterator 不够（VM 用 a[i] 而非迭代）；
// JS 无法拦截普通 a[i] 读（不是方法）。因此兜底策略 = 包装常见**取值方法**（charCodeAt/charAt/slice/
// substr/at），并把它们的读出值喂进 sink；同时提示调用方：纯 a[i] 索引读无法兜底，必须给 bytecodeVarHint。
// 返回 restore()。**finally 里无条件调用以还原，零副作用。**
function installFallback(sink, minRun) {
  const saved = [];
  const patch = (proto, name, label) => {
    if (!proto || typeof proto[name] !== "function") return;
    const orig = proto[name];
    saved.push({ proto, name, orig });
    Object.defineProperty(proto, name, {
      configurable: true, writable: true, enumerable: false,
      value: function (...a) {
        const r = orig.apply(this, a);
        try { record(sink, label + "." + name, name, a, r); } catch {}
        return r;
      },
    });
  };
  patch(String.prototype, "charCodeAt", "fallback:String");
  patch(String.prototype, "charAt", "fallback:String");
  patch(String.prototype, "codePointAt", "fallback:String");
  patch(String.prototype, "at", "fallback:String");
  patch(Array.prototype, "at", "fallback:Array");
  return function restore() {
    for (const s of saved) {
      try { Object.defineProperty(s.proto, s.name, { configurable: true, writable: true, enumerable: false, value: s.orig }); } catch {}
    }
  };
}

module.exports = {
  harvestConsts,
  wrapLogging,
  buildCandidates,
  findSboxWindows,
  findAsciiRuns,
  installFallback,
  pickByHint,
};

// ── 自检/示例（node jsvmp-const-harvest.js）──────────────────────────────────
// 构造一个 mock JSVMP：bytecode 数组里埋入「常量」（一段 0..255 置换的 S-box + 一个 delta + 一个 ascii key），
// VM 的 read 函数从 bytecode 顺序取值；验证 harvest 能把这些常量收割出来。真跑 Node。
if (require.main === module) {
  console.log("=== jsvmp-const-harvest 自检（mock JSVMP）===\n");

  // 1) 造常量：256 字节 S-box（0..255 的一个置换）+ 4 字节 magic + 一段 ascii key
  //    （以下全是**自造的中性值**，不取自任何站点；仅证明收割器能把埋进 bytecode 的常量原样拿出来）
  const MOCK_KEY = "ABCDEFGHIJKLMNOPqrstuvwx"; // 自造 ascii 串（>=16，模拟「自定义表/key 字符段」）
  const MOCK_MAGIC = [0xde, 0xad, 0xbe, 0xef]; // 自造 4 字节 magic（模拟 delta/魔数这类 u32 常量）
  const sboxConst = [];
  for (let i = 0; i < 256; i++) sboxConst.push((i * 167 + 13) & 0xff); // 167 与 256 互质 → 是个置换
  const deltaBytes = MOCK_MAGIC;
  const keyAscii = Array.from(MOCK_KEY).map((c) => c.charCodeAt(0));

  // 2) 造 bytecode：[一些 opcode...][S-box...][delta...][keyAscii...][一些 opcode...]
  //    VM 会逐字节读，常量段就是「连续被读出的值」。
  const noise = [0x3b, 0x2b, 0x06, 0x08, 0x59];
  const bytecodeArr = [].concat(noise, sboxConst, deltaBytes, keyAscii, noise);

  // 3) mock VM：一个 read 函数 + 一次「调用」——逐字节顺序读 bytecode（典型 PC 自增 GetElem）。
  function mockVMRun(bc) {
    let pc = 0;
    const out = [];
    while (pc < bc.length) {
      const v = bc[pc]; // ← 这就是 VM 从 bytecode 数组的 GetElem 读取（被 logging Proxy 记录）
      out.push(v);
      pc++;
    }
    return out;
  }

  // 4) 收割：把 bytecode（数组）交给 harvest，triggerFn 用包装后的数组喂回 mock VM
  const r = harvestConsts({
    bytecode: bytecodeArr,
    bytecodeVarHint: "bytecodeArr",
    triggerFn: ({ wrapped }) => mockVMRun(wrapped),
  });

  console.log("stats:", JSON.stringify(r.stats, null, 2));
  console.log("\n[S-box 窗口] 期望命中 1 个 256 长 0..255 置换:", JSON.stringify(r.sbox));
  if (r.sbox.length) {
    const off = r.sbox[0].offset;
    const got = r.candidates.u8.slice(off, off + 256);
    const match = got.length === 256 && got.every((v, i) => v === sboxConst[i]);
    console.log("  收割出的 S-box 与注入是否逐字节一致:", match);
  }

  // magic：u32/byteSeq 里应能找到注入的那 4 字节
  const magicHex = Buffer.from(MOCK_MAGIC).toString("hex");
  const hex = r.candidates.byteSeq.toString("hex");
  console.log("\n[magic] byteSeq 含 " + magicHex + ":", hex.includes(magicHex));

  console.log("\n[ascii 段] 期望含注入的 key 字符串:");
  console.log("  runs:", JSON.stringify(r.ascii));
  const hitKey = r.ascii.some((a) => a.text.includes(MOCK_KEY));
  console.log("  含注入 key:", hitKey);

  // 5) 兜底自检：不给 bytecode 引用，靠 String.charCodeAt 兜底插桩
  console.log("\n=== 兜底插桩自检（String.charCodeAt）===");
  const r2 = harvestConsts({
    fallbackInstrument: true,
    triggerFn: () => {
      const s = MOCK_KEY;
      let acc = 0;
      for (let i = 0; i < s.length; i++) acc += s.charCodeAt(i); // ← 兜底插桩记录每个字符码
      return acc;
    },
  });
  console.log("  fallback reads:", r2.stats.readCount, "| u8:", r2.stats.u8Count, "| ascii runs:", r2.stats.asciiRuns);
  const fbKey = r2.ascii.some((a) => a.text.includes(MOCK_KEY));
  console.log("  兜底收割含 key:", fbKey, "| 原型已还原(charCodeAt 是原生):", ("x").charCodeAt.toString().includes("[native code]"));

  // 汇总 JSON 摘要
  const summary = {
    sboxFound: r.sbox.length === 1,
    sboxByteExact: r.sbox.length ? r.candidates.u8.slice(r.sbox[0].offset, r.sbox[0].offset + 256).every((v, i) => v === sboxConst[i]) : false,
    magicFound: hex.includes(magicHex),
    asciiKeyFound: hitKey,
    fallbackKeyFound: fbKey,
    fallbackRestored: ("x").charCodeAt.toString().includes("[native code]"),
  };
  console.log("\n__HARVEST_SELFTEST__" + JSON.stringify(summary));
}

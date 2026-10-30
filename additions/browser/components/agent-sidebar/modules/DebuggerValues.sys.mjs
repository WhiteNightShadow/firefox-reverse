/* DebuggerValues.sys.mjs — 把 SpiderMonkey Debugger 的值变成能经 actor 消息回传的普通值。
 * signer_trace / closure_read / debug_breakpoint 共用：浅描述（实参）、深序列化（闭包里的表、字节码）、一行预览（变量目录）。
 */

// 把 Debugger.Object / 原始值安全描述成可经 actor 消息回传的普通值（深度≤2、截断大字符串）。
// 字符串/数字直接回（签名器的 url/ts 实参就是原始值）；对象浅层 dump 出原始属性（如请求配置 e 的 url/method/params）。
export function describeDbgArg(v, depth = 0) {
  const t = typeof v;
  if (v === null || t === "undefined" || t === "boolean" || t === "number") {
    return v;
  }
  if (t === "string") {
    return v.length > 2000 ? v.slice(0, 2000) + "…(截断)" : v;
  }
  if (t === "bigint" || t === "symbol") {
    return String(v);
  }
  if (v && t === "object") {
    // Debugger.Object
    let cls = "Object";
    try {
      cls = v.class || "Object";
    } catch {
      /* ignore */
    }
    if (depth >= 2) {
      return "[" + cls + "]";
    }
    const out = {};
    let names = [];
    try {
      names = v.getOwnPropertyNames().slice(0, 40);
    } catch {
      /* 取不到属性名 */
    }
    for (const n of names) {
      let d;
      try {
        d = v.getOwnPropertyDescriptor(n);
      } catch {
        continue;
      }
      if (d && "value" in d) {
        out[n] = describeDbgArg(d.value, depth + 1);
      }
    }
    return Object.keys(out).length ? out : "[" + cls + "]";
  }
  try {
    return String(v);
  } catch {
    return "[unserializable]";
  }
}

// 把 Debugger 值**深序列化**成可经 actor 回传的普通值（治"256 字节 S-box / 几千字节解码后字节码要整段拿"）。
// 数组(含 TypedArray)逐元素取（上限 maxArr），对象逐属性取（上限 200），递归到 maxDepth。
export function describeDbgDeep(v, depth, maxDepth, maxArr) {
  const t = typeof v;
  if (v === null || t === "undefined" || t === "boolean" || t === "number") {
    return v;
  }
  if (t === "string") {
    return v.length > 20000 ? v.slice(0, 20000) + "…(截断 " + v.length + ")" : v;
  }
  if (t === "bigint" || t === "symbol") {
    return String(v);
  }
  if (v && t === "object") {
    // Debugger.Object
    let cls = "Object";
    try { cls = v.class || "Object"; } catch {}
    if (cls === "Function") {
      let nm = "";
      try { nm = v.name || ""; } catch {}
      return "[function " + (nm || "anonymous") + "]";
    }
    if (depth >= maxDepth) {
      return "[" + cls + "]";
    }
    // 数组 / TypedArray：逐 index 深取（这是 S-box / 解码字节码 / 常量池的关键路径）。
    const isArrayLike = cls === "Array" || /Array$/.test(cls); // Array / Uint8Array / Int32Array …
    if (isArrayLike) {
      let len = 0;
      try {
        const d = v.getOwnPropertyDescriptor("length");
        len = (d && typeof d.value === "number") ? d.value : 0;
      } catch {}
      const n = Math.min(len, maxArr);
      const out = [];
      for (let i = 0; i < n; i++) {
        try {
          const d = v.getOwnPropertyDescriptor(i);
          out.push(d && "value" in d ? describeDbgDeep(d.value, depth + 1, maxDepth, maxArr) : null);
        } catch { out.push(null); }
      }
      if (len > n) { out.push("…(+" + (len - n) + " more)"); }
      return out;
    }
    // 普通对象：逐属性深取（上限 200）。
    const out = {};
    let names = [];
    try { names = v.getOwnPropertyNames().slice(0, 200); } catch {}
    for (const nm of names) {
      let d;
      try { d = v.getOwnPropertyDescriptor(nm); } catch { continue; }
      if (d && "value" in d) {
        out[nm] = describeDbgDeep(d.value, depth + 1, maxDepth, maxArr);
      }
    }
    return out;
  }
  try { return String(v); } catch { return "[unserializable]"; }
}

// 浅预览（无 varNames 过滤时的"变量目录"用，避免整个模块作用域深序列化爆炸）。
export function previewDbg(v) {
  const t = typeof v;
  if (v === null) return null;
  if (t === "undefined" || t === "boolean" || t === "number") return v;
  if (t === "string") return v.length > 120 ? "str(" + v.length + "):" + v.slice(0, 120) + "…" : "str:" + v;
  if (t === "bigint" || t === "symbol") return String(v);
  if (v && t === "object") {
    let cls = "Object";
    try { cls = v.class || "Object"; } catch {}
    if (cls === "Function") { let nm = ""; try { nm = v.name || ""; } catch {} return "[function " + (nm || "anon") + "]"; }
    if (cls === "Array" || /Array$/.test(cls)) {
      let len = 0;
      try { const d = v.getOwnPropertyDescriptor("length"); len = (d && typeof d.value === "number") ? d.value : 0; } catch {}
      return "[" + cls + " len=" + len + "]";
    }
    let kn = 0;
    try { kn = v.getOwnPropertyNames().length; } catch {}
    return "[" + cls + " keys=" + kn + "]";
  }
  return String(v);
}

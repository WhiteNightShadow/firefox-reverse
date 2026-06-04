/* JsvmpBackend.sys.mjs — JSVMP trace 能力（读取 C++ 引擎层落盘的 NDJSON trace）。
 *
 * 原生 trace 由 JsvmpTraceCore.cpp 产生，启动期 env(MOZ_JSVMP_TRACE / _SCRIPT / _DUMP_*) 控制，
 * 默认落盘 /tmp/firefox-reverse-jsvmp-b.ndjson.<pid>（可被 MOZ_JSVMP_TRACE_FILE 覆盖）。
 * 本后端从 Agent 侧读取/筛选这些记录。运行期开关需 C++ pref（后续），故 trace() 仅返回说明。
 */

// 跨平台 trace 目录：mac/Linux 用 /tmp（行为不变）；Windows 无 /tmp → 用系统 TEMP，
// 与 C++ 侧 getenv("TEMP") 同源（同一 OS 环境变量），保证两进程算出**完全相同**的文件路径。
function traceDir() {
  try {
    if (Services.appinfo.OS === "WINNT") {
      const t = Services.env.get("TEMP") || Services.env.get("TMP");
      return t && t.length ? t : "C:\\Windows\\Temp";
    }
  } catch {
    /* 取不到平台信息 → 退回 /tmp */
  }
  return "/tmp";
}
const PREFIX = "firefox-reverse-jsvmp";

function agentWin(ctx) {
  try { const w = ctx && ctx.win; if (w && w.gBrowser && !w.closed) return w; } catch {}
  return Services.wm.getMostRecentWindow("navigator:browser");
}

export class JsvmpBackend {
  constructor({ traceFile, getWorkspaceRoot, workspace } = {}) {
    this._fixed = traceFile || null;
    this._workspace = workspace || null;
    // _getWorkspaceRoot 接受可选 ctx，优先返回 ctx.workspaceRoot（会话级隔离），回退全局 setRoot()。
    this._getWorkspaceRoot =
      getWorkspaceRoot || (workspace ? ctx => workspace.getRoot(ctx) : null);
  }

  /** 把随浏览器打包的离线工具脚本（chrome:// 内）落到 <工作目录>/.agent-tools/ 并缓存，返回工作目录相对路径。 */
  async _ensureToolScript(name, ctx) {
    const root = this._getWorkspaceRoot && this._getWorkspaceRoot(ctx);
    if (!root) {
      throw new Error("需要先设置工作目录（侧边栏「打开目录」），离线工具会落到其 .agent-tools/ 下。");
    }
    const dir = PathUtils.join(root, ".agent-tools");
    await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
    const dest = PathUtils.join(dir, name);
    const rel = ".agent-tools/" + name;
    try {
      const s = await IOUtils.stat(dest);
      if (s.size > 0) {
        return rel; // 已提取过 → 复用
      }
    } catch {
      /* 不存在 → 提取 */
    }
    // 注意 chrome URL 基址：jar.mn 的 content/browser/agent-sidebar/X 经 chrome 清单映射为
    // chrome://browser/content/agent-sidebar/X（少一段 browser/），与 panel.html 引用 bundle 的写法一致。
    const url = "chrome://browser/content/agent-sidebar/tools/" + name;
    const { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
    const text = await new Promise((resolve, reject) => {
      NetUtil.asyncFetch({ uri: url, loadUsingSystemPrincipal: true }, (inputStream, status) => {
        if (!Components.isSuccessCode(status)) {
          reject(new Error("读取打包工具失败 " + url + " status=" + status));
          return;
        }
        try {
          resolve(NetUtil.readInputStreamToString(inputStream, inputStream.available(), { charset: "UTF-8" }));
        } catch (e) {
          reject(e);
        }
      });
    });
    await IOUtils.writeUTF8(dest, text);
    return rel;
  }

  /**
   * 一等工具①：dispatcher 拆解。把 JSVMP dispatcher 函数源码 → handlers.json（含 decode_table + 每个 op 的语义）。
   * 内部 run_node 跑随浏览器打包的 dispatcher_split.cjs（babel 已内联，无需 node_modules）。
   * @param {object} p { source?(内联JS) , sourceFile?(工作目录内.js) , out="handlers.json" , col?(自动检测失败时按列覆盖) }
   */
  async splitDispatcher({ source, sourceFile, out = "handlers.json", col } = {}, ctx) {
    if (!this._workspace || !this._workspace.runNode) {
      throw new Error("workspace 后端不可用");
    }
    const tool = await this._ensureToolScript("dispatcher_split.cjs", ctx);
    let inFile = sourceFile;
    if (!inFile) {
      if (source == null || !String(source).length) {
        throw new Error("需要 source（dispatcher 函数源码）或 sourceFile（工作目录内 .js 路径）之一");
      }
      inFile = ".agent-tools/_dispatcher_input.js";
      await this._workspace.write({ path: inFile, content: String(source) }, ctx);
    }
    const args = [inFile, out];
    if (col != null) {
      args.push("--col=" + col);
    }
    const run = await this._workspace.runNode({ file: tool, args }, ctx);
    let summary = null;
    let handlerCount = 0;
    let decodeTableSize = 0;
    try {
      const j = await this._workspace.read({ path: out }, ctx);
      const parsed = JSON.parse(j.content);
      handlerCount = parsed.handlers ? Object.keys(parsed.handlers).length : 0;
      decodeTableSize = parsed.decode_table ? Object.keys(parsed.decode_table).length : 0;
      summary = (parsed.handlers ? Object.keys(parsed.handlers).slice(0, 24) : []).join(",");
    } catch {
      /* 解析失败：可能 dispatcher 没识别出来 */
    }
    return {
      ok: run.ok && handlerCount > 0,
      out,
      handlerCount,
      decodeTableSize,
      opKeysPreview: summary,
      exitCode: run.exitCode,
      // 工具的 stdout/stderr（含自动检测日志）——给模型看进展，ToolRouter 会再截断
      log: (run.output || "").slice(0, 4000),
      note:
        handlerCount > 0
          ? `已拆出 ${handlerCount} 个 op handler、decode_table ${decodeTableSize} 项 → ${out}。下一步 jsvmp_disassemble(handlers=${out}, bytecode=...)。`
          : "未识别出 dispatcher。可传 col=<dispatcher 函数所在列> 覆盖，或确认 source 是 dispatcher 函数本体。",
    };
  }

  /**
   * 一等工具②：静态反汇编。handlers.json + 字节码 → 伪汇编。
   * 内部 run_node 跑随浏览器打包的 disassemble.cjs（仅依赖 node 内置）。
   * @param {object} p { handlers="handlers.json", bytecode(工作目录内字节码文件), start?, limit?, scan?, cfg?, vpc?, out? }
   */
  async disassemble({ handlers = "handlers.json", bytecode, start, limit, scan, cfg, vpc, out } = {}, ctx) {
    if (!this._workspace || !this._workspace.runNode) {
      throw new Error("workspace 后端不可用");
    }
    if (!bytecode) {
      throw new Error("需要 bytecode（工作目录内的字节码文件路径，hex/二进制）");
    }
    const tool = await this._ensureToolScript("disassemble.cjs", ctx);
    const args = ["--handlers=" + handlers, "--bytecode=" + bytecode];
    if (start != null) {
      args.push("--start=" + start);
    }
    if (limit != null) {
      args.push("--limit=" + limit);
    }
    if (scan) {
      args.push("--scan");
    }
    if (cfg) {
      args.push("--cfg");
    }
    if (vpc) {
      args.push("--vpc=" + vpc);
    }
    // 默认把完整反汇编写到工作目录文件，避免巨量文本直接进对话；只回摘要 + 头部。
    const outFile = out || "disasm.txt";
    args.push("--out=" + outFile);
    const run = await this._workspace.runNode({ file: tool, args }, ctx);
    let head = "";
    let lines = 0;
    try {
      const d = await this._workspace.read({ path: outFile, maxBytes: 8 * 1024 }, ctx);
      head = d.content;
      lines = (d.content.match(/\n/g) || []).length;
    } catch {
      /* 没产出 */
    }
    return {
      ok: run.ok,
      out: outFile,
      exitCode: run.exitCode,
      log: (run.output || "").slice(0, 2000), // disassemble 把统计写在 stderr
      headPreview: head, // 反汇编开头若干行（已落盘到 out，可 fs_read 看全量）
      note: `反汇编已写入 ${outFile}（用 fs_read 看全量）。headPreview 是开头片段。`,
    };
  }

  /**
   * 一等工具③：wasm-bindgen 签名器 import-trace（站点无关、零三方依赖）。
   * 在 node 里加载 wasm-bindgen 的 glue + .wasm，hook 所有 wbg import 打 I/O 日志，
   * 揭示 wasm 在 签名器 初始化/sign 时究竟读了哪些 DOM/env（querySelector/getAttribute/navigator…）
   * 并把 (ptr,len) 实参解码成可读的 selector / 属性名。极简 fake DOM 由 selectors/navigator 驱动。
   * 用法：先空跑（不传 selectors）发现 wasm 读了哪些选择器/属性 → 再用 page_eval 在浏览器取真值、
   * 用 selectors 喂回复现签名输入。⚠ 它在 node 里 eval 原始 glue（与 run_node 同等性质，本地分析用）。
   * @param {object} p {
   *   gluePath(工作目录内 wasm-bindgen glue .js), wasmPath(工作目录内 .wasm),
   *   selectors?({"<css>":{"<attr>":"<value>"}} 喂真值), navigator?({webdriver,userAgent,platform,language}),
   *   url?, signUrl?, signTs?, attrDefault?(未知属性默认返回值),
   *   callExpr?(init 后 eval，作用域含 __G；不传则自动找返回含 .sign 的导出并调 sign(signUrl,signTs)),
   *   signerExpr?(在 glue **模块作用域**里求值拿签名器的表达式，如 "Ee()" / "new pe()"——能拿到闭包内
   *              的 pe/Ee（callExpr 作用域只有 __G、够不到它们）；拿到后自动 .sign(signUrl,signTs) 出签名)
   * }
   */
  async wasmProbe({ gluePath, wasmPath, selectors, navigator, url, signUrl, signTs, attrDefault, callExpr, signerExpr } = {}, ctx) {
    if (!this._workspace || !this._workspace.runNode) {
      throw new Error("workspace 后端不可用");
    }
    if (!gluePath || !wasmPath) {
      throw new Error("需要 gluePath（wasm-bindgen glue .js）+ wasmPath（.wasm），均为工作目录内路径");
    }
    const root = this._getWorkspaceRoot && this._getWorkspaceRoot(ctx);
    if (!root) {
      throw new Error("需要先设置工作目录（侧边栏「打开目录」）");
    }
    const tool = await this._ensureToolScript("wasm_probe.cjs", ctx);
    // ⚠ PathUtils.join 要求每个分量是**单段**；传 "scripts/glue.js" 这种多段相对路径会抛
    //   NS_ERROR_FILE_UNRECOGNIZED_PATH。故按 / 拆段再 join（绝对路径直接用）。
    const abs = (p) => {
      const s = String(p || "");
      if (s.startsWith("/")) return s;
      const segs = s.split(/[\\/]+/).filter((x) => x && x !== ".");
      return PathUtils.join(root, ...segs);
    };
    const cfg = {
      wasmPath: abs(wasmPath),
      gluePath: abs(gluePath),
      url: url || null,
      navigator: navigator || {},
      selectors: selectors || {},
      attrDefault: attrDefault != null ? attrDefault : "",
      signUrl: signUrl || "/",
      signTs: signTs != null ? signTs : Math.floor(Date.now() / 1000),
      callExpr: callExpr || null,
      signerExpr: signerExpr || null,
    };
    const cfgRel = ".agent-tools/_wasm_probe_config.json";
    await this._workspace.write({ path: cfgRel, content: JSON.stringify(cfg) }, ctx);
    const run = await this._workspace.runNode({ file: tool, args: [cfgRel] }, ctx);
    let parsed = null;
    const m = (run.output || "").match(/__WASM_PROBE_JSON__(.+)/);
    if (m) {
      try {
        parsed = JSON.parse(m[1]);
      } catch {
        /* JSON 截断或畸形 */
      }
    }
    if (!parsed) {
      return {
        ok: false,
        exitCode: run.exitCode,
        log: (run.output || "").slice(0, 2500),
        note: "未解析到 probe 结果。确认 gluePath 是 wasm-bindgen glue（含 __wbg_* import）、wasmPath 是对应 .wasm；或 sign 入口需用 callExpr 指定。",
      };
    }
    const calls = parsed.calls || [];
    // 工具结果必须控制在 TOOL_RESULT_CAP(6000) 内——calls 每条最长 ~160 字符。
    // 截为 30 条（~5KB + note/exportsKeys/signPreview ≈ 5.8KB < 6KB）；error 截 300 字符防爆（堆栈很长）。
    // allImports：**所有**被调的 wbg import 名→次数（含 INTEREST 白名单外的）。treat as 完整清单——
    // 若 calls 里"只看到 favicon"但输出对不上，来这里看有没有被白名单滤掉的隐藏读取（实战痛点）。
    const allImports = parsed.allImports && typeof parsed.allImports === "object" ? parsed.allImports : {};
    const allImportNames = Object.keys(allImports).sort((a, b) => (allImports[b] || 0) - (allImports[a] || 0)).slice(0, 40);
    return {
      ok: !!(parsed.ok && calls.length),
      calls: calls.slice(0, 30),
      callCount: calls.length,
      allImportNames,                 // ← 完整 import 名清单（按调用次数）；calls 是其中能解码的"有意思"子集
      exportsKeys: parsed.exportsKeys || [],
      signKind: parsed.signKind || null,
      signPreview: parsed.signPreview || null,
      error: parsed.error ? String(parsed.error).slice(0, 300) : null,
      note: calls.length
        ? "wasm 在 init/sign 时读的 DOM/env 都在 calls 里（字符串已解码）；**allImportNames 是它调的全部 import**——若 calls 只见 favicon 但复刻对不上，对照 allImportNames 找被滤掉的隐藏读取。下一步：page_eval 取每个真值 → 传 selectors 复现。**signPreview 空（自动找不到 sign）多半因签名器是 glue 闭包里的类（如 pe，靠工厂 Ee() 造）——别手改 glue 导出/兜圈子：直接传 `signerExpr`（如 \"Ee()\" 或 \"new pe()\"，在模块作用域求值）就能拿到它并自动 .sign(signUrl,signTs) 出签名。**"
        : "未捕获到 wbg 调用。可能 gluePath/wasmPath 不匹配，或 sign 入口需 callExpr/signerExpr 指定。",
    };
  }

  /**
   * P5 白盒 · Node 复刻侧引擎级 trace（非侵入）。把工作目录内的 Node 复刻 loader（kind:"js"）或
   * .wasm（kind:"wasm"）跑在 node:inspector / wasm import 边界下，落归一化覆盖/序列到 out。
   * 与浏览器真值 whitebox_diff(action:diff) 比对找分叉。零 Proxy 包 env、零 AST 插桩、零源码改动。
   * @param {object} p { entry, kind="js"|"wasm", entryFn?, entryArgs?, out?="work/wb_node.json" }
   */
  async whiteboxNode({ entry, entryFn, entryArgs, kind = "js", out = "work/wb_node.json", neutralizeCrash } = {}, ctx) {
    if (!this._workspace || !this._workspace.runNode) {
      throw new Error("workspace 后端不可用");
    }
    if (!entry) {
      throw new Error("需要 entry（工作目录内的 Node 复刻 loader，或 kind:'wasm' 时的 .wasm 路径）");
    }
    const root = this._getWorkspaceRoot && this._getWorkspaceRoot(ctx);
    if (!root) {
      throw new Error("需要先设置工作目录");
    }
    const abs = (p) => {
      const s = String(p || "");
      if (s.startsWith("/")) return s;
      const segs = s.split(/[\\/]+/).filter((x) => x && x !== ".");
      return PathUtils.join(root, ...segs);
    };
    const isWasm = kind === "wasm";
    const tool = await this._ensureToolScript(isWasm ? "whitebox_wasm_trace.cjs" : "whitebox_node_trace.cjs", ctx);
    const cfg = isWasm
      ? { wasmPath: abs(entry), callExport: entryFn || undefined, callArgs: entryArgs || [], neutralizeCrash: neutralizeCrash !== false }
      : { entry: abs(entry), entryFn: entryFn || undefined, entryArgs: entryArgs || [], neutralizeCrash: neutralizeCrash !== false };
    const cfgRel = ".agent-tools/_wb_node_cfg.json";
    await this._workspace.write({ path: cfgRel, content: JSON.stringify(cfg) }, ctx);
    const run = await this._workspace.runNode({ file: tool, args: [cfgRel] }, ctx);
    const marker = isWasm ? "__WHITEBOX_WASM_JSON__" : "__WHITEBOX_JSON__";
    const m = (run.output || "").match(new RegExp(marker + "(.+)"));
    let trace = null;
    try { trace = JSON.parse(m[1]); } catch { /* 无标记/截断 */ }
    if (!trace) {
      return { ok: false, exitCode: run.exitCode, log: (run.output || "").slice(0, 2000), note: "未解析到 node trace。确认 entry 路径与 kind(js/wasm)。" };
    }
    await this._workspace.write({ path: out, content: JSON.stringify(trace) }, ctx);
    const branchN = isWasm
      ? (trace.wasmImports || []).length
      : Object.values(trace.scripts || {}).reduce((s, x) => s + (x.notTaken || []).length, 0);
    return {
      ok: !!trace.ok,
      out, kind, nodeTracePath: out,
      notTakenBranches: isWasm ? undefined : branchN,
      wasmImportCount: isWasm ? branchN : undefined,
      crashes: (trace.crashes || []).map((c) => c.sink),
      preview: isWasm ? (trace.wasmImports || []).slice(0, 8) : (trace.notTakenPreview || []).slice(0, 8),
      error: trace.error ? String(trace.error).slice(0, 300) : null,
      note: "已落 Node 复刻覆盖/序列到 " + out + "。下一步：whitebox_diff(action:start,scriptUrl) 装浏览器真值 → 触发执行 → action:query → action:diff 比对。",
    };
  }

  /**
   * P5 白盒 · 差分。比对"浏览器真值 trace"与"Node 复刻 trace"→ 第一处分叉分支(源码行/偏移)+驱动它的 env 值。
   * matchBy:"offset"(默认,跨引擎 V8↔SpiderMonkey + 压缩单行 鲁棒,带容差)/"line"/"snippet"(同引擎)。
   * env 可选；**不给则自动捞 `webapi/fingerprint-env.ndjson`**(webapi_trace env 模式落的真值)→ 注入
   * browserTrace.envReads，driver(分叉条件读的 env)自动点亮。
   * @param {object} p { browser?="work/wb_browser.json", node?="work/wb_node.json", matchBy?="offset", env?, out?="work/wb_report.json" }
   */
  async whiteboxDiff({ browser = "work/wb_browser.json", node = "work/wb_node.json", matchBy = "offset", env, out = "work/wb_report.json" } = {}, ctx) {
    if (!this._workspace || !this._workspace.runNode) {
      throw new Error("workspace 后端不可用");
    }
    const root = this._getWorkspaceRoot && this._getWorkspaceRoot(ctx);
    if (!root) {
      throw new Error("需要先设置工作目录");
    }
    const abs = (p) => {
      const s = String(p || "");
      if (s.startsWith("/")) return s;
      const segs = s.split(/[\\/]+/).filter((x) => x && x !== ".");
      return PathUtils.join(root, ...segs);
    };
    const tool = await this._ensureToolScript("whitebox_diff.cjs", ctx);
    const cfg = { nodeTrace: abs(node), browserTrace: abs(browser), matchBy };
    // env 真值：显式 env 路径优先；**否则自动捞 webapi_trace(env) 落的 webapi/fingerprint-env.ndjson**
    // → 注入 browserTrace.envReads，让 driver(分叉条件读的 env)自动点亮，不必 agent 手传。
    const loadEnv = async (path, ndjson) => {
      try {
        const txt = (await this._workspace.read({ path }, ctx)).content;
        if (ndjson || /\.ndjson$/.test(path)) {
          const out = [];
          for (const line of txt.split("\n")) {
            const s = line.trim(); if (!s) continue;
            let o; try { o = JSON.parse(s); } catch { continue; }
            if (o._meta || o.m == null) continue;            // 跳 _meta 行；每行 {if,m,count,values}
            const ifn = o.if || "", member = o.m;
            out.push({ name: (ifn ? ifn + "." : "") + member, member, value: Array.isArray(o.values) ? o.values[0] : o.values });
          }
          return out.length ? out : null;
        }
        const j = JSON.parse(txt);
        return Array.isArray(j) ? j : (j.envReads || null);
      } catch { return null; }
    };
    let envReads = env ? await loadEnv(env) : null;
    let envAuto = false;
    if (!envReads) { envReads = await loadEnv("webapi/fingerprint-env.ndjson", true); envAuto = !!envReads; }
    if (envReads && envReads.length) {
      try {
        const bj = JSON.parse((await this._workspace.read({ path: browser }, ctx)).content);
        bj.envReads = envReads;
        const mergedRel = ".agent-tools/_wb_browser_env.json";
        await this._workspace.write({ path: mergedRel, content: JSON.stringify(bj) }, ctx);
        cfg.browserTrace = abs(mergedRel);
      } catch { /* 合并失败 → 用原 browser trace */ }
    }
    const cfgRel = ".agent-tools/_wb_diff_cfg.json";
    await this._workspace.write({ path: cfgRel, content: JSON.stringify(cfg) }, ctx);
    const run = await this._workspace.runNode({ file: tool, args: [cfgRel] }, ctx);
    const m = (run.output || "").match(/__WHITEBOX_DIFF_JSON__(.+)/);
    let r = null;
    try { r = JSON.parse(m[1]); } catch { /* 无标记/截断 */ }
    if (!r) {
      return { ok: false, exitCode: run.exitCode, log: (run.output || "").slice(0, 2000), note: "未解析到 diff 结果。确认先做了 action:node（出 wb_node.json）+ action:query（出 wb_browser.json）。" };
    }
    await this._workspace.write({ path: out, content: JSON.stringify(r) }, ctx);
    return {
      ok: !!r.ok,
      out,
      firstDivergence: r.firstDivergence || null,
      driver: r.driver || null,
      divergenceCount: r.divergenceCount || 0,
      envTruthCount: (r.envTruth || []).length,
      envSource: env ? "显式 env" : (envAuto ? "自动捞 webapi/fingerprint-env.ndjson" : "无(先 webapi_trace env 模式)"),
      envMismatch: (r.envMismatch || []).slice(0, 8),
      crashes: (r.crashes || []).map((c) => (c && c.sink) || c),
      summary: r.summary || null,
      note: "完整报告在 " + out + "。firstDivergence=首处浏览器/Node 走法不同的分支(源码行/偏移)；driver=驱动它的 env 值——把 Node 补环境对齐到浏览器真值再跑。" +
        (r.driver ? "" : " driver 为空 → 先 webapi_trace(env 模式) 触发同一操作落 fingerprint-env.ndjson，再 whitebox_diff(action:diff) 自动点亮。"),
    };
  }

  /**
   * 一等工具④：WASM 反汇编。用 wabt 把 .wasm → 可读 WAT（保留 wasm-bindgen 的函数/导出名），
   * 完整落盘到 <工作目录>/wasm/<名>.wat（别整读），只回摘要(函数/导出/导入数 + 导出名→索引 + 导入名)；
   * 传 func=导出名或索引 → 抽出该函数的 WAT 段（看具体方法实现）。配合 wasm_probe(边界 I/O)=内部+边界都能分析。
   * 首次用自动 npm 装 wabt 到工作目录。
   * @param {object} p { wasmPath(工作目录内 .wasm), func?(导出名/索引), out?(默认 wasm/<名>.wat) }
   */
  async wasmDisasm({ wasmPath, func, out } = {}, ctx) {
    if (!this._workspace || !this._workspace.runNode) {
      throw new Error("workspace 后端不可用");
    }
    if (!wasmPath) {
      throw new Error("需要 wasmPath（工作目录内 .wasm 文件路径）");
    }
    const root = this._getWorkspaceRoot && this._getWorkspaceRoot(ctx);
    if (!root) {
      throw new Error("需要先设置工作目录（侧边栏「打开目录」）");
    }
    const abs = (p) => {
      const s = String(p || "");
      if (s.startsWith("/")) return s;
      const segs = s.split(/[\\/]+/).filter((x) => x && x !== ".");
      return PathUtils.join(root, ...segs);
    };
    // 确保 wabt 已装（首次自动 npm_install 到工作目录）
    let hasWabt = false;
    try {
      hasWabt = !!(await IOUtils.stat(PathUtils.join(root, "node_modules", "wabt")));
    } catch {
      /* 未装 */
    }
    if (!hasWabt) {
      if (!this._workspace.npmInstall) {
        throw new Error("需要 wabt 但 npm_install 不可用");
      }
      await this._workspace.npmInstall({ packages: ["wabt"] }, ctx);
    }
    const tool = await this._ensureToolScript("wasm_disasm.cjs", ctx);
    const base = (String(wasmPath).split(/[\\/]/).pop() || "module").replace(/\.wasm$/i, "");
    const outRel = out || "wasm/" + base + ".wat";
    // 确保输出子目录存在（结构化：WAT 落 wasm/）
    const outDir = outRel.split(/[\\/]/).slice(0, -1).join("/");
    if (outDir) {
      await this._workspace.mkdir({ path: outDir }, ctx);
    }
    const cfg = { wasmPath: abs(wasmPath), out: abs(outRel), outRel, func: func != null ? func : "" };
    const cfgRel = ".agent-tools/_wasm_disasm_config.json";
    await this._workspace.write({ path: cfgRel, content: JSON.stringify(cfg) }, ctx);
    const run = await this._workspace.runNode({ file: tool, args: [cfgRel] }, ctx);
    let parsed = null;
    const m = (run.output || "").match(/__WASM_DISASM_JSON__(.+)/);
    if (m) {
      try {
        parsed = JSON.parse(m[1]);
      } catch {
        /* 截断/畸形 */
      }
    }
    if (!parsed) {
      return {
        ok: false,
        exitCode: run.exitCode,
        log: (run.output || "").slice(0, 2500),
        note: "未解析到反汇编结果。确认 wasmPath 是有效 .wasm；或 wabt 安装失败（看 log）。",
      };
    }
    return parsed;
  }

  /** 把 trace 文件镜像到 <工作目录>/jsvmp/，让 trace 缓存落在用户打开的目录下。
   *  size+mtime 相同则跳过，避免重复拷贝大文件。返回目标路径或 null。 */
  async _relayToWorkspace(f) {
    try {
      const root = this._getWorkspaceRoot && this._getWorkspaceRoot(ctx);
      if (!root || !f) {
        return null;
      }
      let srcStat;
      try {
        srcStat = await IOUtils.stat(f);
      } catch {
        return null;
      }
      const dir = PathUtils.join(root, "jsvmp");
      await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
      const dest = PathUtils.join(dir, PathUtils.filename(f));
      let need = true;
      try {
        const ds = await IOUtils.stat(dest);
        if (ds.size === srcStat.size && (ds.lastModified || 0) >= (srcStat.lastModified || 0)) {
          need = false;
        }
      } catch {
        /* dest 不存在 → 需拷 */
      }
      if (need) {
        await IOUtils.copy(f, dest);
      }
      return dest;
    } catch {
      return null;
    }
  }

  async _findTrace(ctx) {
    if (this._fixed) {
      return this._fixed;
    }
    const env = Services.env || Cc["@mozilla.org/process/environment;1"]?.getService(Ci.nsIEnvironment);
    const fromEnv = safe(() => env && env.get("MOZ_JSVMP_TRACE_FILE"));
    if (fromEnv) {
      return fromEnv;
    }
    let files = [];
    try {
      files = await IOUtils.getChildren(traceDir());
    } catch {
      return null;
    }
    // 只认真正的 NDJSON trace 文件；**排除控制文件 .ctl**（它同样以 PREFIX 开头，
    // 若被当成 trace 文件，start 刚写完 ctl 它就成了"最新"，query 会去读它 → 读不到数据）。
    const cands = files.filter(f => {
      const n = PathUtils.filename(f);
      return n.startsWith(PREFIX) && n.includes(".ndjson") && !n.endsWith(".ctl");
    });
    if (!cands.length) {
      return null;
    }
    // 关键：trace 文件按进程 pid 分文件（`...ndjson.<pid>`）。页面脚本（目标站点的 JS）跑在
    // **内容进程**，父进程(chrome JS)只会产生 resource://gre / chrome:// 噪声。
    // 优先选「当前标签页内容进程」那份，否则永远读到父进程噪声、抓不到网页字节码。
    const pid = currentContentPid(ctx);
    if (pid) {
      const hit = cands.find(f => PathUtils.filename(f).endsWith("." + pid));
      if (hit) {
        return hit;
      }
    }
    // 退回最新的一份
    let best = null;
    let bestT = -1;
    for (const f of cands) {
      try {
        const s = await IOUtils.stat(f);
        const t = s.lastModified || 0;
        if (t > bestT) {
          bestT = t;
          best = f;
        }
      } catch {}
    }
    return best;
  }

  async status(_args, ctx) {
    const f = await this._findTrace(ctx);
    let tracing = false;
    try {
      // per-PID ctl：与 C++ MaybePollControlFile 保持一致，每个内容进程独享
      const pid = currentContentPid(ctx);
      const ctlBase = traceDir() + "/firefox-reverse-jsvmp.ctl";
      const ctlPath = pid ? ctlBase + "." + pid : ctlBase;
      const ctl = await IOUtils.readUTF8(ctlPath);
      tracing = ctl.trim().startsWith("1");
    } catch {
      /* 控制文件不存在 = 没开过 */
    }
    const pid = currentContentPid(ctx);
    const fileForContent = !!(f && pid && PathUtils.filename(f).endsWith("." + pid));
    return {
      ok: true,
      tracing, // 运行期开关是否已打开
      hasTrace: !!f, // 是否已产生 trace 文件
      enabled: !!f, // 兼容旧字段
      traceFile: f,
      contentPid: pid, // 当前标签页内容进程 pid
      readingContentProcess: fileForContent, // true=正在读网页内容进程的 trace（页面脚本）
      note: tracing
        ? f
          ? "trace 已开启且有记录，可用 jsvmp_query 读取。"
          : "trace 已开启但还没记录；到目标页触发 JS（刷新/交互/请求）再 jsvmp_query。"
        : "trace 未开启。**调用 jsvmp_trace(action:'start') 即可运行期开启，无需重启浏览器**，再触发目标页 JS，然后 jsvmp_query。",
    };
  }

  /**
   * 读取/筛选 trace 记录。**默认返回最近(尾部) limit 条**——trace 是 append-only，最新触发
   * (如刚调的 signer)在文件尾；旧实现读文件头会一直返回页面加载早期的陈旧记录，导致 Agent
   * 反复 query 也看不到刚触发的 op、空转直至超时。这里改为读尾窗、从尾向前收集后再恢复时间序。
   * @param {object} p { limit=200, op, pcMin, pcMax, hasArgs, hasRet, opsOnly,
   *                      filter?(兼容 schema 里的嵌套写法 {op,pcMin,...}) }
   */
  async query({ limit = 200, op, pcMin, pcMax, hasArgs, hasRet, opsOnly = false, filter } = {}, ctx) {
    // 兼容：工具 schema 把筛选项放在 filter 对象里；模型若按此传入，平铺到顶层。
    if (filter && typeof filter === "object") {
      if (op == null) op = filter.op;
      if (pcMin == null) pcMin = filter.pcMin;
      if (pcMax == null) pcMax = filter.pcMax;
      if (hasArgs == null) hasArgs = filter.hasArgs;
      if (hasRet == null) hasRet = filter.hasRet;
      if (filter.opsOnly != null) opsOnly = filter.opsOnly;
      if (filter.limit != null) limit = filter.limit;
    }
    const f = await this._findTrace(ctx);
    if (!f) {
      return {
        ok: true,
        count: 0,
        records: [],
        note: "还没有 trace 记录。先 jsvmp_trace(action:'start') 开启（运行期，无需重启），再触发目标页 JS 生成参数，然后再 jsvmp_query。",
      };
    }
    const CAP = 16 * 1024 * 1024;
    let text;
    let truncatedHead = false;
    try {
      // 只读最后 CAP 字节（尾窗）：既防超大 trace 撑爆内存，又保证拿到的是最新记录。
      const st = await IOUtils.stat(f);
      const size = st.size || 0;
      const offset = size > CAP ? size - CAP : 0;
      truncatedHead = offset > 0;
      const bytes = await IOUtils.read(f, offset ? { offset, maxBytes: CAP } : { maxBytes: CAP });
      text = new TextDecoder().decode(bytes);
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
    const lines = text.split("\n");
    const out = [];
    // 从尾向前扫，收集最近 limit 条匹配记录。（尾窗首行可能是半行 → JSON.parse 失败自然丢弃）
    for (let i = lines.length - 1; i >= 0; i--) {
      const ln = lines[i];
      if (!ln) {
        continue;
      }
      let o;
      try {
        o = JSON.parse(ln);
      } catch {
        continue;
      }
      if (o._meta || o._warn) {
        continue; // 纯记账行（meta/上限警告），非记录，跳过
      }
      const isOp = o.op !== undefined || o.n !== undefined;
      if (opsOnly && !isOp) {
        continue; // 只看 opcode 行时，跳过 _script/_args/_locals/_vpc/_ret
      }
      if (op && o.op !== op && o.n !== op) {
        continue;
      }
      if (pcMin != null && !(o.pc >= pcMin)) {
        continue;
      }
      if (pcMax != null && !(o.pc <= pcMax)) {
        continue;
      }
      if (hasArgs && !o.args) {
        continue;
      }
      if (hasRet && o.ret === undefined) {
        continue;
      }
      out.push(o);
      if (out.length >= limit) {
        break;
      }
    }
    out.reverse(); // 收集时是尾→头，反转回时间顺序（旧→新）
    // 把 trace 镜像到工作目录（若已设），让缓存落在用户打开的目录下。
    const workspaceCopy = await this._relayToWorkspace(f);
    return {
      ok: true,
      traceFile: f,
      count: out.length,
      records: out,
      recent: true, // 标明返回的是最近尾部记录
      ...(truncatedHead ? { truncatedHead: true } : {}),
      ...(workspaceCopy ? { workspaceCopy } : {}),
    };
  }

  /** 运行期 dump 配置文件路径（按当前标签内容进程 pid 区分，只配该进程）。 */
  _dumpPath(pid) {
    return traceDir() + "/firefox-reverse-jsvmp.dump." + pid;
  }

  /**
   * 写运行期 dump 配置（actions: locals/env/vpc/ret/args）。引擎下次摊销轮询即消费、即时生效，
   * 无需重启浏览器（修掉 dump_* 原本只能启动期 env 配的缺陷）。actions 为空 → 写 "off" 全关。
   * col 是目标函数所在列（split/disassemble 可得）；locals+env=1 用于深序列化闭包常量对象。
   */
  async _writeDumpConfig({ actions, col = 0, pc = 0, env = false, depth, limit, skip = 0, maxarr, vpcPc, vpcLimit } = {}, ctx) {
    const pid = currentContentPid(ctx);
    if (!pid) {
      return { ok: false, note: "无法确定当前标签内容进程（先打开/聚焦目标页）。" };
    }
    const set = new Set((actions || []).map(a => String(a)));
    const c = col | 0;
    const lines = [];
    if (set.has("locals")) {
      let l = `locals col=${c} pc=${pc | 0} env=${env ? 1 : 0}`;
      if (limit != null) l += ` limit=${limit | 0}`;
      if (skip) l += ` skip=${skip | 0}`;
      if (depth != null) l += ` depth=${depth | 0}`;
      if (maxarr != null) l += ` maxarr=${maxarr | 0}`;
      lines.push(l);
    }
    if (set.has("vpc")) {
      let l = `vpc col=${c} pc=${(vpcPc != null ? vpcPc : pc) | 0}`;
      const vl = vpcLimit != null ? vpcLimit : limit;
      if (vl != null) l += ` limit=${vl | 0}`;
      lines.push(l);
    }
    if (set.has("ret")) {
      let l = `ret col=${c}`;
      if (limit != null) l += ` limit=${limit | 0}`;
      if (skip) l += ` skip=${skip | 0}`;
      lines.push(l);
    }
    if (set.has("args")) {
      let l = `args col=${c}`;
      if (limit != null) l += ` limit=${limit | 0}`;
      lines.push(l);
    }
    const spec = lines.length ? lines.join("\n") : "off";
    await IOUtils.writeUTF8(this._dumpPath(pid), spec);
    return { ok: true, contentPid: pid, spec, modes: [...set] };
  }

  /**
   * 运行期 start/stop/status/clear/dump trace（写控制文件，引擎摊销轮询，秒级生效，无需重启）。
   * @param {object} p {
   *   action: "start"|"stop"|"status"|"clear"|"dump",
   *   scriptUrl?: 过滤子串,
   *   actions?: ["locals"|"env"|"vpc"|"ret"|"args"]（dump 模式，运行期生效）,
   *   col?, pc?, env?(bool,配 locals 走闭包链), depth?, limit?, skip?, maxarr?, vpcPc?, vpcLimit?
   * }
   */
  async trace({ action = "status", scriptUrl, actions, col, pc, env, depth, limit, skip, maxarr, vpcPc, vpcLimit } = {}, ctx) {
    // per-PID ctl：每个内容进程（标签页/会话）独享自己的控制文件，与 C++ MaybePollControlFile 一致。
    const CTL_BASE = traceDir() + "/firefox-reverse-jsvmp.ctl";
    const _pid = currentContentPid(ctx);
    const CTL = _pid ? CTL_BASE + "." + _pid : CTL_BASE;
    const dumpCfg = { actions, col, pc, env, depth, limit, skip, maxarr, vpcPc, vpcLimit };
    if (action === "start") {
      // 过滤按脚本"名"子串匹配：传完整 URL 时自动取文件名（去掉查询串/路径），否则匹配不上→会全量 trace。
      let filter = (scriptUrl || "").trim();
      if (filter && /[/?#]/.test(filter)) {
        const base = filter.split(/[?#]/)[0].split("/").filter(Boolean).pop();
        if (base) {
          filter = base;
        }
      }
      // 必须带 scriptUrl：无 filter＝在解释器模式下逐 op 记录**所有脚本**，比 webapi 全量更狠，
      // 会把页面彻底卡死/标签空白。直接拒绝，且**不**在拒绝时关 JIT（否则白白拖慢全局）。
      if (!filter) {
        return {
          ok: false,
          action: "start",
          error:
            "jsvmp trace 必须带 scriptUrl（目标脚本文件名子串）。无 filter＝逐 op 记录所有脚本且强制解释器模式，会把浏览器卡到标签空白，已禁止。",
          hint:
            "填目标脚本的文件名子串（如混淆大 bundle 的名字，不是完整 URL）。先用 page_eval/网络面板确认目标脚本名，再 start。",
        };
      }
      // 强制纯解释器：关 blinterp/baseline/ion，否则热函数(如签名/混淆 dispatcher)被 JIT 接管、
      // 绕过 js::Interpret(hook 所在层) → 反复调用抓不到。trace 期间走解释器，stop 再恢复。
      this._setJit(false);
      const body = "1\n" + filter;
      await IOUtils.writeUTF8(CTL, body);
      // 若同时带了 dump actions（locals/env/vpc/ret/args），顺便下发运行期 dump 配置。
      let dump = null;
      if (Array.isArray(actions) && actions.length) {
        dump = await this._writeDumpConfig(dumpCfg, ctx);
      }
      return {
        ok: true,
        action: "start",
        control: CTL,
        filter: filter || "(all scripts)",
        ...(dump ? { dump } : {}),
        note:
          `已开启 trace（filter=${filter || "全部"}，已强制解释器模式/关JIT）。` +
          "**关键：现在刷新/重载目标页**——让已加载脚本在解释器下重跑，之后每次触发(交互/fetch)生成参数都会被逐 op 记录；" +
          "再 jsvmp_query 读。不要反复 status/start。务必带 scriptUrl（目标脚本的文件名子串，不是完整 URL）。" +
          "需要运行期常量/闭包对象时用 action:'dump' 带 actions（如 ['locals'],env:true,col:目标函数列）。" +
          "⏱ trace 约 5 分钟没刷新会**自动关闭**(防忘了 stop)，用完请 stop；需要更久就重新 start。",
      };
    }
    if (action === "dump") {
      // 运行期设置 dump 配置（trace 须已 start）。actions 为空 → 关闭所有 dump。
      const res = await this._writeDumpConfig(dumpCfg, ctx);
      if (!res.ok) {
        return { ok: false, action: "dump", note: res.note };
      }
      return {
        ok: true,
        action: "dump",
        contentPid: res.contentPid,
        spec: res.spec,
        modes: res.modes,
        note:
          res.spec === "off"
            ? "已关闭所有运行期 dump。"
            : `已设置运行期 dump(${res.modes.join("+") || "无"})。引擎下次执行目标脚本即生效；` +
              "现在触发一次目标操作，再 jsvmp_query 读 `_locals`/`_vpc`/`_ret`/`_args` 记录。" +
              "**col 必须是目标函数所在列**（用 jsvmp_split_dispatcher 的 detect 或反汇编可得，传错则不触发）。",
      };
    }
    if (action === "stop") {
      await IOUtils.writeUTF8(CTL, "0");
      this._setJit(true); // 恢复 JIT
      // 关掉运行期 dump（写 off，避免遗留配置在下次 start 时仍触发）
      try {
        const pid = currentContentPid(ctx);
        if (pid) {
          await IOUtils.writeUTF8(this._dumpPath(pid), "off");
        }
      } catch {
        /* ignore */
      }
      // trace 结束：把最终 trace 文件镜像到工作目录。
      let workspaceCopy = null;
      try {
        const f = await this._findTrace(ctx);
        workspaceCopy = await this._relayToWorkspace(f);
      } catch {
        /* ignore */
      }
      return { ok: true, action: "stop", control: CTL, ...(workspaceCopy ? { workspaceCopy } : {}) };
    }
    if (action === "clear") {
      // 清空当前 trace 缓冲但保持开启：丢掉页面加载噪声，紧接着触发目标操作前用。
      // 请求文件按内容进程 pid 区分，引擎下次进解释器(摊销轮询)时消费 → 截断文件+重置计数+解上限锁。
      const pid = currentContentPid(ctx);
      if (!pid) {
        return {
          ok: false,
          action: "clear",
          note: "无法确定当前标签的内容进程（先打开/聚焦目标页再 clear）。",
        };
      }
      const CLR = traceDir() + "/firefox-reverse-jsvmp.clear." + pid;
      await IOUtils.writeUTF8(CLR, String(Date.now()));
      // 等内容进程消费（它只在执行 JS 时轮询）。以"请求文件被删除"为已清空的确证信号。
      const { setTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      let cleared = false;
      for (let i = 0; i < 8; i++) {
        await sleep(250);
        try {
          await IOUtils.stat(CLR); // 还在 = 未消费
        } catch {
          cleared = true; // stat 抛错 = 文件已被引擎删除 = 已清空
          break;
        }
      }
      return {
        ok: true,
        action: "clear",
        cleared,
        contentPid: pid,
        note: cleared
          ? "trace 缓冲已清空（仍开启+解释器钉死）。现在触发一次目标操作（签名/请求），再 jsvmp_query 即只看到这次记录。"
          : "已发出清空请求；内容进程将在下次执行 JS 时清空。可直接触发目标操作后 jsvmp_query（query 默认读最新尾部，旧噪声不影响）。",
      };
    }
    return this.status();
  }

  /**
   * 能力 D：通用 JS 逐函数 trace（静态 AST 插桩 + Node 执行）。
   * 用于非 JSVMP 的普通 JS（混淆 bundle / signer / 工具函数等）。
   * 三种模式：
   *   "static"     — 只列出所有函数名/位置（无执行）
   *   "instrument" — 生成插桩版 + runner 脚手架，再 run_node 执行
   *   "run"        — 插桩 + 立即执行 + 返回调用树
   * 首次用自动 npm install acorn 到工作目录。
   * @param {object} p {
   *   scriptPath(工作目录内 .js), mode?"static"|"instrument"|"run",
   *   entryFn?(入口函数名), entryArgs?(参数数组),
   *   filterFn?(正则子串，只插桩/显示匹配的函数), maxCalls?=2000
   * }
   */
  async jsTrace({ scriptPath, mode = "static", entryFn, entryArgs, filterFn, maxCalls } = {}, ctx) {
    if (!this._workspace || !this._workspace.runNode) {
      throw new Error("workspace 后端不可用");
    }
    if (!scriptPath) {
      throw new Error("需要 scriptPath（工作目录内的 JS 文件路径）");
    }
    const root = this._getWorkspaceRoot && this._getWorkspaceRoot(ctx);
    if (!root) {
      throw new Error("需要先设置工作目录（侧边栏「打开目录」）");
    }
    const abs = p => {
      const s = String(p || "");
      if (s.startsWith("/")) return s;
      const segs = s.split(/[\\/]+/).filter(x => x && x !== ".");
      return PathUtils.join(root, ...segs);
    };
    // 确保 acorn 已装（与 wabt 同模式，首次自动 npm install）
    let hasAcorn = false;
    try {
      hasAcorn = !!(await IOUtils.stat(PathUtils.join(root, "node_modules", "acorn")));
    } catch { /* 未装 */ }
    if (!hasAcorn) {
      if (!this._workspace.npmInstall) {
        throw new Error("需要 acorn 但 npm_install 不可用；请先 npm_install(['acorn'])");
      }
      await this._workspace.npmInstall({ packages: ["acorn"] }, ctx);
    }
    const tool = await this._ensureToolScript("js_trace.cjs", ctx);
    const cfg = {
      scriptPath: abs(scriptPath),
      workDir: root,
      mode,
      entryFn:  entryFn  || null,
      entryArgs: entryArgs || [],
      filterFn: filterFn || null,
      maxCalls: maxCalls || 2000,
    };
    const cfgRel = ".agent-tools/_jstrace_config.json";
    await this._workspace.write({ path: cfgRel, content: JSON.stringify(cfg) }, ctx);
    const run = await this._workspace.runNode({ file: tool, args: [cfgRel] }, ctx);
    let parsed = null;
    const m = (run.output || "").match(/__JS_TRACE_JSON__(.+)/);
    if (m) {
      try { parsed = JSON.parse(m[1]); } catch { /* 截断/畸形 */ }
    }
    if (!parsed) {
      return {
        ok: false,
        exitCode: run.exitCode,
        log: (run.output || "").slice(0, 2500),
        note: "未解析到 js_trace 结果。确认 scriptPath 是有效 JS 文件；或 acorn 安装失败（看 log）。",
      };
    }
    return parsed;
  }

  /** trace 期间关 JIT 强制解释器（false）/ 恢复默认（true）。 */
  _setJit(on) {
    const keys = [
      "javascript.options.blinterp",
      "javascript.options.baselinejit",
      "javascript.options.ion",
    ];
    try {
      for (const k of keys) {
        if (on) {
          Services.prefs.clearUserPref(k); // 恢复默认（JIT 开）
        } else {
          Services.prefs.setBoolPref(k, false); // 关，强制 js::Interpret
        }
      }
      // 立刻落盘：即使之后浏览器被强杀(非正常退出)，stop 的恢复也不会丢，避免 JIT 卡在关闭态。
      Services.prefs.savePrefFile(null);
    } catch {
      /* 没权限/不存在就算了，trace 仍可抓顶层 */
    }
  }
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

/** 当前标签页内容进程的 OS pid（页面脚本的 trace 文件名后缀就是它）。 */
function currentContentPid(ctx) {
  try {
    const win = agentWin(ctx);
    const wgp =
      win &&
      win.gBrowser &&
      win.gBrowser.selectedBrowser &&
      win.gBrowser.selectedBrowser.browsingContext &&
      win.gBrowser.selectedBrowser.browsingContext.currentWindowGlobal;
    return (wgp && wgp.osPid) || null;
  } catch {
    return null;
  }
}

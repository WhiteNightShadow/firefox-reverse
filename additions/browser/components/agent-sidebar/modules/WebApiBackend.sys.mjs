/* WebApiBackend.sys.mjs — 读取/控制 C++ 引擎层「通用 Web-API 调用追踪」(WebApiTraceCore.cpp)。
 *
 * 在 GenericGetter/GenericMethod trampoline 里记录 interface.member(args)→return 到 per-pid NDJSON。
 * 引擎层、JS 不可检测；运行期由控制文件秒级开关，无需重启。与 jsvmp trace 完全独立。
 * 用途：看签名/加密的**环境依赖**(querySelector/getAttribute/navigator.* 读)、**IO 边界**
 * (XHR.setRequestHeader)、**JS↔WASM 边界**(TextDecoder/Crypto)——对 JSVMP/WASM/纯混淆都适用。
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
const PREFIX = "firefox-reverse-webapi";

function agentWin(ctx) {
  try { const w = ctx && ctx.win; if (w && w.gBrowser && !w.closed) return w; } catch {}
  return Services.wm.getMostRecentWindow("navigator:browser");
}

export class WebApiBackend {
  /** @param {object} [opts] { workspace?: WorkspaceBackend(getRoot) } —— 有工作目录就把指纹清单落盘到 <root>/webapi/。 */
  constructor({ workspace } = {}) {
    this._workspace = workspace || null;
  }

  /**
   * 当前内容进程的 per-PID ctl 文件路径（与 C++ MaybePoll 里保持一致）。
   * 每个标签页/内容进程独享自己的 ctl，多会话并行 trace 互不覆盖。
   * 若取不到 pid（无活跃标签页）回退到 CTL_BASE（向下兼容）。
   */
  _ctlPath(ctx) {
    const pid = currentContentPid(ctx);
    const ctlBase = traceDir() + "/firefox-reverse-webapi.ctl";
    return pid ? ctlBase + "." + pid : ctlBase;
  }

  /** 当前工作目录根（未设则 null）。 */
  _root(ctx) {
    try {
      return (this._workspace && this._workspace.getRoot && this._workspace.getRoot(ctx)) || null;
    } catch {
      return null;
    }
  }

  /**
   * 行式 NDJSON 落盘到 <工作目录>/webapi/<name>：第一行 {_meta}，其后每行一条记录。
   * 比单体 pretty JSON 对 AI 友好——可 grep / head / 只读关心的几行 / 部分读都合法，省 token。
   * 返回绝对路径或 null（未设工作目录→跳过）。
   */
  async _saveNdjson(name, meta, rows, ctx) {
    try {
      const root = this._root(ctx);
      if (!root) {
        return null;
      }
      const dir = PathUtils.join(root, "webapi");
      await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
      const dest = PathUtils.join(dir, name);
      const lines = [JSON.stringify({ _meta: meta })];
      for (const r of rows) {
        lines.push(JSON.stringify(r));
      }
      await IOUtils.writeUTF8(dest, lines.join("\n") + "\n");
      await this._ensureAnalyzer(dir);
      return dest;
    } catch {
      return null;
    }
  }

  /** 放一个可重跑的分析脚本到 webapi/，让分组/筛选逻辑在 node 里、AI 可读可改可按站点调（不焊死在引擎里）。 */
  async _ensureAnalyzer(dir) {
    try {
      const p = PathUtils.join(dir, "analyze-fingerprint.js");
      if (await IOUtils.exists(p)) {
        return;
      }
      const src =
        "#!/usr/bin/env node\n" +
        "/* 分析 webapi NDJSON 指纹：node analyze-fingerprint.js [接口子串] [文件=fingerprint-env.ndjson]\n" +
        " * 行式 NDJSON，每行独立可解析；这里按接口分组打印，可自行改筛选/统计逻辑（站点会改版，按需调）。 */\n" +
        "const fs=require('fs'),path=require('path');\n" +
        "const filt=process.argv[2]||'';\n" +
        "const file=process.argv[3]||path.join(__dirname,'fingerprint-env.ndjson');\n" +
        "const lines=fs.readFileSync(file,'utf8').split('\\n').filter(Boolean);\n" +
        "const g={};let meta=null;\n" +
        "for(const ln of lines){let o;try{o=JSON.parse(ln)}catch{continue}if(o._meta){meta=o._meta;continue}\n" +
        "  if(filt&&!(String(o.if||'').includes(filt))) continue;\n" +
        "  (g[o.if]=g[o.if]||[]).push(o);}\n" +
        "if(meta)console.log('# meta',JSON.stringify(meta));\n" +
        "for(const k of Object.keys(g).sort()){console.log('\\n== '+k+' ==');\n" +
        "  for(const o of g[k])console.log('  '+o.m+'  count='+o.count+'  values='+JSON.stringify(o.values).slice(0,160));}\n";
      await IOUtils.writeUTF8(p, src);
    } catch {
      /* ignore */
    }
  }

  async _findTrace(ctx) {
    let files = [];
    try {
      files = await IOUtils.getChildren(traceDir());
    } catch {
      return null;
    }
    const cands = files.filter(f => {
      const n = PathUtils.filename(f);
      return n.startsWith(PREFIX) && n.includes(".ndjson") && !n.endsWith(".ctl");
    });
    if (!cands.length) {
      return null;
    }
    // 页面脚本跑在内容进程；优先选当前标签内容进程那份，否则取最新。
    const pid = currentContentPid(ctx);
    if (pid) {
      const hit = cands.find(f => PathUtils.filename(f).endsWith("." + pid));
      if (hit) {
        return hit;
      }
    }
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
    const ctlPath = this._ctlPath(ctx);
    try {
      const ctl = await IOUtils.readUTF8(ctlPath);
      tracing = ctl.trim().startsWith("1");
    } catch {
      /* 没开过 */
    }
    const pid = currentContentPid(ctx);
    return {
      ok: true,
      tracing,
      hasTrace: !!f,
      traceFile: f,
      contentPid: pid,
      note: tracing
        ? "Web-API trace 已开启。触发目标操作(交互/请求/签名)后 webapi_query 读 interface.member(args)→return。"
        : "未开启。webapi_trace(action:'start', filter?) 运行期开启(无需重启)，再触发目标操作，然后 webapi_query。",
    };
  }

  /**
   * 运行期 start/stop trace（写控制文件，引擎摊销轮询，秒级生效）。
   * @param {object} p { action:"start"|"stop"|"status", filter?: interface/member 子串(命中才记，空=记全部) }
   */
  async trace({ action = "status", filter } = {}, ctx) {
    if (action === "start") {
      const flt = (filter || "").trim();
      // 必须带 filter：无 filter 会逐条记录**所有标签页所有 DOM 调用**，把内容进程写爆 →
      // 页面卡死/标签空白（用户多次踩到）。这里直接拒绝，绝不开启全量 trace（C++ 层只在命中 filter 时才写）。
      if (!flt) {
        return {
          ok: false,
          action: "start",
          error:
            "webapi_trace 必须带 filter（接口名/成员名子串）。无 filter＝记录所有页面所有 DOM 调用，会把浏览器拖到标签空白/打不开，已禁止。",
          hint:
            "填一个目标相关的子串再开：环境指纹类 navigator/screen/canvas/WebGL/Storage/Crypto；" +
            "请求类 XMLHttpRequest/setRequestHeader/fetch；WASM 边界 TextDecoder/TextEncoder/crypto。" +
            "不确定就分几次各填一个窄 filter 分别 trace，别想一次记全部。",
        };
      }
      const body = "1\n" + flt;
      const ctlPath = this._ctlPath(ctx);
      await IOUtils.writeUTF8(ctlPath, body);
      return {
        ok: true,
        action: "start",
        control: ctlPath,
        filter: flt,
        note:
          `已开启 Web-API trace（filter=${flt}）。现在触发目标操作（刷新/交互/调 signer/发请求）。` +
          "再 webapi_query 读 interface.member(args)→return。filter 命中才记，故只会看到与子串相关的调用。" +
          "**关键能力**：能看到签名读了哪些环境(querySelector/getAttribute/navigator 读)、写到哪(setRequestHeader)、WASM 边界(TextDecoder/Crypto)。" +
          "⏱ trace 约 5 分钟没刷新会**自动关闭**(防忘了 stop)，用完请 stop；需要更久就重新 start。换目标就用新的窄 filter 重新 start。",
      };
    }
    if (action === "stop") {
      const ctlPath = this._ctlPath(ctx);
      await IOUtils.writeUTF8(ctlPath, "0");
      return { ok: true, action: "stop", control: ctlPath };
    }
    return this.status(undefined, ctx);
  }

  /** 指纹检测档：env 模式归类哪些"读取"算环境指纹（getter + 这些探测型方法）。通用，无站点信息。 */
  _isFingerprintMethod(m) {
    return /^(getParameter|getExtension|getSupportedExtensions|toDataURL|toBlob|measureText|getImageData|getChannelData|getFloatFrequencyData|getByteFrequencyData|getContext|enumerateDevices|getBattery|getGamepads)$/.test(
      m || ""
    );
  }

  /**
   * 读取/统计 Web-API 调用记录。三种 mode：
   *  - "records"(默认)：最近 limit 条原始记录(interface.member(args)→return)。
   *  - "env"(基础档·指纹清单)：把 getter 读取 + 指纹探测方法**按 接口→属性 归类**，给出 值 + 次数。
   *  - "flow"(高级档·执行流程)：按时间顺序的调用序列 [{ts,if,m,k}]，含毫秒时间戳，便于复原检测逻辑/时序。
   * @param {object} p { mode?, limit=200, iface?, member?, kind? }
   */
  async query({ mode = "records", limit = 200, iface, member, kind } = {}, ctx) {
    const f = await this._findTrace(ctx);
    if (!f) {
      return {
        ok: true,
        count: 0,
        records: [],
        note: "还没有 Web-API trace 记录。先 webapi_trace(action:'start')，再触发目标操作，然后 webapi_query。",
      };
    }
    const CAP = 16 * 1024 * 1024;
    let text;
    let truncatedHead = false;
    try {
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

    // ── 基础档：指纹清单（接口→属性→{值, 次数}）──
    if (mode === "env") {
      const env = {}; // 返回给 LLM：值截断、每属性最多 3 个样本（省 token）
      const envFull = {}; // 落盘：完整去重值、每属性最多 12 个（node 补环境按这个喂）
      let reads = 0; // 命中的 getter/指纹方法读取次数
      let totalRecords = 0; // 整个（读到的）trace 窗口里的 Web-API 记录条数
      for (const ln of lines) {
        if (!ln) continue;
        let o;
        try {
          o = JSON.parse(ln);
        } catch {
          continue;
        }
        if (o._meta || o._warn) continue;
        totalRecords++;
        const isGet = o.k === "get";
        const isFp = o.k === "method" && this._isFingerprintMethod(o.m);
        if (!isGet && !isFp) continue;
        if (iface && !(o.if && String(o.if).includes(iface))) continue;
        const prop = isFp ? o.m + "(" + JSON.stringify(o.a || []).slice(0, 48) + ")" : o.m;
        // 完整档（落盘）：值不截断（引擎已上限 16KB），去重最多 12 个
        const gf = (envFull[o.if] = envFull[o.if] || {});
        const ef = (gf[prop] = gf[prop] || { count: 0, values: [] });
        ef.count++;
        const vfs = JSON.stringify(o.r);
        if (ef.values.length < 12 && !ef.values.some(x => JSON.stringify(x) === vfs)) {
          ef.values.push(o.r);
        }
        // 摘要档（返回）：值截断 160、去重最多 3 个
        const g = (env[o.if] = env[o.if] || {});
        const e = (g[prop] = g[prop] || { count: 0, values: [] });
        e.count++;
        let v = o.r;
        if (typeof v === "string" && v.length > 160) v = v.slice(0, 160) + "…";
        const vs = JSON.stringify(v);
        if (e.values.length < 3 && !e.values.some(x => JSON.stringify(x) === vs)) {
          e.values.push(v);
        }
        reads++;
      }
      const interfaces = Object.keys(env).length;
      let properties = 0;
      for (const k of Object.keys(env)) properties += Object.keys(env[k]).length;
      // 落盘「完整指纹清单」为**行式 NDJSON**：一行一个 接口.属性（可 grep/部分读/省 token）。
      const rows = [];
      for (const ifn of Object.keys(envFull)) {
        for (const prop of Object.keys(envFull[ifn])) {
          rows.push({ if: ifn, m: prop, count: envFull[ifn][prop].count, values: envFull[ifn][prop].values });
        }
      }
      const savedFile = await this._saveNdjson(
        "fingerprint-env.ndjson",
        {
          source: "firefox-reverse webapi-trace",
          mode: "env",
          generated: new Date().toISOString(),
          traceFile: f,
          totalRecords,
          interfaces,
          properties,
          reads,
          ...(truncatedHead ? { truncatedHead: true } : {}),
          desc: "每行 {if,m,count,values} —— 目标算法依赖的浏览器环境输入；values=完整去重值，node 补环境按此喂。grep 接口名只看关心的。",
        },
        rows,
        ctx
      );
      return {
        ok: true,
        traceFile: f,
        mode: "env",
        totalRecords, // 捕获的 Web-API 记录总条数
        interfaces, // 对象（接口）数
        properties, // 属性数（去重）
        reads, // 读取次数（getter + 指纹方法）
        env, // 摘要（值截断）；完整全量见 savedFile
        ...(savedFile ? { savedFile } : {}),
        ...(truncatedHead ? { truncatedHead: true } : {}),
        note:
          `指纹清单：捕获 ${totalRecords} 条 Web-API 记录 → 归类出 ${interfaces} 个对象(接口)、${properties} 个属性、${reads} 次读取。` +
          (savedFile
            ? `完整指纹已落盘为行式 NDJSON：${savedFile}（一行一个接口.属性，grep 接口名按需读；同目录 analyze-fingerprint.js 可重跑分组）。`
            : "（未设工作目录→未落盘；点「打开目录」后会自动存到 <工作目录>/webapi/fingerprint-env.ndjson）") +
          " 返回的 env 是摘要(值截断省 token)，要全量去 grep 那个 ndjson。要时序用 mode:'flow'。" +
          " ⚠ 请向用户汇报：捕获了多少条记录、多少个对象、多少个属性，以及指纹清单存到哪个文件。",
      };
    }

    // ── 高级档：执行流程（按时间顺序 + 毫秒时间戳）──
    if (mode === "flow") {
      const seq = [];
      for (let i = lines.length - 1; i >= 0; i--) {
        const ln = lines[i];
        if (!ln) continue;
        let o;
        try {
          o = JSON.parse(ln);
        } catch {
          continue;
        }
        if (o._meta || o._warn) continue;
        if (iface && !(o.if && String(o.if).includes(iface))) continue;
        if (member && !(o.m && String(o.m).includes(member))) continue;
        if (kind && o.k !== kind) continue;
        seq.push({ ts: o.ts, if: o.if, m: o.m, k: o.k });
        if (seq.length >= limit) break;
      }
      seq.reverse();
      const t0 = seq.length ? seq[0].ts : 0;
      for (const s of seq) if (typeof s.ts === "number") s.dt = s.ts - t0; // 相对首条的毫秒偏移
      const savedFile = await this._saveNdjson(
        "fingerprint-flow.ndjson",
        {
          source: "firefox-reverse webapi-trace",
          mode: "flow",
          generated: new Date().toISOString(),
          traceFile: f,
          count: seq.length,
          ...(iface ? { iface } : {}),
          ...(member ? { member } : {}),
          ...(kind ? { kind } : {}),
          desc: "每行一条调用 {ts,if,m,k,dt}，按时间序；ts=单调毫秒，dt=相对首条毫秒偏移。复原检测逻辑/时序。",
        },
        seq,
        ctx
      );
      return {
        ok: true,
        traceFile: f,
        mode: "flow",
        count: seq.length,
        flow: seq,
        ...(savedFile ? { savedFile } : {}),
        note:
          `执行流程：${seq.length} 个调用（按时间序）。ts=单调毫秒，dt=相对首条毫秒偏移。` +
          (savedFile ? `已落盘为行式 NDJSON：${savedFile}（grep/head 按需读）。` : "（未设工作目录→未落盘）") +
          " 用于复原检测逻辑/时序与时间差检测。 ⚠ 请向用户汇报捕获的调用条数与文件位置。",
      };
    }

    // ── 默认：最近 limit 条原始记录 ──
    const out = [];
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
        continue;
      }
      if (iface && !(o.if && String(o.if).includes(iface))) {
        continue;
      }
      if (member && !(o.m && String(o.m).includes(member))) {
        continue;
      }
      if (kind && o.k !== kind) {
        continue;
      }
      out.push(o);
      if (out.length >= limit) {
        break;
      }
    }
    out.reverse();
    return {
      ok: true,
      traceFile: f,
      count: out.length,
      records: out,
      recent: true,
      ...(truncatedHead ? { truncatedHead: true } : {}),
    };
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

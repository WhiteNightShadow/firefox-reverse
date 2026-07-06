/* PageBackend.sys.mjs — 「执行JS / 页面控制」能力后端（parent / chrome 侧）。
 *
 * 通过运行期注册的 JSWindowActor(AgentEvalChild) 把 JS 送进当前标签页的内容进程执行。
 * 这是 Agent 最高杠杆的能力：有了它，可在页面里扫 window、document.scripts、
 * performance 网络项、给函数下钩子等——许多侦察先用 eval 就能做。
 *
 * 依赖 Firefox 全局：Services / ChromeUtils（chrome 特权环境）。
 */

// 注意：JSWindowActor 要求子类名 = <ActorName>Child。我们的子类是 AgentEvalChild，
// 故 ACTOR_NAME 必须是 "AgentEval"（否则 "Could not find actor constructor"）。
const ACTOR_NAME = "AgentEval";
let _registered = false;

// parent/system-ESM 无 window 全局 setTimeout；从 Timer 取（_q 超时守护用）。
const { setTimeout: _setTimeout, clearTimeout: _clearTimeout } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs"
);

const AUTOMATION_SCAN_EXPRESSION = String.raw`(async () => {
  const safe = (fn, fallback = null) => {
    try { return fn(); } catch (e) { return fallback; }
  };
  const err = e => String((e && e.message) || e || "");
  const descInfo = (obj, prop) => safe(() => {
    const d = Object.getOwnPropertyDescriptor(obj, prop);
    if (!d) return null;
    return {
      configurable: !!d.configurable,
      enumerable: !!d.enumerable,
      writable: Object.prototype.hasOwnProperty.call(d, "writable") ? !!d.writable : null,
      hasGetter: typeof d.get === "function",
      hasSetter: typeof d.set === "function",
      getterSource: d.get ? Function.prototype.toString.call(d.get).slice(0, 160) : "",
    };
  }, null);
  const permission = async name => {
    try {
      if (!navigator.permissions || !navigator.permissions.query) return { state: "unsupported" };
      const r = await navigator.permissions.query({ name });
      return { state: r && r.state || "" };
    } catch (e) {
      return { state: "error", error: err(e) };
    }
  };
  const getUAData = async () => {
    const ua = safe(() => navigator.userAgentData, null);
    if (!ua) return null;
    const out = {
      brands: safe(() => Array.from(ua.brands || []), []),
      mobile: safe(() => ua.mobile, null),
      platform: safe(() => ua.platform, ""),
    };
    if (typeof ua.getHighEntropyValues === "function") {
      try {
        out.highEntropy = await ua.getHighEntropyValues([
          "architecture",
          "bitness",
          "model",
          "platformVersion",
          "uaFullVersion",
          "fullVersionList",
          "wow64",
        ]);
      } catch (e) {
        out.highEntropyError = err(e);
      }
    }
    return out;
  };
  const webgl = () => safe(() => {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    if (!gl) return null;
    const dbg = safe(() => gl.getExtension("WEBGL_debug_renderer_info"), null);
    return {
      vendor: safe(() => gl.getParameter(gl.VENDOR), ""),
      renderer: safe(() => gl.getParameter(gl.RENDERER), ""),
      version: safe(() => gl.getParameter(gl.VERSION), ""),
      shadingLanguageVersion: safe(() => gl.getParameter(gl.SHADING_LANGUAGE_VERSION), ""),
      unmaskedVendor: dbg ? safe(() => gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL), "") : "",
      unmaskedRenderer: dbg ? safe(() => gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL), "") : "",
      extensionsCount: safe(() => (gl.getSupportedExtensions() || []).length, 0),
    };
  }, null);
  const canvas = () => safe(() => {
    const c = document.createElement("canvas");
    c.width = 220;
    c.height = 60;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.textBaseline = "top";
    ctx.font = "16px Arial";
    ctx.fillStyle = "#123456";
    ctx.fillText("frx automation scan", 8, 8);
    const data = c.toDataURL("image/png");
    let h = 2166136261;
    for (let i = 0; i < data.length; i++) {
      h ^= data.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return { hash32: (h >>> 0).toString(16).padStart(8, "0"), dataUrlLength: data.length };
  }, null);
  const audio = async () => safe(() => {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    const ctx = new Ctor();
    const out = {
      sampleRate: ctx.sampleRate || null,
      state: ctx.state || "",
      baseLatency: ctx.baseLatency || null,
      outputLatency: ctx.outputLatency || null,
    };
    Promise.resolve().then(() => safe(() => ctx.close(), null));
    return out;
  }, null);
  const rtc = async () => {
    if (typeof RTCPeerConnection !== "function") return { supported: false };
    return await new Promise(resolve => {
      const candidates = [];
      let done = false;
      const finish = error => {
        if (done) return;
        done = true;
        safe(() => pc.close(), null);
        const types = {};
        for (const c of candidates) {
          const m = String(c).match(/\btyp\s+([a-z0-9]+)/i);
          const t = m ? m[1] : "unknown";
          types[t] = (types[t] || 0) + 1;
        }
        resolve({
          supported: true,
          count: candidates.length,
          types,
          hasMdnsHost: candidates.some(c => /\.local\b/i.test(c)),
          hasPrivateIpv4: candidates.some(c => /\b(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(c)),
          hasIpv6: candidates.some(c => /([a-f0-9]{0,4}:){2,}/i.test(c)),
          error: error || "",
        });
      };
      let pc;
      try {
        pc = new RTCPeerConnection({ iceServers: [] });
        pc.onicecandidate = e => {
          if (e && e.candidate && e.candidate.candidate) {
            candidates.push(e.candidate.candidate);
          } else {
            finish("");
          }
        };
        pc.createDataChannel("frx");
        pc.createOffer().then(o => pc.setLocalDescription(o)).catch(e => finish(err(e)));
        setTimeout(() => finish("timeout"), 1800);
      } catch (e) {
        resolve({ supported: true, count: 0, types: {}, error: err(e) });
      }
    });
  };
  const globalNames = [
    "webdriver",
    "__webdriver_evaluate",
    "__selenium_evaluate",
    "__webdriver_script_function",
    "__webdriver_script_func",
    "__webdriver_script_fn",
    "__fxdriver_evaluate",
    "__driver_unwrapped",
    "__webdriver_unwrapped",
    "__selenium_unwrapped",
    "__fxdriver_unwrapped",
    "_selenium",
    "callSelenium",
    "_Selenium_IDE_Recorder",
    "callPhantom",
    "_phantom",
    "phantom",
    "__nightmare",
    "domAutomation",
    "domAutomationController",
    "Buffer",
    "process",
  ];
  const globals = {};
  for (const name of globalNames) {
    globals[name] = safe(() => Object.prototype.hasOwnProperty.call(window, name) || typeof window[name] !== "undefined", false);
  }
  const uaData = await getUAData();
  const out = {
    schemaVersion: 1,
    scannedAt: new Date().toISOString(),
    url: location.href,
    navigator: {
      userAgent: safe(() => navigator.userAgent, ""),
      platform: safe(() => navigator.platform, ""),
      language: safe(() => navigator.language, ""),
      languages: safe(() => Array.from(navigator.languages || []), []),
      webdriver: safe(() => navigator.webdriver, null),
      hardwareConcurrency: safe(() => navigator.hardwareConcurrency, null),
      deviceMemory: safe(() => navigator.deviceMemory, null),
      maxTouchPoints: safe(() => navigator.maxTouchPoints, null),
      cookieEnabled: safe(() => navigator.cookieEnabled, null),
      pdfViewerEnabled: safe(() => navigator.pdfViewerEnabled, null),
      pluginsLength: safe(() => navigator.plugins.length, null),
      mimeTypesLength: safe(() => navigator.mimeTypes.length, null),
      userAgentData: uaData,
    },
    descriptors: {
      webdriver: descInfo(Navigator.prototype, "webdriver"),
      userAgent: descInfo(Navigator.prototype, "userAgent"),
      plugins: descInfo(Navigator.prototype, "plugins"),
      languages: descInfo(Navigator.prototype, "languages"),
      platform: descInfo(Navigator.prototype, "platform"),
    },
    window: {
      innerWidth: safe(() => innerWidth, null),
      innerHeight: safe(() => innerHeight, null),
      outerWidth: safe(() => outerWidth, null),
      outerHeight: safe(() => outerHeight, null),
      devicePixelRatio: safe(() => devicePixelRatio, null),
      hasFocus: safe(() => document.hasFocus(), null),
      visibilityState: safe(() => document.visibilityState, ""),
      chromeType: safe(() => typeof window.chrome, "undefined"),
      chromeKeys: safe(() => window.chrome ? Object.keys(window.chrome).slice(0, 20) : [], []),
      installTrigger: safe(() => typeof window.InstallTrigger !== "undefined", false),
      mozInnerScreenX: safe(() => typeof window.mozInnerScreenX !== "undefined", false),
      browserType: safe(() => typeof window.browser, "undefined"),
    },
    css: {
      mozAppearance: safe(() => CSS.supports("-moz-appearance", "none"), false),
      webkitAppearance: safe(() => CSS.supports("-webkit-appearance", "none"), false),
    },
    permissions: {
      notifications: await permission("notifications"),
      geolocation: await permission("geolocation"),
      camera: await permission("camera"),
      microphone: await permission("microphone"),
      clipboardRead: await permission("clipboard-read"),
    },
    globals,
    webgl: webgl(),
    canvas: canvas(),
    audio: await audio(),
    webrtc: await rtc(),
    storage: {
      localStorage: safe(() => typeof localStorage === "object", false),
      sessionStorage: safe(() => typeof sessionStorage === "object", false),
      indexedDB: safe(() => typeof indexedDB === "object", false),
      cookieLength: safe(() => document.cookie.length, null),
    },
    timing: {
      performanceNowDecimals: safe(() => {
        const s = String(performance.now());
        return s.includes(".") ? s.split(".")[1].length : 0;
      }, null),
    },
  };
  out.findings = [];
  if (out.navigator.webdriver === true) out.findings.push("navigator.webdriver is true");
  if (out.globals.domAutomation || out.globals.domAutomationController) out.findings.push("domAutomation global exists");
  if (out.globals._selenium || out.globals.callSelenium) out.findings.push("selenium global exists");
  if (out.globals.callPhantom || out.globals._phantom || out.globals.phantom) out.findings.push("phantom global exists");
  if (out.permissions.notifications && out.permissions.notifications.error) out.findings.push("permissions notifications query error: " + out.permissions.notifications.error);
  if (out.webrtc && out.webrtc.hasPrivateIpv4) out.findings.push("WebRTC exposed private IPv4 candidate");
  return out;
})()`;

function ensureActor() {
  if (_registered) {
    return;
  }
  try {
    ChromeUtils.registerWindowActor(ACTOR_NAME, {
      child: {
        esModuleURI: "resource:///modules/agentsidebar/AgentEvalChild.sys.mjs",
      },
      allFrames: false,
    });
  } catch (e) {
    // 跨面板重载会重复注册 → 视为已注册。
    if (!/already.*regist/i.test(String(e && e.message))) {
      throw e;
    }
  }
  _registered = true;
}

function agentWin(ctx) {
  try { const w = ctx && ctx.win; if (w && w.gBrowser && !w.closed) return w; } catch {}
  return Services.wm.getMostRecentWindow("navigator:browser");
}

function activeBrowser(ctx) {
  const win = agentWin(ctx);
  if (!win || !win.gBrowser) {
    throw new Error("找不到浏览器窗口（请确保有打开的标签页）");
  }
  return win.gBrowser.selectedBrowser;
}

export class PageBackend {
  /** 在当前标签页内容上下文执行表达式。
   *  默认返回 { ok, value, type, totalLength, returnedLength }（带完整性元信息，治"被截了却不自知"）；
   *  传 saveTo 则把**完整字符串结果**落盘到工作目录该相对路径、只回 { ok, saved, savedPath, length, preview }
   *  ——专治大输出（如 fn.toString() 取几十万字混淆源码）：落盘后用 code_search/fs_read 分析，别塞进上下文。 */
  async eval({ expression, awaitPromise = true, saveTo } = {}, ctx) {
    if (!expression || typeof expression !== "string") {
      throw new Error("expression (string) required");
    }
    ensureActor();
    const browser = activeBrowser(ctx);
    const wgp = browser.browsingContext?.currentWindowGlobal;
    if (!wgp) {
      throw new Error("当前标签页还没有可用的 window（页面未加载完？）");
    }
    const actor = wgp.getActor(ACTOR_NAME);
    const res = await this._q(actor, "eval", { expression, awaitPromise }, ctx);
    if (res && res.ok === false) {
      let hint = "";
      if (/redefine non-configurable|already been declared|redeclaration|already been defined/i.test(res.error || "")) {
        hint =
          "（这不是工具问题，是你的表达式触发了**页面/框架重定义**——多半是 `import()` 应用模块或重装框架插件让 Vue/$router 等重复定义。" +
          "要本地调签名器请用 `wasm_probe`(glue)，别在页面里 re-import 应用模块。）";
      } else if (/is not a function|is not defined|is not a constructor|can't access|cannot read propert|undefined is not|null is not|not iterable/i.test(res.error || "")) {
        hint =
          "（⚠ 这是**你 page_eval 表达式里的代码**抛的运行时错、**不是 page_eval 工具/内部 bug**——stack 里 `@page_eval-expression:行:列` 就是你表达式的出错位置，挂在 `AgentEvalChild.sys.mjs` 也只是宿主模块、不代表工具坏了。检查你的表达式。" +
          "**尤其：算 MD5/SHA/HMAC/AES 别在 page_eval 里手搓**（手搓必出这类 'X is not a function' bug）→ 用 `run_node` + Node `crypto`（标准库），或调页面里现成的 crypto 库/签名函数，别自己重写算法。）";
      }
      throw new Error("page eval 失败: " + res.error + (res.stack ? "\nstack: " + res.stack : "") + hint);
    }
    // ── saveTo：把**完整**字符串结果落盘工作目录，只回摘要（治"取 51K 混淆源码被截到 20K、还不自知"）──
    if (saveTo && res && typeof res.value === "string") {
      const root = ctx && ctx.workspaceRoot;
      if (!root) {
        throw new Error("saveTo 需要先设工作目录（侧栏「打开目录」）。");
      }
      const rel = String(saveTo).replace(/^[/\\]+/, "");
      if (rel.includes("..") || /^[A-Za-z]:/.test(rel)) {
        throw new Error("saveTo 必须是工作目录内的相对路径、不能含 ..。");
      }
      const abs = PathUtils.join(root, ...rel.split(/[/\\]+/));
      await IOUtils.makeDirectory(PathUtils.parent(abs), { ignoreExisting: true, createAncestors: true });
      await IOUtils.writeUTF8(abs, res.value);
      const total = res.strLen != null ? res.strLen : res.value.length;
      return {
        ok: true,
        saved: true,
        savedPath: rel,
        length: total,
        preview: res.value.slice(0, 300),
        note:
          `完整结果（${total} 字符）已落盘 ${rel}——用 code_search('关键词','${rel}') 或 fs_read('${rel}',offset,limit) 分段分析，别整读进上下文。` +
          (res.hardCapped ? " ⚠ 超 8MB 已硬截，极端大输出请在表达式里自己切片落多块。" : ""),
      };
    }
    // ── 无 saveTo：带**完整性元信息** + 大输出/native 提示（治"模型不知被截、在残缺源码上瞎分析"）──
    if (res && typeof res.value === "string") {
      const total = res.strLen != null ? res.strLen : res.value.length;
      const out = { ok: true, value: res.value, type: res.type, totalLength: total, returnedLength: res.value.length };
      if (/\{\s*\[native code\]\s*\}/.test(res.value)) {
        out.note = "这是 **native 函数**（[native code]）——没有 JS 源码可提取，别当成拿到了源码。";
      } else if (total > 30000) {
        out.note =
          `结果较大（totalLength=${total}）：进对话会被按当前模型上下文上限截断。**要完整内容**就重调并加 ` +
          `saveTo:'work/x.js' 落盘，再 code_search/fs_read 看全量——别基于截断的残缺源码做分析。`;
      }
      return out;
    }
    // ── saveTo 但结果**不是字符串**（对象/数组/数字——如 VM 状态/常量池/环境指纹对象）：把 cycle-safe 序列化后的值
    //    落盘 JSON、只回摘要。治"saveTo 对非字符串结果静默失效（返回 null/空），还撞 JSON.stringify 循环引用抛错"——
    //    res.value 已是内容侧 safeSerialize 的产物（循环引用已标 [Circular]、大数组/对象已截），JSON.stringify 必安全。──
    if (saveTo && res && res.value !== undefined && typeof res.value !== "string") {
      const root = ctx && ctx.workspaceRoot;
      if (!root) {
        throw new Error("saveTo 需要先设工作目录（侧栏「打开目录」）。");
      }
      const rel = String(saveTo).replace(/^[/\\]+/, "");
      if (rel.includes("..") || /^[A-Za-z]:/.test(rel)) {
        throw new Error("saveTo 必须是工作目录内的相对路径、不能含 ..。");
      }
      const abs = PathUtils.join(root, ...rel.split(/[/\\]+/));
      await IOUtils.makeDirectory(PathUtils.parent(abs), { ignoreExisting: true, createAncestors: true });
      const json = JSON.stringify(res.value, null, 2);
      await IOUtils.writeUTF8(abs, json);
      return {
        ok: true,
        saved: true,
        savedPath: rel,
        type: res.type,
        length: json.length,
        preview: json.slice(0, 300),
        note: `非字符串结果（${res.type}）已 cycle-safe 序列化落盘 ${rel}——用 fs_read/code_search 分析。含循环引用的运行时对象已标 [Circular]、超大数组/对象按上限截断（要整段拿大数组建议在表达式里 JSON.stringify/Array.from 后配 saveTo 取字符串）。`,
      };
    }
    return res;
  }

  /** actor.sendQuery 加**超时 + abort 守护**。actor 不回（内容进程繁忙 / trace 目标是热路径函数每请求都触发 /
   *  页面卡）时，到点拒绝返回错误，而**不是让整个 Agent 永久挂死、连「停止」都点不动**（实测 signer_trace 钩
   *  HTTP 拦截器这种热路径直接卡死会话）。ctx.signal（会话级 AbortSignal）触发时立即取消。
   *  注：超时后底层 sendQuery 仍在后台跑完但结果被忽略——无法真正撤销 actor 调用，但足以解冻会话。 */
  async _q(actor, name, data, ctx, timeoutMs = 60000) {
    const signal = ctx && ctx.signal;
    if (signal && signal.aborted) {
      throw new Error("已被用户停止");
    }
    let timer = null;
    let onAbort = null;
    try {
      return await Promise.race([
        actor.sendQuery(name, data),
        new Promise((_, rej) => {
          timer = _setTimeout(
            () =>
              rej(
                new Error(
                  `actor「${name}」${Math.round(timeoutMs / 1000)}s 无响应已超时返回（避免卡死会话）。` +
                    `多半是内容进程繁忙、或 trace 的目标是**热路径函数**（每次请求都触发）——先 stop，再缩小 trace 范围 / 换非热路径目标。`
                )
              ),
            timeoutMs
          );
        }),
        new Promise((_, rej) => {
          if (signal) {
            onAbort = () => rej(new Error("已被用户停止"));
            signal.addEventListener("abort", onAbort, { once: true });
          }
        }),
      ]);
    } finally {
      if (timer) {
        _clearTimeout(timer);
      }
      if (signal && onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
    }
  }

  /** 取当前标签页顶层 window-global 的 AgentEval actor（用于发起者栈 arm/drain/disarm）。null=拿不到。 */
  _topActorOrNull(ctx) {
    try {
      ensureActor();
      const wgp = activeBrowser(ctx).browsingContext?.currentWindowGlobal;
      return wgp ? wgp.getActor(ACTOR_NAME) : null;
    } catch {
      return null;
    }
  }
  /** 开启内容侧「请求发起者调用栈」捕获（net_capture start 调）。 */
  async armNetStack(_args, ctx) {
    const a = this._topActorOrNull(ctx);
    if (!a) {
      return { ok: false };
    }
    try {
      return await this._q(a, "arm-netstack", undefined, ctx);
    } catch {
      return { ok: false };
    }
  }
  /** 关闭捕获（net_capture stop 调）。 */
  async disarmNetStack(_args, ctx) {
    const a = this._topActorOrNull(ctx);
    if (!a) {
      return { ok: false };
    }
    try {
      return await this._q(a, "disarm-netstack", undefined, ctx);
    } catch {
      return { ok: false };
    }
  }
  /** 取走内容侧暂存的发起者栈 [{channelId,stack}]（NetworkBackend 在 list/get 前 drain 合并）。 */
  async drainNetStack(_args, ctx) {
    const a = this._topActorOrNull(ctx);
    if (!a) {
      return [];
    }
    try {
      const r = await this._q(a, "drain-netstack", undefined, ctx);
      return (r && r.stacks) || [];
    } catch {
      return [];
    }
  }

  /**
   * 签名器真实入参捕获（引擎层 Debugger 观测，不注入页面）。start→页内触发→query→stop。
   * @param {object} p { action:"start"|"query"|"stop", scriptUrl?, fn?, line?, maxCalls? }
   */
  async signerTrace({ action = "start", scriptUrl, fn, line, maxCalls, argMatch } = {}, ctx) {
    const a = this._topActorOrNull(ctx);
    if (!a) {
      return { ok: false, error: "拿不到当前标签页 actor（页面没加载完？切到目标标签页再试）。" };
    }
    try {
      if (action === "start") {
        return await this._q(a, "signer-trace-start", { scriptUrl, fn, line, maxCalls, argMatch }, ctx);
      }
      if (action === "query") {
        return await this._q(a, "signer-trace-query", undefined, ctx);
      }
      if (action === "stop") {
        return await this._q(a, "signer-trace-stop", undefined, ctx);
      }
      return { ok: false, error: "action 必须是 start / query / stop" };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }

  /**
   * 闭包变量读取（引擎层 Debugger 观测：目标函数被调用时读 frame.environment 沿作用域链外走，拿任意闭包/局部
   * 变量真值——治"dispatcher / 解码后字节码 / S-box / 常量池 是闭包变量，page_eval 的 window. 够不到"）。
   * start→页内触发目标函数→query→stop。大闭包可 saveTo 落盘只回摘要。
   * @param {object} p { action:"start"|"query"|"stop", scriptUrl?, fn?, line?, varNames?, maxCalls?, argMatch?, depth?, maxArr?, saveTo? }
   */
  async readClosure({ action = "start", scriptUrl, fn, line, varNames, maxCalls, argMatch, depth, maxArr, saveTo } = {}, ctx) {
    const a = this._topActorOrNull(ctx);
    if (!a) {
      return { ok: false, error: "拿不到当前标签页 actor（页面没加载完？切到目标标签页再试）。" };
    }
    try {
      if (action === "start") {
        return await this._q(a, "closure-read-start", { scriptUrl, fn, line, varNames, maxCalls, argMatch, depth, maxArr }, ctx);
      }
      if (action === "query") {
        const r = await this._q(a, "closure-read-query", undefined, ctx);
        // 大闭包（深序列化的字节码/常量池可达几十 KB）→ 可落盘工作目录、只回摘要（同 page_eval saveTo 的治"被截"思路）。
        if (saveTo && r && r.ok && ctx && ctx.workspaceRoot) {
          try {
            const rel = String(saveTo).replace(/^[/\\]+/, "");
            if (!rel.includes("..") && !/^[A-Za-z]:/.test(rel)) {
              const abs = PathUtils.join(ctx.workspaceRoot, ...rel.split(/[/\\]+/));
              await IOUtils.makeDirectory(PathUtils.parent(abs), { ignoreExisting: true, createAncestors: true });
              await IOUtils.writeUTF8(abs, JSON.stringify(r, null, 2));
              return {
                ok: true, saved: true, savedPath: rel, count: r.count, conf: r.conf,
                note: `闭包捕获已落盘 ${rel}（用 fs_read/code_search 看全量；varNames 命中的**深序列化**值在 captures[].deep，含完整 S-box/字节码数组）。`,
              };
            }
          } catch { /* 落盘失败 → 回原结果 */ }
        }
        return r;
      }
      if (action === "stop") {
        return await this._q(a, "closure-read-stop", undefined, ctx);
      }
      return { ok: false, error: "action 必须是 start / query / stop" };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }

  /**
   * document-start hook 注入：在每个新页面**早于页面 JS** 注入 hook（治"首屏/导航时就触发的请求 page_eval 装 hook 来不及"）。
   * start→page_navigate/刷新→query→stop。不传 script＝内置 preset 包 fetch+XHR→window.__frxhook。
   * @param {object} p { action:"start"|"query"|"stop", script?, global? }
   */
  async hookInject({ action = "start", script, global } = {}, ctx) {
    const a = this._topActorOrNull(ctx);
    if (!a) {
      return { ok: false, error: "拿不到当前标签页 actor（页面没加载完？切到目标标签页再试）。" };
    }
    try {
      if (action === "start") {
        return await this._q(a, "hook-inject-start", { script }, ctx);
      }
      if (action === "query") {
        return await this._q(a, "hook-inject-query", { global }, ctx);
      }
      if (action === "stop") {
        return await this._q(a, "hook-inject-stop", undefined, ctx);
      }
      return { ok: false, error: "action 必须是 start / query / stop" };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }

  /** P5 白盒：浏览器侧"分支覆盖真值"采集（引擎层 Debugger collectCoverageInfo）。start→页内触发→query→stop。 */
  async whiteboxCoverage({ action = "start", scriptUrl } = {}, ctx) {
    const a = this._topActorOrNull(ctx);
    if (!a) {
      return { ok: false, error: "拿不到当前标签页 actor（页面没加载完？切到目标标签页再试）。" };
    }
    try {
      if (action === "start") {
        return await this._q(a, "whitebox-cov-start", { scriptUrl }, ctx);
      }
      if (action === "query") {
        return await this._q(a, "whitebox-cov-query", undefined, ctx);
      }
      if (action === "stop") {
        return await this._q(a, "whitebox-cov-stop", undefined, ctx);
      }
      return { ok: false, error: "action 必须是 start / query / stop" };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }

  /** 当前页面概况（URL/标题/脚本数/UA）——常用作第一步侦察。 */
  async info(_args, ctx) {
    return this.eval({
      expression:
        "({url:location.href,title:document.title,scripts:document.scripts.length,ua:navigator.userAgent})",
    }, ctx);
  }

  async automationScan({ saveTo } = {}, ctx) {
    return this.eval({
      expression: AUTOMATION_SCAN_EXPRESSION,
      awaitPromise: true,
      saveTo,
    }, ctx);
  }

  /** 导航当前标签页。 */
  async navigate({ url } = {}, ctx) {
    if (!url) {
      throw new Error("url required");
    }
    const browser = activeBrowser(ctx);
    browser.fixupAndLoadURIString
      ? browser.fixupAndLoadURIString(url, {
          triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        })
      : browser.loadURI(Services.io.newURI(url), {
          triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        });
    // 若正在捕获发起者栈：导航会换文档(可能换内容进程)→旧观察者失效。延迟到新页加载后重新 arm，
    // 让刷新/跳转后的请求也能抓到 initiatorStack（best-effort：仍建议优先用页内交互触发而非整页刷新）。
    if (this._net && this._net._on) {
      try {
        const { setTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
        setTimeout(() => {
          try {
            this.armNetStack(undefined, ctx);
          } catch {}
        }, 1200);
      } catch {}
    }
    return { ok: true, url };
  }

  /** 在页面上下文跑一段 DOM 操作表达式（复用 eval 沙箱，事件以页面 principal 派发，React 可感知）。 */
  async _pageOp(expression, ctx) {
    const r = await this.eval({ expression }, ctx);
    const v = r && r.value;
    if (v && v.ok === false) {
      throw new Error(v.error || "页面操作失败");
    }
    return v;
  }

  /** 按 CSS 选择器或可见文字点击元素（自动滚动到可视区）。 */
  async click({ selector, text } = {}, ctx) {
    if (!selector && !text) {
      throw new Error("click 需要 selector 或 text");
    }
    const sel = JSON.stringify(selector || "");
    const txt = JSON.stringify(text || "");
    return this._pageOp(`(function(){
      function vis(e){ return !!(e.offsetWidth||e.offsetHeight||(e.getClientRects&&e.getClientRects().length)); }
      var el=null, sel=${sel}, txt=${txt};
      if(sel){ try{ el=document.querySelector(sel); }catch(e){} }
      if(!el && txt){
        var all=document.querySelectorAll('a,button,[role=button],input[type=submit],input[type=button],[onclick],summary,label,li,span,div');
        var exact=[],part=[];
        for(var i=0;i<all.length;i++){ var e=all[i]; if(!vis(e))continue; var s=(e.innerText||e.textContent||'').trim(); if(s===txt)exact.push(e); else if(s&&s.indexOf(txt)>=0)part.push(e); }
        var c=exact.length?exact:part;
        c.sort(function(a,b){return (a.textContent||'').length-(b.textContent||'').length;});
        el=c[0]||null;
      }
      if(!el) return {ok:false,error:'未找到可点元素（selector/text 都没命中）'};
      try{ el.scrollIntoView({block:'center',inline:'center'}); }catch(e){}
      el.click();
      return {ok:true,clicked:true,tag:el.tagName.toLowerCase(),text:(el.innerText||el.value||'').trim().slice(0,80)};
    })()`, ctx);
  }

  /** 给输入框/文本域填值并派发 input/change（可选回车提交）。 */
  async type({ selector, text, submit } = {}, ctx) {
    if (!selector) {
      throw new Error("type 需要 selector");
    }
    return this._pageOp(`(function(){
      var el=document.querySelector(${JSON.stringify(selector)});
      if(!el) return {ok:false,error:'未找到输入框'};
      try{ el.focus(); }catch(e){}
      var proto=(el.tagName==='TEXTAREA')?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
      var d=Object.getOwnPropertyDescriptor(proto,'value');
      if(d&&d.set){ d.set.call(el, ${JSON.stringify(text || "")}); } else { el.value=${JSON.stringify(text || "")}; }
      el.dispatchEvent(new Event('input',{bubbles:true}));
      el.dispatchEvent(new Event('change',{bubbles:true}));
      ${submit ? "el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:13,which:13,bubbles:true}));el.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',keyCode:13,which:13,bubbles:true}));" : ""}
      return {ok:true,value:String(el.value).slice(0,120)};
    })()`, ctx);
  }

  /** 滚动：到底/到顶/滚到某元素/增量。 */
  async scroll({ dx, dy, toBottom, toTop, selector } = {}, ctx) {
    const sel = JSON.stringify(selector || "");
    const dyExpr = dy === undefined ? "Math.round(window.innerHeight*0.8)" : String(Number(dy) || 0);
    return this._pageOp(`(function(){
      var sel=${sel};
      if(sel){ var e=document.querySelector(sel); if(e){e.scrollIntoView({block:'center'});return {ok:true,scrolledTo:sel,y:window.scrollY};} return {ok:false,error:'未找到元素'}; }
      if(${toBottom ? 1 : 0}){ window.scrollTo(0,document.documentElement.scrollHeight); return {ok:true,y:window.scrollY}; }
      if(${toTop ? 1 : 0}){ window.scrollTo(0,0); return {ok:true,y:window.scrollY}; }
      window.scrollBy(${Number(dx) || 0}, ${dyExpr});
      return {ok:true,y:window.scrollY,maxY:document.documentElement.scrollHeight};
    })()`, ctx);
  }

  /** 页面分析：列出可视的可交互元素（链接/按钮/输入框…）+ 其选择器，供 Agent 决定点哪。 */
  async elements({ limit = 40, selector } = {}, ctx) {
    const lim = Math.max(1, Math.min(Number(limit) || 40, 120));
    const sel = JSON.stringify(selector || "");
    return this._pageOp(`(function(){
      function vis(e){ return !!(e.offsetWidth||e.offsetHeight||(e.getClientRects&&e.getClientRects().length)); }
      function cssPath(el){
        if(el.id){ try{ return '#'+CSS.escape(el.id); }catch(e){ return '#'+el.id; } }
        var parts=[],e=el,guard=0;
        while(e&&e.nodeType===1&&guard<5){
          var s=e.tagName.toLowerCase();
          try{ if(e.classList&&e.classList.length){ s+='.'+Array.prototype.slice.call(e.classList,0,2).map(function(c){return CSS.escape(c);}).join('.'); } }catch(_){}
          var p=e.parentNode;
          if(p){ var sib=Array.prototype.filter.call(p.children,function(x){return x.tagName===e.tagName;}); if(sib.length>1)s+=':nth-of-type('+(sib.indexOf(e)+1)+')'; }
          parts.unshift(s);
          e=e.parentNode; guard++;
        }
        return parts.join('>');
      }
      var sel=${sel} || 'a[href],button,[role=button],input,textarea,select,[onclick]';
      var all=document.querySelectorAll(sel),out=[];
      for(var i=0;i<all.length&&out.length<${lim};i++){
        var e=all[i]; if(!vis(e))continue;
        var label=((e.innerText||e.value||e.placeholder||(e.getAttribute&&e.getAttribute('aria-label'))||'')+'').trim().replace(/\\s+/g,' ').slice(0,60);
        out.push({tag:e.tagName.toLowerCase(),type:e.type||undefined,text:label,selector:cssPath(e)});
      }
      return {ok:true,count:out.length,url:location.href,title:document.title,elements:out};
    })()`, ctx);
  }

  /** 截当前标签页可视区（或整页）为 PNG。图像放 _media（旁路截断），文本只回尺寸。 */
  async screenshot({ fullPage = false } = {}, ctx) {
    ensureActor();
    const browser = activeBrowser(ctx);
    const wgp = browser.browsingContext?.currentWindowGlobal;
    if (!wgp || typeof wgp.drawSnapshot !== "function") {
      throw new Error("当前标签页不支持截图（drawSnapshot 不可用）");
    }
    const win = agentWin(ctx);
    const dim = await this.eval({
      expression:
        "({w:Math.round(innerWidth),h:Math.round(innerHeight),sx:Math.round(scrollX),sy:Math.round(scrollY),fh:Math.round(document.documentElement.scrollHeight)})",
    }, ctx);
    const d = (dim && dim.value) || { w: 1280, h: 800, sx: 0, sy: 0, fh: 800 };
    const rectH = fullPage ? Math.min(d.fh || d.h, 5000) : d.h;
    const rect = new win.DOMRect(fullPage ? 0 : d.sx, fullPage ? 0 : d.sy, d.w, rectH);
    const bitmap = await wgp.drawSnapshot(rect, 1, "rgb(255,255,255)", false);
    const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    if (typeof bitmap.close === "function") {
      bitmap.close();
    }
    const dataUrl = canvas.toDataURL("image/png");
    return {
      ok: true,
      width: canvas.width,
      height: canvas.height,
      note: `已截图 ${canvas.width}x${canvas.height}（${fullPage ? "整页" : "可视区"}）`,
      _media: [{ type: "image", mime: "image/png", dataUrl }],
    };
  }
}

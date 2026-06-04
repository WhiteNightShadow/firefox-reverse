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
  /** 在当前标签页内容上下文执行表达式，返回 { ok, value, type } 或 { ok:false, error }。 */
  async eval({ expression, awaitPromise = true } = {}, ctx) {
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
          "page_eval 只用于**读值 / 调用页面里现成的函数**；别 re-import 应用模块、别重定义页面已有全局。要本地调签名器请用 `wasm_probe`(glue)，不要在页面里重导入。）";
      }
      throw new Error("page eval 失败: " + res.error + hint);
    }
    return res;
  }

  /** actor.sendQuery 加**超时 + abort 守护**。actor 不回（内容进程繁忙 / trace 目标是热路径函数每请求都触发 /
   *  页面卡）时，到点拒绝返回错误，而**不是让整个 Agent 永久挂死、连「停止」都点不动**（实测 signer_trace 钩
   *  HTTP 拦截器这种热路径直接卡死会话）。ctx.signal（会话级 AbortSignal）触发时立即取消。
   *  注：超时后底层 sendQuery 仍在后台跑完但结果被忽略——无法真正撤销 actor 调用，但足以解冻会话。 */
  async _q(actor, name, data, ctx, timeoutMs = 20000) {
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

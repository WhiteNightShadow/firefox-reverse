/* Tools.sys.mjs — 内置工具规格工厂（Phase N0 起步，按 backend 在场情况自动注册）。
 *
 * createBuiltinTools(backends) 返回一组 ToolRouter spec。**只有其依赖的 backend
 * 存在时该工具才出现** —— 于是「可用工具面 = 已接好的 backend」：
 *   - N0 自测注入 { page, code } → 暴露 page_eval / code_search 两个活工具；
 *   - N1 接入 { net, scripts } → net_* / scripts_* 自动出现；
 *   - N2 接入 { jsvmp } → jsvmp_* 自动出现。
 * 既不假装支持未接的能力（沿用 A1「不假装」原则），又无需改注册代码。
 *
 * backend 适配器约定（各方法 async，返回普通可序列化对象；抛错由 ToolRouter 兜信封）：
 *   page    : eval({expression,awaitPromise}) info() navigate({url})
 *             click({selector,text}) type({selector,text,submit}) scroll({dy,toBottom,toTop,selector})
 *             elements({limit,selector}) screenshot({fullPage}) automationScan({saveTo}) → {_media:[{type:image,dataUrl}]}
 *   code    : search({query,regex,scriptUrl,maxResults})
 *   net     : capture({action,urlPattern,captureBody}) list({urlPattern,method,limit})
 *             get({requestId,includeBody}) intercept({urlPattern,action,...})
 *   scripts : list({urlPattern}) get({url}) save({url,path}) captureAll({toDir})
 *   jsvmp   : trace({action,scriptUrl,col,actions}) query({filter,limit})
 *   workspace: list({subdir,depth}) read({path}) write({path,content}) mkdir({path})
 *              runNode({code,file,args}) runPython({code,file,args})
 */

const T = (name, description, parameters, need, call) => ({
  name,
  description,
  parameters,
  _need: need,
  _call: call,
});

/** 改动型工具：执行前需用户批准（A3 要求；只读类如 *_list/*_get/code_search/jsvmp_query 不需要）。 */
const CONFIRM_TOOLS = new Set([
  "page_eval",
  "page_navigate",
  "page_click",
  "page_type",
  "net_capture",
  "net_intercept",
  "scripts_save",
  "scripts_capture_all",
  "jsvmp_trace",
  "webapi_trace",
  "signer_trace",
  "closure_read",
  "hook_inject",
  "whitebox_diff",
  "cookies",
  "env_create",
  "env_update",
  "env_open",
  "env_close",
  "env_delete",
  "env_import",
  "env_generate_fingerprint",
]);

/** 全部内置工具的声明表（声明 ≠ 注册；注册由 backend 在场决定）。 */
function toolTable() {
  return [
    // ───────── ⑤ JS 执行 / 页面控制（backend: page） ─────────
    T(
      "page_eval",
      "在当前页面上下文执行**任意** JavaScript 并返回结果——**全权**（页面 principal 沙箱、wantXrays:false，`window.X=包装` 会真替换页面的 X、页面自己代码也走你的包装）：读/算页面变量、调现成 signer、**装 hook 记入参出参（包 window.fetch/XHR/crypto/具名全局→交互触发→读 window.__log）、改全局、注入脚本**都行。简单非-JSVMP 站看签名 I/O **首选它**，比 signer_trace 省事；最终产物别靠浏览器跑加密即可。",
      {
        type: "object",
        properties: {
          expression: { type: "string", description: "要执行的 JS 表达式或 IIFE。取大输出（如 `window.someFn.toString()` 拿混淆源码）配 saveTo 落盘" },
          awaitPromise: { type: "boolean", description: "结果是 Promise 时是否等待，默认 true" },
          saveTo: { type: "string", description: "**大输出救星**：给一个工作目录相对路径（如 `work/dispatcher.js`），把**完整结果**落盘（不进上下文）、只回摘要+路径，再用 code_search/fs_read 分析。字符串结果原样落盘（**取 fn.toString() 几十万字混淆源码必用它**）；**非字符串结果（对象/数组/VM 状态/常量池）也会 cycle-safe 序列化成 JSON 落盘**（不再静默失效/撞循环引用）。不给的话结果会被上下文上限截、你还不一定自知。" },
        },
        required: ["expression"],
      },
      b => b.page && b.page.eval,
      (b, a, ctx) => b.page.eval(a, ctx)
    ),
    T(
      "page_navigate",
      "导航当前标签页到指定 URL。",
      {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
      b => b.page && b.page.navigate,
      (b, a, ctx) => b.page.navigate(a, ctx)
    ),
    T(
      "page_elements",
      "页面分析：列出当前页可视的可交互元素（链接/按钮/输入框等）及其 CSS 选择器，供决定点哪/填哪。",
      {
        type: "object",
        properties: {
          selector: { type: "string", description: "可选，限定范围的 CSS 选择器" },
          limit: { type: "integer", description: "最多返回元素数，默认 40" },
        },
      },
      b => b.page && b.page.elements,
      (b, a, ctx) => b.page.elements(a, ctx)
    ),
    T(
      "page_click",
      "点击元素：传 selector（CSS 选择器）或 text（可见文字），自动滚动到可视区后点击。",
      {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS 选择器（优先）" },
          text: { type: "string", description: "按可见文字匹配（selector 缺省时用）" },
        },
      },
      b => b.page && b.page.click,
      (b, a, ctx) => b.page.click(a, ctx)
    ),
    T(
      "page_type",
      "给输入框/文本域填值并触发 input/change 事件，可选回车提交。",
      {
        type: "object",
        properties: {
          selector: { type: "string", description: "目标输入框的 CSS 选择器" },
          text: { type: "string", description: "要填入的文本" },
          submit: { type: "boolean", description: "填完是否按回车提交，默认 false" },
        },
        required: ["selector", "text"],
      },
      b => b.page && b.page.type,
      (b, a, ctx) => b.page.type(a, ctx)
    ),
    T(
      "page_scroll",
      "滚动页面：toBottom 到底 / toTop 到顶 / selector 滚到某元素 / dy 增量（像素，正下负上）。",
      {
        type: "object",
        properties: {
          dy: { type: "integer", description: "纵向增量像素（默认约 0.8 屏）" },
          dx: { type: "integer" },
          toBottom: { type: "boolean" },
          toTop: { type: "boolean" },
          selector: { type: "string", description: "滚动到该元素" },
        },
      },
      b => b.page && b.page.scroll,
      (b, a, ctx) => b.page.scroll(a, ctx)
    ),
    T(
      "page_screenshot",
      "截当前标签页可视区（fullPage=true 整页）为 PNG。图像会展示给用户；若配了视觉模型，模型可据此判断点击/滑动。",
      {
        type: "object",
        properties: { fullPage: { type: "boolean", description: "是否整页截图，默认仅可视区" } },
      },
      b => b.page && b.page.screenshot,
      (b, a, ctx) => b.page.screenshot(a, ctx)
    ),

    // ───────── ⑥ 代码搜索（backend: code） ─────────
    T(
      "code_search",
      "在已捕获/落盘的 JS 语料中搜索字符串或正则，定位加密函数、参数名、常量等。",
      {
        type: "object",
        properties: {
          query: { type: "string", description: "关键字或正则源" },
          regex: { type: "boolean", description: "query 是否按正则处理，默认 false（字面子串）。搜含 `( ) [ ] . * +` 的代码片段（如 `Ig(Dg`、`sign(`）就用默认 false；若 regex:true 但正则编译不出（未配对括号等）会**自动回退字面搜、不报错**。" },
          scriptUrl: { type: "string", description: "限定某个脚本 URL，省略则全语料" },
          maxResults: { type: "integer", description: "最多返回命中数，默认 50" },
        },
        required: ["query"],
      },
      b => b.code && b.code.search,
      (b, a, ctx) => b.code.search(a, ctx)
    ),

    // ───────── ① 网络捕获控制（backend: net） ─────────
    T(
      "net_capture",
      "开启/关闭/查询网络请求捕获（HTTP/WS/fetch/XHR）。start 后会**同时捕获请求发起者 JS 调用栈**（仅 XHR/Fetch/Beacon/WS），net_get 里看 initiatorStack——这是定位「谁生成了签名参数」的黄金路径。**先 start 再触发请求**（栈只在请求发起那一刻能抓到）。",
      {
        type: "object",
        properties: {
          action: { type: "string", enum: ["start", "stop", "status"] },
          urlPattern: { type: "string", description: "fnmatch 过滤，省略捕获全部" },
          captureBody: { type: "boolean" },
        },
        required: ["action"],
      },
      b => b.net && b.net.capture,
      (b, a, ctx) => b.net.capture(a, ctx)
    ),
    T(
      "net_list",
      "列出已捕获的请求摘要。",
      {
        type: "object",
        properties: {
          urlPattern: { type: "string" },
          method: { type: "string" },
          limit: { type: "integer" },
        },
      },
      b => b.net && b.net.list,
      (b, a, ctx) => b.net.list(a, ctx)
    ),
    T(
      "net_get",
      "取单条请求的完整信息（含**请求头 reqHeaders**[含 X-S/签名头]、响应头、body、initiator 调用栈）。`requestId` = `net_list` 返回的那条记录的 `id`（原样传 id 即可，两个名都认）。",
      {
        type: "object",
        properties: {
          requestId: { type: "string", description: "= net_list 返回的 id（把那个数字原样传进来）" },
          id: { type: "integer", description: "requestId 的别名（直接传 net_list 的 id 字段也行）" },
          includeBody: { type: "boolean" },
        },
      },
      b => b.net && b.net.get,
      (b, a, ctx) => b.net.get(a, ctx)
    ),

    // ───────── ② 保存 JS 文件（backend: scripts） ─────────
    T(
      "scripts_list",
      "列出页面已解析的脚本（含 eval/Function/inline/worker）。",
      {
        type: "object",
        properties: { urlPattern: { type: "string" } },
      },
      b => b.scripts && b.scripts.list,
      (b, a, ctx) => b.scripts.list(a, ctx)
    ),
    T(
      "scripts_save",
      "把指定脚本源码落盘。默认落语料目录（供 code_search / 离线分析）；" +
        "**toWorkspace:true → 落到 <工作目录>/scripts/，立即可 run_node 执行**（定位到 signer 脚本后用这个，省去手动拷贝，直接进 node 补环境）。" +
        "⚠ 之后引用该文件**一律原样复制返回里的 `workspaceRelative` 路径**（已是短 basename），别凭记忆手敲长文件名——敲漏会「文件不存在」。",
      {
        type: "object",
        properties: {
          url: { type: "string" },
          path: { type: "string", description: "可选**短**输出文件名（如 glue.js）；省略=用 URL 的 basename（短、可预测，如 http.BINFUR4A.js）" },
          toWorkspace: {
            type: "boolean",
            description: "true=落到 <工作目录>/scripts/（可直接 run_node），false/省略=落语料目录",
          },
          force: {
            type: "boolean",
            description: "可选：覆盖完整性护栏（疑似 404/残片、或会用小文件覆盖已有大文件时引擎默认拒绝）。确认无误才传 true。",
          },
        },
        required: ["url"],
      },
      b => b.scripts && b.scripts.save,
      (b, a, ctx) => b.scripts.save(a, ctx)
    ),

    // ───────── ④ JSVMP trace（backend: jsvmp，底层原生 C++） ─────────
    T(
      "jsvmp_trace",
      "控制原生 C++ JSVMP 执行追踪。action: start/stop/status/clear/dump。" +
        "clear=清空当前缓冲但保持开启（丢页面加载噪声，触发目标前用）。" +
        "dump=运行期开 locals/env/vpc/ret/args 快照（捕运行期常量/闭包对象/虚拟寄存器/返回值；需 col=目标函数列）。",
      {
        type: "object",
        properties: {
          action: { type: "string", enum: ["start", "stop", "status", "clear", "dump"] },
          scriptUrl: { type: "string", description: "目标脚本文件名子串（filter）。**start 必填**——缺它会在解释器模式下逐 op 记录所有脚本、把浏览器卡到标签空白，已禁止" },
          col: { type: "integer", description: "目标函数/ dispatcher 所在列（dump 必填；split detect 可得）" },
          actions: {
            type: "array",
            description: "dump 模式；可与 start 同传或用 action:'dump' 单独下发，空数组=关闭 dump",
            items: { type: "string", enum: ["args", "locals", "ret", "vpc"] },
          },
          pc: { type: "integer", description: "触发 pc 偏移（locals 默认 0=函数入口；vpc=派发循环头）" },
          env: { type: "boolean", description: "locals 时是否同时深序列化闭包/环境链（取外层作用域常量对象）" },
          depth: { type: "integer", description: "对象/数组序列化深度（默认 2）" },
          limit: { type: "integer", description: "该模式最多记录条数" },
          skip: { type: "integer", description: "跳过前 N 次触发（取执行末尾，如最外层返回/输出已成型）" },
          maxarr: { type: "integer", description: "数组/对象键序列化上限（大常量池用，默认 2048）" },
          vpcPc: { type: "integer", description: "vpc 专用触发 pc（不传则用 pc）" },
          vpcLimit: { type: "integer", description: "vpc 专用记录上限（默认 200000）" },
        },
        required: ["action"],
      },
      b => b.jsvmp && b.jsvmp.trace,
      (b, a, ctx) => b.jsvmp.trace(a, ctx)
    ),
    T(
      "jsvmp_query",
      "查询已落盘的 JSVMP trace（NDJSON）记录。",
      {
        type: "object",
        properties: {
          filter: { type: "object", description: "如 {op, pcMin, pcMax, hasArgs}" },
          limit: { type: "integer" },
        },
      },
      b => b.jsvmp && b.jsvmp.query,
      (b, a, ctx) => b.jsvmp.query(a, ctx)
    ),
    T(
      "jsvmp_status",
      "查询 JSVMP trace 是否就绪（C++ 落盘的 trace 文件是否存在）。",
      { type: "object", properties: {} },
      b => b.jsvmp && b.jsvmp.status,
      (b, a, ctx) => b.jsvmp.status(a, ctx)
    ),

    // ───────── ④' 通用 Web-API 调用追踪（C++ 引擎层，RuyiTrace 模式，JS 不可检测） ─────────
    T(
      "webapi_trace",
      "运行期开关 C++ 引擎层**通用 Web-API 调用追踪**(start/stop/status)。记录 interface.member(args)→return," +
        "看签名/加密读了哪些环境(querySelector/getAttribute/navigator 读)、写到哪(XHR.setRequestHeader)、" +
        "JS↔WASM 边界(TextDecoder/Crypto)。对 JSVMP/WASM/纯混淆都适用。JS 层不可检测(引擎层、不改原型)。",
      {
        type: "object",
        properties: {
          action: { type: "string", enum: ["start", "stop", "status"] },
          filter: { type: "string", description: "接口名/成员名子串(命中才记)。**start 必填**——缺它会记录所有页面所有 DOM 调用、把浏览器卡到标签空白，已禁止。如 navigator/screen/canvas/WebGL/Storage/Crypto/XMLHttpRequest/setRequestHeader/TextDecoder" },
        },
        required: ["action"],
      },
      b => b.webapi && b.webapi.trace,
      (b, a, ctx) => b.webapi.trace(a, ctx)
    ),
    T(
      "webapi_query",
      "读取/统计 Web-API 调用。mode：records(默认,最近原始记录)；" +
        "**env(指纹清单·基础档)**=把 getter 读取+指纹探测方法按 接口→属性 归类，给 值+次数（一键拿到目标站点检测了哪些浏览器特征，= 算法的环境输入依赖）；" +
        "**flow(执行流程·高级档)**=按时间顺序的调用序列(含毫秒 ts/dt)，复原检测逻辑与时序。" +
        "env/flow 会自动把**完整指纹**落盘到 <工作目录>/webapi/(fingerprint-env.json / fingerprint-flow.json)，返回 totalRecords/interfaces(对象)/properties(属性)/reads(次数) + savedFile 路径——" +
        "**拿到后务必向用户汇报：捕获多少条记录、多少个对象、多少个属性，指纹存到了哪个文件**。",
      {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["records", "env", "flow"], description: "records原始/env指纹清单/flow执行流程" },
          limit: { type: "integer", description: "records/flow 返回最近 N 条，默认 200" },
          iface: { type: "string", description: "按接口名子串过滤(如 XMLHttpRequest / Navigator / WebGLRenderingContext)" },
          member: { type: "string", description: "按成员名子串过滤(如 setRequestHeader / userAgent)" },
          kind: { type: "string", enum: ["method", "get", "set"], description: "只看方法/属性读/属性写" },
        },
      },
      b => b.webapi && b.webapi.query,
      (b, a, ctx) => b.webapi.query(a, ctx)
    ),
    T(
      "signer_trace",
      "抓某个 JS 函数被调用时的**真实入参**（引擎层 Debugger 观测：旁观页面函数调用读 frame.arguments，不注入页面）。**仅在「hook 日志大法」够不到时才用这个重家伙**——即目标是闭包内部、`window.` 取不到的函数（如模块 `export` 的 signer）；凡是能 page_eval 包到的边界（fetch/XHR/crypto/具名全局）直接 hook 记 I/O 更省事。" +
        "专治「签名器到底喂了什么」——签名函数收到的 **URL/路径实参**究竟是完整URL/相对路径/带不带 query，**别再靠猜和暴力试输入**；也能抓**请求拦截器**拿到的请求配置对象(含 url/参数)。" +
        "**生产代码是混淆/单行压缩的——别猜函数名 `fn`**：只给 `scriptUrl`(signer 脚本文件名子串) → 抓该脚本里**所有函数调用**的入参，混淆名/匿名箭头都不漏；知道确切名再加 `fn` 收窄。" +
        "用法 start→触发→query→stop：① `signer_trace(action:start, scriptUrl:'signer脚本子串')` 装观测（**跨导航存活**——整页刷新/SPA 换页也能抓到加载期才发的签名请求）；" +
        "② 触发一次真实请求（page_click / page_scroll / **page_navigate 都行**）；③ `signer_trace(action:query)` 取每次调用 + 逐参真值；④ `signer_trace(action:stop)` 关闭（用完即关）。" +
        "**query count=0 多半是没新签名请求触发**——换种交互再触发（切分类/翻页/刷新）；目标接口只首屏触发就 page_navigate 重载。" +
        "**抓 sign 真实入参的最佳姿势：`signer_trace(action:start, scriptUrl:'glue子串', argMatch:'/api')`**——`argMatch` 跳过 init 那些传配置对象的噪声调用，直接拿到 `sign('/api/...', ts)`（**url 实参常是 path-only、不带 query**）。别再靠猜 url、别暴力试。",
      {
        type: "object",
        properties: {
          action: { type: "string", enum: ["start", "query", "stop"], description: "start=装观测 / query=取捕获入参 / stop=关闭" },
          scriptUrl: { type: "string", description: "目标函数所在脚本 URL 子串（如 signer glue 文件名）。**强烈建议给**，收窄到目标脚本、避免噪声/卡顿" },
          fn: { type: "string", description: "目标函数名（如 sign）。混淆短名也可填子串；匿名箭头函数改用 line 定位" },
          line: { type: "integer", description: "目标函数定义行号（匿名函数/拦截器用它锁定）" },
          maxCalls: { type: "integer", description: "保留**最后** N 条匹配调用（环形缓冲，默认 12）——sign 在 init 之后才发生，不会再被「抓满前几条就停」漏掉" },
          argMatch: { type: "string", description: "**强烈建议给**：只抓**实参里匹配此正则的调用**，直接跳过 init 传配置对象的噪声、精准命中 sign(url,ts)。签名 url 是 path → 填 `argMatch:'/api'` 或 `'^/'` 一枪抓到真 sign 入参（治「参数入口拦不到」）" },
        },
        required: ["action"],
      },
      b => b.page && b.page.signerTrace,
      (b, a, ctx) => b.page.signerTrace(a, ctx)
    ),
    T(
      "closure_read",
      "**读取某函数闭包/局部变量的真值**（引擎层 Debugger 观测：目标函数被调用时读 frame.environment 沿作用域链外走，不注入页面）。" +
        "专治『**dispatcher / 解码后字节码 / S-box / 常量池 是闭包变量，`window.` 取不到、page_eval 够不到**』——JSVMP 逆向反复撞的根因（如运行时解码出的字节码数组、RC4 的 256 字节 S-box）。" +
        "与 signer_trace 互补：signer_trace 读**入参**(arguments)，closure_read 读**闭包绑定**(environment)。" +
        "用法 start→触发→query→stop：① `closure_read(action:start, scriptUrl:'目标脚本子串', fn:'dispatcher/runner 函数名子串')` 装观测（跨导航存活、120s 自愈）；② 触发一次目标函数执行（page_click/page_scroll/**page_navigate 重载**）；③ `closure_read(action:query)` 取捕获；④ `action:stop` 关。" +
        "**两步工作流**：先**不传 varNames** → 返回**变量目录**（每层作用域有哪些变量名+浅预览，从中认出目标变量）；再带 `varNames:'变量名正则'` 重来 → **深序列化**命中变量的完整值（256 字节 S-box、几千字节字节码数组整段拿）。大闭包加 `saveTo:'work/closure.json'` 落盘再 fs_read。",
      {
        type: "object",
        properties: {
          action: { type: "string", enum: ["start", "query", "stop"], description: "start=装观测 / query=取捕获 / stop=关闭" },
          scriptUrl: { type: "string", description: "目标函数所在脚本 URL 子串（**强烈建议给**，收窄到目标脚本避免噪声/卡顿）" },
          fn: { type: "string", description: "目标函数名（dispatcher/runner，混淆短名填子串也行）；匿名函数改用 line 定位" },
          line: { type: "integer", description: "目标函数定义行号（匿名函数/箭头函数用它锁定）" },
          varNames: { type: "string", description: "**第二步用**：要深序列化的变量名正则（如 `'_0x30754b|bytecode|sbox|table'`）。不给=只回变量目录+浅预览（先发现变量名）" },
          argMatch: { type: "string", description: "只在**实参匹配此正则**的那次调用读闭包（跳过 init 噪声、命中真正在跑的那次）" },
          maxCalls: { type: "integer", description: "保留最后 N 条捕获（环形缓冲，默认 4）" },
          depth: { type: "integer", description: "深序列化递归深度（默认 4）" },
          maxArr: { type: "integer", description: "数组/TypedArray 逐元素上限（默认 4096，够整段 S-box/字节码）" },
          saveTo: { type: "string", description: "大闭包落盘工作目录相对路径、只回摘要（深序列化的字节码可达几十 KB）" },
        },
        required: ["action"],
      },
      b => b.page && b.page.readClosure,
      (b, a, ctx) => b.page.readClosure(a, ctx)
    ),
    T(
      "hook_inject",
      "**document-start hook 注入**（治『首屏/导航时就触发的签名请求，page_eval 装 hook 来不及、`window.__log is undefined`』）：在**每个新页面、早于页面 JS** 注入你的 hook → 页面自己的 fetch/XHR 都走你的包装、**跨刷新存活**。用法 start→**page_navigate/刷新**→query→stop：① `hook_inject(action:start)` **不传 script＝用内置 preset**（包 fetch+XHR+sendBeacon，把每次请求 url/method/headers/body 记进 `window.__frxhook`）；传 `script` 则注入你自己的 IIFE 片段（自带防重复 guard、往某全局数组 push）。② `page_navigate(目标URL)` 触发——注入在页面 JS 之前，首屏请求被记下。③ `hook_inject(action:query)` 读回记录（默认读 `window.__frxhook`；自定义片段换了变量名就传 `global`）。④ `hook_inject(action:stop)` 关。**只在『必须靠导航/首屏才触发』时用**；能交互触发不刷新的，直接 page_eval 装 hook 更轻（见 skill「hook 日志大法」）。注：同 net 观测，只在**当前内容进程**生效，跨进程导航可能漏。",
      {
        type: "object",
        properties: {
          action: { type: "string", enum: ["start", "query", "stop"], description: "start=注册注入(并立刻往当前页装一份) / query=读回捕获 / stop=关闭" },
          script: { type: "string", description: "要在 document-start 注入的 JS 片段(IIFE)。省略＝用内置 preset(包 fetch+XHR→window.__frxhook)。自定义记得：① 防重复装的 guard ② 往一个全局数组 push ③ 用 `window.X=包装`(显式 window.)" },
          global: { type: "string", description: "query 读哪个全局数组，默认 __frxhook（仅自定义 script 换了变量名才需传）" },
        },
        required: ["action"],
      },
      b => b.page && b.page.hookInject,
      (b, a, ctx) => b.page.hookInject(a, ctx)
    ),
    T(
      "whitebox_diff",
      "P5 白盒诊断：**浏览器真值 vs Node 复刻** 的引擎级 trace 差分，找出「复刻在哪条分支/哪个 import 走法不同、被哪个 env 值带偏」——把黑盒兜圈试值变成白盒定位。" +
        "全程**非侵入**：浏览器侧用引擎层 Debugger 覆盖(collectCoverageInfo，页面测不到)，Node 侧用 node:inspector 精确覆盖 + wasm import 边界(wasm 反射不到)，**零 Proxy 包 env、零 AST 插桩、零源码改动**——不像 Proxy/插桩会被难站点检测污染执行。" +
        "用法(像 signer_trace 那样 start→触发→采→比)：① `whitebox_diff(action:start, scriptUrl:'目标脚本子串')` 装浏览器分支覆盖(**跨导航存活**)；② **page_navigate 重载/交互触发一次真实执行**(覆盖须在脚本运行时采)；③ `whitebox_diff(action:query)` 取浏览器真值(自动落 work/wb_browser.json)；④ `whitebox_diff(action:node, entry:'work/loader.cjs', kind:'js'|'wasm')` 跑 Node 复刻覆盖(落 work/wb_node.json)；⑤ `whitebox_diff(action:diff [,env:webapi导出的env真值json])` 出报告：firstDivergence(分叉分支+源码行) + driver(驱动它的 env 值) + 崩溃/自杀点。⑥ `action:stop` 收。" +
        "env 真值来自 `webapi_trace`(env 模式)；崩溃指 wasm-bindgen 探到 Node 的 process 时的 process.abort 等(已 neutralize 并记栈)。",
      {
        type: "object",
        properties: {
          action: { type: "string", enum: ["start", "query", "node", "diff", "stop"], description: "start=装浏览器分支覆盖 / query=取浏览器真值(落盘) / node=跑Node复刻覆盖(落盘) / diff=比对出报告 / stop=收" },
          scriptUrl: { type: "string", description: "start：目标脚本 URL 子串(锁定要采覆盖的脚本，必给)" },
          entry: { type: "string", description: "node：工作目录内的 Node 复刻 loader(.cjs)，或 kind:'wasm' 时的 .wasm 路径" },
          kind: { type: "string", enum: ["js", "wasm"], description: "node：js=JS复刻走分支覆盖 / wasm=裸 wasm 走 import 序列。默认 js" },
          entryFn: { type: "string", description: "node：要调的导出名(js 的 module 函数名 / wasm 的导出名)；不给则自动找" },
          entryArgs: { type: "array", description: "node：调用实参数组" },
          matchBy: { type: "string", enum: ["offset", "line", "snippet"], description: "diff：对齐粒度。默认 offset(跨引擎+压缩单行 鲁棒,带容差)；line=按源码行；snippet=同引擎" },
          env: { type: "string", description: "diff：可选，工作目录内 env 真值 JSON([{name,value,line?}]，来自 webapi_trace)→ 注入作真值对比" },
        },
        required: ["action"],
      },
      b => b.page && b.page.whiteboxCoverage && b.jsvmp && b.jsvmp.whiteboxNode && b.jsvmp.whiteboxDiff,
      async (b, a, ctx) => {
        const action = a.action || "diff";
        if (action === "start") {
          return b.page.whiteboxCoverage({ action: "start", scriptUrl: a.scriptUrl }, ctx);
        }
        if (action === "stop") {
          return b.page.whiteboxCoverage({ action: "stop" }, ctx);
        }
        if (action === "query") {
          const cov = await b.page.whiteboxCoverage({ action: "query" }, ctx);
          if (cov && cov.ok && b.workspace && b.workspace.write) {
            try { await b.workspace.write({ path: "work/wb_browser.json", content: JSON.stringify(cov) }, ctx); } catch { /* 落盘失败不致命 */ }
          }
          return cov;
        }
        if (action === "node") {
          return b.jsvmp.whiteboxNode(a, ctx);
        }
        if (action === "diff") {
          return b.jsvmp.whiteboxDiff(a, ctx);
        }
        return { ok: false, error: "action ∈ start / query / node / diff / stop" };
      }
    ),
    T(
      "jsvmp_split_dispatcher",
      "离线拆解 JSVMP dispatcher：dispatcher 函数源码 → handlers.json（decode_table + 每个 opcode 语义）。**switch-case 派发**走内置 babel 工具；若它回 0（多为 **if-else 链 / 跳转表**派发），自动跑 `dispatcher_probe`（结构无关：靠 AST+数据流定位派发循环、跳过控制流平坦化假外壳、认 if-else/跳转表、给诊断）兜底，结果写 `<out>.probe.json` 并在返回的 `probe` 字段汇报结构/op 数/诊断——**回 0 不等于此路不通，看 probe**。需先设工作目录。",
      {
        type: "object",
        properties: {
          source: { type: "string", description: "dispatcher 函数源码（内联，与 sourceFile 二选一）" },
          sourceFile: { type: "string", description: "工作目录内含 dispatcher 的 .js 文件（与 source 二选一）" },
          out: { type: "string", description: "输出 handlers.json 路径，默认 handlers.json" },
          col: { type: "integer", description: "自动检测失败时按列号强制指定 dispatcher 函数" },
        },
      },
      b => b.jsvmp && b.jsvmp.splitDispatcher,
      (b, a, ctx) => b.jsvmp.splitDispatcher(a, ctx)
    ),
    T(
      "jsvmp_disassemble",
      "离线静态反汇编：handlers.json + 字节码 → 伪汇编（结果写工作目录文件、只回摘要+头部，避免巨量文本进对话）。内部 run_node 跑打包的离线工具。需先 jsvmp_split_dispatcher 产出 handlers.json。",
      {
        type: "object",
        properties: {
          handlers: { type: "string", description: "handlers.json 路径，默认 handlers.json" },
          bytecode: { type: "string", description: "工作目录内字节码文件：JSON 字节数组 [1,0,4,…] 或 hex 字符串" },
          start: { type: "integer", description: "起始 pc（跳过头部 magic/meta）" },
          limit: { type: "integer", description: "最多反汇编多少条指令" },
          scan: { type: "boolean", description: "自动寻找代码起点" },
          cfg: { type: "boolean", description: "做控制流图 / 结构化恢复" },
          vpc: { type: "string", description: "vpc_resolve.json：用动态轨迹补全跳转目标" },
          out: { type: "string", description: "输出文件，默认 disasm.txt" },
        },
        required: ["bytecode"],
      },
      b => b.jsvmp && b.jsvmp.disassemble,
      (b, a, ctx) => b.jsvmp.disassemble(a, ctx)
    ),
    T(
      "wasm_probe",
      "WASM(wasm-bindgen) 签名器 import-trace：加载 glue+.wasm，hook 所有 wbg import 打 I/O 日志，揭示 wasm 在 签名器 初始化/sign 时读了哪些 DOM/env（querySelector/getAttribute/navigator.webdriver/crypto…，(ptr,len) 实参已解码成可读选择器/属性名）。零三方依赖（极简 fake DOM）。**用法：先空跑（不传 selectors）看 wasm 读了哪些选择器/属性 → 再 page_eval 取真值、用 selectors 喂回复现签名输入。** 签名器若是 glue 闭包里的类（如 pe，靠工厂 Ee() 造）→ 传 `signerExpr`（如 \"Ee()\"）一步拿到它并出签名，**别手改 glue 导出兜圈子**。需先设工作目录，并把 glue(.js) 与 .wasm 落到工作目录（scripts_save/下载）。",
      {
        type: "object",
        properties: {
          gluePath: { type: "string", description: "工作目录内 wasm-bindgen glue .js（含 __wbg_* import 的那份）" },
          wasmPath: { type: "string", description: "工作目录内对应 .wasm 文件" },
          selectors: { type: "object", description: "喂真值：{\"<css 选择器>\":{\"<属性名>\":\"<值>\"}}，如 {\"link[rel*='icon']\":{\"href\":\"…\"},\"meta[name='keywords']\":{\"content\":\"…\"}}。空跑发现阶段省略。" },
          navigator: { type: "object", description: "navigator 字段：{webdriver:false,userAgent,platform,language}" },
          url: { type: "string", description: "页面 URL（document.location）" },
          signUrl: { type: "string", description: "自动调 sign 时传入的 url 实参" },
          signTs: { type: "integer", description: "自动调 sign 时传入的时间戳实参（秒）" },
          attrDefault: { type: "string", description: "未知属性默认返回值，默认空串（避免 Rust unwrap panic）" },
          callExpr: { type: "string", description: "init 后要 eval 的表达式（作用域**只有** __G=导出对象；够不到 glue 闭包内的类/工厂）；不传则自动找返回含 .sign 的导出并调 sign(signUrl,signTs)" },
          signerExpr: { type: "string", description: "在 glue **模块作用域**里求值拿签名器的表达式，如 \"Ee()\" 或 \"new pe()\"——专治『签名器是闭包里的类(pe)、靠工厂(Ee)造，callExpr/自动检测都够不到』。给了它就**不用手改 glue 导出**：自动在模块作用域取到签名器再 .sign(signUrl,signTs) 出签名。先 code_search 找到工厂/类名(如 Ee/pe)再传。" },
        },
        required: ["gluePath", "wasmPath"],
      },
      b => b.jsvmp && b.jsvmp.wasmProbe,
      (b, a, ctx) => b.jsvmp.wasmProbe(a, ctx)
    ),
    T(
      "wasm_disasm",
      "WASM 反汇编：用 wabt 把 .wasm 转成可读 **WAT**（保留 wasm-bindgen 的函数/导出名）。**完整 WAT 落盘到 wasm/<名>.wat（别整读）**，只回摘要：函数/导出/导入数 + 导出名→函数索引。" +
        "传 `func`=导出名或函数索引 → 把该函数的 WAT **另存为 wasm/<名>.func<N>.wat**（不塞进对话），回 funcPath + 前 600 字预览 + 行数。" +
        "读函数 WAT 用 fs_read(funcPath, offset, limit) 切片，或 code_search('指令名', funcPath) 定位特定指令；**禁止整读大函数 WAT 进对话**（超 token 会超时）。" +
        "配合 wasm_probe(边界 I/O) = 内部算法 + 边界依赖都能分析。首次用自动 npm 装 wabt。",
      {
        type: "object",
        properties: {
          wasmPath: { type: "string", description: "工作目录内 .wasm 文件路径" },
          func: { type: "string", description: "可选：导出名或函数索引 → 只抽该函数的 WAT 段（先空跑看 exports，再指定）" },
          out: { type: "string", description: "可选：WAT 输出路径，默认 wasm/<名>.wat" },
        },
        required: ["wasmPath"],
      },
      b => b.jsvmp && b.jsvmp.wasmDisasm,
      (b, a, ctx) => b.jsvmp.wasmDisasm(a, ctx)
    ),

    // ───────── D: 通用 JS 逐函数活体 trace（AST 插桩 + Node 执行，无需 C++ 改动） ─────────
    T(
      "js_trace",
      "通用 JS 逐函数活体 trace（静态 AST 插桩 + Node 执行）。用于非 JSVMP 的普通混淆 JS（bundle/signer/工具函数）。" +
        "三种模式：**static**=列出所有函数名/位置（先看目标在哪）；**instrument**=生成插桩版+runner（再 run_node 执行）；" +
        "**run**=插桩+立即执行+返回调用树。callLog 按深度/进出记录谁调了谁、参数是什么。" +
        "首次用自动 npm 装 acorn 到工作目录。🔑 IIFE 包裹的代码内部函数不暴露到全局 context → 用 filterFn 缩小范围，" +
        "或先 static 找目标函数、再 instrument+run_node 手动执行。",
      {
        type: "object",
        properties: {
          scriptPath: { type: "string", description: "工作目录内的 JS 文件路径（如 scripts/sign.js）" },
          mode: {
            type: "string",
            enum: ["static", "instrument", "run"],
            description: "static=仅列函数（默认）；instrument=生成插桩版+runner；run=插桩+立即执行",
          },
          entryFn: { type: "string", description: "入口函数名（run/instrument 模式：指定后 runner 主动调它，不传则只执行顶层/IIFE）" },
          entryArgs: { type: "array", description: "入口函数参数数组（JSON 可序列化值）" },
          filterFn: { type: "string", description: "正则子串：只插桩/显示名字匹配的函数（如 \"sign|hash|enc\"），缩小噪声" },
          maxCalls: { type: "integer", description: "最大调用日志条数（默认 2000）" },
        },
        required: ["scriptPath"],
      },
      b => b.jsvmp && b.jsvmp.jsTrace,
      (b, a, ctx) => b.jsvmp.jsTrace(a, ctx)
    ),
    T(
      "crypto_scan",
      "**通用密码学指纹扫描**（站点无关、纯分析无副作用）：给一段数据/源码 → 一眼判出用了哪些加密原语，免去人工暴力扫常量。" +
        "识别 **RC4/类RC4 256-字节排列 S-box**、**XXTEA/TEA delta 0x9e3779b9**、**MD5/SHA-1/SHA-256 IV+K 常量**、**AES S-box/Te 查表**、**国密 SM4**、**自定义 base64 字母表**（64 字符排列）。" +
        "全是**公开标准常量/结构**特征，对所有站点一视同仁。" +
        "用法：① 拿到一段疑似 S-box/密钥/字节码（hex 串或 `[1,2,3]` 字节数组）→ `crypto_scan(input:'56544b...')` 判是不是 RC4/AES；" +
        "② 拿到 signer/dispatcher 源码 → `crypto_scan(inputFile:'work/dispatcher.js')` 扫数字字面量里的 IV/K/delta 一眼定 MD5/XXTEA；" +
        "③ 一段 64 字符串 → 判是否自定义 base64 表。**判型分歧时先用它**（如「是 XXTEA 还是 RC4」），别上来就暴力扫几千个常量。",
      {
        type: "object",
        properties: {
          input: { type: "string", description: "内联待扫数据：hex 字符串 / 字节数组 JSON（`[108,71,200,...]`）/ 源码文本（扫其中的 0x.. 十六进制+十进制字面量）/ 64 字符 base64 表。与 inputFile 二选一" },
          inputFile: { type: "string", description: "工作目录内的数据/源码文件路径（如 work/mnsv2_bytecode.hex / work/dispatcher.js）；大文件用它别塞 input。与 input 二选一" },
          out: { type: "string", description: "可选：把完整扫描结果 JSON 落盘到该工作目录相对路径" },
        },
      },
      b => b.jsvmp && b.jsvmp.cryptoScan,
      (b, a, ctx) => b.jsvmp.cryptoScan(a, ctx)
    ),

    // ───────── 页面侦察 / 组合工具 ─────────
    T(
      "page_info",
      "获取当前页面概况（URL/标题/脚本数/UA）——侦察第一步。",
      { type: "object", properties: {} },
      b => b.page && b.page.info,
      (b, a, ctx) => b.page.info(a, ctx)
    ),
    T(
      "page_automation_scan",
      "在当前网页内容上下文扫描常见自动化/底层环境暴露点：navigator.webdriver、UA-CH、plugins、permissions、Chrome/Firefox 对象、WebGL/canvas/audio/WebRTC/storage 等。用于比较手动打开与 MCP 打开的全局差异，不做单站点加密分析。",
      {
        type: "object",
        properties: {
          saveTo: { type: "string", description: "可选；把完整扫描 JSON 落到工作目录相对路径，如 diagnostics/automation-scan.json" },
        },
      },
      b => b.page && b.page.automationScan,
      (b, a, ctx) => b.page.automationScan(a, ctx)
    ),
    T(
      "scripts_capture_all",
      "把当前页面所有外部脚本源码落盘到语料目录（供 code_search / find_param_entry）。",
      { type: "object", properties: {} },
      b => b.scripts && b.scripts.captureAll,
      (b, a, ctx) => b.scripts.captureAll(a, ctx)
    ),
    T(
      "find_param_entry",
      "③ 定位加密/签名参数入口：该参数出现在哪些请求 + 其字面量在哪些已存 JS 的行。",
      {
        type: "object",
        properties: {
          param: { type: "string", description: "参数名，如 sign / token / 加密签名参数" },
          urlPattern: { type: "string", description: "可选，限定请求 URL（fnmatch）" },
        },
        required: ["param"],
      },
      b => b.find && b.find.paramEntry,
      (b, a, ctx) => b.find.paramEntry(a, ctx)
    ),

    // ───────── ⑦ 工作目录：文件读写 + 本地执行（backend: workspace） ─────────
    T(
      "fs_list",
      "列出当前会话工作目录下的文件/子目录（路径相对工作目录，浅递归）。",
      {
        type: "object",
        properties: {
          subdir: { type: "string", description: "相对子目录，省略=工作目录根" },
          depth: { type: "integer", description: "递归层数，默认 2，最多 3" },
        },
      },
      b => b.workspace && b.workspace.list,
      (b, a, ctx) => b.workspace.list(a, ctx)
    ),
    T(
      "fs_read",
      "读取工作目录内文本文件。**大文件别整读**——它是数据：优先用 `code_search` 查询、或写 `run_node` 脚本 fs.readFileSync 提取/转换(只回小结果)；确需读某段用 offset+limit 切片。整读超过 32KB 的文件只会回头部+提示（防上下文爆炸/卡死）。",
      {
        type: "object",
        properties: {
          path: { type: "string", description: "相对工作目录的文件路径" },
          offset: { type: "integer", description: "起始字节偏移（切片读大文件用）" },
          limit: { type: "integer", description: "最多读取字节数（从 offset 起）" },
        },
        required: ["path"],
      },
      b => b.workspace && b.workspace.read,
      (b, a, ctx) => b.workspace.read(a, ctx)
    ),
    T(
      "fs_write",
      "写入/覆盖工作目录内的文本文件（自动建父目录）。用于把抓取的脚本、还原出的算法实现、分析笔记落盘。" +
        "**大文件务必分多次写**：第一段正常 fs_write，后续段用 append:true 追加——单次内容过大会被输出长度限制截断、整个调用失败。",
      {
        type: "object",
        properties: {
          path: { type: "string", description: "相对工作目录的文件路径" },
          content: { type: "string", description: "文件内容（单次别太大，超长会被截断；大文件分多次写）" },
          append: { type: "boolean", description: "true=追加到文件尾（分多次写大文件用）；省略/false=覆盖" },
        },
        required: ["path", "content"],
      },
      b => b.workspace && b.workspace.write,
      (b, a, ctx) => b.workspace.write(a, ctx)
    ),
    T(
      "fs_mkdir",
      "在工作目录内创建子目录（含多级父目录）。",
      {
        type: "object",
        properties: { path: { type: "string", description: "相对工作目录的目录路径" } },
        required: ["path"],
      },
      b => b.workspace && b.workspace.mkdir,
      (b, a, ctx) => b.workspace.mkdir(a, ctx)
    ),
    T(
      "fs_copy",
      "在工作目录内复制文件（服务端直接拷，内容**不经模型输出**）。**要在 Node 里跑/改一个已落盘的大文件（如已 scripts_save 的 wasm-bindgen glue），用它复制现成的 + 只写几十行小 loader/补丁；绝不要用 fs_write 把大文件全文重新生成**——那要模型一轮吐上万字符，会撞单轮输出上限被截断、卡住会话。",
      {
        type: "object",
        properties: {
          src: { type: "string", description: "源文件（工作目录内相对路径，如 scripts/xxx.js）" },
          dst: { type: "string", description: "目标路径（工作目录内）" },
          overwrite: { type: "boolean", description: "目标已存在是否覆盖，默认 true" },
        },
        required: ["src", "dst"],
      },
      b => b.workspace && b.workspace.copy,
      (b, a, ctx) => b.workspace.copy(a, ctx)
    ),
    T(
      "run_node",
      "在工作目录内执行 Node.js：传 code(内联JS, 经 node -e) 或 file(目录内 .js 路径)，可带 args；返回合并的 stdout/stderr 与退出码。" +
        "用于跑还原脚本、验证算法实现、补环境跑 signer。需要三方库(jsdom/crypto-js/sm-crypto…)先用 npm_install 装，再 require。",
      {
        type: "object",
        properties: {
          code: { type: "string", description: "内联 JS 代码（与 file 二选一）" },
          file: { type: "string", description: "工作目录内的 .js 文件路径（与 code 二选一）" },
          args: { type: "array", items: { type: "string" }, description: "命令行参数" },
        },
      },
      b => b.workspace && b.workspace.runNode,
      (b, a, ctx) => b.workspace.runNode(a, ctx)
    ),
    T(
      "npm_install",
      "在工作目录内 `npm install` 三方包（装到 <工作目录>/node_modules，run_node 里直接 require）。" +
        "阶段一补环境的标配：jsdom(模拟DOM) / crypto-js / sm-crypto / node-forge 等标准密码学库**正常装来用，不要手搓**。" +
        "省略 packages 则按已有 package.json 安装。",
      {
        type: "object",
        properties: {
          packages: {
            type: "array",
            items: { type: "string" },
            description: "包名数组，如 [\"jsdom\",\"crypto-js\"]；可带版本如 \"jsdom@24\"",
          },
          args: { type: "array", items: { type: "string" }, description: "额外 npm 参数，如 [\"--save-dev\"]" },
        },
      },
      b => b.workspace && b.workspace.npmInstall,
      (b, a, ctx) => b.workspace.npmInstall(a, ctx)
    ),

    // ───────── ⑧ 逆向方法论（内置 skill 全文，开工按需拉取） ─────────
    T(
      "skill_get",
      "读取内置的**逆向方法论全文**。**开工逆向前先调一次**——尤其看 §3 反爬三分(选路径)、§4 阶段一(Node 可用版,以本地实打目标接口返回有效数据为准)、§6 决策树(同类报错≥3 次就换路线、别绕圈)。系统提示只有短核心,完整流程/红线/工具映射在这里。",
      { type: "object", properties: {} },
      b => b.skill && b.skill.get,
      (b, a, ctx) => b.skill.get(a, ctx)
    ),

    // ───────── ⑨ 逆向进展笔记（跨会话按站点记"验证过的突破点/坑"） ─────────
    T(
      "notes_add",
      "记一条**验证通过**的逆向进展笔记到本地（<工作目录>/.frx-notes.ndjson，按站点）。" +
        "**只在结论已跑通/对比一致时才记**（如签名公式、关键入口、指纹依赖、踩过的坑）。下次逆向同站点会自动提示。" +
        "⚠ 别记未验证的猜测；站点会改版，记的是经验不是长期真理。",
      {
        type: "object",
        properties: {
          note: { type: "string", description: "一句话结论（突破点/坑/算法/指纹依赖），≤600字" },
          site: { type: "string", description: "站点域名，省略=当前标签页域名" },
          topic: { type: "string", description: "主题，如 sign / token / 登录" },
          kind: { type: "string", enum: ["breakthrough", "pitfall", "env", "algo", "endpoint", "note"], description: "突破点/坑/指纹/算法/接口/其他" },
          verifiedBy: { type: "string", description: "怎么验证的（如：业务API返回status_code:0 / 与浏览器逐字节一致）" },
        },
        required: ["note"],
      },
      b => b.notes && b.notes.add,
      (b, a, ctx) => b.notes.add(a, ctx)
    ),
    T(
      "notes_get",
      "读历史逆向进展笔记（默认当前站点，最近若干条）。开工前先看：可能有突破点/要避的坑。⚠ 站点会改版，仅供参考、用前先验证。",
      {
        type: "object",
        properties: {
          site: { type: "string", description: "站点域名子串，省略=当前标签页域名" },
          limit: { type: "integer", description: "最近 N 条，默认 30" },
          all: { type: "boolean", description: "true=不按站点过滤，返回全部" },
        },
      },
      b => b.notes && b.notes.get,
      (b, a, ctx) => b.notes.get(a, ctx)
    ),
    T(
      "remember",
      "把一条**已确认的事实**或**已否决的死路**记进任务账本（落 <工作目录>/ledger.md）。" +
        "**发现即记、别等**：每定位到一个入口/函数/真值、每验证一个算法/特征、每排除一条路，就立刻记一条。" +
        "账本**每轮都自动注入到你上下文顶部、压缩也永不衰减**——所以记过的就不必重新发现/重抓/重解码，否决的就不会重走。" +
        "这是治「压缩后兜圈重复」的核心，比写长摘要更稳。",
      {
        type: "object",
        properties: {
          text: { type: "string", description: "一句话写清：已确认的事实（**带具体定位/真值**——具体到 文件/函数/位置、已验证的算法或特征、关键运行时真值，别只写\"已定位 X\"），或要排除的死路+理由。≤500字" },
          kind: { type: "string", enum: ["fact", "deadend"], description: "fact=已确认事实（默认）；deadend=已否决/别重试的方向" },
          evidence: { type: "string", description: "证据：哪个工具+关键返回片段（如 net_get 某请求 / run_node 某输出）" },
        },
        required: ["text"],
      },
      b => b.ledger && b.ledger.append,
      (b, a, ctx) => b.ledger.append(a, ctx)
    ),
    T(
      "recall",
      "检索**当前工作目录(任务)**的历史记忆库（remember 沉淀的已确认事实/已否决死路，SQLite 持久化、**按目录隔离**）。" +
        "本目录的记忆每轮已自动注入你上下文顶部；recall 用于按关键词/类型在**本目录**里精确查（不跨站点、不从全局捞）。" +
        "想复用某个旧任务的记忆，就「打开目录」开回那个任务的目录——记忆随目录回来。",
      {
        type: "object",
        properties: {
          query: { type: "string", description: "关键词子串（匹配事实正文，如 签名函数名 / 某指纹项 / nonce / 目标参数名）" },
          kind: { type: "string", enum: ["fact", "deadend"], description: "只看已确认事实 / 已否决死路" },
          limit: { type: "integer", description: "最多返回几条，默认 20" },
        },
      },
      b => b.ledger && b.ledger.recall,
      (b, a, ctx) => b.ledger.recall(a, ctx)
    ),
    T(
      "run_python",
      "在工作目录内执行 Python：传 code(内联, 经 python -c) 或 file(目录内 .py 路径)，可带 args；返回合并的 stdout/stderr 与退出码。",
      {
        type: "object",
        properties: {
          code: { type: "string", description: "内联 Python 代码（与 file 二选一）" },
          file: { type: "string", description: "工作目录内的 .py 文件路径（与 code 二选一）" },
          args: { type: "array", items: { type: "string" }, description: "命令行参数" },
        },
      },
      b => b.workspace && b.workspace.runPython,
      (b, a, ctx) => b.workspace.runPython(a, ctx)
    ),

    // ───────── Cookie 管理（backend: cookies；nsICookieManager，含 httpOnly） ─────────
    T(
      "cookies",
      "管理浏览器 cookie（经引擎 nsICookieManager，**含 httpOnly**——page_eval 的 document.cookie 拿不到 httpOnly；可跨域、可管理登录态）。" +
        "**action=list** 列出（按 domain/name 过滤，只读）；**action=set** 新增/修改（同 host+path+name 覆盖，会读回确认）；**action=remove** 删除（name+domain 删单个 / 只给 domain 删该 host 全部 / `all:true` 清空所有）。",
      {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "set", "remove"], description: "list=列出 / set=新增改 / remove=删除" },
          name: { type: "string", description: "cookie 名（set 必填；list/remove 选填，list 时按名过滤）" },
          value: { type: "string", description: "[set] cookie 值（省略=空串）" },
          domain: { type: "string", description: "cookie 的 host，如 example.com 或 .example.com（set 必填；list 按 host 子串过滤；remove 必填，除非 all）" },
          path: { type: "string", description: "路径，默认 /" },
          secure: { type: "boolean", description: "[set] 仅 https 发送" },
          httpOnly: { type: "boolean", description: "[set] JS 读不到（document.cookie 不可见）" },
          session: { type: "boolean", description: "[set] 会话 cookie（关浏览器即失效）；不设且无 expires/maxAge 时默认持久一年" },
          expires: { type: "number", description: "[set] 过期时间：unix 时间戳【秒】" },
          maxAge: { type: "number", description: "[set] 从现在起多少【秒】后过期（优先于 expires）" },
          sameSite: { type: "number", description: "[set] 0=None 1=Lax 2=Strict（省略=引擎默认 UNSET）" },
          all: { type: "boolean", description: "[remove] true=清空所有 cookie（忽略其它参数，慎用）" },
        },
        required: ["action"],
      },
      b => b.cookies && b.cookies.run,
      (b, a) => b.cookies.run(a)
    ),

    // ───────── 环境管理（backend: env；一个环境一个 profile + 独立进程）─────────
    T(
      "env_current",
      "返回当前 Firefox Reverse 进程所属的环境。如果浏览器不是从环境打开，则 environment 为 null。",
      {
        type: "object",
        properties: {
          refresh: { type: "boolean", description: "是否刷新运行状态，默认 true" },
        },
      },
      b => b.env && b.env.current,
      (b, a) => b.env.current(a)
    ),
    T(
      "env_current_process",
      "返回当前主进程的指纹配置状态。普通启动时它不是环境列表的一行；保存主进程配置后需重启 Firefox Reverse 生效。",
      {
        type: "object",
        properties: {
          refresh: { type: "boolean", description: "是否刷新运行状态，默认 true" },
        },
      },
      b => b.env && b.env.currentProcess,
      (b, a) => b.env.currentProcess(a)
    ),
    T(
      "env_read_current_process_config",
      "读取当前主进程配置文件。type 支持 fingerprint 或 proxy；普通启动主进程使用当前 profile 的 user.js 指向该配置。",
      {
        type: "object",
        properties: {
          type: { type: "string", enum: ["fingerprint", "proxy"] },
        },
      },
      b => b.env && b.env.readCurrentProcessConfig,
      (b, a) => b.env.readCurrentProcessConfig(a)
    ),
    T(
      "env_write_current_process_config",
      "写入当前主进程配置文件。保存后会写入当前 profile/user.js，C++ 指纹覆盖需要重启主进程后生效。",
      {
        type: "object",
        properties: {
          type: { type: "string", enum: ["fingerprint", "proxy"] },
          config: { type: "object" },
          text: { type: "string", description: "可选 JSON 文本；传入时优先解析 text" },
        },
      },
      b => b.env && b.env.writeCurrentProcessConfig,
      (b, a) => b.env.writeCurrentProcessConfig(a)
    ),
    T(
      "env_reset_current_process_default",
      "一键还原当前主进程默认指纹配置：移除当前 profile/user.js 中的主进程指纹 block，并清掉对应 user prefs。需要 confirm:true。",
      {
        type: "object",
        properties: {
          confirm: { type: "boolean", description: "必须为 true" },
        },
        required: ["confirm"],
      },
      b => b.env && b.env.resetCurrentProcessDefault,
      (b, a) => b.env.resetCurrentProcessDefault(a)
    ),
    T(
      "env_list",
      "列出 firefox-reverse 环境。环境是独立 profile + 独立 Firefox 进程；root 默认 ~/.firefox-reverse/environments。",
      {
        type: "object",
        properties: {
          refresh: { type: "boolean", description: "是否刷新运行状态，默认 true" },
        },
      },
      b => b.env && b.env.list,
      (b, a) => b.env.list(a)
    ),
    T(
      "env_status",
      "查看某个环境或全部环境的运行状态。",
      {
        type: "object",
        properties: {
          id: { type: "string", description: "环境 id；省略则返回全部环境" },
        },
      },
      b => b.env && b.env.status,
      (b, a) => b.env.status(a)
    ),
    T(
      "env_create",
      "新建一个隔离环境，自动创建 env.json/fingerprint.json/proxy.json/profile/traces/control。",
      {
        type: "object",
        properties: {
          id: { type: "string", description: "可选环境 id；不传则自动生成" },
          name: { type: "string", description: "环境名称" },
          generateOptions: {
            type: "object",
            description: "可选；传入时新建后立即按该组选项生成 fingerprint.json",
            properties: {
              os: { type: "string", enum: ["windows", "macos", "linux"] },
              firefoxVersion: { type: "string" },
              language: { type: "string" },
              resolution: { type: "string", description: "如 1920x1080" },
              timezone: { type: "string" },
              devicePixelRatio: { type: "number" },
              hardwareConcurrency: { type: "integer" },
              randomize: { type: "boolean", description: "true 时从内置桌面组合池随机生成一组参数" },
            },
          },
        },
      },
      b => b.env && b.env.create,
      (b, a) => b.env.create(a)
    ),
    T(
      "env_update",
      "修改环境基础信息。第一版只支持改名。",
      {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
        },
        required: ["id"],
      },
      b => b.env && b.env.update,
      (b, a) => b.env.update(a)
    ),
    T(
      "env_open",
      "启动指定环境：独立 Firefox 进程 + -no-remote + 独立 profile + 独立 Marionette 端口。",
      {
        type: "object",
        properties: {
          id: { type: "string" },
          url: { type: "string", description: "可选，启动后打开的 URL" },
          port: { type: "integer", description: "可选 Marionette 端口；不传则自动分配" },
        },
        required: ["id"],
      },
      b => b.env && b.env.open,
      (b, a) => b.env.open(a)
    ),
    T(
      "env_close",
      "关闭指定环境进程并更新 runtime 状态。",
      {
        type: "object",
        properties: {
          id: { type: "string" },
        },
        required: ["id"],
      },
      b => b.env && b.env.close,
      (b, a) => b.env.close(a)
    ),
    T(
      "env_read_config",
      "读取环境配置文件。type 支持 fingerprint 或 proxy。",
      {
        type: "object",
        properties: {
          id: { type: "string" },
          type: { type: "string", enum: ["fingerprint", "proxy"] },
        },
        required: ["id"],
      },
      b => b.env && b.env.readConfig,
      (b, a) => b.env.readConfig(a)
    ),
    T(
      "env_write_config",
      "写入环境配置文件。type 支持 fingerprint 或 proxy；config 必须是 JSON object。",
      {
        type: "object",
        properties: {
          id: { type: "string" },
          type: { type: "string", enum: ["fingerprint", "proxy"] },
          config: { type: "object" },
          text: { type: "string", description: "可选 JSON 文本；传入时优先解析 text" },
        },
        required: ["id"],
      },
      b => b.env && b.env.writeConfig,
      (b, a) => b.env.writeConfig(a)
    ),
    T(
      "env_generate_fingerprint",
      "按 Firefox 桌面参数生成一致的 fingerprint.json。支持 os/firefoxVersion/language/languages/resolution/timezone/devicePixelRatio/hardwareConcurrency。",
      {
        type: "object",
        properties: {
          id: { type: "string" },
          options: {
            type: "object",
            properties: {
              os: { type: "string", enum: ["windows", "macos", "linux"] },
              firefoxVersion: { type: "string" },
              language: { type: "string" },
              languages: { type: "array", items: { type: "string" } },
              resolution: { type: "string", description: "如 1920x1080" },
              timezone: { type: "string", description: "如 Asia/Shanghai" },
              devicePixelRatio: { type: "number" },
              hardwareConcurrency: { type: "integer" },
              randomize: { type: "boolean", description: "true 时从内置桌面组合池随机生成一组参数" },
            },
          },
        },
        required: ["id"],
      },
      b => b.env && b.env.generateFingerprint,
      (b, a) => b.env.generateFingerprint(a)
    ),
    T(
      "env_capture_fingerprint",
      "采集当前 Firefox Reverse JS 可见指纹并写入该环境 captures/*.json。",
      {
        type: "object",
        properties: {
          id: { type: "string" },
        },
        required: ["id"],
      },
      b => b.env && b.env.captureFingerprint,
      (b, a) => b.env.captureFingerprint(a)
    ),
    T(
      "env_import_fingerprint",
      "把 captures/*.json 或传入 capture 对象规范化写入 fingerprint.json。",
      {
        type: "object",
        properties: {
          id: { type: "string" },
          capturePath: { type: "string", description: "可选；省略则导入最新 capture" },
          capture: { type: "object", description: "可选；直接传 capture object" },
          text: { type: "string", description: "可选；外部采集脚本弹出的 JSON 文本" },
        },
        required: ["id"],
      },
      b => b.env && b.env.importFingerprint,
      (b, a) => b.env.importFingerprint(a)
    ),
    T(
      "env_import",
      "导入完整环境 JSON。支持 {name,id,fingerprint,proxy,generateOptions} 或 {env, fingerprint, proxy}；默认新建环境，若 id 已存在必须传 overwrite:true。",
      {
        type: "object",
        properties: {
          id: { type: "string", description: "可选；指定导入到哪个环境 id" },
          name: { type: "string", description: "可选；覆盖导入后的环境名称" },
          text: { type: "string", description: "完整环境 JSON 文本" },
          config: { type: "object", description: "完整环境 JSON object" },
          overwrite: { type: "boolean", description: "id 已存在时是否覆盖 fingerprint/proxy/name" },
        },
      },
      b => b.env && b.env.importEnvironment,
      (b, a) => b.env.importEnvironment(a)
    ),
    T(
      "env_delete",
      "删除已关闭环境。必须传 confirm:true；会递归删除该环境目录。",
      {
        type: "object",
        properties: {
          id: { type: "string" },
          confirm: { type: "boolean", description: "必须为 true" },
        },
        required: ["id", "confirm"],
      },
      b => b.env && b.env.delete,
      (b, a) => b.env.delete(a)
    ),
  ];
}

/**
 * 按在场 backend 生成可注册的 ToolRouter spec 数组。
 * @param {object} backends  { page?, code?, net?, scripts?, jsvmp? }
 * @returns {Array<{name,description,parameters,handler}>}
 */
export function createBuiltinTools(backends = {}) {
  return toolTable()
    .filter(t => {
      try {
        return !!t._need(backends);
      } catch {
        return false;
      }
    })
    .map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      needsConfirm: CONFIRM_TOOLS.has(t.name),
      handler: (args, ctx) => t._call(backends, args, ctx),
    }));
}

/** 仅用于文档/调试：列出全部声明的工具名（不论 backend 是否在场）。 */
export function declaredToolNames() {
  return toolTable().map(t => t.name);
}

# Agent 逆向方法论（skill_get 全文 · 一页流）

> 站点无关、通用。只用 Agent 自己的工具。目标：产出**不靠浏览器运行时**的 Node 复刻（补环境/纯算），实打接口返回有效数据。
> 这份只教**怎么用工具走通常规链路**；具体怎么拆、何时换路，你自己判断。站点特例进 notes。

## 红线（4 条，记牢）
1. **最终产物不靠浏览器跑加密**：node 补环境/纯算都行；开浏览器调 signer 当 runtime＝违规。浏览器只作分析/验证 oracle。从浏览器抓的**静态值**（cookie/登录态/风控令牌等）当输入用**不算违规**。
2. **page_eval 只读**：取值/调页面现成 signer 取样/验证；别注入 JS hook、别 import 应用模块/重定义全局。要 hook 在引擎层（jsvmp_trace/webapi_trace）。
3. **trace 必带 filter**：webapi_trace 填接口/成员名子串，jsvmp_trace 填脚本文件名子串；收窄到 signer 一次调用（start→clear→触发一次→query）。
4. **标准密码学用库**（crypto/crypto-js/sm-crypto/node-forge），不手搓 MD5/SHA/HMAC/AES/SM3。

## 决策树（先判型，再选模式）
```
抓到目标接口 + 有加密参数
  └─ 加密逻辑在哪？
       ├─ 明文 JS / 普通混淆      → 模式A：code_search 定位 → 提取 → 纯算 Node 还原
       ├─ 服务端下发 JS 动态执行   → 模式B：vm/jsdom 沙箱执行原始 JS
       ├─ WASM(__wbg_*/.wasm)     → 模式C：wasm_probe 看边界 I/O → 补环境加载 glue+wasm
       └─ JSVMP(大单文件+派发循环+字节码) → 优先模式B补环境黑盒；卡了再 jsvmp_trace 看算法
```

## 常规执行链（从上往下推，别在一处死磕）
**0. 开工（30 秒）**：`notes_get` 看本站历史 → 明确目标参数名 + 它在哪个请求 → 设好工作目录。

**1. P0 拿真实样本**：`net_capture start`（自动带发起者栈）→ 页内**滚动/点击触发**目标请求（别整页刷新，会丢栈）→ `net_list` 找带目标参数的请求 → `net_get` 看 URL/headers/**initiatorStack**。把**逐字节真实样本 + 对应输入**记进 ledger。

**2. P1 定位生成点**：`net_get` 的 `initiatorStack` 直接给"谁拼了这个参数"的调用栈（栈为 null 就页内交互重触发）。`scripts_capture_all` 落盘 → `code_search(参数名/signer特征, scriptUrl)` 摸到 signer 脚本 → `scripts_save(url, toWorkspace:true)` 落到 `scripts/`。

**3. P2 先验证再逆向（关键，别跳）**：在浏览器内 `page_eval` 调到候选 signer，给已知输入取输出，和 P0 真实样本**逐字节 diff**。
- **wire 参数常 ≠ 最显眼 signer 的输出**（常见 `wire = wrapper(signer输出, 其它字段)`）。格式/长度/前缀对不上＝没找对，顺调用栈往上层找真正拼装 wire 值的函数。**没 diff 对上之前，别进字节码反汇编。**
- **字节长度先速判**：写复刻代码前，先比「你假设的算法输出字节数」和「真实 wire 值解码后的字节数」——对不上（如假设 HMAC-SHA256＝32 字节、但 wire 解码后是 75 字节）就**立刻否决该假设、换方向**，别写一堆代码白验证。长度/前缀这种廉价信号能在 30 秒内排除大半错误假设。
- **没用真实 wire 值复现对上前，禁止往账本写「已确认/已破译」**：账本（remember）只记**验证过**的事实。把"看着像/猜的算法"当确认写进去，会污染账本、误导后续每一轮（确认过的不再重验、直接拿去用）——比没记还糟。没验证就写「待验证假设」，别写「已确认」。
- **不确定 signer 真实入参就别猜、更别暴力试**——生产代码混淆/单行，**别猜函数名**：`signer_trace(action:start, scriptUrl:signer脚本子串, argMatch:'/api')`——**`argMatch` 只抓实参匹配此正则的调用、跳过 init 那堆传配置对象的噪声，一枪命中 `sign('/api/...', ts)`**（不给 argMatch 时 init 调用会先占满、真 sign 在其后被永久漏掉＝实战"参数入口拦不到、兜几十轮"的根因；现已改环形缓冲留最后 N 条，但加 argMatch 最干净）→ 触发一次真实请求（**导航也能抓**，跨导航存活）→ `signer_trace(action:query)` 拿到**喂给 signer 的真实实参**（不注入页面）。**经验（通用）：url 实参常是 path/相对路径、且常不含 query string（`?a=b` 在 params 里单传）**——别拿完整 URL 去试。也能看到拦截器拿到的 `e`（含 `e.url`/`e.params`）。**这一步省掉"猜输入→暴力试→兜圈"的大坑。** `query count=0` = 没新请求触发，换种交互/page_navigate 重载再试。

**4. P3/P4 判型选路**：`wasm_probe`(有 WASM) / 看 JSVMP 特征 → 按决策树选模式。**黑盒优先**：复刻**完整加载顺序 + init 调用**（signer 常由 glue/`_XxxInit` 编排多脚本，只 load 单文件＝signer 不存在，这是高频坑）。

**5. P5 补环境闭环**：脚手架在 `.agent-tools/templates/`（`fs_copy` 拿现成改，别从零写）。**报错驱动**：跑→读错→补**一个**最小缺失项→再跑。指纹用 `webapi_trace`(env 模式)/`wasm_probe` 抓的**真值**补，别瞎填。常见缺失：`window/document/navigator` 桩、`Object/Array/Date` 等构造器没挂全（VM 取 `window.X` 当 `new` → "is not a constructor"）、`globalThis.process` 没藏（wasm-bindgen getrandom 走 Node 分支崩）。**Node 21+ 的 `global.navigator` 是只读 getter**——补环境别 `global.navigator={…}` 赋值（抛 `Cannot set property navigator`），用 `Object.defineProperty(globalThis,'navigator',{value:{webdriver:false,…},configurable:true})`。
- **复刻结果和浏览器对不上（分支/加密值不一致、偶尔空响应）别瞎试** → `whitebox_diff` 做**浏览器真值 vs Node 复刻**的引擎级差分（非侵入：浏览器侧 Debugger 覆盖、Node 侧 inspector 覆盖/wasm import 边界，**零 Proxy 包 env、零 AST 插桩**，难站点也测不到观测本身）：`action:start(scriptUrl)` → `page_navigate` 重载触发 → `action:query`（取浏览器真值）→ `action:node(entry:work/loader.cjs, kind:js|wasm)`（跑复刻覆盖）→ `action:diff(env:webapi导出的env真值)` → 直接告诉你**第一处走法不同的分支（源码行）+ 驱动它的 env 值**，按真值对齐补环境再跑。复刻里的崩溃/自杀（如探到 Node 的 `process` 后 abort）也会被拦截记栈。

**6. P6 实打验证**：node 生成参数 → 拼完整请求模板（`net_get` 抓的真实请求当模版，稳定值 cookie/token 从浏览器拿）→ 打真实接口 → **非空有效**才算过；换多组输入再验。产出最小可运行示例到 `out/`。

## 记账本（治压缩后兜圈重复，最重要的习惯）
- **确认即记**：每定位到入口/函数/真值、每验证一个算法/特征、每排除一条死路 → 立刻 `remember(text, kind:fact|deadend, evidence)`。带**具体值**（偏移/真值/字节结构/调用方式），别只写"已定位 X"。
- 账本**每轮自动注入你上下文顶部、压缩永不衰减、跨会话持久化（SQLite，按工作目录隔离）**——所以**动手前先看账本**：✅已确认的别重新发现/重抓/重解码，⛔已否决的别重走。这比反复写长摘要稳得多（散文摘要多压几次就丢细节，逼你重读重抓）。
- **隔离模型**：自动注入只给**当前工作目录(=任务)**的账本——**换目录=新任务、干净起步**；要**续**之前的任务就**开回原目录**（它的账本自动回来）。remember 仍按域名打 site 标签，只是不再自动跨目录灌。
- **开工/换方向先 `recall`**：跨**全部**任务/会话/站点按关键词/站点检索——查这个站点或类似目标**以前**确认过什么、排除过哪些死路，别从零开始。`recall(site:目标域名)` 或 `recall(query:关键词)` 翻历史（**工作目录可能已清空 → 历史结论先验证仍适用、产物按需重新落盘**）。

## 反绕圈（自己掌握，引擎只轻提醒）
- 同一手段反复无新结果 ≥3 次＝在绕 → 挑一条最有把握的路**推到判决**（跑出结果 / 确认此路不通带证据再换），别在同处磨；确认走不通就 `remember(kind:deadend)` 记下别再走。
- signer 明文/参数名搜不到＝正常（混淆/运行时拼接）→ 转 trace，别死搜。
- 补环境同类报错 ≥3 次 → 多半是**初始化链/加载顺序不对**，不是缺某个属性 → 补缺失层 / 转 browser-as-oracle 拿对照样本 / 转 jsvmp_trace 看算法。
- 红旗（格式不符/长度对不上/偶尔空响应）**别忽略**——通常是目标没锁对或漏了易变字段（时间戳/nonce）。

## WASM(wasm-bindgen) 专项
**先判 native/WASM——别在压缩 JS 里反复硬找签名函数定义**：`signer_trace` 已给出签名函数名+`length` 却在压缩脚本里**搜不到它的 JS 定义**（`code_search`/`run_node grep` 找 **2 次没有就停**）→ 几乎一定是 native/WASM。`code_search` 搜一次 `__wbg_` 或 `signtool` 或 `wasm_bindgen` 或 `.wasm`，命中即**定型为 WASM**、立刻转下面的 WASM 路线，**绝不再反复 `code_search`/`run_node grep` 找 `function sign`/追 import 重命名链**（实战：在压缩 JS 里追 `W→ne→Ui→post→…` 的导出重命名链、找 WASM 签名的 JS 定义，磨了上百轮还没找到——因为它根本不在 JS 里，签名体在 `.wasm`）。
落 .wasm 直接 `scripts_save(url, toWorkspace:true)`（已正确按二进制落到 `wasm/`，别再 page_eval 分块传 base64）。
**第一步就 `fs_copy .agent-tools/templates/wasm-signer-loader.js` 到 work/ 改 3 处(glue路径/wasm路径/sign入参)先跑一次——别先自己手写 loader、别先逐个补 import、更别去逆向 wasm_probe.cjs 照抄它的 polyfill**（它已处理 jsdom 真 Window、藏 process、每次 sign 新建实例这些坑；实战里不用模板从零写会写出十几个 loader 版本还在补 import）。它跑不通(缺某 import / 某真值不对)再用下面路线①的 wasm_probe 看**缺哪个 import / 读了哪个真值**，只补那一个。
路线①快：`wasm_probe(gluePath, wasmPath)` 空跑 → 列出 wasm 在 init/sign 读的每个 DOM/env（已解码）＝**签名真实输入清单**（这才是 wasm_probe 的核心价值）→ `page_eval` 取真值 → `wasm_probe(selectors:{...})` 喂回。**注意 wasm_probe 不保证能自动调出 sign 输出**（高层导出常是依赖别的 chunk、被 stub 掉的工厂链）——真实 sign 输出走路线②裸 loader，别在 wasm_probe 上反复试调 sign。
路线②补环境跑 signer：`fs_copy .agent-tools/templates/wasm-signer-loader.js` 到 work/ 改三处——它已处理 **wasm-bindgen+jsdom 二次 sign 崩**（每次 sign 新建实例）、构造期 `instanceof Window`/`querySelector` panic（jsdom 注入真 favicon/meta）、藏 process、补构造器。纯 wasm-bindgen signer 也可**裸 instantiate**（自己 stub 那 ~12 个 wbg import），但务必踩对这几个**通用反 Node 调试坑**：① **藏 process**（`globalThis.process=undefined` + `__wbg_static_accessor_PROCESS` 返回 undefined）——否则 wasm 探到 Node 的 `process` 会直接 `process.abort()` 自杀（SIGABRT）；② navigator.webdriver=false 且**拦截对它的 set**；③ 每次 sign 新建实例。
- **别手改/注入 glue**（压缩代码一改就断：实战里往 glue 注 `console.error` 把 `Se(){…,t}` 的逗号表达式 `,t` 截断、返回了错的对象，反 debug 自己的注入花了十几轮）——看 import 一律用 `wasm_probe`（非侵入；现已可吃被 patch 成 CommonJS 的 glue）。
- **WASM init/sign 跑出 `unreachable`/panic/abort/`RuntimeError` → 是缺环境，不是要懂字节码**：wasm-bindgen 的 `signtool_new()`/sign 在 Node 里 trap，几乎一定是某个 import 没补对（`crypto.getRandomValues` / 藏 `process`(否则 getrandom 走 Node 分支 panic) / `instanceof Window` / `querySelector` 的 favicon·meta / `getAttribute`）。`wasm_probe` 空跑看崩**之前**读了哪些 import → 补上真值；**绝不 `wasm_disasm` 逐个反汇编 func 去追 `call_indirect`/函数指针表**（那是更深的兔子洞，实战里追 func62→96→118→42 磨了几十轮还没出结果）。先 `fs_copy .agent-tools/templates/wasm-signer-loader.js`——它已处理这些 unreachable 的根因。
- **复刻输出对不上 / 固定部分不匹配 → 绝不字节级逆向签名**（reverse+base64+猜字符表＝违反"WASM 别反编译、黑盒优先"红线，且 99% 是**某个 env 输入没喂对**、不是算法要逆）。正确三步：① `signer_trace(argMatch:'/api')` 复核 sign 真入参（url 常 path-only 不带 query）；② `wasm_probe` 看 **`allImportNames`**（wasm 调的**全部** import，**别只盯解码出的 calls**——漏掉的隐藏 env 读多半在这）→ page_eval 取那些真值喂回；③ 仍对不上就 `whitebox_diff`（浏览器真值 vs Node 复刻 哪个 import/分支不同）。
看内部算法：`wasm_disasm(wasmPath, func=导出名)`（另存 .wat，fs_read 切片读）。
**含随机 nonce 的签名每次不同、不可逐字节复现**——别和历史样本 byte-match（用 `FIXED_NONCE=1` 做固定输入→固定中段哈希的对照），最终以**实打接口返回有效数据**为准；403 多半是 cookie 缺（httpOnly 的 WAF cookie 如 aliyungf_tc）或 url 输入含/缺随机参数。

## 落盘纪律
- 大文件是**数据不是文本**：绝不 `fs_read` 整读（>32KB 被拦）→ `code_search` 精搜 / `run_node` 脚本里 `fs.readFileSync` 处理只回小结果 / `fs_read(offset,limit)` 切片。
- 别 `fs_write` 大文件全文（撞输出上限会截断卡死）→ 改现成文件用 `fs_copy` + 只写小 loader。
- 按用途分目录：抓的脚本 `scripts/`、wasm/wat `wasm/`、你写的 loader/中间数据 `work/`、最终产物 `out/`、trace `jsvmp/`+`webapi/`。`fs_write` 给**裸文件名**（`x.js`/`data.json` 等）会**自动归 `work/`**——不用自己加前缀；要落别处就显式写目录（如 `out/main.js`）。`progress.md`/`ledger.md`/`package.json` 等仍留根。
- 每验证通过一个关键结论 → `notes_add`（只记验证过的），下次复用。

## 工具速查
| 组 | 工具 |
|---|---|
| 页面 | page_info / page_elements / page_eval(只读) / page_navigate / page_click / page_scroll / page_type / page_screenshot |
| 网络 | net_capture / net_list / net_get(带 initiatorStack 调用栈) |
| 脚本 | scripts_capture_all / scripts_list / scripts_save(toWorkspace) / code_search / find_param_entry |
| JSVMP/WASM | jsvmp_trace / jsvmp_query / jsvmp_split_dispatcher / jsvmp_disassemble / wasm_probe / wasm_disasm / js_trace |
| 抓真实入参 | **signer_trace(引擎层 Debugger 观测 sign/拦截器的真实实参,start→页内触发→query→stop;治"猜签名输入")** |
| 白盒诊断 | **whitebox_diff(浏览器真值 vs Node复刻 引擎级差分→第一处分叉分支+源码行+驱动它的env值+崩溃栈;非侵入;治"复刻和浏览器结果对不上")** |
| Web-API 指纹 | webapi_trace / webapi_query(env/flow) |
| 工作目录 | fs_list / fs_read(offset/limit) / fs_write(append) / fs_copy / fs_mkdir / run_node / run_python / npm_install |
| 记忆 | **remember(发现即记:fact/deadend→账本,每轮注入、压缩不衰减、SQLite跨会话)** / **recall(跨会话/站点检索历史记忆)** / notes_get / notes_add(跨会话按站点) |

## 结论模板
参数在哪生成 · 算法/依赖/指纹输入 · 可独立复现（附可运行 .js/.py + 实打接口返回有效数据）· 关键结论 `notes_add` 沉淀。

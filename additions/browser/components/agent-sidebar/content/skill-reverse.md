# Agent 逆向方法论（skill_get 全文 · 一页流）

> 站点无关、通用。只用 Agent 自己的工具。目标：产出**不靠浏览器运行时**的 Node 复刻（补环境/纯算），实打接口返回有效数据。
> 这份只教**怎么用工具走通常规链路**；具体怎么拆、何时换路，你自己判断。站点特例进 notes。

## 红线（4 条，记牢）
1. **最终产物不靠浏览器跑加密**：node 补环境/纯算都行；开浏览器调 signer 当 runtime＝违规。浏览器只作分析/验证 oracle。从浏览器抓的**静态值**（cookie/登录态/风控令牌等）当输入用**不算违规**。
2. **page_eval 全权、别自我设限**：在页面里**怎么方便怎么来**——读值 / 调现成 signer / **装 hook 记入参出参 / 改全局 / 重定义函数 / 注入脚本** 都行（页面 principal、`wantXrays:false`，`window.X=包装` 会真替换页面的 X，见「hook 日志大法」）。它是你**最趁手的分析工具**，别因为"应该只读"就退回笨重的 signer_trace。唯一边界是 #1（最终**产物**别靠浏览器跑加密）；强检测/JSVMP 站注入**可能被检测到**——那是你**自己权衡**要不要改用引擎层 trace，**不是禁令**。
3. **trace 必带 filter**：webapi_trace 填接口/成员名子串，jsvmp_trace 填脚本文件名子串；收窄到 signer 一次调用（start→clear→触发一次→query）。
4. **标准密码学用库**（crypto/crypto-js/sm-crypto/node-forge），**绝不手搓 MD5/SHA/HMAC/AES/SM3**——尤其**别在 `page_eval` 里手写 MD5**（手搓必出 `X is not a function` 这类 bug、还会因栈挂在模块上被误判成"工具坏了"）。算哈希/加密：用 `run_node` + Node `crypto`，或调**页面现成的** crypto 库/签名函数，别自己重写算法。

## 决策树（先判型，再选模式 —— 按 ①→⑤ 顺序试，命中即停，**别一上来就扣代码/补环境**）
**先花 30 秒看参数"长什么样"**：长度 / 字符集 / 前缀 / 是否 `=` 结尾 / 有没有同发一个毫秒时间戳 → 对照下面[快速识别表]先猜标准算法。**大多数站点是 ①，几分钟出活；只有真卡住才往下掉一档。** 简单 AES/HMAC 站点被当成"明文 JS→扣代码"硬抠混淆、兜几十轮，就是跳过了这条快车道。
```
抓到目标接口 + 有加密参数
  ① 【快车道·标准算法】← 简单站默认走这条，**先试这个**
       signer_trace/webapi_trace 抓到 signer 的"真实入参" → 本地标准库(crypto)对同一入参
       跑「候选算法 × 候选拼接模板」和真实 wire 值逐字节比 → 对上=收工（一行混淆代码都不用读）。
       这就是用户要的"直接对比是不是官方加密算法、hook 到入参本地用一样的算法生成"。
  ② 【轻定制】算法是标准的、但有魔改：自定义 base64 字符表 / 改了初始常量 / 特殊拼接顺序
       → 只还原那一处差异，其余仍用标准库算。
  ③ 【扣代码·沙箱】hook 不到入参，**或**确认不是任何官方算法(纯自定义)
       → code_search 定位 signer → 抠**最小 JS 片段**进 vm/jsdom **原样执行**（别手译算法）。
  ④ 【WASM】出现 `__wbg_*`/`.wasm` → wasm_probe 看边界 I/O → 补环境加载 glue+wasm（见 WASM 专项）。
  ⑤ 【JSVMP】大单文件+派发循环+字节码 → 优先补环境黑盒跑；卡了再 jsvmp_trace 看算法。
```

### 算法快速识别表（看一眼参数就能缩范围）
| 参数特征 | 候选算法 | 本地验证(标准库) |
|---|---|---|
| 32 位 hex | MD5 / HMAC-MD5 | `createHash('md5')` / `createHmac('md5',key)` |
| 40 位 hex | SHA-1 / HMAC-SHA1 | `createHash('sha1')` |
| 64 位 hex | SHA-256 / HMAC-SHA256 | `createHash('sha256')` / `createHmac('sha256',key)` |
| 44 字符、`=` 结尾 | SHA-256 的 Base64 | `digest('base64')` |
| **Base64 解码后里面是一串 hex** | **哈希结果先转 hex、再套一层 Base64（双层编码，很常见）** | 先 base64 解码 → 看里面是不是 32/64 位 hex → 再按哈希验 |
| `A-Za-z0-9-_`、无 `=` | Base64url | 替 `-_`→`+/` 补 `=` 再解 |
| 16 字节倍数密文 | AES（CBC 需 iv / ECB 不需） | `createCipheriv('aes-128-*')` |
| 8 字节倍数密文 | DES / 3DES | `des-ecb` / `des-ede3-cbc` |
| 超长数字串 | RSA | 找公钥(模数+指数 或 PEM) |
| 源码见 `CryptoJS`/`sm-crypto`/`forge` | 该库 | 用对应库 1:1 复刻 |

> **判型分歧 / 拿到一段疑似 S-box·密钥·字节码·signer 源码 → 先 `crypto_scan`（站点无关，纯分析）**：一眼识别 RC4 的 256 字节排列 S-box、XXTEA 的 delta `0x9e3779b9`、MD5/SHA 的 IV+K、AES 的 S-box/Te 表、SM4、自定义 base64 字母表。传 `input`(hex/字节数组/源码) 或 `inputFile`(work/字节码或源码文件)。**别再为"是 RC4 还是 XXTEA"暴力扫几千个常量**——这一步省一整轮。

### 签名拼接常见模板（hook 到入参后，本地按这些套着试 —— **别去解混淆的字符串表反推格式**）
`path+ts` · `method+path+query+ts` · `path+sortedQuery(无?)+ts` · `sortedParams(&拼)+secret` · `JSON.stringify(body,无空格)+secret` · `a|b|ts`(管道) · 在开头/末尾拼上 `secret`(skey)。
> 有了真实「入参→wire」样本 + 已知 key/算法，**一个 run_node 脚本枚举「上面模板 × 候选算法」逐字节比**即可命中——比去解自定义 base64 表、逐行读 VM 反推消息格式快几十倍（后者正是简单站兜圈的根因）。

### hook 日志大法（简单非-JSVMP 站看"入参出参"最快的路 —— 优先用它，别一上来就 signer_trace）
`page_eval` 跑在 `Cu.Sandbox(win, wantXrays:false)`、原型是页面 window → **`window.X = 包装函数` 会真正替换页面的 X、页面自己的代码也走你的包装**（务必写 `window.`；裸 `X=` 只落沙箱、页面看不到）。三步：
1. **装 hook**（page_eval）：包裹**可达边界**，把 `{入参, 返回}` 推进 `window.__log`——
   - 出参（最常用）：`window.fetch` / `XMLHttpRequest.prototype.setRequestHeader`+`send` → 看到每次请求的 url/body/**签名 header**；
   - 入参/算法：`JSON.stringify` / `crypto.subtle.{digest,sign,importKey}` / `TextEncoder.prototype.encode` / **任何具名全局函数**。
   例：`(()=>{const o=window.fetch;window.__log=[];window.fetch=function(u,i){try{window.__log.push({u:String(u),h:i&&i.headers&&JSON.stringify([...new Headers(i.headers)]),b:i&&String(i.body)})}catch(e){}return o.apply(this,arguments)};return'hooked@'+location.href})()`
2. **触发一次**：`page_click`/`page_scroll`/`page_type`（**交互触发 > 整页刷新**——刷新会清掉 hook 和 `__log`）。
3. **读回**（page_eval）：`window.__log` → 直接拿到 (url, body, 签名 header, ts) 一组组真值，逐字节比 / 反推拼接。
- ⚠**别在装 hook 和读 __log 之间 `page_navigate`**——整页刷新会重建 window、清掉 hook 和 `__log`（读到 `window.__log is undefined` 就是这么来的）。读前用 `(window.__log||[])` 兜底。
- **首屏/导航时就触发的请求**（交互触发不出来、非刷新不可）→ page_eval 装 hook **来不及**（页面 JS 毫秒级就发了请求）→ 用 **`hook_inject`**：引擎在**每个新页面早于页面 JS** 注入、跨刷新存活。`hook_inject(start)`（不传 script＝内置 preset 包 fetch+XHR→`window.__frxhook`）→ `page_navigate(目标URL)` → `hook_inject(query)` 读回。这就是"刷新后、XHR 前注入"的确定性版本。
比 signer_trace 强在：**装一次就行、不挑 scriptUrl/argMatch、不靠"抢在请求前 arm"**。**只有够不到的闭包内部值**（如模块 `export {…as sign}` 的 signer，`window.` 取不到它）才退回 `signer_trace`（引擎层 Debugger 观测、不注入）↓。
> **要读闭包里的「变量值」而不是入参**（JSVMP 反复撞的：dispatcher / **运行时解码出的字节码** / **RC4 S-box** / 常量池 是闭包变量，`window.`、page_eval 都够不到）→ 用 **`closure_read`**（引擎层 Debugger 读 `frame.environment`，不注入）。两步：先不传 `varNames` 拿**变量目录**（每层作用域有哪些变量名）→ 认出目标后带 `varNames:'名字正则'` 重来**深序列化**整段值（256 字节 S-box、几千字节字节码数组一次拿全，大的配 `saveTo`）。与 `signer_trace`(读 arguments) 互补。**别再手动解码 VM 字节码抠常量**。

### signer_trace 抓入参铁律（hook 够不到闭包内部值时才用；治"trace 全是噪声"）
signer_trace/webapi_trace 必须 **arm → clear → 只触发一次新请求 → query**，且 trace 要**早于**请求装好。
**接口在首屏加载就触发的**：**先 arm trace，再 `page_navigate` 重载**让请求落在 trace 窗口内；别"等页面加载完才开 trace"——那只会抓到 init/UI 渲染噪声，真正的 sign 调用永远漏。`query count=0`＝没新请求触发，换交互或重载重触发。
- **多 chunk / hash 文件名站点（XHS 等）必看**：① 返回的 `matchedFunctions` 是**函数数**不是文件数（`findScripts` 按函数算，一个压缩大文件几千个函数→命中几千个是**正常**、不是匹配 bug）；② 命中一整个大文件**没给 argMatch** → onEnterFrame 被刷爆、安全阀很快自卸 + ring buffer 全噪声 → **必给 argMatch**（签名 url 的 `'/api'`/`'^/'`、或目标参数名子串）收窄到真 sign；③ **不知道签名在哪个 chunk** 就别瞎猜 hash → 先 hook fetch/XHR（hook 日志大法）看签名输出 + `net_get` 的 `initiatorStack` 定位真正发起的 chunk，再 signer_trace 那个 chunk；④ trace 装好后**别拖太久才触发**（虽已放宽到 120s 自愈，但忙页面背景帧仍会消耗预算）。

## 常规执行链（从上往下推，别在一处死磕）
**0. 开工（30 秒）**：`notes_get` 看本站历史 → 明确目标参数名 + 它在哪个请求 → 设好工作目录。

**1. P0 拿真实样本**：`net_capture start`（自动带发起者栈）→ 页内**滚动/点击触发**目标请求（别整页刷新，会丢栈）→ `net_list` 找带目标参数的请求 → `net_get` 看 URL/headers/**initiatorStack**。把**逐字节真实样本 + 对应输入**记进 ledger。

**2. P1 定位生成点**：`net_get` 的 `initiatorStack` 直接给"谁拼了这个参数"的调用栈（栈为 null 就页内交互重触发）。`scripts_capture_all` 落盘 → `code_search(参数名/signer特征, scriptUrl)` 摸到 signer 脚本 → `scripts_save(url, toWorkspace:true)` 落到 `scripts/`。

**3. P2 先验证再逆向（关键，别跳）**：在浏览器内 `page_eval` 调到候选 signer，给已知输入取输出，和 P0 真实样本**逐字节 diff**。
- **wire 参数常 ≠ 最显眼 signer 的输出**（常见 `wire = wrapper(signer输出, 其它字段)`）。格式/长度/前缀对不上＝没找对，顺调用栈往上层找真正拼装 wire 值的函数。**没 diff 对上之前，别进字节码反汇编。**
- **字节长度先速判**：写复刻代码前，先比「你假设的算法输出字节数」和「真实 wire 值解码后的字节数」——对不上（如假设 HMAC-SHA256＝32 字节、但 wire 解码后是 75 字节）就**立刻否决该假设、换方向**，别写一堆代码白验证。长度/前缀这种廉价信号能在 30 秒内排除大半错误假设。
- **签名内含随机字节/nonce（有的签名末段带 random、很多 sig 拼了 nonce）→ 同输入每次输出不同、不可能逐字节复现历史样本**：这时 P2 的"对上真实 wire 值"标准要换成 **① 长度/结构对（解码后字节数、头部布局一致）+ ② 浏览器内 replay 验证**（page_eval 调 signer 生成一个**新**签名 → 立刻 fetch 真实接口 → 服务器返回有效数据＝入口确认）。**别在随机签名上死磕 byte-match**（会误判成"没找对"无限回退）。判断有没有随机：同一输入在浏览器里连调 signer 两次，输出变=有随机。
- **没用真实 wire 值复现对上前，禁止往账本写「已确认/已破译」**：账本（remember）只记**验证过**的事实。把"看着像/猜的算法"当确认写进去，会污染账本、误导后续每一轮（确认过的不再重验、直接拿去用）——比没记还糟。没验证就写「待验证假设」，别写「已确认」。
- **不确定 signer 真实入参就别猜、更别暴力试**——生产代码混淆/单行，**别猜函数名**：`signer_trace(action:start, scriptUrl:signer脚本子串, argMatch:'/api')`——**`argMatch` 只抓实参匹配此正则的调用、跳过 init 那堆传配置对象的噪声，一枪命中 `sign('/api/...', ts)`**（不给 argMatch 时 init 调用会先占满、真 sign 在其后被永久漏掉＝实战"参数入口拦不到、兜几十轮"的根因；现已改环形缓冲留最后 N 条，但加 argMatch 最干净）→ 触发一次真实请求（**导航也能抓**，跨导航存活）→ `signer_trace(action:query)` 拿到**喂给 signer 的真实实参**（不注入页面）。**经验（通用）：url 实参常是 path/相对路径、且常不含 query string（`?a=b` 在 params 里单传）**——别拿完整 URL 去试。也能看到拦截器拿到的 `e`（含 `e.url`/`e.params`）。**这一步省掉"猜输入→暴力试→兜圈"的大坑。** `query count=0` = 没新请求触发，换种交互/page_navigate 重载再试。

**4. P3/P4 判型选路**：`wasm_probe`(有 WASM) / 看 JSVMP 特征 → 按决策树选模式。**黑盒优先**：复刻**完整加载顺序 + init 调用**（signer 常由 glue/`_XxxInit` 编排多脚本，只 load 单文件＝signer 不存在，这是高频坑）。

**5. P5 补环境闭环**：脚手架在 `.agent-tools/templates/`（`fs_copy` 拿现成改，别从零写）：自包含单文件混淆用 `node-env-loader.js`、纯 wasm-bindgen 用 `wasm-signer-loader.js`、**webpack/loadable 代码分割 chunk 用 `webpack-chunk-loader.js`**（见下「代码分割」）、拼请求用 `request-template.js`、**JSVMP「数据常量」收割（S-box/RC4 key/XXTEA delta/自定义 base64 表/魔数——VM 从字节码数组 GetElem 读出、`closure_read`/dump 都够不到时）用 `jsvmp-const-harvest.js`**（把字节码数组包成 logging 容器，记下 PC 读出的每个值 + 兜底 hook charCodeAt）、**VM 闭包内 `instantiate` 的小 WASM（算完整性 hash、无公开 glue、wasm_probe 够不到）日志用 `wasm-call-logger.js`**（加载前 monkeypatch `WebAssembly.instantiate/compile` 套 import/export 日志）。**报错驱动**：跑→读错→补**一个**最小缺失项→再跑。指纹用 `webapi_trace`(env 模式)/`wasm_probe` 抓的**真值**补，别瞎填。常见缺失：`window/document/navigator` 桩、`Object/Array/Date` 等构造器没挂全（VM 取 `window.X` 当 `new` → "is not a constructor"）、`globalThis.process` 没藏（wasm-bindgen getrandom 走 Node 分支崩）。**Node 21+ 的 `global.navigator` 是只读 getter**——补环境别 `global.navigator={…}` 赋值（抛 `Cannot set property navigator`），用 `Object.defineProperty(globalThis,'navigator',{value:{webdriver:false,…},configurable:true})`。
- **复刻结果和浏览器对不上（分支/加密值不一致、偶尔空响应）别瞎试** → `whitebox_diff` 做**浏览器真值 vs Node 复刻**的引擎级差分（非侵入：浏览器侧 Debugger 覆盖、Node 侧 inspector 覆盖/wasm import 边界，**零 Proxy 包 env、零 AST 插桩**，难站点也测不到观测本身）：`action:start(scriptUrl)` → `page_navigate` 重载触发 → `action:query`（取浏览器真值）→ `action:node(entry:work/loader.cjs, kind:js|wasm)`（跑复刻覆盖）→ `action:diff(env:webapi导出的env真值)` → 直接告诉你**第一处走法不同的分支（源码行）+ 驱动它的 env 值**，按真值对齐补环境再跑。复刻里的崩溃/自杀（如探到 Node 的 `process` 后 abort）也会被拦截记栈。

**6. P6 实打验证**：node 生成参数 → 拼完整请求模板（`net_get` 抓的真实请求当模版，稳定值 cookie/token 从浏览器拿）→ 打真实接口 → **非空有效**才算过；换多组输入再验。产出最小可运行示例到 `out/`。
- **本地请求"非空但报错/被拒"时，先别怀疑算法**——签名往往是对的，是请求没和 `net_get` 的真实请求**逐字段对齐**。**一般往这几个方向排查**（一次只改一处，对照真实请求收敛）：
  ① **漏了必带字段**：cookie（尤其 httpOnly 的风控/会话 cookie）、token、UA、referer/origin、某个业务自定义头；
  ② **易变字段过期/错位**：时间戳（秒 vs 毫秒、时区、要不要用服务端时间）、nonce、requestId；
  ③ **body 序列化差异**：空格、键顺序、编码、尾换行——任一不同都改变长度与哈希；
  ④ **请求结构**：method、路径细节（末尾斜杠、大小写）、query 编码、content-type；
  ⑤ **传输层指纹**：TLS/HTTP2（纯请求过不了＝另一档问题，需 got-scraping/curl_cffi）。
  方法：**先把"浏览器里能成的那一个请求"逐字节原样复刻通**，再逐字段换成你生成的值，谁一换就失败＝它是门/它没对齐。
- **目标请求在浏览器点几下还触发不出来 → 别死磕"抓那一次真实样本"**：有了公式+skey，直接 Node 打真实接口，**返回有效业务数据本身就是验证**（不必非得在浏览器里截到目标那次请求）。`net_list` 反复同一结果＝没新请求，换一两次交互还不出就转"直接打接口"。

## 记账本（治压缩后兜圈重复，最重要的习惯）
- **确认即记**：每定位到入口/函数/真值、每验证一个算法/特征、每排除一条死路 → 立刻 `remember(text, kind:fact|deadend, evidence)`。带**具体值**（偏移/真值/字节结构/调用方式），别只写"已定位 X"。
- 账本**每轮自动注入你上下文顶部、压缩永不衰减、跨会话持久化（SQLite，按工作目录隔离）**——所以**动手前先看账本**：✅已确认的别重新发现/重抓/重解码，⛔已否决的别重走。这比反复写长摘要稳得多（散文摘要多压几次就丢细节，逼你重读重抓）。
- **隔离模型**：自动注入只给**当前工作目录(=任务)**的账本——**换目录=新任务、干净起步**；要**续**之前的任务就**开回原目录**（它的账本自动回来）。remember 仍按域名打 site 标签，只是不再自动跨目录灌。
- **开工/换方向先 `recall`**：跨**全部**任务/会话/站点按关键词/站点检索——查这个站点或类似目标**以前**确认过什么、排除过哪些死路，别从零开始。`recall(site:目标域名)` 或 `recall(query:关键词)` 翻历史（**工作目录可能已清空 → 历史结论先验证仍适用、产物按需重新落盘**）。

## 反绕圈（自己掌握，引擎只轻提醒）
- **⛔ 最高优先级·工具的硬限制 ≠「此路不通」**（这是本 Agent 最容易犯、代价最大的坑）。撞到**执行层约束**——`page_eval` 输出被截、`run_node` 超时、结果被上下文上限截、`fs_read` 整读被拦——那是**工具用法要换**（加 `saveTo` 落盘 / 提高超时 / `fs_read(offset,limit)` 分段 / `code_search` 精搜），**绝不是分析路线死了**。**严禁**因为撞了个工具上限，就编一个"体面根因"（如"环境校验/指纹绕不过"）、再甩一个"转白盒 / 转 oracle 二选一"来收尾结案。下结论前先问自己：这是**路真走不通（有证据、复现过失败）**，还是**我把工具用错了 / 撞了个上限**？——后者占绝大多数。**症状识别**：看到"truncated / 被截 / 只回了一截 / can't get it in one call / 输出不完整" = 工具上限，换用法、别换策略、更别结案。
- **密钥/秘密是站点级稳定值，别"换个接口就重抠一遍"**：同一套 API 的不同页面分包（bundle/chunk）**通常共用同一个后端 skey**——一个包抠到并验证过，换目标接口**直接拿来用**。请求 4xx 被拒、而你**已有验证过的公式+skey**时，**先查请求构造（method/body/header/易变字段），别断定"另一个 bundle 用别的 skey"去重逆**（server 端是一个稳定密钥、不因接口而变）。⚠实战反例：目标接口在另一 bundle、报 405 → 误判成"要换 skey" → 几十轮手抠那个**混淆** skey，结果它跟手里已有的 skey **是同一个**、纯重抠已有值；真卡点其实是请求构造。
- signer 明文/参数名搜不到＝正常（混淆/运行时拼接）→ 转 trace，别死搜。
- **拿到真实「入参→wire」样本后，定位拼接格式靠"枚举标准模板逐字节比"（一个 run_node 脚本枚举 模板×算法）**——不是去解混淆的自定义 base64 解码表、不是 page_eval 反复抠闭包里的 signer、更不是逐行读 VM。signer 在闭包里 page_eval 取不到就直接 signer_trace 抓入参，别和 page_eval 死磕。
- **真要拿混淆里藏的某个值（skey/url/常量）：跑它"自带的解码器"，别手按索引重算**。obfuscator.io 式字符串数组（取值函数 `lt/gt(i)=arr[i-偏移]` + 数组 + **运行时旋转 IIFE**）——手动按下标重算几乎必出垃圾（数组被旋转重排、还夹控制流假串）。正确做法：把"字符串数组 + 旋转 IIFE + 取值函数"**整段抠出来在 Node 原样跑、再调取值函数读真值**（让它自己旋转/解嵌套）；或直接 sandbox 跑那个 chunk、调它导出的 `sign()`/`fetchSkey()` 拿真值。**不是要懂混淆怎么转，是让代码自己转**。
- 补环境同类报错 ≥3 次 → 多半是**初始化链/加载顺序不对**，不是缺某个属性 → 补缺失层 / 转 browser-as-oracle 拿对照样本 / 转 jsvmp_trace 看算法。
- **【代码分割 signer：require/eval 后 window.XXX 没设上 / `Cannot read properties of undefined (reading 'call')`】别手搓 webpack runtime 兜圈**——signer 文件是 **code-split chunk**（开头 `(self.__LOADABLE_LOADED_CHUNKS__||[]).push([...])` 或 `(self.webpackChunkXXX=...).push([...])`），不是自包含 bundle，直接跑**不会**执行入口、设不上 `window.XXX`，且它常 `__webpack_require__(外部id)` 引用本文件没有的别的 chunk 模块（→ 那个 `call` 报错）。**直接 `fs_copy .agent-tools/templates/webpack-chunk-loader.js`** 到 work/（`loadBundle(path)`）。三个**已验证踩坑**，照做省几十轮：① **先**建好全局数组（`self.__LOADABLE_LOADED_CHUNKS__=[]`）**再** eval；② 缺失的外部模块 id **自动返回 Proxy stub**（多数只缺 1~2 个非签名的 runtime 模块）；③ 通用 JS 全局（**atob/btoa**/TextEncoder/URL）**用 Node 原生别用 jsdom 的**（jsdom 的 atob 更严格、init 期会抛 `InvalidCharacterError` 让 window.XXX 设不上），`process` **加载期别藏**（webpack init 读 `process.env`），等调 signer 前再 `hideProcess()`。④ 签名器常是 **nested bundle 内部、没暴露在 window 上的函数**（window 只暴露少数入口）→ 用 `huntExports` 遍历内部导出按输出特征（如解码后字节数）找，或浏览器 hook 抓真实调用栈定位后再 patch 出该导出。⑤ **纠缠型 signer（一个 chunk `__webpack_require__(外部id)` 引用别的 chunk 的模块，单文件加载 stubbed 列表几十~几百项）**：单 `loadBundle` 会把签名器的**真依赖**也 stub 掉而失败 → `scripts_capture_all` 把 app 的 chunk 抓全 → **`loadBundles([签名器chunk, ...它依赖的chunk])`** 合并加载（各 chunk 模块进同一 registry、跨 chunk 依赖就能解析）；**看返回的 `stubbed` 列表还缺哪些 id，就回浏览器 net_list 找对应 chunk 补抓再合并**，直到关键依赖不再被 stub。若依赖散在几十个 app 主包 chunk（整包加载过重/装不起来），转 `jsvmp_trace` 白盒看算法。
- **【SDK 自动签名在 Node "透传不签"：先查 init 的 URL 规则，别急着伪造指纹】** 有的反爬 SDK 在 `init()` 时**包装 `window.fetch`/XHR**、按规则**自动**给匹配的请求加签（业务代码无感）。在 Node 复刻时调包装后的 fetch **透传、没注入签名** → **第一反应别是"被检测到 Node、去伪造 canvas/webgl/webdriver 指纹"**（这会白烧好几轮）。**真因多数是：你没用 SDK 的真实 `init(配置)`，目标 URL 没被注册进签名规则**（很多 SDK 的 init 配置里有"要签的 URL 白名单/include 列表"）。**实测过的反例**：webapi_trace 显示真实浏览器 `navigator.webdriver=true` 也照样签——**说明签名门控是 init 的 URL 白名单规则、不是 env/webdriver 检测**；Node 透传纯粹因为目标 URL 没进白名单。→ 顺序：① page_eval hook 这个 `init` 抓**真实配置**（在业务 chunk 里）→ ② Node 用真实配置 init → ③ 调包装的 fetch 看签名注入了没。env 指纹是签名的**输入值**（影响签名内容，用 webapi_trace 真值补），但通常**不是**签/不签的门。
- **目标请求在浏览器里死活不出现（F12 刷新也没有、net_capture/hook_inject 都空）→ 大概率是 SSR**：Nuxt/Next 这类 SSR 框架，**首屏数据是服务端渲染时取的**（请求在 Node 服务端发、签名也在服务端算、结果嵌进 HTML 的 `window.__NUXT__`/`__NEXT_DATA__`），浏览器**根本不发**这个请求——路径带 `/ssr/`、页面有 `__NUXT__`/`__NEXT_DATA__`、刷新无该请求但**客户端点进去/站内跳转才有**，就是它。**别再整页刷新**（刷新=SSR=没请求，纯空转）→ ① 用**客户端导航触发**（回首页→点进去/站内跳转，**不 page_navigate 整页刷新**→ 框架这次在客户端 re-fetch→请求出现）；② 或 `page_eval` 直接读 `window.__NUXT__` 拿服务端塞进来的数据；③ 或**根本别等浏览器发**——signer 算法已从 JS 扒到就本地 Node 构造签名直接打接口，返回有效数据即成（拿不到浏览器样本时，实打接口本身就是验证）。
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
- **取大源码/大输出：`page_eval` 一律加 `saveTo` 落盘，别用裸 page_eval（默认动作、肌肉记忆）**。`fn.toString()` 取混淆 dispatcher / signer 源码（动辄几万~几十万字）、或任何可能超 ~20K 的 page_eval 结果 → **`page_eval({expression:'x.toString()', saveTo:'work/x.js'})` 直接落完整结果到文件**，再 `code_search('关键词','work/x.js')` / `fs_read('work/x.js',offset,limit)` 分析。**别裸 `page_eval('x.toString()')` 再 substring 分段拼**——单次结果 >20K 会被截、分段边界还会被再截导致**错位丢字**，你却**不自知**、拿残缺源码往下跑（实战扣 5 万字混淆 dispatcher 就栽这、烧十几轮还误判成"环境绕不过"）。万一裸调了：返回里 `totalLength > returnedLength` 就是被截了 → 立刻改 `saveTo` 重取，别在残缺数据上分析。
- 别 `fs_write` 大文件全文（撞输出上限会截断卡死）→ 改现成文件用 `fs_copy` + 只写小 loader。
- 按用途分目录：抓的脚本 `scripts/`、wasm/wat `wasm/`、你写的 loader/中间数据 `work/`、最终产物 `out/`、trace `jsvmp/`+`webapi/`。`fs_write` 给**裸文件名**（`x.js`/`data.json` 等）会**自动归 `work/`**——不用自己加前缀；要落别处就显式写目录（如 `out/main.js`）。`progress.md`/`ledger.md`/`package.json` 等仍留根。
- 每验证通过一个关键结论 → `notes_add`（只记验证过的），下次复用。

## 工具速查
| 组 | 工具 |
|---|---|
| 页面 | page_info / page_elements / **page_eval(全权:读/调/装hook/改全局/注入；**取大源码/fn.toString() 一律加 `saveTo` 落盘**)** / page_navigate / page_click / page_scroll / page_type / page_screenshot |
| 网络 | net_capture / net_list / net_get(带 initiatorStack 调用栈) |
| 脚本 | scripts_capture_all / scripts_list / scripts_save(toWorkspace) / code_search / find_param_entry |
| JSVMP/WASM | jsvmp_trace / jsvmp_query / jsvmp_split_dispatcher / jsvmp_disassemble / wasm_probe / wasm_disasm / js_trace |
| 判型/常量 | **crypto_scan**(一段数据/源码→识别 RC4/XXTEA/MD5/SHA/AES/SM4/自定义base64，免暴力扫常量) / **closure_read**(读闭包变量真值：解码后字节码·S-box·常量池，page_eval 够不到的) |
| 抓真实入参 | **简单站先「hook 日志大法」**(page_eval 包 `window.fetch`/XHR/crypto 记入参出参→交互触发→读 `window.__log`)；**首屏/导航就触发的**用 `hook_inject`(document-start 注入、早于页面 JS、跨刷新存活,start→page_navigate→query)；**够不到的闭包内部值**才用 signer_trace(引擎层 Debugger 观测、不注入) |
| 白盒诊断 | **whitebox_diff(浏览器真值 vs Node复刻 引擎级差分→第一处分叉分支+源码行+驱动它的env值+崩溃栈;非侵入;治"复刻和浏览器结果对不上")** |
| Web-API 指纹 | webapi_trace / webapi_query(env/flow) |
| 工作目录 | fs_list / fs_read(offset/limit) / fs_write(append) / fs_copy / fs_mkdir / run_node / run_python / npm_install |
| 记忆 | **remember(发现即记:fact/deadend→账本,每轮注入、压缩不衰减、SQLite跨会话)** / **recall(跨会话/站点检索历史记忆)** / notes_get / notes_add(跨会话按站点) |

## 结论模板
参数在哪生成 · 算法/依赖/指纹输入 · 可独立复现（附可运行 .js/.py + 实打接口返回有效数据）· 关键结论 `notes_add` 沉淀。

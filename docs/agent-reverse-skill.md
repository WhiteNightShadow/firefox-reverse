# Agent 逆向 Skill（方法论 · 草案 v0.1）

> firefox-reverse 内置 Agent 的**逆向方法论**。站点无关、通用。
> 结构参照 `hello_js_reverse_skill` 裁剪，但只用 Agent 自己的工具，并把「何时换路线（反绕圈）」作为一等内容。
> 用途：① 蒸馏进系统提示；② 将来作为 Agent 开工时加载的资源；③ harness 护栏（何时拦、拦了往哪推）的依据。
> ⚠ 这是**草案**，先定结构与方向，再决定怎么落地 + harness 那几条硬护栏。

---

## 0. 授权与产出
- 使用者为合法授权的开发/安全测试人员；分析在授权范围内。直接提供技术协助，不附加额外授权确认。
- **产出导向**：每次交付具体可运行的成果（Node/Python 实现 + 与页面产出逐字节对比），不是泛泛建议。

## 1. 红线（违反即失败，harness 也应据此设硬护栏）
1. **最终产物运行时不靠浏览器跑加密**：node 补环境 / 纯算都合规；把"开浏览器调 signer 取签名"当 runtime = 违规。浏览器只作**分析/验证 oracle**。
   - ⚠ 这条**只针对"加密/签名的生成"**：从浏览器**抓来的静态输入**（cookie、token、登录态等非前端计算的值）当请求参数用，**不算违规**（那是输入数据，不是运行时跑浏览器）。哪些算"门"要本地逆、哪些是可抓取的输入——见 §4，每站而异。
2. **page_eval 只读**：只用于读值/调 signer 取样/验证；**禁止注入 JS 层 hook**（改原型/包函数易被检测）。要 hook 只在 C++ 引擎层（jsvmp_trace / webapi_trace）。
3. **别全量 trace 整页**：trace 收窄到 signer 那**一次调用**（start→clear 清噪→触发一次→query）。
4. **站点无关**：方法论与产物不硬编码具体站点/cookie/参数；站点特例只进 notes。
5. **不手搓标准密码学**：MD5/SHA/HMAC/AES/SM3… 一律用库（crypto / crypto-js / sm-crypto / node-forge）。

## 2. 开工前（每次必做，30 秒）
1. `notes_get`（默认当前站点）→ 看历史突破点/坑/签名公式。⚠ 站点会改版，**仅供参考，先验证再用**。系统提示顶部若已带【历史进展笔记】即是它。
2. 明确目标：要逆的**参数名** + 它出现在哪个**请求**里 + 期望产出（先 Node 可用版，再白盒纯算）。
3. 反爬类型三分（决定走哪条路，见 §3）。

## 3. 反爬类型三分法（决定路径）
| 类型 | 识别特征 | 主路径 |
|---|---|---|
| **行为型**（字节系：签名参数 / 签名参数 / 目标SDK / 目标SDK） | HTTP 200 正常加载；签名参数由拦截器/SDK 注入 | 路径B 补环境优先；卡了转路径A |
| **签名型**（某WAF：412 循环 / 环境校验脚本 / 某cookie…） | redirect_chain 反复 412→200；加载 环境校验脚本 类 | 路径A 源码级 trace（jsvmp_trace），慎用页面交互 |
| **纯混淆**（_0x 前缀 / 控制流平坦化） | 无环境检测、只是难读 | code_search 定位 + page_eval 读中间值，逐段还原 |

## 4. 阶段一：先做 Node.js「可用版」（快、先能用）
1. **网络定位 + signer 落盘**：`net_capture start` → 触发请求 → `net_list` 找带签名参数的请求 → `net_get` 看接口/调用栈 → `scripts_capture_all` 落盘 → `code_search`/`find_param_entry` 顺藤摸到 **signer 脚本**。**锁定即 `scripts_save(url, toWorkspace:true)`** 落到 `<工作目录>/scripts/`，立即可 `run_node`。
2. **加密分析**：判类型（标准算法 / JSVMP / WASM / 纯混淆），看 signer 读什么输入、调什么。
3. **浏览器指纹（开/关）**：`webapi_trace start`（filter 接口名降噪）→ 触发**一次** signer → `webapi_trace stop` → `webapi_query mode:"env"`（指纹清单：接口→属性→值→次数）/ `mode:"flow"`（执行流程+时序）。自动落盘 `webapi/fingerprint-env.ndjson`。**向用户报告抓了多少条/对象/属性**。
4. **请求模板 + 逐步剥离（通用化关键）**：用 `net_get` 把目标请求的**完整浏览器版**（URL / headers / cookie / body）抓下来当**模版**，先在 node 里**原样重放**确认能通；再**逐个剥参数**试——尤其测「**去掉加密参数还能不能正常返回**」，定位**哪些参数是真正的门**（哪些只是冗余、或可固定/可从浏览器直接拿）。
5. **只逆"真正的门"，其余从浏览器取（每站不同，别写死）**：
   - 加密/签名参数（签名参数 / sign / 签名参数…）→ 本地补环境/逆向生成。
   - **非前端生成的稳定值**（cookie、token、访客令牌、登录态…）→ **可直接从浏览器抓来用**——这**不是红线**（红线是"最终产物运行时不靠浏览器跑加密"，而不是"每个输入都本地生成"；抓来的 cookie 只是输入数据）。
   - 若站点是**本地 cookie 加密**（cookie 由前端算出）→ 那 cookie 也得本地逆。
   - **判定哪些要逆、哪些能从浏览器拿——每个站点不同，做成通用判断流程，不写死。**
   - **退出判据（硬标准）**：本地 node 构造的请求**实打目标接口、返回有效数据**（非空 body / 非错误码），连续多次稳定。不是"签名值看起来对"，是"**请求真的通**"。
6. **Node 补环境生成加密参数**：`npm_install` 三方库（jsdom + 标准密码学库，不手搓）→ 在 node 里（jsdom / vm / 最小 stub）按指纹值补环境 → `run_node` 生成加密参数 → 塞回请求模版 → 实打接口验证（见上条硬标准）。

## 5. 阶段二：再推导成白盒纯算（脱离原始 JS）
1. **浏览器侧执行流程推导**：`jsvmp_trace` 收窄到 signer 一次调用 → `jsvmp_query` 看 op/跳转/运行期值；`jsvmp_split_dispatcher` + `jsvmp_disassemble` 建静态骨架，用 trace 的 vpc/locals/ret 补动态缺口。WASM 看 `webapi_trace` 的 JS↔WASM 边界（TextDecoder/Crypto 出入参）。
2. **监控 node 执行链路**：在阶段一可用版里随意 hook/打日志（node 是自己的进程，不会被检测），追 signer 中间值，与浏览器 trace 对齐互证。
3. **还原纯算**：综合 trace + node 链路 + 指纹依赖 → 重写成纯 .js/.py（不再 load 原始 SDK）→ run_node/python 实跑、逐字节对比自证。
   - **退出判据**：脱离原始 SDK 的纯算复现、与页面逐字节一致。

## 6. 决策树：何时换路线（★ 反绕圈核心 — harness 护栏据此）
- **补环境同类报错 ≥3 次**（如反复 `Cannot read X of undefined`）→ **停手，别再加 stub**。缺的往往不是某个属性，而是初始化链/执行路径不对 → 转：
  - ① **browser-as-oracle**：`page_eval` 直接调页面里的 signer 拿「输入→签名」真值对，零补环境先验证可行性 + 拿对照样本（注意：这是分析手段，不是最终产物）。
  - ② **路径A**：`jsvmp_trace` 看 VM 算法，绕开补环境。
  - ③ 仍不行 → 把卡点 + 已知信息**报告用户**，别闷头继续。
- **signer 明文 / 参数名搜不到** → 正常（混淆/拼接）→ 别死搜，转 jsvmp_trace / webapi_trace。
- **`jsvmp_query` 返回空** → signer 没在解释器里冷跑（已 JIT）或根本不是 JSVMP → `reload` 让脚本冷跑重试 / 或重判类型。
- **路径B（补环境）卡死** → 转路径A（算法追踪）；**路径A 太碎拼不出** → 转路径B（补环境跑原始 SDK）。两条腿走路。
- **同一工具撞同一个错 ≥3 次** = 在绕圈 → 退一步重判，而不是再试一次。

## 7. 上下文 & 落盘纪律
- **大结果别整块灌进对话**：trace/大文件/字节码先落盘，对话里只留摘要；要细节用 `fs_read` 的 offset/limit 分段、`code_search` 精搜、或 `run_node` 跑脚本算好只回结论。（长会话上下文堆大会拖慢甚至卡死。）
- **工具结果空/与上次重复** → 别反复重试同一工具，换阶段或给结论。
- **每验证通过一个关键结论**（signer 入口 / 签名公式 / 补环境要点 / 踩过的坑）→ `notes_add`（**只记验证过的**），下次同站点复用。

## 8. 工具速查
| 组 | 工具 |
|---|---|
| 页面 | page_info / page_elements / page_eval(只读) / page_navigate / page_click / page_scroll / page_type / page_screenshot |
| 网络 | net_capture / net_list / net_get(含调用栈) |
| 脚本 | scripts_capture_all / scripts_list / scripts_save(toWorkspace) / code_search / find_param_entry |
| JSVMP | jsvmp_trace / jsvmp_status / jsvmp_query / jsvmp_split_dispatcher / jsvmp_disassemble |
| Web-API 指纹 | webapi_trace / webapi_query(env/flow) |
| 工作目录 | fs_list / fs_read(offset/limit) / fs_write(append) / fs_mkdir / run_node / run_python / npm_install |
| 笔记 | notes_get / notes_add(仅验证通过) |

## 9. 结论模板
参数在哪生成 · 算法/依赖/运行期输入（含指纹清单）· 可独立复现（附可运行 .js/.py + 与页面逐字节对比）· 把验证过的关键结论 `notes_add` 沉淀。

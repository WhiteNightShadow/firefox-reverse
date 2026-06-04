# Agent 能力与逆向 SOP

> firefox-reverse 浏览器内置 Agent 的**能力清单**与**通用逆向方法论**。
> 方法论思路参考 `hello_js_reverse_skill`，但这里是站点无关的通用流程——**不绑定任何具体站点/参数**。
> 系统提示里内置了精简版；本文是完整参考。

## A. 能力清单（Agent 可调用的工具）

| 分组 | 工具 | 作用 |
|---|---|---|
| **页面/JS** | `page_info` | 当前页概况（URL/标题/脚本数/UA） |
| | `page_eval` | 在页面上下文执行 JS，读变量/调函数/验证想法 |
| | `page_navigate` | 导航当前标签页到某 URL |
| | `page_click` | 按 CSS 选择器或可见文字点击元素 |
| | `page_scroll` | 滚动页面（增量/到底/滚到某元素） |
| | `page_type` | 给输入框填值并触发 input/change 事件 |
| | `page_screenshot` | 截当前页可视区为 PNG（给用户看，或喂视觉模型） |
| **网络** | `net_capture` | start/stop/status 控制请求捕获 |
| | `net_list` | 列已捕获请求摘要 |
| | `net_get` | 取单条请求完整信息（headers/body/调用栈） |
| **脚本** | `scripts_capture_all` | 抓当前页全部外部脚本落盘到语料目录 |
| | `scripts_list` / `scripts_save` | 列脚本 / 落盘指定脚本 |
| **搜索** | `code_search` | 在已落盘 JS 语料里搜字符串/正则，定位函数/常量 |
| **JSVMP** | `jsvmp_trace` | start/stop 运行期开关引擎级 C++ VM 执行追踪 |
| | `jsvmp_status` / `jsvmp_query` | 查 trace 是否就绪 / 读 VM 执行轨迹 |
| **组合** | `find_param_entry` | 把某参数关联到「哪些请求带它 + 它在哪些 JS 行」 |

> 改动型工具（page_eval / page_navigate / page_click / page_type / page_scroll / net_capture / scripts_* / jsvmp_trace）默认可在「设置」里开启执行前确认。

### 自动操作（无需人工介入）
- **DOM 路线（默认，当前模型即可）**：用 `page_info`/`page_eval` 读页面结构与可点元素 → `page_click`/`page_scroll`/`page_type`/`page_navigate` 操作 → 再读状态确认，循环推进。
- **视觉路线（需配视觉模型）**：`page_screenshot` 截图 → 多模态模型「看」图 → 决定点哪、滑哪。需在「设置」里配一个支持看图的模型（如 GPT-4o / Gemini / Qwen-VL）；纯文本模型（如 DeepSeek-chat）只能用 DOM 路线。

## B. 纪律
- 工具结果为空或与上次重复 → **别反复重试同一工具**，换阶段或直接给结论。
- 拿到目标先**拆成有序子任务**列给用户看，再**逐步执行**、每步简述进展，最后总结。
- 不确定就明说「不确定」并给下一步建议；结论要可落地。

## C. 逆向某签名/加密参数的通用流程

### 1. 侦察（Recon）
- `page_info` 看当前页 URL/标题/脚本数。
- 明确目标：要逆的是哪个**参数**、它出现在哪个**请求**里。

### 2. 抓包定位（参数 ↔ 请求）
- `net_capture start`（可加 urlPattern 过滤）→ 触发请求（让用户操作，或 `page_eval`/`page_click` 主动触发）。
- `net_list` 找带目标参数的请求 → `net_get` 看接口、参数在查询串还是请求体、**initiator 调用栈**。

### 3. 关联代码（参数 ↔ JS）
- `scripts_capture_all` 落盘当前页全部 JS → 语料目录。
- `code_search` 搜参数名/相关字符串；`find_param_entry` 一步给出「请求 + 代码命中行」。
- ⚠️ **混淆很常见**：参数名常由字符串数组拼出，**明文搜不到属正常**，别死搜 → 转第 4 步。

### 4. 算法还原（核心路径，引擎级无侵入）
firefox-reverse 把「hook/插桩/日志/源码插桩」统一成 C++ 引擎层能力——**只走算法还原**，不依赖让浏览器替你生成（不做黑盒复现）：
- `jsvmp_trace start`（**不设 filter 或填准确脚本名；要在目标代码冷跑前开**）→ 触发一次参数生成 → `jsvmp_query` 读 VM 执行轨迹（opcode/pc/行列），据此还原 dispatcher、decode、算法骨架。
- 配合离线 `tools/dispatcher_split.js` / `disassemble.js`（开发期 Subprocess）把 trace 翻成伪代码。
- 对非 JSVMP 的普通混淆：`code_search` 定位函数 + `page_eval` 读闭包常量/中间值，逐段还原算法逻辑。

### 5. 验证
- `page_eval` 跑一遍还原出的算法实现，与页面真实产出对比一致即成立。
- 辨清环境依赖：哪些输入参与签名、哪些是定值/时间戳/cookie，把「真正的门」标出来。

### 6. 结论
- 参数在哪里生成、算法/依赖是什么、如何独立复现，给可操作要点。

## D. 工具 ↔ 通用四板斧映射
| 通用四板斧 | firefox-reverse 原生 |
|---|---|
| Hook 函数 | `page_eval`（在页面里包/读函数） |
| 插桩 / 日志 | C++ `jsvmp_trace`（引擎级 per-op，JS 不可见） |
| 源码级插桩 | `scripts_capture_all` + 离线 `tools/*` 反汇编 |
| 网络截获 | `net_capture` / `net_get`（含调用栈） |
| 定位入口 | `find_param_entry`（网络×代码关联） |
| 页面自动操作 | `page_click` / `page_scroll` / `page_type` / `page_screenshot` |

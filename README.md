<div align="center">

<img src="logo.png" width="120" alt="Firefox-Reverse logo">

# Firefox‑Reverse

**一个内置 AI 逆向工程师的 Firefox**

把网页里的加密 / 签名 / 风控参数，从「黑盒」做成「可独立运行、不依赖浏览器的纯算法」。

<br>

![Firefox](https://img.shields.io/badge/Firefox-153.0a1-FF7139?style=for-the-badge&logo=firefoxbrowser&logoColor=white)
![Windows](https://img.shields.io/badge/Windows-0078D6?style=for-the-badge&logo=windows&logoColor=white)
![macOS](https://img.shields.io/badge/macOS-000000?style=for-the-badge&logo=apple&logoColor=white)
![Linux](https://img.shields.io/badge/Linux-FCC624?style=for-the-badge&logo=linux&logoColor=black)

![AI](https://img.shields.io/badge/AI-DeepSeek_·_Claude_·_OpenAI-412991?style=for-the-badge&logo=openai&logoColor=white)
![Engine](https://img.shields.io/badge/hooks-SpiderMonkey_C++-8957E5?style=for-the-badge)
![License](https://img.shields.io/badge/license-MPL_2.0-2EA043?style=for-the-badge)

<br>

[**📥 下载安装（Releases）**](../../releases)　·　[快速开始](#-快速开始5-步)　·　[工具大全](#-工具大全40)　·　[从源码构建](#-从源码构建)

</div>

---

## 概述

很多网站发请求时会带一个**加密参数**——签名 `sign`、令牌 `token`、风控指纹等。想在浏览器之外（你自己的 Node / Python 脚本里）复现这个请求，就得搞清楚这个参数**是怎么算出来的**。这就是 **JS 逆向**，而它通常很难：逻辑被**混淆**、塞进 **JSVMP（JS 虚拟机保护）**、或编译成 **WASM**，还深度依赖一堆**浏览器环境指纹**。传统做法要在 DevTools 里手动下断点、补环境、反复试值，耗时且容易兜圈。

**Firefox‑Reverse 把这套活儿交给一个内置的 AI Agent。** 它住在浏览器侧边栏里，能像一名专业逆向工程师那样**自己**抓包、读代码、在**引擎 C++ 内核层**打点（页面察觉不到）、补环境、写脚本、实打接口验证——目标是把一个加密参数还原成**你能在 Node.js 里独立跑出来的纯算法**。

> 与「AI + 普通浏览器自动化」最大的不同：它的关键观测工具（签名器入参追踪 / JSVMP 逐指令 trace / WASM import 边界 / 引擎级分支差分）都做在 **SpiderMonkey/Gecko 的 C++ 引擎里**——这些是**页面 JS 反射不到、检测不出**的「上帝视角」，对抗反调试 / 反 hook 的强站点尤其关键。

---

## 🚀 快速开始（5 步）

**① 下载安装**
到本仓库的 [**Releases**](../../releases) 页，按你的系统下载安装包：

| 系统 | 文件 | 安装 |
|---|---|---|
| **Windows** | `FirefoxReverse-*-win64.zip` | 解压，双击 `firefox.exe` |
| **macOS (Apple Silicon)** | `FirefoxReverse-*-mac-arm64.dmg` | 打开 → 拖进「应用程序」 |
| **Linux (x86_64)** | `FirefoxReverse-*-linux-x86_64.tar.xz` | 解压，运行 `./firefox` |

**② 打开 AI 侧边栏**
启动浏览器 → 点右侧边栏的 **Firefox‑Reverse** 工具图标（机器人/逆向图标），打开 Agent 面板。

**③ 配置一个大模型 Key**（用一次配一次，存本地）
点面板右上角 ⚙️ 设置 → 选一个模型供应商，填上你的 API Key：
- 支持 **DeepSeek**、**Claude**、**OpenAI**，或任何 **OpenAI / Anthropic 协议兼容**的自定义端点（填 baseUrl + token + 模型名即可）。

> 💡 **模型选型建议**：简单 / 小站点用便宜模型（如 DeepSeek）即可上手；遇到复杂 / 大站点，弱模型在长链路里容易走弯路——这类目标建议用「自定义模型」端点接入 **Opus 4.8 或最新旗舰模型**，逆向推进更稳、少绕路。

**④ 新建会话 → 选模式**
点「新对话」，会弹出选择卡：
- **⚡ 全自动** —— 给它目标接口/参数，它一条龙自己搞定（适合放着跑）；
- **🧭 AI辅助** —— 它先出方案、每做完一个阶段就停下、给你方向选项，你来拍板、逐步推进（适合边看边学、复杂目标）。

**⑤ 把目标告诉它**
按下面这个格式把任务说清楚（信息越具体，AI 越少走弯路）：

```
【目标站点】https://example.com/list          # 能看到目标请求的页面
【目标接口】GET https://example.com/api/v1/list?page=1   # 你最终想复现的请求
【目标参数】请求头里的 X-Sign（签名）。若还有其他动态参数（时间戳 / 设备指纹 / token 等）一并列出
【最终目标】用 Node.js 还原这些参数的生成算法，脱离浏览器独立把这个接口请求成功
```

然后看它自己抓包、定位、补环境、实打验证。产物（脚本、还原代码、笔记）都会落到你为这个会话指定的**工作目录**里。

<details>
<summary><b>新手名词速查（点开看）</b></summary>

- **签名 / 加密参数**：请求里一段算出来的字符串（如 `sign` `token` `X-Bogus`），服务端用它校验请求是否合法。
- **补环境**：签名算法常依赖浏览器特有的东西（`navigator`、DOM、`crypto` 等）。在 Node 里把这些「假装」提供出来，让算法能跑，就叫补环境。
- **JSVMP**：把 JS 编译成自定义「字节码 + 解释器」，看不到原始逻辑、极难读，是常见的强保护。
- **WASM**：把算法编译成二进制模块，浏览器直接执行，源码不可见。
- **白盒纯算**：彻底搞懂算法、用普通代码重写，最终**不再需要原始的 JSVMP/WASM 二进制**。
- **工作目录**：你为一个会话指定的本地文件夹，Agent 的抓取脚本 / trace / 还原代码 / 进度笔记都存这里。

</details>

---

## ✨ 核心亮点

- **🧠 内置自主 Agent** —— 不是聊天框，是能连续调用 40+ 工具、自己跑完「抓包→定位→验证→补环境→实打」全流程的逆向智能体。
- **🔬 引擎层「上帝视角」工具** —— 签名器入参、JSVMP 逐指令、WASM import 边界、浏览器真值 vs Node 复刻的分支差分，全部在 C++ 引擎里观测，**页面检测不到、反调试挡不住**。
- **🎛 两种工作模式** —— 全自动一条龙 / AI辅助逐阶段（你领航），按会话持久化、随时切换。
- **🌐 站点无关** —— 面向**通用** JS / JSVMP / WASM / 签名逆向，不为任何特定网站定制；案例只是测试样例。
- **🔌 任意大模型** —— DeepSeek / Claude / OpenAI 及任意 OpenAI/Anthropic 协议兼容端点，Key 存本地、不外传。
- **💾 跨会话记忆** —— 确认过的事实 / 踩过的坑沉淀进内置 SQLite，下次不再兜圈。
- **🧩 常驻引擎** —— 对话引擎跑在父进程系统模块，切侧栏 / 关窗口都不中断，多窗口工作目录互相隔离。

---

## 🤖 两种工作模式

首次新建会话时选择，整条会话沿用（顶部模式标可随时切换）：

| | ⚡ 全自动 | 🧭 AI辅助 |
|---|---|---|
| **节奏** | 给目标 → 一条龙跑到底 | 先出方案 → 逐阶段停下 → 你选方向 |
| **打扰** | 中途不打扰，只在真需要你（登录态/验证码/纯业务决策）或完成时停 | 每做完一个阶段（入口定位 / 字节trace / DOM-API分析 / 构造实现）就停下汇报、给 2–3 个方向选项 |
| **适合** | 放着跑、目标清晰、信任模型 | 复杂目标、想边看边学、想自己把控方向 |
| **价值** | 省心 | 弱模型 + 人类领航 = 少走死路，复杂案例更稳 |

---

## 🎯 二阶段：黑盒可用 → 白盒纯算

Agent 的推进遵循一条务实路线——**先拿到能用的，再追求吃透的**：

1. **黑盒可用版**：Node 补环境**跑原始 WASM/JSVMP**，以「**本地生成的签名实打目标接口、服务端返回有效数据**」为准。✅ JSVMP / WASM 两种载体都成熟。
2. **白盒纯算**：把内部算法**抠出来、纯代码重写**，彻底不依赖原始二进制。✅ JSVMP 工具链齐全且实战验证；WASM 提供反汇编（WAT）+ 引擎级分支诊断，可深入分析。

---

## 🧰 工具大全（40+）

Agent 可自主调用的工具，按用途分类：

| 类别 | 工具 | 说明 |
|---|---|---|
| **页面自动化** | `page_navigate` `page_click` `page_scroll` `page_type` `page_eval` `page_screenshot` `page_elements` `page_info` | 导航 / 点击 / 滑动 / 填表 / 执行 JS / 截图 / 取元素 |
| **网络** | `net_capture` `net_list` `net_get` `net_intercept` `find_param_entry` | 抓包、看请求详情（含**发起者调用栈**）、拦改、定位参数入口 |
| **🔑 签名器追踪** | `signer_trace` | **引擎层 Debugger** 抓签名函数的**真实入参**（混淆/闭包也能抓，页面无感） |
| **代码 / 脚本** | `code_search` `scripts_list` `scripts_save` `scripts_capture_all` | 在语料 + 工作目录里搜代码、落盘脚本 |
| **WebAPI 指纹** | `webapi_trace` `webapi_query` | 记录页面读了哪些 `navigator`/`document`/`canvas`… 指纹 |
| **🔒 JSVMP 白盒** | `jsvmp_trace` `jsvmp_split_dispatcher` `jsvmp_disassemble` `jsvmp_query` `jsvmp_status` | 逐 op trace → 识别派发器/解码 → 字节反汇编 → 还原算法 |
| **🧬 WASM** | `wasm_probe` `wasm_disasm` | import-trace（探 WASM 读的 DOM/env 边界）、`.wasm`→可读 **WAT** |
| **🩺 白盒诊断** | `whitebox_diff` | **浏览器真值 vs Node 复刻**的引擎级分支差分——把「黑盒兜圈试值」变成「白盒定位是哪条分支/哪个 env 带偏」，全程非侵入 |
| **通用 JS trace** | `js_trace` | AST 插桩 + Node 执行，逐函数追踪（非 JSVMP 的普通 JS） |
| **执行 / 文件** | `run_node` `run_python` `npm_install` `fs_read` `fs_write` `fs_list` `fs_copy` `fs_mkdir` | 在工作目录跑脚本、实打验证、读写文件 |
| **方法论 / 记忆** | `skill_get` `notes_add` `notes_get` | 拉取内置逆向方法论、跨会话沉淀站点经验 |

---

## 🖥 平台与下载

| 平台 | 架构 | 状态 |
|---|---|---|
| **Windows** | x86_64 | ✅ 提供安装包（持续完善中，欢迎反馈） |
| **macOS** | Apple Silicon (arm64) | ✅ 提供安装包 |
| **Linux** | x86_64 | ✅ 提供安装包 |

安装包通过 GitHub Actions **自动编译、自动发布到 [Releases](../../releases)**，每次打 tag 自动出三端构建。

---

## 🏗 从源码构建

> 只想用的话直接去 [Releases](../../releases) 下载即可，无需自己编译。

本仓库是 **Firefox 的「补丁集」**（`additions/`），不含 Firefox 源码本身。构建流程：

```bash
# 1. 取得 Firefox 153.0a1 源码到 upstream/（首次）
#    （见 scripts/，或用 mach 的标准 bootstrap）

# 2. 应用本仓库的 additions（agent-sidebar + 引擎层 C++ 补丁）
bash scripts/apply-patches.sh

# 3. 编译 + 打包
cd upstream && ./mach build && ./mach package
```

- 前端（侧栏 React UI）：`additions/browser/components/agent-sidebar/`，`npm run build` 出 bundle。
- 引擎补丁（非侵入 trace）：`additions/js/...`、`additions/dom/...` 的 C++。
- 自动化构建脚本见 `.github/workflows/release.yml`。

---

## 🏛 架构

```
┌─────────────────────────── Firefox‑Reverse ───────────────────────────┐
│                                                                        │
│  侧边栏 React UI (omni.ja)         常驻引擎 (父进程系统模块, .sys.mjs)   │
│  ├ 对话 / 模式选择卡 / 工作目录    ├ AgentSession  跨面板重载存活        │
│  └ 仅订阅快照、不持业务态          ├ AgentLoop     工具循环/上下文压缩    │
│                                    ├ ToolRouter    40+ 工具路由          │
│                                    └ ConfigStore / Memory (SQLite)      │
│                                                                        │
│  引擎层 C++ 打点（页面无感、反射不到）                                   │
│  ├ JSVMP 逐指令 trace（SpiderMonkey 解释器插桩）                         │
│  ├ WebAPI 指纹 trace（DOM 边界）                                         │
│  └ 覆盖率/分支 差分（whitebox_diff）                                     │
└────────────────────────────────────────────────────────────────────────┘
        最终产物：一段 Node.js / Python 纯算法，不再需要浏览器
```

---

## ❓ FAQ

- **要不要懂编译 / 配环境？** 不用。下载 Releases 安装包即可，配个大模型 Key 就能用。
- **支持哪些大模型？** DeepSeek / Claude / OpenAI，以及任何 OpenAI/Anthropic 协议兼容的自定义端点。Key 只存本地。
- **我的 Key / 数据会上传吗？** 不会。Key 存在本地浏览器配置里，只用于直连你选的大模型端点。
- **全自动和 AI辅助选哪个？** 目标清晰、信任模型 → 全自动；复杂 / 想把控方向 / 想学 → AI辅助。
- **能保证破解任何站点吗？** 不能。强保护（深度 JSVMP / 自带密钥的 WASM）依然很难；本工具是把分析效率拉满，不是银弹。

---

## ⚖️ 法律与授权声明

本项目是面向**安全研究、接口对接、授权测试**的逆向分析工具。使用者须对自己的行为负责：

- **仅在你拥有合法授权的目标上使用**（你自己的平台、获得授权的测试对象、CTF / 教学等）。
- **不得**用于未授权访问、绕过他人系统的安全机制、大规模抓取或任何违反目标方服务条款 / 当地法律的行为。
- 作者与贡献者不对任何滥用行为负责。下载即表示你已理解并同意上述条款。

---

## 📮 反馈 / 联系

使用中遇到问题、想反馈 bug、或交流逆向思路，欢迎加微信：

> **微信号：`han8888v8888`**（加好友请备注「Firefox-Reverse」）

---

## License

[MPL‑2.0](https://www.mozilla.org/MPL/2.0/) —— 与上游 Firefox 一致。本项目为 Firefox 的衍生作品，相关商标归 Mozilla 所有。

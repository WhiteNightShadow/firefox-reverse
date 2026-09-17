# 原生一致指纹策略

本策略随 v0.25.0 发布。隔离边界仍为一个环境一个 profile、一个父进程，不替换 Agent、工具接口、产品壳或历史环境数据。

## 新旧环境

- 新环境默认 `consistency: {"mode":"native-consistent","version":1}`，默认中国大陆、简体中文，语言和时区可编辑。
- UA、platform、appVersion 默认跟随实际 Firefox 内核；Screen、DPR、窗口几何、CPU 和 GPU 保持原生。JSON 中的禁用采集值只是元数据。
- 没有 `consistency` 的旧环境不自动迁移，过去没有消费者的 Canvas/Audio seed 元数据不自动激活。
- 编辑页可显式切换策略。切换会重建 Canvas/Audio/字体配置并关闭会与自定义语言、时区冲突的 RFP/FPP；需要保留原值时先导出配置，选“历史策略”不等于恢复全部旧参数。
- 新模式管理过的渲染首选项在禁用或切回历史策略时显式复位，避免 `prefs.js` 残留。修改后重开环境生效。

## 加载协议

父进程优先级：显式 inline JSON > 显式绝对文件路径 > profile JSON pref > profile 路径 pref。显式空值/损坏的来源为 Invalid，不回退到其他环境或全局 `.current-process` 文件。

`FrxFingerprintConfig` 缓存 Loaded / Invalid / Absent，包括禁用状态。Invalid 表示停用覆盖、返回 Firefox 原生值，不代表整台浏览器拒绝启动；环境管理器另做启动前校验。

内容子进程（含 Worker 所属进程）只消费父快照，即使继承不同 inline/path 也不改变身份。原始 JSON、状态、来源和每次父进程启动生成的 token 经不超过 4000 字节的 ASCII default-pref 片段传入，走现有共享内存首选项链路，不持久化到 `prefs.js`，不放松沙箱。

要求严格 UTF-8 JSON 对象，最大 1 MiB，不接受注释、重复键、尾逗号和尾随内容。Windows 使用 `GetEnvironmentVariableW`、`_wfopen` 和 UTF-8/UTF-16 转换。大配置宜用文件；1 MiB 不是操作系统环境块容量承诺。

原生一致模式默认采用 file-only 启动，清除继承的旧 inline 指纹和父 token；profile 的 inline pref 写空字符串，父进程改读该 profile 的配置文件。历史模式保留既有 inline 启动方式。

## 真实消费者

| 能力 | 配置 | 实际落点 |
| --- | --- | --- |
| Canvas | `mode=native`, `backend=native/software` | software 禁用加速及 force-enabled，Azure 后端选 Skia；真实 2D 绘制，不添加噪声 |
| WebGL | `mode=native`, `msaaSamples=0/4` 或禁用该字段 | `webgl.msaa-samples`，实际采样设置，不伪造 GPU 标签 |
| Fonts | `mode=native/allowlist`, `families` | 本机安装字体校验、`font.system.whitelist`、过滤字体表；macOS 补 `local()` 与 CoreText fallback |
| Offline Audio | `mode=seeded`, `scope=profile`, active 64-hex `seed` | 离线图完成后、发布 AudioBuffer 前，在引擎拥有的 PCM 上处理一次 |

字段支持 `{ "enabled": true, "value": ... }`。字体白名单不能凭名称创建字体资源；删掉必要的语言字体可能导致缺字，Windows/Linux local-font fallback 必须分别实测。

离线音频默认原生，种子模式明确 opt-in，种子持久保存。算法按 seed/channel/绝对 frame 设置正常 Float32 样本最低位，最多改变一个 ULP，保留正负零、subnormal、无穷和 NaN payload。不在 getter、复制接口或实时音频线程中扰动。种子模式不能同时声明 sampleRate/noise/baseLatency/outputLatency；native 模式的默认设备采样率可单独选 44100/48000。它不代表跨设备音频等价或实时音频、AudioWorklet、物理设备模拟。

## 显示边界

本轮不开放完整显示模拟。原生一致模式禁用每个 Screen/window/DPR 覆盖字段，C++ 同样守住边界；历史 getter 覆盖保留。

原生对照中，125% 缩放会使 Screen 的整数值与 CSS 小数尺寸出现舍入差；本轮用一 CSS 像素范围检查并保留精确查询结果。Gecko 的 WebDriver 截图使用 chrome 窗口比例，页面 DPR 还包含页面缩放，不能直接把两者视为同一坐标空间。

后续必须整体验收 Screen/availScreen、CSS device-width/device-height/resolution、缩放、viewport/visualViewport、截图尺寸和 Canvas/WebGL backing buffer，不能只看单个 getter。UA-CH、跨 OS 和 Chromium 身份不扩展。

## 验证

```sh
bash scripts/selftest-agent-tools.sh
FRX_UPSTREAM_DIR=/path/to/gecko python3 scripts/selftest-fingerprint-config.py
c++ -std=c++17 -Wall -Wextra -Werror -I additions/dom/media/webaudio \
  scripts/tests/offline-audio-transform.cpp -o /tmp/frx-offline-audio-test
/tmp/frx-offline-audio-test
node scripts/verify-native-fingerprint.mjs \
  --firefox /path/to/staged/Firefox\ Reverse.app --xul-sha256 <actual-XUL-sha256>
```

读取器单测编译本仓实际 C++ 和树内 JsonCpp，以替身模拟 XPCOM/prefs，不能证明 Gecko IPC、沙箱或 Windows Unicode 行为。浏览器测试绑定新产物 hash，使用临时 profile，不能用旧安装包代替新构建。

2026-09-17 最终包验证：macOS ARM64 213 项、Intel Mac 197 项、Windows 212 项、Linux x86_64/ARM64 各 182 项通过。macOS ARM64 在本机运行，其余目标在对应原生架构的 CI runner 上运行，不将 Rosetta 或静态文件检查算作原生运行。

Intel Mac 与 Linux 的无头 runner 无 WebGL，GPU/MSAA 未验证；Linux 缺少 Arial/Times 字体用例。Windows/Linux 保留 Firefox 原生 local-font fallback 策略，不承诺跨硬件字体或音频等价。完整范围、每项断言和限制见 [NATIVE-VALIDATION.json](https://github.com/WhiteNightShadow/firefox-reverse/releases/download/v0.25.0/NATIVE-VALIDATION.json)。

读取器 68 项、MCP 25 项及 Agent 自测通过；真实浏览器验证 68 个工具注册，抽样调用文件、Node、笔记、页面和环境管理工具及 cookie 隔离；实际 MCP stdio 验证 23 个入口工具。Mac/Windows 另各通过六次新 profile 截图/退出，Mac 验证扩展后台、DevTools 描述符和卸载。没有使用真实付费模型账号进行线上推理验收，也没有覆盖用户日常安装或 profile。

最终包 BuildID 为 `20260917112226`，构建源码提交 `cfa74a51ccb01e99df6f0458874d8c40e94fa5bd`。该提交之后的发布提交仅更新验证脚本和文档；逐包哈希、核心库哈希及来源见 [RELEASE-MANIFEST.json](https://github.com/WhiteNightShadow/firefox-reverse/releases/download/v0.25.0/RELEASE-MANIFEST.json)。

移植参考 PaBox `4913975992bd55adc615cc40f3119ef13d098557` 的配置、音频与字体实现，按 Firefox Reverse 锁定基线逐函数适配，不引入 runtime shell/BiDi 改造。参考：[Camoufox 指纹边界](https://camoufox.com/fingerprint/)、[Mozilla 实现](https://firefox-source-docs.mozilla.org/toolkit/components/resistfingerprinting/resistfingerprinting/implementation.html)。不承诺不可检测或完整 Chromium 身份。

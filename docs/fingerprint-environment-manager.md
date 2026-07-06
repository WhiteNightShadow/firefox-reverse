# 指纹环境管理能力设计

本文说明如何把当前单一 `settings/fingerprint.json` 的指纹随机化能力，升级成可新建、导入、修改、打开、关闭、删除的多环境指纹浏览器能力。

适用边界：自有系统、授权测试、隐私隔离、逆向分析环境复现。设计重点是环境隔离、可审计、C++/Gecko 层一致性，不依赖页面可见的 JS 原型补丁。

## 1. 当前仓库落点

仓库现在已经具备几个基础：

- `docs/architecture.md` 已确定补丁集模式、`additions/` 放新增文件、`settings/*.json` 做运行时配置、C++ 优先。
- `docs/features.md` 已列出 fingerprint/proxy/network/cookie/property trace 等模块，其中 fingerprint 目标覆盖 `navigator`、`screen`、canvas、WebGL、Audio、WebRTC、timezone、locale、fonts。
- `settings/fingerprint.example.json` 是单环境指纹配置雏形。
- `additions/browser/components/agent-sidebar/modules/WebApiBackend.sys.mjs` 已有 C++ Web-API trace 控制与查询，可以复用为“看目标读了哪些环境项”的验证工具。
- `ToolRouter`/`Backends` 已经适合新增 `env_*` 工具并暴露给侧边栏 Agent 或未来 MCP。

缺口是：现在没有“环境实体”，只有单个配置文件；没有 profile 目录生命周期；trace 仍偏全局临时目录；C++ 指纹覆盖还没有统一配置服务。

## 2. 核心结论

需要管理界面，而且需要 C++ 层更改。

管理界面负责环境生命周期：新建、导入、导出、修改、打开、关闭、删除、复制、查看锁与 PID、查看指纹摘要、查看隔离目录。

C++ 层负责真实返回值：`navigator.*`、`screen.*`、canvas/WebGL/Audio/Intl/WebRTC 等必须从 Gecko/SpiderMonkey/Necko 层返回一致值。只靠 JS 注入会被 `toString`、原型描述符、执行时序、跨 realm、worker、iframe、首屏脚本轻易看出破绽。

## 3. 数据模型

把“环境”定义为一组目录、配置、profile 与运行状态：

```json
{
  "schemaVersion": 1,
  "id": "env_20260703_a1b2c3",
  "name": "win-firefox-us-01",
  "browserFamily": "firefox",
  "createdAt": "2026-07-03T10:00:00.000Z",
  "updatedAt": "2026-07-03T10:00:00.000Z",
  "profilePath": "~/.firefox-reverse/environments/env_20260703_a1b2c3/profile",
  "fingerprintPath": "~/.firefox-reverse/environments/env_20260703_a1b2c3/fingerprint.json",
  "proxyPath": "~/.firefox-reverse/environments/env_20260703_a1b2c3/proxy.json",
  "traceDir": "~/.firefox-reverse/environments/env_20260703_a1b2c3/traces",
  "seed": "base64-or-hex-random-seed",
  "seedMode": "persistent",
  "source": {
    "type": "generated|captured-js|imported",
    "browser": "firefox",
    "capturedAt": null
  },
  "runtime": {
    "status": "stopped",
    "pid": null,
    "lastStartedAt": null,
    "lastUrl": null
  }
}
```

建议目录结构：

```text
~/.firefox-reverse/
  environments/
    manifest.json                 # 环境索引，只存摘要和 id/path
    env_xxx/
      env.json                    # 上面的环境 manifest
      fingerprint.json            # C++ 层读取的指纹配置
      proxy.json                  # Necko 代理配置
      user.js                     # profile 初始化 prefs
      profile/                    # Firefox profile 根目录，cookies/storage/prefs/extensions 隔离
      local/                      # cache 等可清理数据，后续可分离
      captures/                   # JS 采集的真实浏览器指纹原始文本
      traces/                     # webapi/jsvmp/network/property trace
      control/                    # ctl 文件、运行状态、心跳
      exports/                    # .frxenv.zip 导出包
```

隔离原则：

- 每个环境一个独立 Firefox profile，不能复用 `cookies.sqlite`、`storage/`、`webappsstore.sqlite`、`permissions.sqlite`、`cert9.db`。
- 每个环境一个独立 trace/control 目录，避免现在 `/tmp/firefox-reverse-webapi.*` 这类路径被多个环境混用。
- 每个环境一个独立 seed。canvas/audio 噪声必须同环境内稳定，不要每次调用随机。
- 删除环境时默认只从索引移除；真正删除 profile 文件必须二次确认，且要求进程已关闭、锁已释放。

## 4. 新增模块

### 4.1 JS/侧边栏后端

新增：

```text
additions/browser/components/agent-sidebar/modules/EnvironmentBackend.sys.mjs
additions/browser/components/agent-sidebar/modules/FingerprintCaptureBackend.sys.mjs
```

接入：

```text
additions/browser/components/agent-sidebar/modules/Backends.sys.mjs
additions/browser/components/agent-sidebar/modules/Tools.sys.mjs
additions/browser/components/agent-sidebar/content/EnvironmentPane.jsx
```

工具建议：

```text
env_list
env_create
env_import
env_export
env_update
env_open
env_close
env_delete
env_status
env_capture_current
env_validate
```

`env_open` 不是简单换配置，而是启动独立进程：

```text
firefox-reverse -no-remote -profile <env/profile> <url>
```

启动时传入环境变量：

```text
MOZ_FRX_ENV_ID=<env id>
MOZ_FRX_FINGERPRINT_CONFIG=<env/fingerprint.json>
MOZ_FRX_PROXY_CONFIG=<env/proxy.json>
MOZ_FRX_TRACE_DIR=<env/traces>
MOZ_WEBAPI_TRACE_FILE=<env/traces/webapi.ndjson>
MOZ_WEBAPI_TRACE_CTL=<env/control/webapi.ctl>
MOZ_JSVMP_TRACE_FILE=<env/traces/jsvmp.ndjson>
```

这样内容进程天然继承当前环境，不需要猜当前 tab 属于哪个环境。

### 4.2 C++ 配置服务

新增一个小的配置缓存服务，例如：

```text
additions/dom/base/FrxFingerprintConfig.h
additions/dom/base/FrxFingerprintConfig.cpp
```

或更中性的：

```text
additions/toolkit/components/firefoxreverse/FrxEnvironmentConfig.h
additions/toolkit/components/firefoxreverse/FrxEnvironmentConfig.cpp
```

职责：

- 读取 `MOZ_FRX_FINGERPRINT_CONFIG` 或 profile pref `firefox_reverse.fingerprint.config_path`。
- 解析 JSON 到 C++ struct。
- 缓存配置，热路径只读内存，不在 getter 中读文件。
- 可选按 mtime 低频热更新。
- 提供 `GetNavigatorOverride()`、`GetScreenOverride()`、`GetNoiseSeed()` 等轻量 API。

patch 接入口放到：

```text
patches/fingerprint/
  0001-register-frx-fingerprint-config.patch
  0002-navigator-screen-overrides.patch
  0003-canvas-audio-webgl-noise.patch
  0004-intl-timezone-locale-overrides.patch
  0005-webrtc-network-header-consistency.patch
```

## 5. Web API 覆盖优先级

第一阶段先做低风险且容易验证的字段：

- `navigator.userAgent`
- `navigator.platform`
- `navigator.language`
- `navigator.languages`
- `navigator.webdriver`
- `navigator.hardwareConcurrency`
- `screen.width/height/availWidth/availHeight/colorDepth/pixelDepth`
- `window.devicePixelRatio`
- HTTP `User-Agent` 与 `Accept-Language`
- `Intl.DateTimeFormat().resolvedOptions().timeZone`

第二阶段做图形与音频：

- canvas `toDataURL` / `toBlob` / `getImageData` 提取时加确定性噪声。
- WebGL `UNMASKED_VENDOR_WEBGL`、`UNMASKED_RENDERER_WEBGL`、部分 `getParameter`、shader precision。
- AudioContext/Analyser 输出加确定性微扰。

第三阶段做更容易穿帮的能力：

- fonts 与 text metrics。
- WebRTC 本地 IP 泄漏控制。
- media devices、voices、permissions、battery/USB/Bluetooth 等按 Firefox 实际支持情况处理。
- Worker/iframe/private window 下的一致性。

不要给 Firefox 硬塞 Chromium/V8 独有行为。若导入源是 Chrome，只能转换通用字段，并打 warning；否则 JS 行为、Web API 缺省值、错误类型、`Function.prototype.toString` 等会互相矛盾。

## 6. 真实浏览器环境采集

可以提供一个 `env_capture_current`，在当前页面执行只读 JS，把真实浏览器可见环境导出成文本：

```js
(async () => {
  const safe = (fn, fallback = null) => {
    try { return fn(); } catch { return fallback; }
  };
  const safeAsync = async (fn, fallback = null) => {
    try { return await fn(); } catch { return fallback; }
  };
  const glInfo = () => {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    if (!gl) return null;
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    return {
      vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      version: gl.getParameter(gl.VERSION),
      shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
      extensions: gl.getSupportedExtensions()
    };
  };
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    browserFamily: "firefox",
    navigator: {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      language: navigator.language,
      languages: Array.from(navigator.languages || []),
      hardwareConcurrency: navigator.hardwareConcurrency,
      maxTouchPoints: navigator.maxTouchPoints,
      webdriver: navigator.webdriver,
      cookieEnabled: navigator.cookieEnabled,
      pdfViewerEnabled: navigator.pdfViewerEnabled,
      plugins: Array.from(navigator.plugins || []).map(p => ({ name: p.name, filename: p.filename })),
      mimeTypes: Array.from(navigator.mimeTypes || []).map(m => ({ type: m.type, suffixes: m.suffixes }))
    },
    screen: {
      width: screen.width,
      height: screen.height,
      availWidth: screen.availWidth,
      availHeight: screen.availHeight,
      colorDepth: screen.colorDepth,
      pixelDepth: screen.pixelDepth
    },
    window: {
      innerWidth,
      innerHeight,
      outerWidth,
      outerHeight,
      devicePixelRatio
    },
    intl: {
      dateTimeFormat: Intl.DateTimeFormat().resolvedOptions(),
      numberFormat: Intl.NumberFormat().resolvedOptions()
    },
    webgl: safe(glInfo),
    storage: await safeAsync(
      () => navigator.storage && navigator.storage.estimate
        ? navigator.storage.estimate()
        : null
    )
  };
})();
```

采集注意：

- JS 只能采集页面可见值，采不到 TLS/JA3、真实 TCP 栈、底层 GPU 驱动细节、HTTP header 全量、Firefox 内部 prefs。
- media device label、字体全量、WebRTC IP、地理位置属于敏感项，默认不采或只采摘要，需用户显式开启。
- 导入时要做 schema normalization，不要把采集 JSON 原样喂 C++。
- canvas/audio 适合保存 hash 与参数，不建议保存大量原始像素/音频样本。

## 7. 一致性校验

每次新建、导入、修改都跑 `env_validate`：

- `User-Agent` header、`navigator.userAgent`、`appVersion` 一致。
- `Accept-Language`、`navigator.language/languages`、Intl locale 一致。
- timezone 与代理地理位置不冲突；冲突时 warning。
- screen、viewport、outer/inner、DPR 合理。
- WebGL vendor/renderer 与 OS、GPU、字体策略不冲突。
- `navigator.webdriver`、remote debugging、automation 痕迹按模式控制。
- canvas/audio/WebGL 噪声同环境内多次读取稳定。
- cookie/localStorage/cache 只在当前 env profile 内出现。
- Worker、iframe、new window 读到同样环境。

验证工具链：

- 用现有 `webapi_trace` 看目标页面实际读了哪些环境项。
- 用 `page_eval` 运行采集脚本，对比 `fingerprint.json`。
- 打开两个环境分别写 cookie/localStorage，确认互不可见。
- 重启同环境，确认 persistent seed 下 canvas/audio hash 稳定。

## 8. 管理界面

建议做一个轻量“环境”页签，而不是塞进现有设置页：

- 列表：名称、状态、PID、代理、OS/UA 摘要、profile 大小、最后打开时间。
- 操作：新建、复制、导入、导出、打开、关闭、删除。
- 编辑：分组表单编辑 navigator/screen/locale/timezone/proxy/seed。
- 采集：从当前标签页采集真实浏览器环境，保存到 `captures/`，再选择导入到某个环境。
- 校验：显示一致性 warning，不阻塞保存，但打开前强提醒。
- 高级：显示目录路径、锁文件、trace/control 文件。

UI 放在：

```text
additions/browser/components/agent-sidebar/content/EnvironmentPane.jsx
additions/browser/components/agent-sidebar/content/agent-panel.css
```

也可以后续做 `about:frx-environments`，但第一版用侧边栏更快。

## 9. 分阶段落地

### P0：环境实体与目录隔离

- 新增 `settings/environment.example.json` 和 `docs/fingerprint-environment-manager.md`。
- 新增 `EnvironmentBackend.sys.mjs`。
- 实现 `env_list/create/update/delete/import/export/status`。
- 每个环境创建独立 profile 目录与 `user.js`。

### P1：打开/关闭指定环境

- `env_open` 用 `Subprocess` 启动独立 Firefox-Reverse 进程。
- `env_close` 先尝试温和关闭，超时再 force。
- 记录 PID、启动 URL、心跳、锁。
- 禁止同一 env 被重复打开。

### P2：采集真实浏览器环境

- 新增 `FingerprintCaptureBackend.sys.mjs`。
- `env_capture_current` 导出 `captures/<ts>.json`。
- `env_import_capture` 把采集结果规范化为 `fingerprint.json`。

### P3：C++ 低风险覆盖

- 实现 `FrxFingerprintConfig` 缓存服务。
- 接 navigator/screen/locale/timezone/headers。
- 加自动测试：同 env 多次读取稳定，跨 env 不同。

### P4：图形/音频/字体/WebRTC

- canvas/audio/WebGL 确定性噪声。
- 字体与 text metrics 策略。
- WebRTC 本地 IP 控制。
- 用 `webapi_trace` 和检测页做回归。

### P5：UI 与 MCP

- 环境管理 UI。
- ToolRouter 暴露 `env_*`。
- 未来 MCP server 复用同一 `EnvironmentBackend`。

## 10. 最容易踩的坑

- 不要在同一 profile 上开多个 Firefox 实例，会触发 profile lock 或数据损坏。
- 不要全局写 `/tmp` trace/control；多环境、多 PID 会混。
- 不要每次 getter 随机返回值；同一次页面运行中重复读取不一致最容易暴露。
- 不要只改 `navigator.userAgent`，HTTP header 和 JS 值不一致会立刻穿帮。
- 不要导入 Chromium 指纹后伪装成 Firefox；引擎行为不一致。
- 不要把敏感 profile 数据默认打进导出包；cookies、密码、证书、storage 必须 opt-in。
- 不要在热路径读 JSON；C++ getter 只能读内存缓存。

## 11. 推荐先改的文件

第一批只做环境管理，不碰 C++ 热路径：

```text
settings/environment.example.json
additions/browser/components/agent-sidebar/modules/EnvironmentBackend.sys.mjs
additions/browser/components/agent-sidebar/modules/Backends.sys.mjs
additions/browser/components/agent-sidebar/modules/Tools.sys.mjs
additions/browser/components/agent-sidebar/content/EnvironmentPane.jsx
```

第二批再进 C++：

```text
additions/dom/base/FrxFingerprintConfig.h
additions/dom/base/FrxFingerprintConfig.cpp
patches/fingerprint/0001-register-frx-fingerprint-config.patch
patches/fingerprint/0002-navigator-screen-overrides.patch
patches/fingerprint/0003-canvas-audio-webgl-noise.patch
```

这样拆分后，环境 CRUD/profile 隔离可以先独立验证；C++ 指纹覆盖再逐项加，不会一上来把构建和浏览器稳定性都压到一个大补丁里。

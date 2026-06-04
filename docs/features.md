# 功能清单

每个功能模块在 `patches/<module>/` 下维护补丁文件，并在 `patches/<module>/README.md` 描述实现细节与状态。

## 1. 指纹随机化（fingerprint）

**目的**：让每次启动浏览器的指纹与上次不同，且每个字段可配置开关与策略。

**覆盖范围**：
- `navigator.*`：userAgent, platform, language(s), hardwareConcurrency, deviceMemory, webdriver, plugins, mimeTypes
- `screen.*`：width, height, availWidth, availHeight, colorDepth, pixelDepth
- `window.*`：innerWidth/Height, outerWidth/Height, devicePixelRatio
- `canvas`：toDataURL / getImageData 噪声注入
- `WebGL`：UNMASKED_VENDOR / RENDERER, getParameter 返回值
- `AudioContext`：oscillator buffer 噪声
- `WebRTC`：本地 IP 泄漏屏蔽
- `Battery / Bluetooth / USB / 字体枚举` 等
- 时区、locale、ICU 数据

**实现位置**：SpiderMonkey C++ 层（Web IDL binding 层 hook），避免 JS 层伪装可被检测。

**配置**：`settings/fingerprint.json`。

## 2. 代理配置（proxy）

**目的**：进程级 HTTP / SOCKS 代理，支持按 URL 模式路由。

**特性**：
- HTTP / HTTPS / SOCKS4 / SOCKS5
- 鉴权（user:pass）
- 按域名 / URL 正则路由到不同代理
- 失败自动 fallback

**实现位置**：Necko 网络栈层修改 + nsIProtocolProxyService 扩展。

**配置**：`settings/proxy.json`。

## 3. JSVMP 执行流程追踪（jsvmp-trace）

**目的**：在 SpiderMonkey C++ 层捕获字节码 dispatch（含 JSVMP 解释器内部的虚拟字节码），并写本地文件。

**输出字段**（每条 trace）：
- 时间戳（ns 级）
- script_id, line, column
- opcode（原生 SpiderMonkey + 上层 JSVMP）
- 调用栈（C++ stack + JS stack）
- 当前函数名 / 上下文

**实现位置**：`js/src/vm/Interpreter.cpp` 中 dispatch 循环 hook，结合 BaselineIC / IonMonkey 路径补丁。

**输出**：NDJSON，路径由 `settings/fingerprint.json::trace.jsvmp_dir` 决定。

## 4. 网络请求分析（network-analysis）

**目的**：捕获完整的网络层请求/响应，含调用栈与时序。

**覆盖**：
- HTTP / HTTPS（Fetch / XHR / Worker / Service Worker）
- WebSocket
- WebRTC DataChannel
- 资源加载（script, css, image, font, media）

**字段**：method, url, headers, body, status, response_headers, response_body（可配置截断）, timing, initiator_stack。

**实现位置**：Necko nsHttpChannel + WebSocketChannel + 网络观察者 + JS 调用栈采集。

## 5. 站点 Cookie 与 JS 文件分析（cookie-js-analysis）

**目的**：

- **Cookie**：捕获 Set-Cookie / document.cookie 读写、第三方 Cookie 流向。
- **JS 文件**：记录所有加载的 JS（含 inline / eval / new Function / Worker scripts），保存原始内容到本地。

**字段**：
- Cookie：domain, name, value, attrs, source（http/js）, set_by_url, set_by_stack
- JS：url, hash, size, content_path（本地落盘路径）, loaded_at, parser（main/worker/sw）, evaluated_at

**实现位置**：CookieService hook + Script Loader hook。

## 6. 属性追踪（property-trace）

**目的**：扩展 camoufox-reverse 的 PropertyTracer，覆盖更多 DOM API、Storage、Crypto 等。

**覆盖**：Navigator / Screen / Window / Document / Canvas / WebGL / Audio / Storage / Crypto / Performance / PaymentRequest / USB 等。

**输出**：每次 getter / setter 调用一条 NDJSON，含属性路径、value、调用栈、frame URL。

**实现位置**：与 camoufox-reverse 同思路，在 Web IDL binding 自动生成代码处插桩。

## 配置开关

所有模块的开关与采样率统一在 `settings/*.json` 中控制，运行时无需重编。

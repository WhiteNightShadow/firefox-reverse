# patches/cookie-js-analysis/

## Cookie 监控

- 关键文件：`netwerk/cookie/CookieService.cpp`、`dom/base/Document.cpp::Cookie`
- 字段：`domain, name, value, attrs, source(http|js), set_by_url, set_by_stack`

## JS 文件分析

- 关键文件：`dom/script/ScriptLoader.cpp`、`js/src/vm/Compilation.cpp`、`js/src/builtin/Eval.cpp`
- 行为：每个加载/编译/eval 的 JS 都落盘到 `settings.trace.js_dir/<sha256>.js`，并在 NDJSON 记录元信息。
- 覆盖：外链 script、inline script、eval、new Function、Worker scripts、Module script、Service Worker。

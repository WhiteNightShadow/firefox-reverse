# tests/

集成测试（按模块）。每个 patch 模块在此有对应子目录，运行已编译的 firefox-reverse 二进制 + 模拟站点，验证 trace 输出符合预期。

```
tests/
├── fingerprint/
├── proxy/
├── jsvmp-trace/
├── network-analysis/
├── cookie-js-analysis/
└── property-trace/
```

测试驱动建议使用 Python + camoufox-reverse-mcp 复用的 fixture（待 MCP 集成阶段确定）。

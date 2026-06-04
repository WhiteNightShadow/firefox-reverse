# patches/property-trace/

DOM API getter/setter 调用追踪。**思路与 camoufox-reverse PropertyTracer 一致**，但范围扩大，且基于原生 mozilla-firefox/firefox 重新实现（不基于 camoufox fork）。

## 关键 Firefox 源文件

- 由 `dom/bindings/Codegen.py` 自动生成的 binding 代码（如 `obj-*/dom/bindings/NavigatorBinding.cpp`）
- 在生成器中插入 trace hook，对所有 DOM API getter/setter 统一插桩

## 覆盖范围

详见 [../../docs/features.md#6-属性追踪property-trace](../../docs/features.md)。

## 数据流

```
DOM getter/setter
   ↓ (auto-generated trace hook from Codegen.py)
TraceWriter
   ↓
NDJSON file (settings.trace.property_dir)
```

## 与 camoufox-reverse 复用

- 算法/数据结构可借鉴 camoufox-reverse 中的 `PropertyTracer` 实现。
- 但因为 fork 基础不同（一个是 camoufox，一个是上游 firefox），补丁文件不能直接 cherry-pick。

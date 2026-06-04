# 架构概览

## 设计原则

1. **不在仓库中存放上游源码** —— Firefox 源码 ~5 GB（不含 git 历史）/ ~30 GB（含），超过 GitHub 仓库实用上限（5 GB 推荐，单文件 100 MB）；上游每天数百 commit，vendor 模式同步成本天文数字。通过 `scripts/bootstrap.sh` 在 `upstream/` 下浅克隆。**业界都用补丁集模式**：camoufox / Brave（chromium_src）/ Tor Browser / LibreWolf / Mullvad，无一 vendor 全量上游。
2. **以补丁集 (patches/) 维护魔改** —— 每个功能模块一个子目录，便于审查、回退、跨上游版本迁移。
3. **新增文件放 additions/** —— 不修改原 firefox 文件、纯新增的 C++/JS/配置文件单独放，避免补丁体积过大。
4. **配置与代码分离** —— 运行时可调参数（指纹、代理）走 `settings/*.json`，编译期不固化。
5. **C++ 优先 + JS 兜底** —— 能在 SpiderMonkey/Gecko C++ 层做的不放 JS，确保对反检测脚本不可见。
6. **用户自编不依赖 build 仓库** —— `firefox-reverse-build/` 是私有的 CI 基础设施。用户想自己编只需要本仓库 + Mozilla 官方依赖。Release 还会发 patched-source tarball 让用户跳过 bootstrap 直接 `./mach build`。

## 构建流程

```
┌─────────────┐    bootstrap.sh    ┌──────────────┐    apply-patches.sh    ┌──────────────┐
│ upstream    │ ─────────────────▶ │ upstream/    │ ─────────────────────▶ │ upstream/    │
│ git remote  │   shallow clone    │ (pristine)   │   patch -p1 + copy     │ (patched)    │
└─────────────┘                    └──────────────┘                        └──────────────┘
                                                                                  │
                                                                          build.sh│
                                                                                  ▼
                                                                          ┌──────────────┐
                                                                          │ build/       │
                                                                          │ (artifacts)  │
                                                                          └──────────────┘
                                                                                  │
                                                                       package.sh │
                                                                                  ▼
                                                                          ┌──────────────┐
                                                                          │ dist/        │
                                                                          │ multi-platform│
                                                                          └──────────────┘
```

## 模块分层

```
┌─────────────────────────────────────────────────────────────────┐
│  Runtime Config (settings/*.json)                              │
│    ├─ fingerprint.json    可配置的指纹随机参数                  │
│    └─ proxy.json          代理配置                              │
└─────────────────────────────────────────────────────────────────┘
                                │
┌───────────────────────────────┼─────────────────────────────────┐
│  Patched Firefox              ▼                                 │
│  ┌──────────────────┐  ┌──────────────────┐                    │
│  │ Gecko / Browser  │  │ SpiderMonkey JS  │                    │
│  │ ──────────────── │  │ ──────────────── │                    │
│  │ • proxy          │  │ • jsvmp-trace    │                    │
│  │ • network-analysis│ │ • property-trace │                    │
│  │ • cookie-analysis│  │ • fingerprint    │                    │
│  └──────────────────┘  └──────────────────┘                    │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
                       本地输出（NDJSON）
                       ├─ traces/jsvmp-*.jsonl
                       ├─ traces/network-*.jsonl
                       └─ traces/property-*.jsonl
```

## 与 camoufox-reverse 的差异

| 维度 | camoufox-reverse | firefox-reverse |
|------|------------------|-----------------|
| 上游 | daijro/camoufox | mozilla-firefox/firefox |
| 范围 | PropertyTracer 为主 | 指纹/代理/JSVMP/网络/Cookie/JS/属性 全栈 |
| 集成 | 已有 MCP 包装 | MCP 包装后续做 |

## 数据输出

所有 trace 输出统一使用 NDJSON（每行一个 JSON 对象），方便流式处理与离线分析。输出目录由 `settings/*.json` 中的 `trace_dir` 决定，默认 `$HOME/.firefox-reverse/traces/`。

详细文档见：
- [features.md](features.md) — 功能清单
- [roadmap.md](roadmap.md) — 实现路线
- [upstream-sync.md](upstream-sync.md) — 上游同步策略

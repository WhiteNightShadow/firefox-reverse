# additions/

新增的源文件，按对应路径放进 `upstream/`（少数品牌资源会覆盖上游同名文件）。`scripts/apply-patches.sh` 在 patch 阶段后调用 `scripts/sync-additions.py` 同步：只复制内容有变化的文件；从本目录删除的文件，下次同步时也会从 `upstream/` 删除（覆盖过的上游文件则还原）。

## 子目录结构

应与 firefox 源码树对应，例如：

```
additions/
└── js/
    └── src/
        └── reverse/         # 新增的 namespace
            ├── TraceWriter.h
            ├── TraceWriter.cpp
            └── Config.h
```

## 与 patches/ 的关系

- `patches/` — 修改既有文件
- `additions/` — 新增独立文件（避免 patch 中包含大量纯新增内容导致补丁臃肿）
- 入口接入（如在 `moz.build` 中添加新文件、在头文件中 include 新增声明）仍走 `patches/`

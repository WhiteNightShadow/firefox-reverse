# additions/

新增的源文件，纯增量、不修改任何上游 firefox 文件。`scripts/apply-patches.sh` 在 patch 阶段后将本目录的文件按对应路径 copy 到 `upstream/`。

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

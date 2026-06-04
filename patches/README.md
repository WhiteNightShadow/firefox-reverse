# patches/

按功能模块组织的补丁集，每个子目录维护一个独立模块。

## 应用顺序

`scripts/apply-patches.sh` 按以下顺序应用：

1. `property-trace/`       — 基础追踪能力
2. `network-analysis/`     — 网络层 hook
3. `cookie-js-analysis/`   — Cookie + JS Loader hook
4. `fingerprint/`          — 指纹随机化
5. `proxy/`                — 代理
6. `jsvmp-trace/`          — JSVMP 字节码追踪（依赖前面的基础设施）

## 补丁文件命名

```
patches/<module>/NNNN-short-description.patch
```

- `NNNN` 顺序号（0001, 0002, ...）
- `short-description` kebab-case 简述

## 新增补丁

```bash
cd upstream
# 编辑源码
git add -p
git commit -m "[module] brief description"
git format-patch -1 --output-directory ../patches/<module>/
```

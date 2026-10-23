# patches/

按功能模块组织的补丁集，每个子目录维护一个独立模块。

## 应用顺序

`scripts/apply-patches.sh` 是本地、CI 和编译机共用的唯一入口，可以在同一棵源码树上重复执行。按以下顺序应用各模块的 git 补丁，已经打过的整份跳过；源码树和补丁对不上时直接失败：

1. `property-trace/`       — 基础追踪能力
2. `network-analysis/`     — 网络层 hook
3. `cookie-js-analysis/`   — Cookie + JS Loader hook
4. `fingerprint/`          — 指纹随机化
5. `proxy/`                — 代理
6. `jsvmp-trace/`          — JSVMP 字节码追踪（依赖前面的基础设施）
7. `agent-ui/`             — Agent 侧栏注册与启动期修复
8. `branding/`             — 品牌

之后依次：

- 构建侧栏 bundle（依赖缺失或 lock 更新时先 `npm ci`）；
- `scripts/sync-additions.py` 把 `additions/` 同步进源码树：只复制内容有变化的文件；上次同步过、`additions/` 里已删除的文件也从源码树删除，覆盖过的上游文件则还原；
- `scripts/apply-fingerprint-config.py`、`scripts/apply-phase-b.py` 两个字符串替换式补丁器，已应用的跳过。

CI（`.github/workflows/ci.yml`）在每次 push / PR 时，于锁定基线上把整条流程跑两遍，第二遍必须没有任何改动。

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

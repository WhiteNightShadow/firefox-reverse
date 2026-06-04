# 上游同步策略

## 上游

- URL: https://github.com/mozilla-firefox/firefox
- 基线版本：**待定**（建议从最近的 ESR 起步）
- 同步频率：每 ESR 一次（约半年），或在 CVE 紧急时跟进

## 跟踪策略

1. **基线锁定**：在 `scripts/bootstrap.sh` 中写死上游 git ref（tag 或 commit）。
2. **补丁可应用性**：每次升级基线，需要重新尝试 `apply-patches.sh`，处理冲突。
3. **冲突归档**：上游 API 变化导致的补丁失效，归档到 `patches/<module>/legacy/` 并新建新版本补丁。

## 子模块 vs 浅克隆

- 不用 git submodule（体积大、维护复杂）。
- 用 `git clone --depth 1 --branch <ref>` 浅克隆到 `upstream/`，`upstream/` 加入 `.gitignore`。

## 补丁格式

- 优先使用 `git format-patch` 生成的格式（含上下文），便于 `git am` 应用。
- 补丁文件命名：`patches/<module>/NNNN-short-description.patch`，NNNN 为顺序号。

## 升级流程

```bash
# 1. 备份当前补丁
git tag patches-<old-version>

# 2. 修改 bootstrap.sh 中的上游 ref
vim scripts/bootstrap.sh

# 3. 清理并重新拉取
make reset
make bootstrap

# 4. 尝试应用补丁
make patch  # 若失败，按模块手工解决冲突

# 5. 重新生成补丁文件
cd upstream && git format-patch <upstream-ref>..HEAD --output-directory ../patches/<module>/
```
